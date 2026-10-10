import { afterEach, describe, expect, it, vi } from "vitest";
import { newDropId, randomHex } from "./dropId.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("randomHex", () => {
  it("hex-encodes the requested number of chars", () => {
    const source = { getRandomValues: (array: Uint8Array) => array.fill(0xab) };
    expect(randomHex(16, source)).toBe("abababababababab");
    // Odd lengths are sliced down to size.
    expect(randomHex(15, source)).toBe("abababababababa");
  });

  it("falls back to Math.random when the source has no getRandomValues", () => {
    vi.spyOn(Math, "random").mockReturnValue(15 / 256); // -> 0x0f
    expect(randomHex(4, {})).toBe("0f0f");
  });

  it("falls back to Math.random when there is no Web Crypto at all", () => {
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Math, "random").mockReturnValue(255 / 256); // -> 0xff
    expect(newDropId()).toBe("ffffffffffffffff");
  });
});

describe("newDropId", () => {
  it("works when crypto.randomUUID is absent (insecure context)", () => {
    // Plain HTTP puts the page in an insecure context: `crypto` exists with
    // `getRandomValues` but `randomUUID` is undefined entirely. The old
    // implementation called `crypto.randomUUID()` unconditionally and threw.
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => {
        for (let i = 0; i < array.length; i += 1) array[i] = i + 1;
        return array;
      },
    });
    expect(newDropId()).toBe("0102030405060708");
  });

  it("keeps ids unique", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newDropId()));
    expect(ids.size).toBe(1000);
  });
});
