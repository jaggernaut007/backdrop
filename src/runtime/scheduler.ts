/**
 * The staleness scheduler (ADR 0006 — "in-process job loop + interval scheduler"). A second plain
 * `setInterval`, separate from the 3s job loop, that runs `runStalenessCheck` on a slow cadence
 * (`STALE_SWEEP_INTERVAL_MS`, hourly by default) — a 3-day threshold does not need second-by-second
 * checking, and keeping it off the hot loop means a slow escalation post can't delay drafting.
 *
 * Thin process glue: excluded from coverage. The work it drives is `app/staleness-check`, which is
 * unit-tested directly with fakes and no timers. Mirrors `runtime/job-loop.ts`.
 */
import {
  runStalenessCheck,
  type StalenessCheckDeps,
} from "../app/staleness-check.js";

export interface Scheduler {
  stop(): void;
}

export function startStalenessScheduler(
  deps: StalenessCheckDeps,
  intervalMs: number,
  onError: (err: unknown) => void,
): Scheduler {
  let inFlight = false;

  const run = async (): Promise<void> => {
    if (inFlight) return; // a slow sweep must not stack on the next interval
    inFlight = true;
    try {
      await runStalenessCheck(deps);
    } catch (err) {
      onError(err);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void run(), intervalMs);
  timer.unref(); // the scheduler must not keep the process alive on its own
  return { stop: () => clearInterval(timer) };
}
