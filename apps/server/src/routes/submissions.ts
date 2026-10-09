import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { basename, extname, join, resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import {
  analyzeDrop,
  pickDefaultCategory,
  RadarrClient,
  SonarrClient,
  type DropAnalysis,
} from "@droparr/core";
import {
  requiresApproval,
  submissionStateSchema,
  type Category,
  type FileRef,
  type FolderAnalysisItem,
  type Instance,
  type MatchSelection,
  type Submission,
  type SubmissionItem,
  type SubmissionState,
  type User,
} from "@droparr/shared";
import type { ConfigStore } from "../config/store.js";
import type { Db } from "../db.js";
import type { JobRegistry } from "../jobs.js";
import { runImport, type ImportRequest } from "../import/runner.js";
import { removeDrop } from "../uploads/cleanup.js";
import type { UploadEventBus } from "../uploads/events.js";
import { sanitizeDropId } from "../uploads/paths.js";
import type { UploadSettings } from "../uploads/settings.js";
import { walkMediaFiles } from "../fs/walk.js";
import type { SubmissionEventBus } from "../submissions/events.js";

const matchSchema = z.object({
  tvdbId: z.number().int().positive().optional(),
  tmdbId: z.number().int().positive().optional(),
  title: z.string().min(1),
  year: z.number().int().optional(),
  extra: z.record(z.unknown()).optional(),
});

/** Per-item review override; items are keyed by `subPath`. */
const itemPatchSchema = z.object({
  subPath: z.string(),
  include: z.boolean().optional(),
  title: z.string().min(1).optional(),
  year: z.number().int().nullable().optional(),
  categoryId: z.string().min(1).optional(),
  match: matchSchema.nullable().optional(),
  seasons: z.array(z.number().int().nonnegative()).optional(),
});

const createSchema = z.object({
  dropId: z.string().min(1),
  importMode: z.enum(["move", "copy"]).default("copy"),
  items: z.array(itemPatchSchema).max(100).optional(),
});

const analyzeSchema = z.object({
  dropId: z.string().min(1),
  /** When set, the lookup runs with this term instead of per-item guesses. */
  term: z.string().max(200).optional(),
});

const editSchema = z.object({
  items: z.array(itemPatchSchema).max(100).optional(),
  importMode: z.enum(["move", "copy"]).optional(),
});

const rejectSchema = z.object({
  note: z.string().max(2000).optional(),
});

type ItemPatch = z.infer<typeof itemPatchSchema>;

export interface SubmissionDeps {
  config: ConfigStore;
  db: Db;
  jobs: JobRegistry;
  submissions: SubmissionEventBus;
  uploads: UploadEventBus;
  getSettings: () => UploadSettings;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

/** A fanned-out analysis item with its absolute import path attached. */
interface DroppedItem extends FolderAnalysisItem {
  sourcePath: string;
}

function requireUser(req: FastifyRequest, reply: FastifyReply): User | undefined {
  if (!req.auth) {
    reply.code(401).send({ error: "Authentication required" });
    return undefined;
  }
  return req.auth.user;
}

/** Returns true when the request may proceed; sends the error reply itself. */
function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const user = requireUser(req, reply);
  if (!user) return false;
  if (user.role !== "admin") {
    reply.code(403).send({ error: "Admin access required" });
    return false;
  }
  return true;
}

function isStrictlyInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c !== p && c.startsWith(p + sep);
}

/**
 * Resolve a client-supplied drop id to its quarantine directory. The id is
 * sanitized and the result asserted to sit strictly inside the quarantine
 * dir — submitters never supply a path directly.
 */
function resolveQuarantineDrop(
  settings: UploadSettings,
  dropIdRaw: string,
): { dropId: string; dir: string } | { error: string } {
  const dropId = sanitizeDropId(dropIdRaw);
  if (!dropId) return { error: "Invalid drop id" };
  const root = resolve(settings.quarantineDir);
  const dir = resolve(root, dropId);
  if (!isStrictlyInside(root, dir)) return { error: "Invalid drop id" };
  return { dropId, dir };
}

/**
 * Best-effort display name for a quarantine drop: its single top folder when
 * the files arrived inside one, else the first file's basename without the
 * extension (the quarantine dir itself is named after the random drop id).
 */
function dropNameFromFiles(fallback: string, files: FileRef[]): string {
  const paths = files.map((f) => f.path);
  const tops = new Set(
    paths.filter((p) => p.includes("/")).map((p) => p.split("/")[0]),
  );
  if (tops.size === 1) return [...tops][0] ?? fallback;
  const first = paths[0];
  if (first) {
    const base = basename(first);
    const ext = extname(base);
    const name = ext ? base.slice(0, -ext.length) : base;
    if (name) return name;
  }
  return fallback;
}

interface AnalyzedDrop {
  analysis: DropAnalysis["analysis"];
  items: DroppedItem[];
  totalBytes: number;
  skipped: string[];
  dropName: string;
}

/** Walk + analyze a quarantine drop; analysis paths stay drop-relative. */
async function analyzeDropDir(
  dir: string,
  fallbackName: string,
): Promise<AnalyzedDrop | { error: string }> {
  const walked = await walkMediaFiles(dir);
  if (walked.files.length === 0) {
    return { error: "No media files found in this folder" };
  }
  const dropName = dropNameFromFiles(fallbackName, walked.files);
  const drop = analyzeDrop({
    files: walked.files.map((f) => f.path),
    sizes: Object.fromEntries(walked.files.map((f) => [f.path, f.size])),
    dropName,
  });
  return {
    analysis: drop.analysis,
    items: drop.items.map((item) => ({
      ...item,
      sourcePath: item.subPath ? join(dir, item.subPath) : dir,
    })),
    totalBytes: walked.totalBytes,
    skipped: walked.skipped,
    dropName,
  };
}

/** Fresh submission item: analysis + a routing suggestion, nothing chosen yet. */
function baseItem(item: DroppedItem, categories: Category[]): SubmissionItem {
  const category = pickDefaultCategory(categories, item);
  return {
    subPath: item.subPath,
    sourcePath: item.sourcePath,
    analysis: {
      kind: item.kind,
      title: item.title,
      year: item.year,
      seriesType: item.seriesType,
      season: item.season,
      episodeNumbers: item.episodeNumbers,
      files: item.files,
      confidence: item.confidence,
      reasoning: item.reasoning,
      subPath: item.subPath,
    },
    title: item.title,
    year: item.year,
    categoryId: category?.id,
    match: null,
    seasons:
      item.kind === "series"
        ? item.season !== undefined
          ? [item.season]
          : item.episodeNumbers && item.episodeNumbers.length > 0
            ? [1]
            : []
        : undefined,
    include: true,
  };
}

/** Apply per-item review overrides (keyed by subPath) over stored items. */
function mergeItems(base: SubmissionItem[], patches?: ItemPatch[]): SubmissionItem[] {
  if (!patches || patches.length === 0) return base;
  const byPath = new Map(patches.map((p) => [p.subPath, p]));
  return base.map((item) => {
    const patch = byPath.get(item.subPath);
    if (!patch) return item;
    const next: SubmissionItem = { ...item };
    if (patch.include !== undefined) next.include = patch.include;
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.year !== undefined) {
      next.year = patch.year === null ? undefined : patch.year;
    }
    if (patch.categoryId !== undefined) next.categoryId = patch.categoryId;
    if (patch.match !== undefined) next.match = patch.match;
    if (patch.seasons !== undefined) next.seasons = patch.seasons;
    return next;
  });
}

/** Validate the importable items exactly like POST /api/import does. */
function validateImportItems(
  deps: SubmissionDeps,
  submission: Pick<Submission, "items">,
): string | undefined {
  const included = submission.items.filter((i) => i.include);
  if (included.length === 0) return "No items selected for import";
  for (const [i, item] of submission.items.entries()) {
    if (!item.include) continue;
    if (!item.categoryId) return `items[${i}]: Category not assigned`;
    const category = deps.config.getCategory(item.categoryId);
    if (!category) return `items[${i}]: Category not found`;
    const instance = deps.config.getInstance(category.instanceId);
    if (!instance) return `items[${i}]: Instance not found`;
    if (instance.kind === "series" && !item.match?.tvdbId) {
      return `items[${i}]: Series imports require match.tvdbId`;
    }
    if (instance.kind === "movie" && !item.match?.tmdbId) {
      return `items[${i}]: Movie imports require match.tmdbId`;
    }
  }
  return undefined;
}

/** One pipeline request per included item, mirroring the review UI. */
function importRequestFor(
  submission: Submission,
  item: SubmissionItem,
): ImportRequest {
  const fanned = submission.items.length > 1;
  return {
    sourcePath: item.sourcePath,
    categoryId: item.categoryId!,
    match: {
      tvdbId: item.match?.tvdbId,
      tmdbId: item.match?.tmdbId,
      title: item.match?.title ?? item.title,
      year: item.match?.year ?? item.year,
      extra: item.match?.extra,
    },
    seasons: item.seasons,
    importMode: submission.importMode,
    // Loose files at a shared drop root: import only this item's files, not
    // every sibling folder that sits under the same sourcePath.
    files:
      fanned && item.subPath === ""
        ? item.analysis.files.map((f) => f.path)
        : undefined,
    submissionId: submission.id,
  };
}

/**
 * Run the M1 import pipeline for every included item, then settle the
 * submission. Partial success (≥ 1 item imported) stays `done`; only a run
 * where every pipeline errored is `failed`.
 */
async function runApproval(
  deps: SubmissionDeps,
  submission: Submission,
): Promise<void> {
  const included = submission.items.filter((i) => i.include);
  const jobIds = included.map(() => nanoid(12));
  // Owner-scoped so the submitter's socket can follow their own import.
  for (const id of jobIds) deps.jobs.create(id, submission.submitterId);
  deps.db.updateSubmission(submission.id, { jobIds, state: "importing" });
  deps.submissions.emitSubmission({
    submissionId: submission.id,
    submitterId: submission.submitterId,
    state: "importing",
  });

  let imported = 0;
  try {
    for (const [i, item] of included.entries()) {
      await runImport(deps, jobIds[i], importRequestFor(submission, item));
      const last = deps.jobs.get(jobIds[i])?.events.at(-1);
      if (last?.phase === "done") imported++;
    }
  } catch (err) {
    deps.log?.warn(
      { err, submissionId: submission.id },
      "submission import crashed",
    );
  }

  const state: SubmissionState = imported > 0 ? "done" : "failed";
  deps.db.updateSubmission(submission.id, {
    state,
    completedAt: new Date().toISOString(),
  });
  deps.submissions.emitSubmission({
    submissionId: submission.id,
    submitterId: submission.submitterId,
    state,
  });
}

function lookupClient(instance: Instance): SonarrClient | RadarrClient {
  return instance.kind === "series"
    ? new SonarrClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey })
    : new RadarrClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });
}

/** Raw instance lookup; failures read as "no suggestions", never an error. */
async function lookupRaw(
  instance: Instance,
  term: string,
): Promise<Record<string, unknown>[]> {
  try {
    const results = await lookupClient(instance).lookup(term);
    return results as unknown as Record<string, unknown>[];
  } catch {
    return [];
  }
}

/** Normalize one raw lookup record, dropping hits without the right id. */
function toMatchSelection(
  kind: "series" | "movie",
  raw: Record<string, unknown>,
): MatchSelection | undefined {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const id = kind === "series" ? raw.tvdbId : raw.tmdbId;
  if (!title || typeof id !== "number") return undefined;
  return {
    tvdbId: kind === "series" ? id : undefined,
    tmdbId: kind === "movie" ? id : undefined,
    title,
    year: typeof raw.year === "number" ? raw.year : undefined,
    extra: raw,
  };
}

/** Best-effort suggested match per item, through each item's default category. */
async function suggestMatches(
  deps: SubmissionDeps,
  items: DroppedItem[],
): Promise<(MatchSelection | undefined)[]> {
  const categories = deps.config.get().categories;
  return Promise.all(
    items.map(async (item) => {
      const category = pickDefaultCategory(categories, item);
      const instance = category
        ? deps.config.getInstance(category.instanceId)
        : undefined;
      if (!instance) return undefined;
      const term = `${item.title}${item.year ? ` ${item.year}` : ""}`.trim();
      const results = await lookupRaw(instance, term);
      for (const raw of results) {
        const match = toMatchSelection(item.kind, raw);
        if (match) return match;
      }
      return undefined;
    }),
  );
}

/** Attach the submitter's display name for the queue list / detail. */
function withSubmitterName(db: Db, submission: Submission): Submission {
  return {
    ...submission,
    submitterName: db.getUser(submission.submitterId)?.name,
  };
}

export function submissionRoutes(
  app: FastifyInstance,
  deps: SubmissionDeps,
): void {
  /**
   * Analyze an uploaded (quarantined) drop and suggest a match per item.
   * The path is resolved from the drop id server-side; submitters can never
   * point the analyzer at arbitrary paths.
   */
  app.post("/api/submissions/analyze", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = analyzeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const resolvedDrop = resolveQuarantineDrop(
      deps.getSettings(),
      parsed.data.dropId,
    );
    if ("error" in resolvedDrop) {
      return reply.code(400).send({ error: resolvedDrop.error });
    }
    const { dropId, dir } = resolvedDrop;
    if (user.role !== "admin" && !deps.db.dropOwnedBy(dropId, user.id)) {
      return reply.code(404).send({ error: "Drop not found" });
    }
    const st = await stat(dir).catch(() => undefined);
    if (!st?.isDirectory()) {
      return reply.code(404).send({ error: "Drop not found" });
    }

    const analyzed = await analyzeDropDir(dir, dropId);
    if ("error" in analyzed) {
      return reply.code(422).send({ error: analyzed.error });
    }

    let results: Record<string, unknown>[] = [];
    let suggestions: (MatchSelection | undefined)[];
    if (parsed.data.term) {
      // "Search again" mode: one lookup with the typed term through the
      // default category's instance; item guesses are skipped.
      suggestions = [];
      const category = pickDefaultCategory(
        deps.config.get().categories,
        analyzed.analysis,
      );
      const instance = category
        ? deps.config.getInstance(category.instanceId)
        : undefined;
      if (instance) results = await lookupRaw(instance, parsed.data.term);
    } else {
      suggestions = await suggestMatches(deps, analyzed.items);
    }

    return {
      sourcePath: dir,
      dropName: analyzed.dropName,
      analysis: analyzed.analysis,
      items: analyzed.items.map((item, i) => ({
        ...item,
        suggestedMatch: suggestions[i] ?? null,
      })),
      totalBytes: analyzed.totalBytes,
      skipped: analyzed.skipped,
      ...(parsed.data.term ? { results } : {}),
    };
  });

  /**
   * Create a submission from an uploaded drop. Trusted users (and admins)
   * run the pipeline immediately; everyone else lands in the pending queue.
   */
  app.post("/api/submissions", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const resolvedDrop = resolveQuarantineDrop(
      deps.getSettings(),
      parsed.data.dropId,
    );
    if ("error" in resolvedDrop) {
      return reply.code(400).send({ error: resolvedDrop.error });
    }
    const { dropId, dir } = resolvedDrop;
    if (user.role !== "admin" && !deps.db.dropOwnedBy(dropId, user.id)) {
      return reply.code(404).send({ error: "Drop not found" });
    }
    if (deps.db.findActiveSubmissionByDrop(dropId)) {
      return reply.code(409).send({
        error: "This drop already has a submission awaiting a decision",
      });
    }
    const st = await stat(dir).catch(() => undefined);
    if (!st?.isDirectory()) {
      return reply.code(404).send({ error: "Drop not found" });
    }

    const analyzed = await analyzeDropDir(dir, dropId);
    if ("error" in analyzed) {
      return reply.code(422).send({ error: analyzed.error });
    }
    const categories = deps.config.get().categories;
    const items = mergeItems(
      analyzed.items.map((item) => baseItem(item, categories)),
      parsed.data.items,
    );

    const now = new Date().toISOString();
    const submission: Submission = {
      id: nanoid(12),
      submitterId: user.id,
      state: "pending",
      dropId,
      dropName: analyzed.dropName,
      sourcePath: dir,
      items,
      importMode: parsed.data.importMode,
      createdAt: now,
      updatedAt: now,
    };

    // Trusted submitters and admins skip the queue — but only when the review
    // is complete enough to actually import; otherwise an admin fixes it.
    const autoApprove =
      !requiresApproval(user) &&
      validateImportItems(deps, submission) === undefined;
    if (autoApprove) submission.state = "approved";

    deps.db.createSubmission(submission);
    deps.submissions.emitSubmission({
      submissionId: submission.id,
      submitterId: submission.submitterId,
      state: submission.state,
    });

    if (autoApprove) {
      void runApproval(deps, submission);
    }
    return reply
      .code(201)
      .send(withSubmitterName(deps.db, deps.db.getSubmission(submission.id)!));
  });

  /** Admin: every submission (newest first, optional state filter). */
  app.get<{ Querystring: { state?: string } }>(
    "/api/submissions",
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return;
      let state: SubmissionState | undefined;
      if (req.query.state) {
        const parsed = submissionStateSchema.safeParse(req.query.state);
        if (!parsed.success) {
          return reply.code(400).send({ error: "Unknown state" });
        }
        state = parsed.data;
      }
      const list = deps.db
        .listSubmissions(
          user.role === "admin"
            ? { state }
            : { state, submitterId: user.id },
        )
        .map((s) => withSubmitterName(deps.db, s));
      return list;
    },
  );

  /** Owner or admin: one submission. */
  app.get<{ Params: { id: string } }>(
    "/api/submissions/:id",
    async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) return;
      const submission = deps.db.getSubmission(req.params.id);
      if (
        !submission ||
        (user.role !== "admin" && submission.submitterId !== user.id)
      ) {
        return reply.code(404).send({ error: "Submission not found" });
      }
      return withSubmitterName(deps.db, submission);
    },
  );

  /** Admin: inline edits (match, category, seasons, import mode) while pending. */
  app.patch<{ Params: { id: string } }>(
    "/api/submissions/:id",
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const parsed = editSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const submission = deps.db.getSubmission(req.params.id);
      if (!submission) {
        return reply.code(404).send({ error: "Submission not found" });
      }
      if (submission.state !== "pending") {
        return reply.code(409).send({
          error: `Submission is ${submission.state}; only pending ones can be edited`,
        });
      }
      const updated = deps.db.updateSubmission(submission.id, {
        items: mergeItems(submission.items, parsed.data.items),
        importMode: parsed.data.importMode ?? submission.importMode,
      });
      return withSubmitterName(deps.db, updated!);
    },
  );

  /** Admin: approve (optionally with the latest edits) and run the pipeline. */
  app.post<{ Params: { id: string } }>(
    "/api/submissions/:id/approve",
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const parsed = editSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const submission = deps.db.getSubmission(req.params.id);
      if (!submission) {
        return reply.code(404).send({ error: "Submission not found" });
      }
      if (submission.state !== "pending") {
        return reply.code(409).send({
          error: `Submission is ${submission.state}; only pending ones can be approved`,
        });
      }
      const next: Submission = {
        ...submission,
        items: mergeItems(submission.items, parsed.data.items),
        importMode: parsed.data.importMode ?? submission.importMode,
      };
      const invalid = validateImportItems(deps, next);
      if (invalid) return reply.code(400).send({ error: invalid });

      deps.db.updateSubmission(submission.id, {
        items: next.items,
        importMode: next.importMode,
        state: "approved",
      });
      deps.submissions.emitSubmission({
        submissionId: submission.id,
        submitterId: submission.submitterId,
        state: "approved",
      });

      void runApproval(deps, next);
      return reply
        .code(202)
        .send(withSubmitterName(deps.db, deps.db.getSubmission(submission.id)!));
    },
  );

  /** Admin: reject with an optional note; quarantined files are removed. */
  app.post<{ Params: { id: string } }>(
    "/api/submissions/:id/reject",
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const parsed = rejectSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const submission = deps.db.getSubmission(req.params.id);
      if (!submission) {
        return reply.code(404).send({ error: "Submission not found" });
      }
      if (submission.state !== "pending") {
        return reply.code(409).send({
          error: `Submission is ${submission.state}; only pending ones can be rejected`,
        });
      }
      const updated = deps.db.updateSubmission(submission.id, {
        state: "rejected",
        note: parsed.data.note,
        completedAt: new Date().toISOString(),
      });
      deps.submissions.emitSubmission({
        submissionId: submission.id,
        submitterId: submission.submitterId,
        state: "rejected",
      });

      // Quarantine cleanup per policy: the drop is no longer protected by an
      // active submission, so a failure here is only logged — the sweep will
      // remove what is left.
      try {
        await removeDrop(
          { db: deps.db, events: deps.uploads, getSettings: deps.getSettings },
          submission.dropId,
        );
      } catch (err) {
        deps.log?.warn(
          { err, submissionId: submission.id, dropId: submission.dropId },
          "reject could not remove the quarantine drop",
        );
      }
      return withSubmitterName(deps.db, updated!);
    },
  );
}
