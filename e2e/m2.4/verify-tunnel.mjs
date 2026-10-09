#!/usr/bin/env node
// M2.4 verification bench — checks a live Droparr deployment through its
// Cloudflare Tunnel public hostname (issue #8).
//
// Usage:
//   cp e2e/m2.4/local.env.example e2e/m2.4/local.env   # fill in
//   node --env-file=e2e/m2.4/local.env e2e/m2.4/verify-tunnel.mjs
//
// Node >= 22, no dependencies. Anonymous checks always run; login, session,
// oversized-chunk and WebSocket checks need DROPARR_USERNAME/PASSWORD.
// Set RATE_LIMIT_CHECK=1 to also prove the login limiter keys on the real
// client IP — see e2e/m2.4/README.md for the caveat.

const BASE = (process.env.DROPARR_URL ?? "").replace(/\/+$/, "");
if (!BASE) {
  console.error("Missing DROPARR_URL — copy e2e/m2.4/local.env.example to local.env");
  process.exit(2);
}
if (!BASE.startsWith("https://")) {
  console.error(`DROPARR_URL must be the public https:// tunnel URL (got ${BASE})`);
  process.exit(2);
}

const USERNAME = process.env.DROPARR_USERNAME;
const PASSWORD = process.env.DROPARR_PASSWORD;
const RATE_LIMIT_CHECK = process.env.RATE_LIMIT_CHECK === "1";

const accessHeaders = {};
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  accessHeaders["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  accessHeaders["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
}

const results = [];
let cookie = "";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function api(path, { method = "GET", headers = {}, body } = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: { accept: "application/json", ...accessHeaders, ...headers },
    body,
    // Never follow redirects: an Access challenge would otherwise turn into
    // an HTML login page and produce confusing parse errors.
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") ?? "";
    if (location.includes("cloudflareaccess.com") || location.includes("/cdn-cgi/access")) {
      throw new Error(
        `Cloudflare Access challenged this request (${res.status}) — ` +
          "set CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET to a service token",
      );
    }
  }
  return res;
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, status: "pass", detail });
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "fail", detail });
    console.log(`❌ ${name} — ${detail}`);
  }
}

function skip(name, reason) {
  results.push({ name, status: "skip", detail: reason });
  console.log(`⏭  ${name} — ${reason}`);
}

/** Loopback/RFC1918/link-local/CGNAT: an origin-side address, not a visitor. */
function isPrivateIp(ip) {
  const v = ip.replace(/^::ffff:/i, "");
  if (v === "::1" || /^f[cd]/i.test(v) || /^fe80:/i.test(v)) return true;
  const parts = v.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false; // a public IPv6 address
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

console.log(`\n=== Droparr M2.4 tunnel verification — ${BASE} ===\n`);

await check("API health is reachable and Cache-Control: no-store", async () => {
  const res = await api("/api/health");
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.ok === true, "body.ok is not true");
  const cache = res.headers.get("cache-control");
  assert(cache === "no-store", `cache-control: ${cache}`);
  return "200, cache-control: no-store";
});

await check("Auth status is also no-store", async () => {
  const res = await api("/api/auth/status");
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const cache = res.headers.get("cache-control");
  assert(cache === "no-store", `cache-control: ${cache}`);
  return "200, cache-control: no-store";
});

await check("Web UI is served over the tunnel", async () => {
  const res = await api("/");
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  assert(type.includes("text/html"), `content-type: ${type}`);
  return "200 text/html";
});

let loggedIn = false;
if (USERNAME && PASSWORD) {
  await check("Login sets Secure + HttpOnly + SameSite=Lax cookie", async () => {
    const res = await api("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    assert(
      res.status === 200,
      `login failed: ${res.status} ${await res.text()}`,
    );
    const rawCookies = res.headers.getSetCookie?.() ?? [
      res.headers.get("set-cookie") ?? "",
    ];
    const raw = rawCookies.find((c) => c.startsWith("droparr_session="));
    assert(raw, "no droparr_session cookie in the response");
    for (const flag of ["HttpOnly", "SameSite=Lax", "Path=/", "Secure"]) {
      assert(raw.includes(flag), `missing ${flag} in: ${raw}`);
    }
    cookie = raw.split(";")[0];
    loggedIn = true;
    return "HttpOnly, SameSite=Lax, Path=/, Secure";
  });

  if (loggedIn) {
    await check("Sessions record the public visitor IP", async () => {
      const res = await api("/api/auth/sessions", { headers: { cookie } });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const sessions = await res.json();
      const current = sessions.find((s) => s.current);
      assert(current, "no current session in the list");
      assert(
        current.ip && !isPrivateIp(current.ip),
        `session ip is origin-side, not the visitor: ${current.ip}`,
      );
      return `ip=${current.ip}`;
    });

    await check("Oversized chunk gets Droparr's JSON 413, not a Cloudflare page", async () => {
      const metadata = `filename ${Buffer.from("tunnel-check.mkv").toString("base64")}`;
      const create = await api("/api/uploads", {
        method: "POST",
        headers: {
          cookie,
          "tus-resumable": "1.0.0",
          "upload-length": "1",
          "upload-metadata": metadata,
        },
      });
      assert(
        create.status === 201,
        `upload creation failed: ${create.status} ${await create.text()}`,
      );
      const location = create.headers.get("location");
      assert(location, "no Location header on creation");
      try {
        // 2 bytes against a declared Upload-Length of 1: the server's own
        // size guard must answer 413 before any 100 MB edge limit matters.
        const patch = await api(location, {
          method: "PATCH",
          headers: {
            cookie,
            "tus-resumable": "1.0.0",
            "upload-offset": "0",
            "content-type": "application/offset+octet-stream",
          },
          body: "xx",
        });
        assert(patch.status === 413, `expected 413, got ${patch.status}`);
        const type = patch.headers.get("content-type") ?? "";
        assert(
          type.includes("application/json"),
          `413 is not JSON (${type}) — likely Cloudflare's HTML page`,
        );
        const body = await patch.json();
        assert(typeof body.error === "string", "413 body has no error field");
        return `413 ${JSON.stringify(body.error)}`;
      } finally {
        await api(location, {
          method: "DELETE",
          headers: { cookie, "tus-resumable": "1.0.0" },
        }).catch(() => {});
      }
    });
  }
} else {
  skip(
    "Login sets Secure + HttpOnly + SameSite=Lax cookie",
    "set DROPARR_USERNAME/DROPARR_PASSWORD",
  );
  skip("Sessions record the public visitor IP", "needs a login");
  skip("Oversized chunk gets Droparr's JSON 413, not a Cloudflare page", "needs a login");
}

await check("WebSocket upgrade reaches Droparr (unauth closes 4401)", async () => {
  const wsUrl = `${BASE.replace(/^https:/, "wss:")}/api/ws`;
  const code = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timed out waiting for the socket to close"));
    }, 10_000);
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      resolve(ev.code);
    });
    ws.addEventListener("error", () => {
      // A close event follows; the timeout guards against silence.
    });
  });
  assert(code === 4401, `expected close code 4401, got ${code}`);
  return "closed 4401";
});

if (RATE_LIMIT_CHECK) {
  await check(
    "Login limiter keys on the real client IP (consumes this IP's budget)",
    async () => {
      let limited = false;
      for (let i = 0; i < 25 && !limited; i++) {
        const res = await api("/api/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Rotated like an attacker would; Cloudflare appends the real
            // visitor IP, so only a CF-Connecting-IP-keyed limiter answers 429.
            "x-forwarded-for": `198.51.100.${i}`,
          },
          body: JSON.stringify({ username: `tunnel-check-${i}`, password: "wrong" }),
        });
        if (res.status === 429) limited = true;
      }
      assert(
        limited,
        "no 429 after 25 attempts with rotated X-Forwarded-For — the limiter may be keying on the spoofable header",
      );
      return "429 after rotated X-Forwarded-For";
    },
  );
} else {
  skip(
    "Login limiter keys on the real client IP",
    "set RATE_LIMIT_CHECK=1 (consumes this IP's budget)",
  );
}

// Best-effort cleanup: drop the session the bench created.
if (loggedIn) {
  await api("/api/auth/logout", { method: "POST", headers: { cookie } }).catch(() => {});
}

const failed = results.filter((r) => r.status === "fail");
const passed = results.filter((r) => r.status === "pass").length;
const skipped = results.filter((r) => r.status === "skip").length;
console.log(`\n${passed} passed, ${failed.length} failed, ${skipped} skipped`);
if (failed.length > 0) {
  console.log("\nFailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
