import { describe, expect, it } from "vitest";
import type { Category } from "@droparr/shared";
import { pickDefaultCategory } from "./pickCategory.js";

function category(overrides: Partial<Category>): Category {
  return {
    id: "c1",
    name: "Category",
    kind: "series",
    instanceId: "i1",
    rootFolder: "/tv",
    tags: [],
    seriesType: "standard",
    ...overrides,
  };
}

const tv = category({ id: "tv", name: "TV", seriesType: "standard" });
const anime = category({ id: "anime", name: "Anime", seriesType: "anime" });
const movies = category({ id: "movies", name: "Movies", kind: "movie" });

describe("pickDefaultCategory", () => {
  it("preselects the anime category for absolute-numbered drops", () => {
    const picked = pickDefaultCategory([tv, anime], {
      kind: "series",
      seriesType: "anime",
    });
    expect(picked?.id).toBe("anime");
  });

  it("preselects the standard category for SxxExx drops", () => {
    const picked = pickDefaultCategory([anime, tv], {
      kind: "series",
      seriesType: "standard",
    });
    expect(picked?.id).toBe("tv");
  });

  it("treats a missing seriesType as standard", () => {
    const picked = pickDefaultCategory([anime, tv], { kind: "series" });
    expect(picked?.id).toBe("tv");
  });

  it("falls back to the first eligible category when nothing matches", () => {
    const picked = pickDefaultCategory([anime], {
      kind: "series",
      seriesType: "standard",
    });
    expect(picked?.id).toBe("anime");
  });

  it("ignores seriesType for movies", () => {
    const picked = pickDefaultCategory([tv, movies], { kind: "movie" });
    expect(picked?.id).toBe("movies");
  });

  it("returns undefined when no category is eligible", () => {
    expect(pickDefaultCategory([movies], { kind: "series" })).toBeUndefined();
    expect(pickDefaultCategory([], { kind: "movie" })).toBeUndefined();
  });
});
