import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  extractYear,
  parse1x01,
  parseAbsolute,
  parseSxxExx,
} from "./parse.js";
import { analyzeFolder, dropRootName } from "./analyze.js";

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
