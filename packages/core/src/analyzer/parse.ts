/**
 * Filename/folder parsing utilities for media analysis.
 * Pure functions, no I/O — unit-testable.
 */

import {
  extname,
  isSubtitleFileName,
  isVideoFileName,
} from "@droparr/shared";

export { extname };

/** Files that should never be treated as media. */
const JUNK_PATTERNS = [
  /^\._/, // macOS AppleDouble
  /^\.DS_Store$/,
  /\.part$/i,
  /\.!ut$/i,
  /^sample/i,
  /\bsample\b/i,
  /-trailer\./i,
  /\btrailer\b/i,
];

export function isVideoFile(name: string): boolean {
  return isVideoFileName(name);
}

export function isSubtitleFile(name: string): boolean {
  return isSubtitleFileName(name);
}

export function isJunkFile(name: string): boolean {
  return JUNK_PATTERNS.some((p) => p.test(name));
}

export function isMediaFile(name: string): boolean {
  return (isVideoFile(name) || isSubtitleFile(name)) && !isJunkFile(name);
}

/** Release/quality tags stripped when cleaning titles. */
const RELEASE_TAGS = [
  /\b(19|20)\d{2}\b/gi, // year (captured separately)
  /\b[Ss]\d{1,2}(?:[Ee]\d{1,3})?\b/g, // S01 / S01E01 markers
  /[-–—]\s*\d{1,3}(?:v\d)?\b/g, // absolute anime numbering ("Show - 12", "Show - 100v2")
  /\b(1080p|720p|2160p|480p|4k|uhd|hdr|dv|dolby ?vision|sdr)\b/gi,
  /\b(x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|av1|vp9)\b/gi,
  /\b(web[- .]?dl|webrip|bluray|blu[- .]?ray|bdrip|brrip|dvdrip|dvd|hdtv|remux|hdrip|cam|telesync|ts|tc)\b/gi,
  /\b(aac|ac3|eac3|dd5\.?1|dts(-hd)?|truehd|atmos|flac|mp3|opus)\b/gi,
  /\b(5\.1|7\.1|2\.0)\b/g,
  /\b(10 ?bit|8 ?bit)\b/gi,
  /\b(proper|repack|extended|unrated|remastered|uncut|directors? ?cut)\b/gi,
  /\b(multi|dual ?audio|subbed|dubbed)\b/gi,
  /\bREPACK\b/gi,
  /\[[^\]]*\]/g, // [Group] / [1080p] style brackets
  /\([^)]*\)/g, // (2020) style parens, handled via year extraction first
];

const MEDIA_EXTS = new Set([
  ".mkv",
  ".mp4",
  ".avi",
  ".mov",
  ".m4v",
  ".wmv",
  ".flv",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts",
  ".webm",
  ".srt",
  ".ass",
  ".ssa",
  ".sub",
  ".idx",
  ".vtt",
]);

/**
 * Extract a year (1900–2099) from a name, if present.
 */
export function extractYear(name: string): number | undefined {
  const matches = [...name.matchAll(/\b(19|20)\d{2}\b/g)];
  if (matches.length === 0) return undefined;
  // Prefer the last match — usually the release year in "Title (2020) 1080p".
  const raw = matches[matches.length - 1][0];
  const year = Number(raw);
  if (year < 1900 || year > 2099) return undefined;
  return year;
}

/**
 * Strip release tags and separators, leaving a human-ish title.
 */
export function cleanTitle(name: string): string {
  let t = name;
  // Strip a real media extension first (before dot-separators get replaced).
  const ext = extname(t);
  if (ext && MEDIA_EXTS.has(ext)) {
    t = t.slice(0, -ext.length);
  }
  for (const pattern of RELEASE_TAGS) {
    t = t.replace(pattern, " ");
  }
  // Normalize dots/underscores/hyphens used as separators
  t = t.replace(/[._]/g, " ");
  t = t.replace(/\s*-\s*/g, " - ");
  // Collapse whitespace and trim stray leading/trailing separators
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/^[\s\-–—]+|[\s\-–—]+$/g, "");
  return t;
}

export interface ParsedEpisode {
  season: number;
  episodes: number[];
}

/**
 * Parse SxxExx (also 1x01) style numbering.
 * Returns season + episode list; multi-episode files ("S01E01E02") supported.
 */
export function parseSxxExx(name: string): ParsedEpisode | undefined {
  // Multi-episode: S01E01E02 or S01E01-E02
  const multi = name.match(/[Ss](\d{1,2})[Ee](\d{1,3})(?:[-.]?[Ee](\d{1,3}))+/);
  if (multi) {
    const season = Number(multi[1]);
    const eps = [...name.matchAll(/[Ee](\d{1,3})/g)].map((m) => Number(m[1]));
    return { season, episodes: [...new Set(eps)].sort((a, b) => a - b) };
  }
  const single = name.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
  if (single) {
    return { season: Number(single[1]), episodes: [Number(single[2])] };
  }
  return undefined;
}

/**
 * Parse 1x01 style numbering (season x episode).
 */
export function parse1x01(name: string): ParsedEpisode | undefined {
  const m = name.match(/\b(\d{1,2})x(\d{1,3})\b/);
  if (!m) return undefined;
  return { season: Number(m[1]), episodes: [Number(m[2])] };
}

/**
 * Parse absolute episode numbering used by anime: "Show - 01", "[Group] Show - 12v2 (1080p)".
 * Requires a separator and a small number to reduce false positives (years, resolutions).
 */
export function parseAbsolute(name: string): number | undefined {
  const m = name.match(/[-–—]\s*(\d{1,3})(?:v\d)?(?:\s|$|\.|\[|\()/);
  if (!m) return undefined;
  const n = Number(m[1]);
  // Exclude years and likely resolution/format numbers
  if (n >= 1900 && n <= 2099) return undefined;
  return n;
}

/**
 * Parse a "Season 2" / "S02" / "Series 2" folder name.
 */
export function parseSeasonFolder(name: string): number | undefined {
  const m = name.match(/\b(?:season|s|series)\s*(\d{1,2})\b/i);
  if (m) return Number(m[1]);
  const spec = name.match(/\bspecials?\b/i);
  if (spec) return 0;
  return undefined;
}
