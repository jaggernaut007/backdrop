/**
 * F3b — the staleness sweep. Every `in_review` Draft whose `draftPostedAt` is older than
 * `config.pipeline.staleThresholdDays` is escalated: a Slack message @-mentions the escalation contact and the
 * Request moves `in_review → stale` (SPEC F3b: "the Request is marked `stale` and a Slack message
 * @-mentioning the escalation contact is posted in the channel"). A Draft still inside the threshold is left alone.
 *
 * This instruments VALUE.md's kill signal — "how often does the approver just ignore a Draft" — so the
 * mention is the point of the feature, not a side effect. It is posted BEFORE the transition (ADR
 * 0014 B2 posture): if `mentionEscalationContact` throws, the Request stays `in_review` and the next sweep
 * retries, rather than a `stale` Request that the escalation contact was never actually told about.
 *
 * Driven off its own interval (`runtime/scheduler`), not the 3s job loop — a 3-day threshold does
 * not need second-by-second checking (hourly by default — `STALE_SWEEP_INTERVAL_MS`). Each Request
 * is swept inside its own try/catch so one failure does not abort the rest of the sweep.
 */
import { markStale } from "../domain/shot-request.js";
import type { Config } from "../config.js";
import type { Clock } from "../ports/clock.js";
import type { Repository } from "../ports/repository.js";
import type { SlackGateway } from "../ports/slack-gateway.js";
import { refreshBatchStatus } from "./refresh-batch-status.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface StalenessCheckDeps {
  readonly repo: Repository;
  readonly clock: Clock;
  readonly gateway: SlackGateway;
  readonly config: Config;
  /** Where a per-Request sweep error goes. Defaults to `console.error`; `main` passes the logger. */
  readonly onItemError?: (context: string, err: unknown) => void;
}

export interface StalenessCheckResult {
  /** How many Requests this sweep escalated to the escalation contact. */
  readonly escalated: number;
}

export async function runStalenessCheck(
  deps: StalenessCheckDeps,
): Promise<StalenessCheckResult> {
  const { repo, clock, gateway, config } = deps;
  const report =
    deps.onItemError ??
    ((c: string, e: unknown) => console.error(`staleness check: ${c}`, e));

  const now = clock.now();
  const nowMs = Date.parse(now);
  const thresholdMs = config.pipeline.staleThresholdDays * MS_PER_DAY;

  let escalated = 0;
  for (const request of repo.listRequestsByStatus("in_review")) {
    try {
      if (!request.draftPostedAt) continue; // no timestamp to age — nothing to do
      const ageMs = nowMs - Date.parse(request.draftPostedAt);
      if (ageMs < thresholdMs) continue; // still inside the threshold

      // Mention first, transition second (see file header).
      await gateway.mentionEscalationContact(
        `<@${config.slack.escalationUserId}> — the Draft for ${request.sku} has been waiting ` +
          `${config.pipeline.staleThresholdDays}+ days without a review. Can you take a look?`,
      );
      repo.saveRequest(markStale(request, now));
      await refreshBatchStatus(
        { repo, slack: gateway, clock },
        request.sku,
      );
      escalated += 1;
    } catch (err) {
      report(
        `escalation failed for Request ${request.id} (${request.sku})`,
        err,
      );
    }
  }

  return { escalated };
}
