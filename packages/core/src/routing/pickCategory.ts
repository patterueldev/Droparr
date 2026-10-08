import type { Category, FolderAnalysis } from "@droparr/shared";

/**
 * Pick the category to preselect in the review UI.
 *
 * Heuristics preselect the category; the review screen always allows an
 * override. For series, a drop detected as anime-style (absolute numbering)
 * prefers an `anime` category and a standard drop prefers a `standard` one,
 * so a drop can't be routed to the wrong Sonarr by accident.
 */
export function pickDefaultCategory(
  categories: Category[],
  analysis: Pick<FolderAnalysis, "kind" | "seriesType">,
): Category | undefined {
  const eligible = categories.filter((c) => c.kind === analysis.kind);
  if (eligible.length === 0) return undefined;

  if (analysis.kind === "series") {
    const detected = analysis.seriesType ?? "standard";
    const preferred = eligible.find((c) => c.seriesType === detected);
    if (preferred) return preferred;
  }

  return eligible[0];
}
