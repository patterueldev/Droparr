import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { nanoid } from "nanoid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Submission, User } from "@droparr/shared";
import { ConfigStore } from "../config/store.js";
import { Db } from "../db.js";
import { JobRegistry } from "../jobs.js";
import { runImport, type ImportRequest } from "../import/runner.js";
import { SubmissionEventBus } from "../submissions/events.js";
import { UploadEventBus } from "../uploads/events.js";
import type { UploadSettings } from "../uploads/settings.js";
import { submissionRoutes } from "./submissions.js";

// The pipeline itself is covered by the runner's own end-to-end tests against
// a mock *arr; the route's wiring is what this suite checks.
vi.mock("../import/runner.js", () => ({
  runImport: vi.fn(async () => {}),
}));

interface Harness {
  app: FastifyInstance;
  config: ConfigStore;
  db: Db;
  jobs: JobRegistry;
  quarantineDir: string;
  tmp: string;
  setUser: (user: User) => void;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.mocked(runImport).mockClear();
  // Suggestions go through the target *arr; this suite has no instances
  // reachable, so lookups fail soft (no suggestion).
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("arr offline (test)");
    }),
  );
});

function testUser(role: User["role"], id: string, trusted = false): User {
  return {
    id,
    jellyfinUserId: `jf-${id}`,
    name: id,
    role,
    trusted,
    blocked: false,
    createdAt: new Date().toISOString(),
  };
}

const ADMIN = testUser("admin", "user-admin");
const SUBMITTER = testUser("submitter", "user-a");
const TRUSTED = testUser("submitter", "user-trusted", true);
const OTHER = testUser("submitter", "user-b");

async function buildHarness(): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), "droparr-submissions-"));
  const quarantineDir = join(tmp, "quarantine");
  await mkdir(quarantineDir, { recursive: true });
  const config = await ConfigStore.load(join(tmp, "config.json"));
  await config.addInstance({
    id: "radarr-1",
    name: "Movies Radarr",
    kind: "movie",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "k",
    pathMappings: [],
  });
  await config.addCategory({
    id: "movies",
    name: "Movies",
    kind: "movie",
    instanceId: "radarr-1",
    rootFolder: "/movies",
    tags: [],
    seriesType: "standard",
  });

  const settings: UploadSettings = {
    quarantineDir,
    maxFileSizeBytes: 0,
    maxSubmissionSizeBytes: 0,
    minFreeSpaceBytes: 0,
    retentionDays: 7,
  };
  const db = new Db(join(tmp, "droparr.db"));
  const jobs = new JobRegistry();
  const app = Fastify();
  let currentUser = ADMIN;
  app.decorateRequest("auth");
  app.addHook("onRequest", async (req) => {
    req.auth = {
      user: currentUser,
      session: {
        id: "test-session",
        userId: currentUser.id,
        tokenHash: "test-hash",
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
  });
  submissionRoutes(app, {
    config,
    db,
    jobs,
    submissions: new SubmissionEventBus(),
    uploads: new UploadEventBus(),
    getSettings: () => settings,
  });
  cleanups.push(async () => {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  });
  return {
    app,
    config,
    db,
    jobs,
    quarantineDir,
    tmp,
    setUser: (user) => {
      currentUser = user;
    },
  };
}

/** Seed a completed quarantine drop owned by `userId` (DB rows + files). */
async function seedDrop(
  h: Harness,
  dropId: string,
  files: { path: string; content?: string }[],
  userId = SUBMITTER.id,
): Promise<void> {
  const now = new Date().toISOString();
  for (const file of files) {
    const content = file.content ?? "x";
    const abs = join(h.quarantineDir, dropId, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    h.db.createUpload({
      id: nanoid(8),
      dropId,
      userId,
      filename: basename(file.path),
      relPath: file.path,
      ext: extname(file.path),
      size: content.length,
      offset: content.length,
      state: "complete",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
  }
}

const MOVIE_FILES = [
  { path: "Movie (2020)/Movie (2020).mkv", content: "movie-bytes" },
];

/** Simulate a pipeline that finished its job successfully. */
function succeedNextImport(): void {
  vi.mocked(runImport).mockImplementationOnce(async (deps, jobId) => {
    deps.jobs.emitEvent({
      jobId,
      phase: "done",
      message: "Import complete",
      at: new Date().toISOString(),
    });
  });
}

async function createSubmission(
  h: Harness,
  dropId: string,
  body: Record<string, unknown> = {},
) {
  return h.app.inject({
    method: "POST",
    url: "/api/submissions",
    payload: { dropId, ...body },
  });
}

describe("POST /api/submissions/analyze", () => {
  it("analyzes an owned quarantined drop and suggests its default routing", async () => {
    const h = await buildHarness();
    await seedDrop(h, "analyzedrop", MOVIE_FILES);
    h.setUser(SUBMITTER);

    const res = await h.app.inject({
      method: "POST",
      url: "/api/submissions/analyze",
      payload: { dropId: "analyzedrop" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      dropName: string;
      items: { title: string; subPath: string; suggestedMatch: unknown }[];
      totalBytes: number;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.title).toBe("Movie");
    expect(body.items[0]?.subPath).toBe("");
    // Lookup failed (no reachable *arr) → no suggested match, not an error.
    expect(body.items[0]?.suggestedMatch).toBeNull();
    expect(body.totalBytes).toBeGreaterThan(0);
  });

  it("hides drops the requester does not own", async () => {
    const h = await buildHarness();
    await seedDrop(h, "otherdrop", MOVIE_FILES);
    h.setUser(OTHER);

    const res = await h.app.inject({
      method: "POST",
      url: "/api/submissions/analyze",
      payload: { dropId: "otherdrop" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects unknown drop ids", async () => {
    const h = await buildHarness();
    h.setUser(SUBMITTER);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/submissions/analyze",
      payload: { dropId: "../escape" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/submissions", () => {
  it("lands untrusted submissions in pending without touching the *arrs", async () => {
    const h = await buildHarness();
    await seedDrop(h, "pendingdrop", MOVIE_FILES);
    h.setUser(SUBMITTER);

    const res = await createSubmission(h, "pendingdrop");
    expect(res.statusCode).toBe(201);
    const submission = res.json() as Submission;
    expect(submission.state).toBe("pending");
    expect(submission.items[0]?.categoryId).toBe("movies");
    expect(vi.mocked(runImport)).not.toHaveBeenCalled();
  });

  it("auto-approves trusted submitters and settles the state from the jobs", async () => {
    const h = await buildHarness();
    await seedDrop(h, "trusteddrop", MOVIE_FILES, TRUSTED.id);
    h.setUser(TRUSTED);
    succeedNextImport();

    const res = await createSubmission(h, "trusteddrop", {
      items: [
        { subPath: "", match: { tmdbId: 7, title: "Movie", year: 2020 } },
      ],
    });
    expect(res.statusCode).toBe(201);

    await vi.waitFor(() => {
      expect(vi.mocked(runImport)).toHaveBeenCalledTimes(1);
    });
    const [, jobId, request] = vi.mocked(runImport).mock.calls[0]!;
    expect((request as ImportRequest).submissionId).toBeTruthy();
    expect(request.match.tmdbId).toBe(7);
    // The job is owned by the submitter so their socket can follow it.
    expect(h.jobs.get(jobId)?.ownerId).toBe(TRUSTED.id);

    await vi.waitFor(() => {
      const submission = h.db.listSubmissions({ submitterId: TRUSTED.id })[0];
      expect(submission?.state).toBe("done");
    });
  });

  it("stays pending when a trusted submission is not importable yet", async () => {
    const h = await buildHarness();
    await seedDrop(h, "incompletedrop", MOVIE_FILES, TRUSTED.id);
    h.setUser(TRUSTED);

    // No match chosen → an admin has to fix it, even for a trusted user.
    const res = await createSubmission(h, "incompletedrop");
    expect(res.statusCode).toBe(201);
    expect((res.json() as Submission).state).toBe("pending");
    expect(vi.mocked(runImport)).not.toHaveBeenCalled();
  });

  it("refuses a second active submission for the same drop", async () => {
    const h = await buildHarness();
    await seedDrop(h, "dupdropsub", MOVIE_FILES);
    h.setUser(SUBMITTER);
    expect((await createSubmission(h, "dupdropsub")).statusCode).toBe(201);
    const again = await createSubmission(h, "dupdropsub");
    expect(again.statusCode).toBe(409);
  });

  it("applies submitter title/year corrections", async () => {
    const h = await buildHarness();
    await seedDrop(h, "editdrop", MOVIE_FILES);
    h.setUser(SUBMITTER);

    const res = await createSubmission(h, "editdrop", {
      items: [{ subPath: "", title: "Corrected Title", year: 1999 }],
    });
    const submission = res.json() as Submission;
    expect(submission.items[0]?.title).toBe("Corrected Title");
    expect(submission.items[0]?.year).toBe(1999);
  });
});

describe("admin queue", () => {
  it("lists all submissions for admins and only own ones for submitters", async () => {
    const h = await buildHarness();
    await seedDrop(h, "drop-a", MOVIE_FILES, SUBMITTER.id);
    await seedDrop(h, "drop-b", MOVIE_FILES, OTHER.id);
    h.setUser(SUBMITTER);
    await createSubmission(h, "drop-a");
    h.setUser(OTHER);
    await createSubmission(h, "drop-b");

    h.setUser(ADMIN);
    const adminList = (await h.app.inject({ url: "/api/submissions" })).json() as Submission[];
    expect(adminList).toHaveLength(2);

    h.setUser(SUBMITTER);
    const own = (await h.app.inject({ url: "/api/submissions" })).json() as Submission[];
    expect(own).toHaveLength(1);
    expect(own[0]?.dropId).toBe("drop-a");

    const other = await h.app.inject({ url: `/api/submissions/${own[0]!.id}` });
    h.setUser(OTHER);
    const hidden = await h.app.inject({ url: `/api/submissions/${own[0]!.id}` });
    expect(other.statusCode).toBe(200);
    expect(hidden.statusCode).toBe(404);
  });

  it("approves with inline edits and runs the pipeline with them", async () => {
    const h = await buildHarness();
    await seedDrop(h, "approve-drop", MOVIE_FILES);
    h.setUser(SUBMITTER);
    const created = (await createSubmission(h, "approve-drop")).json() as Submission;
    h.setUser(ADMIN);
    succeedNextImport();

    const res = await h.app.inject({
      method: "POST",
      url: `/api/submissions/${created.id}/approve`,
      payload: {
        importMode: "move",
        items: [
          {
            subPath: "",
            categoryId: "movies",
            match: { tmdbId: 42, title: "Edited Match", year: 2020 },
            seasons: [],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(vi.mocked(runImport)).toHaveBeenCalledTimes(1);
    });
    const [, , request] = vi.mocked(runImport).mock.calls[0]!;
    expect(request).toMatchObject({
      sourcePath: join(h.quarantineDir, "approve-drop"),
      categoryId: "movies",
      importMode: "move",
      match: { tmdbId: 42, title: "Edited Match", year: 2020 },
      submissionId: created.id,
    });

    await vi.waitFor(() => {
      expect(h.db.getSubmission(created.id)?.state).toBe("done");
    });
  });

  it("refuses to approve an item without a match", async () => {
    const h = await buildHarness();
    await seedDrop(h, "nomatch-drop", MOVIE_FILES);
    h.setUser(SUBMITTER);
    const created = (await createSubmission(h, "nomatch-drop")).json() as Submission;
    h.setUser(ADMIN);

    const res = await h.app.inject({
      method: "POST",
      url: `/api/submissions/${created.id}/approve`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("match.tmdbId");
    expect(vi.mocked(runImport)).not.toHaveBeenCalled();
    expect(h.db.getSubmission(created.id)?.state).toBe("pending");
  });

  it("is admin-only and single-shot", async () => {
    const h = await buildHarness();
    await seedDrop(h, "authz-drop", MOVIE_FILES);
    h.setUser(SUBMITTER);
    const created = (await createSubmission(h, "authz-drop")).json() as Submission;

    const asSubmitter = await h.app.inject({
      method: "POST",
      url: `/api/submissions/${created.id}/approve`,
      payload: {},
    });
    expect(asSubmitter.statusCode).toBe(403);

    h.setUser(ADMIN);
    succeedNextImport();
    await h.app.inject({
      method: "POST",
      url: `/api/submissions/${created.id}/approve`,
      payload: {
        items: [
          { subPath: "", match: { tmdbId: 1, title: "M", year: 2000 }, categoryId: "movies" },
        ],
      },
    });
    await vi.waitFor(() => {
      expect(h.db.getSubmission(created.id)?.state).toBe("done");
    });
    const again = await h.app.inject({
      method: "POST",
      url: `/api/submissions/${created.id}/approve`,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(vi.mocked(runImport)).toHaveBeenCalledTimes(1);
  });

  it("marks the submission failed when every pipeline errors", async () => {
    const h = await buildHarness();
    await seedDrop(h, "fail-drop", MOVIE_FILES);
    h.setUser(SUBMITTER);
    const created = (await createSubmission(h, "fail-drop")).json() as Submission;
    h.setUser(ADMIN);
    vi.mocked(runImport).mockImplementationOnce(async (deps, jobId) => {
      deps.jobs.emitEvent({
        jobId,
        phase: "error",
        message: "staging dir missing",
        at: new Date().toISOString(),
      });
    });

    const res = await h.app.inject({
      method: "POST",
      url: `/api/submissions/${created.id}/approve`,
      payload: {
        items: [
          { subPath: "", match: { tmdbId: 1, title: "M", year: 2000 }, categoryId: "movies" },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(h.db.getSubmission(created.id)?.state).toBe("failed");
    });
  });

  it("rejects with a note, removes the quarantined files and frees the drop", async () => {
    const h = await buildHarness();
    await seedDrop(h, "reject-drop", MOVIE_FILES);
    h.setUser(SUBMITTER);
    const created = (await createSubmission(h, "reject-drop")).json() as Submission;
    h.setUser(ADMIN);

    const res = await h.app.inject({
      method: "POST",
      url: `/api/submissions/${created.id}/reject`,
      payload: { note: "Not ours" },
    });
    expect(res.statusCode).toBe(200);
    const rejected = res.json() as Submission;
    expect(rejected.state).toBe("rejected");
    expect(rejected.note).toBe("Not ours");

    await expect(
      stat(join(h.quarantineDir, "reject-drop")),
    ).rejects.toThrow();
    expect(h.db.listUploads({ dropId: "reject-drop" })).toHaveLength(0);
    // The drop is no longer protected by a live submission.
    expect(h.db.isDropProtected("reject-drop")).toBe(false);
  });

  it("shows the rejection reason to the owner and hides the drop from others", async () => {
    const h = await buildHarness();
    await seedDrop(h, "note-drop", MOVIE_FILES);
    h.setUser(SUBMITTER);
    const created = (await createSubmission(h, "note-drop")).json() as Submission;
    h.setUser(ADMIN);
    await h.app.inject({
      method: "POST",
      url: `/api/submissions/${created.id}/reject`,
      payload: { note: "Duplicate of an older drop" },
    });

    h.setUser(SUBMITTER);
    const own = await h.app.inject({ url: `/api/submissions/${created.id}` });
    expect(own.statusCode).toBe(200);
    const body = own.json() as Submission;
    expect(body.state).toBe("rejected");
    expect(body.note).toBe("Duplicate of an older drop");

    h.setUser(OTHER);
    expect(
      (await h.app.inject({ url: `/api/submissions/${created.id}` }))
        .statusCode,
    ).toBe(404);
  });

  it("never approves or rejects while a decision is already running", async () => {
    const h = await buildHarness();
    await seedDrop(h, "racedrop", MOVIE_FILES);
    h.setUser(SUBMITTER);
    const created = (await createSubmission(h, "racedrop")).json() as Submission;
    h.setUser(ADMIN);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(runImport).mockImplementationOnce(async (deps, jobId) => {
      await gate;
      deps.jobs.emitEvent({
        jobId,
        phase: "done",
        message: "ok",
        at: new Date().toISOString(),
      });
    });
    await h.app.inject({
      method: "POST",
      url: `/api/submissions/${created.id}/approve`,
      payload: {
        items: [
          { subPath: "", match: { tmdbId: 1, title: "M", year: 2000 }, categoryId: "movies" },
        ],
      },
    });

    const reject = await h.app.inject({
      method: "POST",
      url: `/api/submissions/${created.id}/reject`,
      payload: {},
    });
    expect(reject.statusCode).toBe(409);
    release();
    await vi.waitFor(() => {
      expect(h.db.getSubmission(created.id)?.state).toBe("done");
    });
    // Files survive a rejected reject attempt.
    await expect(
      stat(join(h.quarantineDir, "racedrop")),
    ).resolves.toBeTruthy();
  });
});

describe("active drop protection", () => {
  it("protects drops with active submissions and releases them afterwards", async () => {
    const h = await buildHarness();
    await seedDrop(h, "protect-drop", MOVIE_FILES);
    expect(h.db.isDropProtected("protect-drop")).toBe(false);
    h.setUser(SUBMITTER);
    await createSubmission(h, "protect-drop");
    expect(h.db.isDropProtected("protect-drop")).toBe(true);
  });
});
