/**
 * Retry-decision math for `LumaGenerationClient` — pure, no timers, no I/O, so it can be
 * property-tested in isolation. The policy is the one Luma's own docs prescribe
 * (docs/libraries/luma-vitest-railway.md §1.5, ADR 0016):
 *
 *   - Retryable HTTP: 429 (RPM or concurrent), 502, 503. Everything else is terminal.
 *   - Delay: honour `Retry-After` (seconds) if present; else honour `X-RateLimit-Reset`
 *     (unix ts); else exponential `baseMs * 2^attempt`, capped at `maxDelayMs`.
 *   - Always add 0–999 ms of random jitter so a fleet of callers doesn't resynchronise.
 *   - A hard ceiling caps a pathological server value (e.g. `Retry-After: 86400`).
 */

/** HTTP statuses worth retrying — a transient throttle / upstream blip, not a client error. */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** Absolute cap on any single sleep, regardless of what a server asks for (ms). */
export const RETRY_HARD_CEILING_MS = 120_000;

/** Widest jitter added to every backoff (ms) — the doc's "0–1 s random jitter". */
export const RETRY_JITTER_MS = 1_000;

/**
 * `Retry-After` as an integer number of seconds. Luma only ever sends the delta-seconds form
 * (`Retry-After: 60`), never an HTTP-date, so that is all we parse; anything else → `null` and
 * the caller falls back to the exponential schedule.
 */
export function parseRetryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * `X-RateLimit-Reset` (unix epoch seconds) → milliseconds to wait from `now` (epoch ms). Only
 * used when there is no `Retry-After`. A reset in the past → `null` (fall back to exponential).
 */
export function millisUntilRateLimitReset(
  headers: Headers,
  now: number,
): number | null {
  const raw = headers.get("x-ratelimit-reset");
  if (raw === null) return null;
  const resetSec = Number(raw.trim());
  if (!Number.isFinite(resetSec) || resetSec <= 0) return null;
  const deltaMs = resetSec * 1_000 - now;
  return deltaMs > 0 ? deltaMs : null;
}

export interface BackoffInput {
  /** 0-based retry index — 0 is the wait before the first retry. */
  readonly attempt: number;
  readonly headers: Headers;
  /** Exponential base (ms). `baseMs * 2^attempt`. */
  readonly baseMs: number;
  /** Ceiling for the *exponential* branch (ms) before jitter. */
  readonly maxDelayMs: number;
  /** `Date.now()` at the call site, injectable for tests. */
  readonly now: number;
  /** `Math.random`, injectable for tests. Must yield `[0, 1)`. */
  readonly random: () => number;
}

/**
 * How long to sleep before the next attempt (ms). Precedence: `Retry-After` →
 * `X-RateLimit-Reset` → exponential (`baseMs * 2^attempt`, capped at `maxDelayMs`). Jitter of
 * 0–999 ms is added to whichever wins, and the sum is clamped to `RETRY_HARD_CEILING_MS`.
 */
export function backoffDelayMs(input: BackoffInput): number {
  const { attempt, headers, baseMs, maxDelayMs, now, random } = input;

  const retryAfterMs = (() => {
    const secs = parseRetryAfterSeconds(headers);
    return secs === null ? null : secs * 1_000;
  })();
  const resetMs = millisUntilRateLimitReset(headers, now);
  const exponentialMs = Math.min(baseMs * 2 ** attempt, maxDelayMs);

  const base = retryAfterMs ?? resetMs ?? exponentialMs;
  const jitter = Math.floor(random() * RETRY_JITTER_MS);
  return Math.min(Math.max(base, 0) + jitter, RETRY_HARD_CEILING_MS);
}
