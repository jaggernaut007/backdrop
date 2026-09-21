/**
 * The in-process job loop (ADR 0006) — a plain `setInterval` that runs `runPipelineTick` and never
 * lets two passes overlap. No queue, no external cron: one long-running Railway process already
 * exists, and at 40 products a tick is a handful of cheap calls.
 *
 * Thin process glue: excluded from coverage. The work it drives is `app/run-pipeline-tick`, which
 * is unit-tested directly with fakes and no timers.
 */
import type { PipelineTickDeps } from "../app/run-pipeline-tick.js";
import { runPipelineTick } from "../app/run-pipeline-tick.js";

export interface JobLoop {
  stop(): void;
}

export function startJobLoop(
  deps: PipelineTickDeps,
  intervalMs: number,
  onError: (err: unknown) => void,
): JobLoop {
  let inFlight = false;

  const run = async (): Promise<void> => {
    if (inFlight) return; // a slow tick must not stack on the next interval
    inFlight = true;
    try {
      await runPipelineTick(deps);
    } catch (err) {
      onError(err);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void run(), intervalMs);
  timer.unref(); // the loop must not keep the process alive on its own
  return { stop: () => clearInterval(timer) };
}
