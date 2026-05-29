import { test, expect, describe } from "bun:test";

import {
  MIN_POLL_SECONDS,
  normalizePollSeconds,
  shouldKeepPolling,
} from "../src/lib/claim-policy";

describe("normalizePollSeconds (E3 / F5 — --poll 0 spin-loop guard)", () => {
  test("clamps a zero interval up to the 100ms floor", () => {
    expect(normalizePollSeconds(0)).toBe(MIN_POLL_SECONDS);
  });

  test("clamps a negative interval up to the floor", () => {
    expect(normalizePollSeconds(-5)).toBe(MIN_POLL_SECONDS);
  });

  test("clamps a sub-floor interval (50ms) up to the floor", () => {
    expect(normalizePollSeconds(0.05)).toBe(MIN_POLL_SECONDS);
  });

  test("leaves an interval at or above the floor untouched", () => {
    expect(normalizePollSeconds(0.1)).toBe(0.1);
    expect(normalizePollSeconds(1)).toBe(1);
    expect(normalizePollSeconds(30)).toBe(30);
  });

  test("the floor is exactly 100ms", () => {
    expect(MIN_POLL_SECONDS).toBe(0.1);
  });
});

describe("shouldKeepPolling (E4 / F4 — deadline early-fire guard)", () => {
  test("no --wait (null): never polls — single attempt only", () => {
    expect(shouldKeepPolling({ waitSeconds: null, attempts: 1, now: 0, deadline: 0 })).toBe(false);
  });

  test("--wait 0: never polls — single attempt only (preserves test 2 contract)", () => {
    expect(shouldKeepPolling({ waitSeconds: 0, attempts: 1, now: 0, deadline: 0 })).toBe(false);
  });

  test("--wait > 0: guarantees at least one poll even if the first attempt blew past the deadline", () => {
    // Slow first attempt: clock is already well past the deadline, but we have
    // not polled even once. F4: must still poll once.
    expect(
      shouldKeepPolling({ waitSeconds: 3, attempts: 1, now: 10_000, deadline: 5_000 }),
    ).toBe(true);
  });

  test("--wait > 0: stops once the deadline passes AND at least one poll has happened", () => {
    expect(
      shouldKeepPolling({ waitSeconds: 3, attempts: 2, now: 10_000, deadline: 5_000 }),
    ).toBe(false);
  });

  test("--wait > 0: keeps polling while still within the deadline", () => {
    expect(
      shouldKeepPolling({ waitSeconds: 3, attempts: 5, now: 4_000, deadline: 5_000 }),
    ).toBe(true);
  });
});
