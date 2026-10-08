/**
 * TUS `Upload-Metadata` header parsing.
 *
 * Format: `key base64value,key2 base64value2` — values are optional and
 * base64-encoded; keys are case-insensitive and lowercased here.
 */
export function parseUploadMetadata(
  header: string | string[] | undefined,
): Record<string, string> {
  const raw = Array.isArray(header) ? header.join(",") : header;
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const spaceAt = trimmed.indexOf(" ");
    const key =
      spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
    if (!key) continue;
    const encoded = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1).trim();
    if (!encoded) {
      out[key.toLowerCase()] = "";
      continue;
    }
    try {
      out[key.toLowerCase()] = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      out[key.toLowerCase()] = "";
    }
  }
  return out;
}
