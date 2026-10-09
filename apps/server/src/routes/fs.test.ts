import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
