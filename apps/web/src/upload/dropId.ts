/**
 * Drop-id generation that also works in insecure contexts.
 *
 * `crypto.randomUUID` is secure-context-only: over plain HTTP on a LAN host it
 * is `undefined`, which crashed the upload panel on first render. Web Crypto's
 * `getRandomValues` is available in insecure contexts, so prefer it and fall
 * back to `Math.random` only when there is no Web Crypto at all.
 */

export interface RandomSource {
  getRandomValues?(array: Uint8Array): Uint8Array;
}

/** Lowercase hex string of the requested length. */
export function randomHex(
  length: number,
  source: RandomSource | undefined = globalThis.crypto,
): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  if (source && typeof source.getRandomValues === "function") {
    source.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex.slice(0, length);
}

/** 16-char drop id (the same shape the UUID-derived ids had). */
export function newDropId(): string {
  return randomHex(16);
}
