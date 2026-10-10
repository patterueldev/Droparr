import Fastify, { type FastifyInstance } from "fastify";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fsRoutes } from "./fs.js";

// Analyze hands back one reviewable item per movie when a drop fans out.
describe("POST /api/analyze", () => {
  const originalRoots = process.env.DROPARR_BROWSE_ROOTS;
  const cleanups: (() => Promise<void>)[] = [];
  let app: FastifyInstance;

  beforeAll(async () => {
    // Browse-root restrictions are read when the routes are registered.
    delete process.env.DROPARR_BROWSE_ROOTS;
    app = Fastify();
    fsRoutes(app, {});
  });

  afterAll(async () => {
    if (originalRoots !== undefined) {
      process.env.DROPARR_BROWSE_ROOTS = originalRoots;
    }
    await app.close();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  async function makeDrop(layout: Record<string, string>): Promise<string> {
    const tmp = await mkdtemp(join(tmpdir(), "droparr-fs-"));
    cleanups.push(async () => {
      await rm(tmp, { recursive: true, force: true });
    });
    for (const [rel, name] of Object.entries(layout)) {
      await mkdir(join(tmp, rel), { recursive: true });
      await writeFile(join(tmp, rel, name), Buffer.alloc(32, 1));
    }
    return tmp;
  }

  it("fans an acceptance-shaped multi-movie drop into two items", async () => {
    const tmp = await makeDrop({
      "A (2001)": "A.mkv",
      "B (2004)": "B.mkv",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { path: tmp },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sourcePath: string;
      analysis: { kind: string; confidence: string };
      items: {
        title: string;
        year?: number;
        subPath: string;
        sourcePath: string;
      }[];
    };
    expect(body.analysis.kind).toBe("movie");
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.subPath)).toEqual(["A (2001)", "B (2004)"]);
    expect(body.items[0]).toMatchObject({
      title: "A",
      year: 2001,
      sourcePath: join(tmp, "A (2001)"),
    });
    expect(body.items[1].sourcePath).toBe(join(tmp, "B (2004)"));
  });

  it("keeps a single movie folder a single item pointed at the drop root", async () => {
    const tmp = await makeDrop({ "The Matrix (1999)": "The.Matrix.mkv" });

    const res = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: { path: tmp },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { subPath: string; sourcePath: string }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].subPath).toBe("");
    expect(body.items[0].sourcePath).toBe(tmp);
  });
});

// The staging/import path pickers type-ahead against the container's own
// filesystem.
describe("GET /api/fs/suggest", () => {
  const originalRoots = process.env.DROPARR_BROWSE_ROOTS;
  const cleanups: (() => Promise<void>)[] = [];
  let app: FastifyInstance;

  beforeAll(() => {
    delete process.env.DROPARR_BROWSE_ROOTS;
    app = Fastify();
    fsRoutes(app, {});
  });

  afterAll(async () => {
    if (originalRoots !== undefined) {
      process.env.DROPARR_BROWSE_ROOTS = originalRoots;
    }
    await app.close();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  /** A directory tree: `"dir"` entries become folders, anything else a file. */
  async function makeTree(layout: Record<string, "dir" | "file">): Promise<string> {
    const tmp = await mkdtemp(join(tmpdir(), "droparr-suggest-"));
    cleanups.push(async () => {
      await rm(tmp, { recursive: true, force: true });
    });
    for (const [rel, kind] of Object.entries(layout)) {
      if (kind === "dir") await mkdir(join(tmp, rel), { recursive: true });
      else await writeFile(join(tmp, rel), Buffer.alloc(8, 1));
    }
    return tmp;
  }

  const suggest = (p: string) =>
    app.inject({
      method: "GET",
      url: `/api/fs/suggest?path=${encodeURIComponent(p)}`,
    });

  it("prefix-matches subdirectories of the partial's parent", async () => {
    const tmp = await makeTree({
      data: "dir",
      download: "dir",
      "data/staging": "dir",
      ".hidden": "dir",
      notes: "file",
    });

    const res = await suggest(join(tmp, "da"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dir: tmp, matches: [join(tmp, "data")] });
  });

  it("matches deeper segments under the parent", async () => {
    const tmp = await makeTree({
      "data/staging": "dir",
      "data/media": "dir",
      "data/My Shows": "dir",
    });

    const res = await suggest(join(tmp, "data/st"));
    expect(res.json()).toEqual({
      dir: join(tmp, "data"),
      matches: [join(tmp, "data/staging")],
    });

    // Spaces survive the query encoding.
    const spaced = await suggest(join(tmp, "data/My"));
    expect(spaced.json()).toEqual({
      dir: join(tmp, "data"),
      matches: [join(tmp, "data/My Shows")],
    });
  });

  it("lists an existing directory's children, or all for a trailing slash", async () => {
    const tmp = await makeTree({
      data: "dir",
      "data/staging": "dir",
      "data/media": "dir",
    });

    const exact = await suggest(join(tmp, "data"));
    expect(exact.json()).toEqual({
      dir: join(tmp, "data"),
      matches: [join(tmp, "data/media"), join(tmp, "data/staging")],
    });

    const trailing = await suggest(`${tmp}/`);
    expect(trailing.json()).toEqual({ dir: tmp, matches: [join(tmp, "data")] });
  });

  it("hides dot-directories and files", async () => {
    const tmp = await makeTree({ data: "dir", ".hidden": "dir", notes: "file" });

    expect((await suggest(`${tmp}/`)).json()).toEqual({
      dir: tmp,
      matches: [join(tmp, "data")],
    });
    expect((await suggest(join(tmp, "note"))).json()).toEqual({
      dir: tmp,
      matches: [],
    });
  });

  it("suggests nothing for missing directories instead of erroring", async () => {
    const tmp = await makeTree({ data: "dir" });

    const res = await suggest(join(tmp, "nope", "deeper"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dir: join(tmp, "nope"), matches: [] });
  });

  it("suggests nothing when the parent is unreadable", async () => {
    const tmp = await makeTree({ secret: "dir" });
    const secret = join(tmp, "secret");
    await chmod(secret, 0o000);
    // Restore permissions first so cleanup can remove the tree (LIFO).
    cleanups.push(async () => {
      await chmod(secret, 0o755).catch(() => {});
    });

    const res = await suggest(join(secret, "x"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dir: secret, matches: [] });
  });

  it("rejects relative and missing paths", async () => {
    expect((await suggest("data/staging")).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/fs/suggest" })).statusCode).toBe(400);
  });
});

// Browse roots gate every suggestion — including the folders walked through
// on the way down to a root.
describe("GET /api/fs/suggest with DROPARR_BROWSE_ROOTS", () => {
  const originalRoots = process.env.DROPARR_BROWSE_ROOTS;
  let app: FastifyInstance;
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "droparr-roots-"));
    await mkdir(join(tmp, "data/staging"), { recursive: true });
    await mkdir(join(tmp, "outside/tv"), { recursive: true });
    process.env.DROPARR_BROWSE_ROOTS = join(tmp, "data");
    app = Fastify();
    fsRoutes(app, {});
  });

  afterAll(async () => {
    if (originalRoots === undefined) {
      delete process.env.DROPARR_BROWSE_ROOTS;
    } else {
      process.env.DROPARR_BROWSE_ROOTS = originalRoots;
    }
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const suggest = (p: string) =>
    app.inject({
      method: "GET",
      url: `/api/fs/suggest?path=${encodeURIComponent(p)}`,
    });

  it("suggests inside the root and steps on the way down to it", async () => {
    expect((await suggest(join(tmp, "da"))).json()).toEqual({
      dir: tmp,
      matches: [join(tmp, "data")],
    });
    expect((await suggest(join(tmp, "data/st"))).json()).toEqual({
      dir: join(tmp, "data"),
      matches: [join(tmp, "data/staging")],
    });
  });

  it("never reveals directories outside the roots", async () => {
    expect((await suggest(join(tmp, "ou"))).json()).toEqual({
      dir: tmp,
      matches: [],
    });
    expect((await suggest(`${tmp}/`)).json()).toEqual({
      dir: tmp,
      matches: [join(tmp, "data")],
    });
    expect((await suggest(join(tmp, "outside/tv"))).json()).toEqual({
      dir: join(tmp, "outside/tv"),
      matches: [],
    });
  });
});
