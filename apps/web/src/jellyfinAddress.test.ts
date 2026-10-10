import { describe, expect, it } from "vitest";
import { jellyfinBaseUrlSchema } from "@droparr/shared";
import {
  composeJellyfinUrl,
  isValidJellyfinHostFields,
  isValidJellyfinPort,
  isValidJellyfinUrl,
  normalizeJellyfinUrl,
  splitJellyfinUrl,
} from "./jellyfinAddress.js";

describe("composeJellyfinUrl", () => {
  it("composes host and port over http", () => {
    expect(
      composeJellyfinUrl({ host: "saturday.local", port: "8096", https: false }),
    ).toBe("http://saturday.local:8096");
  });

  it("composes https and omits an empty port", () => {
    expect(
      composeJellyfinUrl({ host: "media.example.com", port: "", https: true }),
    ).toBe("https://media.example.com");
  });

  it("trims the host and port", () => {
    expect(
      composeJellyfinUrl({ host: "  jellyfin ", port: " 8096 ", https: false }),
    ).toBe("http://jellyfin:8096");
  });

  it("brackets bare IPv6 hosts but leaves bracketed ones alone", () => {
    expect(
      composeJellyfinUrl({ host: "::1", port: "8096", https: false }),
    ).toBe("http://[::1]:8096");
    expect(
      composeJellyfinUrl({ host: "[::1]", port: "8096", https: false }),
    ).toBe("http://[::1]:8096");
  });

  it("returns empty while the host is empty", () => {
    expect(composeJellyfinUrl({ host: " ", port: "8096", https: false })).toBe(
      "",
    );
  });
});

describe("splitJellyfinUrl", () => {
  it("splits http and https values into host/port/SSL", () => {
    expect(splitJellyfinUrl("http://saturday.local:8096")).toEqual({
      host: "saturday.local",
      port: "8096",
      https: false,
    });
    expect(splitJellyfinUrl("https://media.example.com:8920")).toEqual({
      host: "media.example.com",
      port: "8920",
      https: true,
    });
  });

  it("round-trips URLs through split and compose", () => {
    for (const url of [
      "http://saturday.local:8096",
      "https://media.example.com:8920",
      "https://media.example.com",
      "http://jellyfin",
      "http://[::1]:8096",
      "http://192.168.1.10:8096",
    ]) {
      expect(composeJellyfinUrl(splitJellyfinUrl(url)!)).toBe(url);
    }
  });

  it("keeps no-port URLs portless and tolerates a trailing slash", () => {
    expect(splitJellyfinUrl("https://jellyfin.example.com")).toEqual({
      host: "jellyfin.example.com",
      port: "",
      https: true,
    });
    expect(splitJellyfinUrl("http://saturday.local:8096/")).toEqual({
      host: "saturday.local",
      port: "8096",
      https: false,
    });
  });

  it("falls back for URLs the fields cannot represent", () => {
    expect(splitJellyfinUrl("http://host:8096/jellyfin")).toBeNull();
    expect(splitJellyfinUrl("http://host:8096/?a=1")).toBeNull();
    expect(splitJellyfinUrl("http://host:8096/#section")).toBeNull();
    expect(splitJellyfinUrl("http://user:pass@host:8096")).toBeNull();
    expect(splitJellyfinUrl("ftp://host:8096")).toBeNull();
    expect(splitJellyfinUrl("not a url")).toBeNull();
    expect(splitJellyfinUrl("")).toBeNull();
  });
});

describe("isValidJellyfinPort", () => {
  it("accepts empty (scheme default) and 1–65535", () => {
    expect(isValidJellyfinPort("")).toBe(true);
    expect(isValidJellyfinPort("8096")).toBe(true);
    expect(isValidJellyfinPort("1")).toBe(true);
    expect(isValidJellyfinPort("65535")).toBe(true);
  });

  it("rejects zero, out-of-range, and non-numeric values", () => {
    expect(isValidJellyfinPort("0")).toBe(false);
    expect(isValidJellyfinPort("65536")).toBe(false);
    expect(isValidJellyfinPort("80a")).toBe(false);
    expect(isValidJellyfinPort("-1")).toBe(false);
    expect(isValidJellyfinPort("8096.5")).toBe(false);
  });
});

describe("isValidJellyfinHostFields", () => {
  it("accepts a host with an explicit or default port", () => {
    expect(
      isValidJellyfinHostFields({
        host: "saturday.local",
        port: "8096",
        https: false,
      }),
    ).toBe(true);
    expect(
      isValidJellyfinHostFields({
        host: "jellyfin.example.com",
        port: "",
        https: true,
      }),
    ).toBe(true);
    expect(
      isValidJellyfinHostFields({ host: "::1", port: "8096", https: false }),
    ).toBe(true);
  });

  it("rejects empty hosts, bad ports and hosts with slashes", () => {
    expect(
      isValidJellyfinHostFields({ host: " ", port: "8096", https: false }),
    ).toBe(false);
    expect(
      isValidJellyfinHostFields({ host: "host", port: "99999", https: false }),
    ).toBe(false);
    expect(
      isValidJellyfinHostFields({
        host: "host/path",
        port: "8096",
        https: false,
      }),
    ).toBe(false);
  });

  it("composes addresses the server schema accepts", () => {
    for (const fields of [
      { host: "saturday.local", port: "8096", https: false },
      { host: "media.example.com", port: "", https: true },
      { host: "192.168.1.10", port: "8096", https: false },
    ]) {
      expect(composeJellyfinUrl(fields)).not.toBe("");
      expect(jellyfinBaseUrlSchema.safeParse(composeJellyfinUrl(fields)).success).toBe(
        true,
      );
    }
  });
});

describe("isValidJellyfinUrl", () => {
  it("accepts full http(s) URLs, including subpaths", () => {
    expect(isValidJellyfinUrl("http://192.168.1.10:8096")).toBe(true);
    expect(isValidJellyfinUrl("https://jellyfin.example.com/jellyfin")).toBe(
      true,
    );
    expect(isValidJellyfinUrl(" http://host:8096 ")).toBe(true);
  });

  it("rejects junk and non-http(s) values", () => {
    expect(isValidJellyfinUrl("")).toBe(false);
    expect(isValidJellyfinUrl("jellyfin")).toBe(false);
    expect(isValidJellyfinUrl("ftp://host")).toBe(false);
    expect(isValidJellyfinUrl("http://")).toBe(false);
  });
});

describe("normalizeJellyfinUrl", () => {
  it("trims and drops trailing slashes", () => {
    expect(normalizeJellyfinUrl(" http://host:8096/ ")).toBe("http://host:8096");
    expect(normalizeJellyfinUrl("http://host:8096")).toBe("http://host:8096");
    expect(normalizeJellyfinUrl("")).toBe("");
  });
});
