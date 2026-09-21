/**
 * The retry-decision math (`src/adapters/luma-retry.ts`) — pure, so tested without timers or a
 * stubbed `fetch`. Policy source: docs/libraries/luma-vitest-railway.md §1.5 (ADR 0016).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  RETRY_HARD_CEILING_MS,
  backoffDelayMs,
  isRetryableStatus,
  millisUntilRateLimitReset,
  parseRetryAfterSeconds,
} from "../../src/adapters/luma-retry.js";

const H = (init: Record<string, string> = {}): Headers => new Headers(init);

const base = {
  baseMs: 1_000,
  maxDelayMs: 30_000,
  now: 1_000_000,
  random: () => 0, // no jitter unless a test asks for it
};

describe("isRetryableStatus", () => {
  it.each([429, 502, 503])("%d is retryable", (s) =>
    expect(isRetryableStatus(s)).toBe(true),
  );
  it.each([200, 201, 400, 401, 402, 403, 404, 413, 422, 500])(
    "%d is not retryable",
    (s) => expect(isRetryableStatus(s)).toBe(false),
  );
});

describe("parseRetryAfterSeconds", () => {
  it("reads the integer-seconds form", () => {
    expect(parseRetryAfterSeconds(H({ "retry-after": "60" }))).toBe(60);
    expect(parseRetryAfterSeconds(H({ "retry-after": "  7 " }))).toBe(7);
  });
  it("returns null for a missing, negative, or non-numeric value", () => {
    expect(parseRetryAfterSeconds(H())).toBeNull();
    expect(parseRetryAfterSeconds(H({ "retry-after": "-5" }))).toBeNull();
    expect(parseRetryAfterSeconds(H({ "retry-after": "soon" }))).toBeNull();
    expect(
      parseRetryAfterSeconds(
        H({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
      ),
    ).toBeNull();
  });
});

describe("millisUntilRateLimitReset", () => {
  it("converts a future epoch-seconds reset into a positive delta", () => {
    expect(
      millisUntilRateLimitReset(H({ "x-ratelimit-reset": "1005" }), 1_000_000),
    ).toBe(5_000); // 1005s -> 1_005_000ms, now 1_000_000ms
  });
  it("returns null when the reset is missing or already past", () => {
    expect(millisUntilRateLimitReset(H(), 1_000_000)).toBeNull();
    expect(
      millisUntilRateLimitReset(H({ "x-ratelimit-reset": "999" }), 1_000_000),
    ).toBeNull();
  });
});

describe("backoffDelayMs", () => {
  it("is exponential in the attempt with no headers (base * 2^attempt)", () => {
    const d = (attempt: number) =>
      backoffDelayMs({ ...base, attempt, headers: H() });
    expect([d(0), d(1), d(2), d(3)]).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("caps the exponential branch at maxDelayMs", () => {
    // 1000 * 2^10 = 1_024_000, well over the 30_000 cap.
    expect(backoffDelayMs({ ...base, attempt: 10, headers: H() })).toBe(30_000);
  });

  it("adds 0-999ms of jitter, never a full second", () => {
    expect(
      backoffDelayMs({
        ...base,
        attempt: 0,
        headers: H(),
        random: () => 0.999999,
      }),
    ).toBe(1_999); // 1000 + floor(0.999999 * 1000)
  });

  it("honours Retry-After (seconds) over the exponential schedule", () => {
    expect(
      backoffDelayMs({
        ...base,
        attempt: 0, // exponential would be 1_000
        headers: H({ "retry-after": "7" }),
      }),
    ).toBe(7_000);
  });

  it("falls back to X-RateLimit-Reset when there is no Retry-After", () => {
    expect(
      backoffDelayMs({
        ...base,
        attempt: 0,
        now: 1_000_000,
        headers: H({ "x-ratelimit-reset": "1004" }), // 4s out
      }),
    ).toBe(4_000);
  });

  it("falls back to exponential when Retry-After is malformed", () => {
    expect(
      backoffDelayMs({
        ...base,
        attempt: 2,
        headers: H({ "retry-after": "later" }),
      }),
    ).toBe(4_000);
  });

  it("clamps a pathological Retry-After to the hard ceiling", () => {
    expect(
      backoffDelayMs({
        ...base,
        attempt: 0,
        headers: H({ "retry-after": "86400" }), // a day
      }),
    ).toBe(RETRY_HARD_CEILING_MS);
  });

  it("property: the delay is always in [0, ceiling + jitter] for any attempt / headers", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.option(fc.integer({ min: -10, max: 100_000 }), { nil: undefined }),
        fc.double({ min: 0, max: 0.9999999, noNaN: true }),
        (attempt, retryAfter, rnd) => {
          const headers =
            retryAfter === undefined
              ? H()
              : H({ "retry-after": String(retryAfter) });
          const d = backoffDelayMs({
            ...base,
            attempt,
            headers,
            random: () => rnd,
          });
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(RETRY_HARD_CEILING_MS + 1_000);
        },
      ),
    );
  });
});
