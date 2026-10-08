import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  extractYear,
  parse1x01,
  parseAbsolute,
  parseSxxExx,
} from "./parse.js";
import { analyzeFolder, analyzeDrop, dropRootName } from "./analyze.js";

describe("cleanTitle", () => {
  it("strips release tags and separators from folder names", () => {
    expect(cleanTitle("The.Matrix.1999.1080p.BluRay.x265")).toBe("The Matrix");
    expect(
      cleanTitle("Breaking Bad S01 1080p WEB-DL DD5.1 H.264"),
    ).toBe("Breaking Bad");
    expect(cleanTitle("[SubsPlease] Frieren - 12 (1080p)")).toContain(
      "Frieren",
    );
  });

  it("handles brackets and parens", () => {
    expect(cleanTitle("[Group] Show Title [1080p]")).toBe("Show Title");
    expect(cleanTitle("Some Movie (2019) [Remux]")).toBe("Some Movie");
  });
});

describe("extractYear", () => {
  it("finds release years", () => {
    expect(extractYear("The.Matrix.1999.1080p")).toBe(1999);
    expect(extractYear("Dune Part Two (2024) 2160p")).toBe(2024);
  });

  it("returns undefined when no year", () => {
    expect(extractYear("Some.Show.S01E01.1080p")).toBeUndefined();
  });

  it("prefers the last year match", () => {
    expect(extractYear("Blade Runner 2049 2017 1080p")).toBe(2017);
  });
});

describe("parseSxxExx", () => {
  it("parses standard numbering", () => {
    expect(parseSxxExx("S01E05.mkv")).toEqual({ season: 1, episodes: [5] });
    expect(parseSxxExx("Show.S02E12.1080p.WEB-DL.mkv")).toEqual({
      season: 2,
      episodes: [12],
    });
  });

  it("parses multi-episode files", () => {
    expect(parseSxxExx("Show.S01E01E02.mkv")).toEqual({
      season: 1,
      episodes: [1, 2],
    });
    expect(parseSxxExx("Show.S01E03-E04.mkv")).toEqual({
      season: 1,
      episodes: [3, 4],
    });
  });

  it("handles lowercase and dots", () => {
    expect(parseSxxExx("show.s01e07.mkv")).toEqual({ season: 1, episodes: [7] });
  });
});

describe("parse1x01", () => {
  it("parses 1x01 style", () => {
    expect(parse1x01("Show 1x05.mkv")).toEqual({ season: 1, episodes: [5] });
    expect(parse1x01("Show 3x12.mkv")).toEqual({ season: 3, episodes: [12] });
  });

  it("does not confuse resolution or years", () => {
    expect(parse1x01("Movie 2019 1080p.mkv")).toBeUndefined();
  });
});

describe("parseAbsolute", () => {
  it("parses anime absolute numbering", () => {
    expect(parseAbsolute("[SubsPlease] Frieren - 12 (1080p).mkv")).toBe(12);
    expect(parseAbsolute("Show - 100v2.mkv")).toBe(100);
  });

  it("rejects years", () => {
    expect(parseAbsolute("Movie 2019 - 1080p.mkv")).toBeUndefined();
  });
});

describe("dropRootName", () => {
  it("finds the common top folder", () => {
    expect(
      dropRootName(["Show/Season 1/S01E01.mkv", "Show/Season 1/S01E02.mkv"]),
    ).toBe("Show");
  });

  it("returns file name for root-level files", () => {
    expect(dropRootName(["movie.mkv"])).toBe("movie.mkv");
  });
});

describe("analyzeFolder", () => {
  it("detects a standard series from SxxExx files", () => {
    const result = analyzeFolder({
      files: [
        "Breaking Bad S01 1080p/S01E01.mkv",
        "Breaking Bad S01 1080p/S01E02.mkv",
        "Breaking Bad S01 1080p/S01E03.mkv",
      ],
    });
    expect(result.kind).toBe("series");
    expect(result.seriesType).toBe("standard");
    expect(result.title).toBe("Breaking Bad");
    expect(result.episodeNumbers).toEqual([1, 2, 3]);
  });

  it("detects anime from absolute numbering", () => {
    const result = analyzeFolder({
      files: [
        "[SubsPlease] Frieren - 01 (1080p).mkv",
        "[SubsPlease] Frieren - 02 (1080p).mkv",
        "[SubsPlease] Frieren - 03 (1080p).mkv",
      ],
    });
    expect(result.kind).toBe("series");
    expect(result.seriesType).toBe("anime");
    expect(result.confidence).toBe("high");
  });

  it("detects a movie with a year", () => {
    const result = analyzeFolder({
      files: ["The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x265.mkv"],
    });
    expect(result.kind).toBe("movie");
    expect(result.year).toBe(1999);
    expect(result.confidence).toBe("high");
  });

  it("flags a single absolute-numbered file as low confidence", () => {
    const result = analyzeFolder({
      files: ["[Group] Something - 05 (1080p).mkv"],
    });
    expect(result.kind).toBe("series");
    expect(result.confidence).toBe("low");
  });

  it("ignores junk files", () => {
    const result = analyzeFolder({
      files: [
        "Movie (2020)/Movie.2020.mkv",
        "Movie (2020)/._Movie.2020.mkv",
        "Movie (2020)/Movie.2020.srt",
        "Movie (2020)/sample.mkv",
      ],
    });
    expect(result.files).toHaveLength(2); // video + subtitle
  });

  it("handles multi-season drops", () => {
    const result = analyzeFolder({
      files: [
        "Show/Season 1/S01E01.mkv",
        "Show/Season 2/S02E01.mkv",
      ],
    });
    expect(result.kind).toBe("series");
    expect(result.season).toBeUndefined(); // ambiguous — multiple seasons
    expect(result.episodeNumbers).toEqual([1]);
  });
});

describe("analyzeDrop", () => {
  it("fans out sibling movie folders into one item each (issue #17)", () => {
    const { analysis, items } = analyzeDrop({
      files: ["A (2001)/A.mkv", "B (2004)/B.mkv"],
    });

    // The whole drop still reports its ambiguous single-item analysis…
    expect(analysis.kind).toBe("movie");
    expect(analysis.confidence).toBe("low");

    // …but the reviewable items are the two movies.
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.subPath)).toEqual(["A (2001)", "B (2004)"]);
    expect(items[0]).toMatchObject({
      kind: "movie",
      title: "A",
      year: 2001,
      confidence: "high",
    });
    expect(items[1]).toMatchObject({
      kind: "movie",
      title: "B",
      year: 2004,
      confidence: "high",
    });
    expect(items[0].files.map((f) => f.path)).toEqual(["A (2001)/A.mkv"]);
    expect(items[0].reasoning[0]).toContain("item 1 of 2");
    expect(analysis.reasoning.join(" ")).toContain("Fanned out into 2 items");
  });

  it("keeps episode-patterned drops a single item", () => {
    const { items } = analyzeDrop({
      files: ["Show S01/S01E01.mkv", "Show S02/S02E01.mkv"],
    });
    expect(items).toHaveLength(1);
    expect(items[0].subPath).toBe("");
    expect(items[0].kind).toBe("series");
  });

  it("keeps a mixed drop single when any folder has episode patterns", () => {
    const { items } = analyzeDrop({
      files: ["A (2001)/a.mkv", "B (2004)/S01E01.mkv"],
    });
    expect(items).toHaveLength(1);
    expect(items[0].subPath).toBe("");
  });

  it("does not fan out a single movie folder with sidecars", () => {
    const { items } = analyzeDrop({
      files: [
        "The Matrix (1999)/The.Matrix.1999.mkv",
        "The Matrix (1999)/The.Matrix.1999.srt",
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].subPath).toBe("");
    expect(items[0]).toMatchObject({ kind: "movie", title: "The Matrix" });
  });

  it("never turns extras or split-media folders into items", () => {
    const disc = analyzeDrop({
      files: ["Disc1/movie.mkv", "Disc2/movie.mkv"],
    });
    expect(disc.items).toHaveLength(1);

    const withExtras = analyzeDrop({
      files: [
        "A (2001)/a.mkv",
        "B (2004)/b.mkv",
        "Extras/making-of.mkv",
      ],
    });
    expect(withExtras.items).toHaveLength(2);
    expect(withExtras.items.some((i) => i.subPath === "Extras")).toBe(false);
    expect(withExtras.analysis.reasoning.join(" ")).toContain("Extras");
  });

  it("adds loose root files as an extra item", () => {
    const { items } = analyzeDrop({
      files: [
        "A (2001)/a.mkv",
        "B (2004)/b.mkv",
        "C (2010).mkv",
        "C (2010).srt",
      ],
    });
    expect(items).toHaveLength(3);
    const loose = items[2];
    expect(loose.subPath).toBe("");
    expect(loose.title).toBe("C");
    expect(loose.year).toBe(2010);
    expect(loose.files.map((f) => f.path)).toEqual([
      "C (2010).mkv",
      "C (2010).srt",
    ]);
    expect(loose.reasoning[0]).toContain("item 3 of 3");
  });

  it("keeps the single-item flow when there is only one folder", () => {
    const { items } = analyzeDrop({
      files: ["A (2001)/a.mkv", "loose (2010).mkv"],
    });
    expect(items).toHaveLength(1);
    expect(items[0].subPath).toBe("");
  });
});
