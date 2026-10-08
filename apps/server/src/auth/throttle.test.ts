import { describe, expect, it } from "vitest";
import { Db } from "../db.js";
import { LoginThrottle } from "./throttle.js";

function makeClock(start = "2026-01-01T00:00:00.000Z") {
  let current = new Date(start);
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

function makeThrottle(clock: ReturnType<typeof makeClock>) {
  const db = new Db(":memory:");
  return new LoginThrottle(db, {
    maxFailures: 3,
    windowMs: 60_000,
    lockMs: 300_000,
    now: clock.now,
  });
}

describe("LoginThrottle", () => {
  it("is not locked before any failures", () => {
    const throttle = makeThrottle(makeClock());
    expect(throttle.check("admin")).toEqual({
      locked: false,
      retryAfterSeconds: 0,
    });
  });

  it("locks after maxFailures and reports retry-after", () => {
    const clock = makeClock();
    const throttle = makeThrottle(clock);
    throttle.recordFailure("admin");
    throttle.recordFailure("admin");
    expect(throttle.check("admin").locked).toBe(false);

    throttle.recordFailure("admin");
    const state = throttle.check("admin");
    expect(state.locked).toBe(true);
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(state.retryAfterSeconds).toBeLessThanOrEqual(300);
  });

  it("releases the lock after it expires and starts a fresh window", () => {
    const clock = makeClock();
    const throttle = makeThrottle(clock);
    for (let i = 0; i < 3; i++) throttle.recordFailure("admin");
    expect(throttle.check("admin").locked).toBe(true);

    clock.advance(300_001);
    expect(throttle.check("admin").locked).toBe(false);
    // Fresh window: one failure does not lock.
    throttle.recordFailure("admin");
    expect(throttle.check("admin").locked).toBe(false);
  });

  it("forgets failures older than the window", () => {
    const clock = makeClock();
    const throttle = makeThrottle(clock);
    throttle.recordFailure("admin");
    throttle.recordFailure("admin");

    clock.advance(60_001);
    throttle.recordFailure("admin");
    expect(throttle.check("admin").locked).toBe(false);
  });

  it("clears failures on success", () => {
    const clock = makeClock();
    const throttle = makeThrottle(clock);
    throttle.recordFailure("admin");
    throttle.recordFailure("admin");
    throttle.recordSuccess("admin");

    throttle.recordFailure("admin");
    expect(throttle.check("admin").locked).toBe(false);
  });

  it("normalizes usernames and keeps counters isolated", () => {
    const throttle = makeThrottle(makeClock());
    throttle.recordFailure("Alice");
    throttle.recordFailure(" alice ");
    expect(throttle.check("ALICE").locked).toBe(false);

    throttle.recordFailure("Alice");
    expect(throttle.check("alice").locked).toBe(true);
    expect(throttle.check("bob").locked).toBe(false);
  });
});
