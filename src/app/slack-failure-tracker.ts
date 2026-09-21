/**
 * General backstop for a Slack post that keeps failing forever. `postReadyFinals` already fails a
 * Request fast when Slack says `invalid_blocks` because the image bytes are gone
 * (`isUnrenderableImagesError`, run-pipeline-tick.ts) — that is one *known* permanent-failure
 * shape. This tracker covers every *other* shape: an expired token, a malformed block the domain
 * layer produces some day, a wrong channel id, a sustained Slack outage, a bug not yet seen.
 * Without a ceiling, the pipeline tick (every few seconds, ADR 0006) retries the identical doomed
 * call forever — that sustained call volume is exactly what turned one bad batch of orphaned
 * Finals into real rate-limit pressure on the *whole* app's Slack token, not just the caller that
 * started it (this is the incident PROGRESS.md records; `isUnrenderableImagesError` fixed that one
 * shape, this fixes the general case so it can't recur for a different reason).
 *
 * Pure counter, no I/O — one instance lives for the process lifetime (ADR 0011, single replica) and
 * is threaded through `PipelineTickDeps` like `repo`/`clock`, so it persists across ticks but resets
 * on a restart (acceptable: a few more retries before giving up again, never fewer).
 */

/** Consecutive failures for the same key before the caller should stop retrying and fail loudly. */
export const MAX_CONSECUTIVE_SLACK_FAILURES = 5;

export class SlackFailureTracker {
  private readonly counts = new Map<string, number>();

  /**
   * Record a failure for `key`. Returns `true` once it has failed
   * `MAX_CONSECUTIVE_SLACK_FAILURES` times in a row — the caller should give up rather than retry
   * on the next tick.
   */
  recordFailure(key: string): boolean {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next >= MAX_CONSECUTIVE_SLACK_FAILURES;
  }

  /** Clear `key`'s streak — call on any success (or once given up) so it starts fresh. */
  clear(key: string): void {
    this.counts.delete(key);
  }
}
