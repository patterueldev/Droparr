import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NotificationSettings,
  Submission,
  SubmissionState,
} from "@droparr/shared";
import { ConfigStore } from "../config/store.js";
import { Db } from "../db.js";
import { JobRegistry } from "../jobs.js";
import {
  SubmissionEventBus,
  type SubmissionEvent,
} from "../submissions/events.js";
import { NotificationService } from "./service.js";

interface Harness {
  config: ConfigStore;
  db: Db;
  jobs: JobRegistry;
  submissions: SubmissionEventBus;
  service: NotificationService;
  warnings: { obj: unknown; msg?: string }[];
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
  vi.unstubAllGlobals();
});

async function buildHarness(): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), "droparr-notifications-"));
  const config = await ConfigStore.load(join(tmp, "config.json"));
  const db = new Db(join(tmp, "droparr.db"));
  const jobs = new JobRegistry();
  const submissions = new SubmissionEventBus();
  const warnings: { obj: unknown; msg?: string }[] = [];
  const service = new NotificationService({
    config,
    db,
    jobs,
    submissions,
    log: { warn: (obj, msg) => warnings.push({ obj, msg }) },
  });
  cleanups.push(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  return { config, db, jobs, submissions, service, warnings };
}

async function enable(
  h: Harness,
  overrides: Partial<NotificationSettings> = {},
): Promise<void> {
  await h.config.updateSettings({
    notifications: {
      enabled: true,
      url: "https://ntfy.sh/droparr-test",
      format: "ntfy",
      ...overrides,
    },
  });
}

let seq = 0;

function seedSubmission(
  h: Harness,
  opts: {
    submitterId: string;
    state?: SubmissionState;
    dropName?: string;
    note?: string;
    jobIds?: string[];
  },
): Submission {
  seq += 1;
  const now = new Date().toISOString();
  const submission: Submission = {
    id: `sub-${seq}`,
    submitterId: opts.submitterId,
    state: opts.state ?? "pending",
    dropId: `drop-${seq}`,
    dropName: opts.dropName ?? "My Drop",
    sourcePath: "/tmp/drop",
    items: [
      {
        subPath: "",
        sourcePath: "/tmp/drop",
        analysis: {
          kind: "movie",
          title: "My Drop",
          files: [],
          confidence: "high",
          reasoning: [],
          subPath: "",
        },
        title: "My Drop",
        include: true,
      },
    ],
    importMode: "copy",
    note: opts.note,
    jobIds: opts.jobIds,
    createdAt: now,
    updatedAt: now,
  };
  h.db.createSubmission(submission);
  return submission;
}

function eventFor(
  submission: Submission,
  state: SubmissionState,
): SubmissionEvent {
  return {
    type: "submission",
    submissionId: submission.id,
    submitterId: submission.submitterId,
    state,
    at: new Date().toISOString(),
  };
}

function stubFetch(status = 200) {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function postedBody(fetchMock: ReturnType<typeof stubFetch>, call = 0): string {
  return String(fetchMock.mock.calls[call]![1]?.body ?? "");
}

describe("NotificationService — event mapping", () => {
  it("posts a pending-submission alert through the started bus", async () => {
    const h = await buildHarness();
    await enable(h);
    const ada = h.db.upsertUser({
      jellyfinUserId: "jf-ada",
      name: "Ada",
      role: "submitter",
    });
    const submission = seedSubmission(h, {
      submitterId: ada.id,
      dropName: "Severance S01",
    });
    const fetchMock = stubFetch();

    h.service.start();
    h.submissions.emitSubmission({
      submissionId: submission.id,
      submitterId: ada.id,
      state: "pending",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = postedBody(fetchMock);
    expect(body).toContain("Ada");
    expect(body).toContain("Severance S01");
    expect(body).toContain("approval");
  });

  it("reports done with imported counts and *arr rejections", async () => {
    const h = await buildHarness();
    await enable(h);
    const ada = h.db.upsertUser({
      jellyfinUserId: "jf-ada",
      name: "Ada",
      role: "submitter",
    });
    const submission = seedSubmission(h, {
      submitterId: ada.id,
      state: "done",
      dropName: "Dune (2021)",
      jobIds: ["job-1"],
    });
    h.jobs.create("job-1");
    h.jobs.emitEvent({
      jobId: "job-1",
      phase: "done",
      message: "Import complete",
      at: new Date().toISOString(),
      result: {
        importedFiles: 1,
        rejectedFiles: [{ path: "/staging/x.mkv", reasons: ["bad codec"] }],
        historyId: "h1",
      },
    });
    const fetchMock = stubFetch();

    await h.service.handleEvent(eventFor(submission, "done"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = postedBody(fetchMock);
    expect(body).toContain("Ada");
    expect(body).toContain("Dune (2021)");
    expect(body).toContain("1/1 item(s) imported");
    expect(body).toContain("1 file(s) were rejected");
  });

  it("reports failed with the job error", async () => {
    const h = await buildHarness();
    await enable(h);
    const ada = h.db.upsertUser({
      jellyfinUserId: "jf-ada",
      name: "Ada",
      role: "submitter",
    });
    const submission = seedSubmission(h, {
      submitterId: ada.id,
      state: "failed",
      jobIds: ["job-1"],
    });
    h.jobs.create("job-1");
    h.jobs.emitEvent({
      jobId: "job-1",
      phase: "error",
      message: "Import pipeline failed",
      at: new Date().toISOString(),
      error: "All files were rejected by Movies Radarr",
    });
    const fetchMock = stubFetch();

    await h.service.handleEvent(eventFor(submission, "failed"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = postedBody(fetchMock);
    expect(body).toContain("could not be imported");
    expect(body).toContain("All files were rejected by Movies Radarr");
  });

  it("reports rejections with the admin note", async () => {
    const h = await buildHarness();
    await enable(h);
    const ada = h.db.upsertUser({
      jellyfinUserId: "jf-ada",
      name: "Ada",
      role: "submitter",
    });
    const submission = seedSubmission(h, {
      submitterId: ada.id,
      state: "rejected",
      dropName: "Wrong Movie",
      note: "This is a duplicate of the library copy.",
    });
    const fetchMock = stubFetch();

    await h.service.handleEvent(eventFor(submission, "rejected"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = postedBody(fetchMock);
    expect(body).toContain("was rejected");
    expect(body).toContain("This is a duplicate of the library copy.");
  });

  it("ignores progress states like approved and importing", async () => {
    const h = await buildHarness();
    await enable(h);
    const ada = h.db.upsertUser({
      jellyfinUserId: "jf-ada",
      name: "Ada",
      role: "submitter",
    });
    const submission = seedSubmission(h, { submitterId: ada.id });
    const fetchMock = stubFetch();

    await h.service.handleEvent(eventFor(submission, "approved"));
    await h.service.handleEvent(eventFor(submission, "importing"));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("NotificationService — gating and failures", () => {
  it("does nothing without configuration or while disabled", async () => {
    const h = await buildHarness();
    const ada = h.db.upsertUser({
      jellyfinUserId: "jf-ada",
      name: "Ada",
      role: "submitter",
    });
    const submission = seedSubmission(h, { submitterId: ada.id });
    const fetchMock = stubFetch();

    // No notifications configured (fresh install default).
    await h.service.handleEvent(eventFor(submission, "pending"));
    expect(fetchMock).not.toHaveBeenCalled();

    await enable(h, { enabled: false });
    await h.service.handleEvent(eventFor(submission, "pending"));
    expect(fetchMock).not.toHaveBeenCalled();

    await enable(h);
    await h.service.handleEvent(eventFor(submission, "pending"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips transitions for unknown submissions", async () => {
    const h = await buildHarness();
    await enable(h);
    const fetchMock = stubFetch();

    await h.service.handleEvent({
      type: "submission",
      submissionId: "nope",
      submitterId: "ghost",
      state: "pending",
      at: new Date().toISOString(),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs delivery failures without throwing", async () => {
    const h = await buildHarness();
    await enable(h);
    const ada = h.db.upsertUser({
      jellyfinUserId: "jf-ada",
      name: "Ada",
      role: "submitter",
    });
    const submission = seedSubmission(h, { submitterId: ada.id });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );

    await expect(
      h.service.handleEvent(eventFor(submission, "pending")),
    ).resolves.toBeUndefined();
    expect(h.warnings.some((w) => w.msg === "notification webhook failed")).toBe(
      true,
    );
  });

  it("never lets a crashed handler bubble out of the event bus", async () => {
    const h = await buildHarness();
    await enable(h);
    const ada = h.db.upsertUser({
      jellyfinUserId: "jf-ada",
      name: "Ada",
      role: "submitter",
    });
    const submission = seedSubmission(h, { submitterId: ada.id });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );

    h.service.start();
    // emitSubmission is synchronous; a throwing listener would surface here.
    expect(() =>
      h.submissions.emitSubmission({
        submissionId: submission.id,
        submitterId: ada.id,
        state: "pending",
      }),
    ).not.toThrow();
    await vi.waitFor(() =>
      expect(
        h.warnings.some((w) => w.msg === "notification webhook failed"),
      ).toBe(true),
    );
  });
});
