/**
 * F3a — apply a review tap to a Request. This is where the binding-actor gate lives (ASSUMPTIONS.md
 * A2): a tap by anyone other than the configured approver id is a no-op — no Decision recorded, no
 * state change, no Finals generated (SPEC: "the Request does not change state and no Finals are
 * generated"). Non-binding taps are not even logged as `NonBindingTapRecorded` — that courtesy is
 * out of scope (ASSUMPTIONS.md A2 / VALUE.md).
 *
 * DEMO POSTURE: `OPEN_APPROVAL` (`config.slack.openApproval`) defaults to `true` in the open-by-default posture
 * — every tapper becomes the binding actor, so anyone with the workspace invite can drive
 * the approval loop. Set it to `false` to restore the gate above as the only behaviour.
 *
 * For a binding tap: record the `Decision`, move the aggregate (`approveDraft` / `rejectDraft`),
 * and swap the review message's controls for a status line (best-effort — the Decision is already
 * durable). Approve is the only path that authorises Finals spend; Reject records the reason chip
 * and re-enters `drafting` for the one retry (or parks on a second reject) — no finals-spend entry
 * is ever written here.
 */
import { randomUUID } from "node:crypto";

import {
  approveDraft,
  isBindingActor,
  rejectDraft,
} from "../domain/shot-request.js";
import type {
  Decision,
  RejectReason,
  ShotRequest,
  ShotRequestStatus,
} from "../domain/types.js";
import type { Config } from "../config.js";
import type { Clock } from "../ports/clock.js";
import type { Repository } from "../ports/repository.js";
import type { SlackGateway } from "../ports/slack-gateway.js";
import { refreshBatchStatus } from "./refresh-batch-status.js";

export interface HandleDecisionDeps {
  readonly repo: Repository;
  readonly clock: Clock;
  readonly gateway: SlackGateway;
  readonly config: Config;
}

export interface HandleDecisionInput {
  readonly requestId: string;
  /** Slack user id of whoever tapped (`body.user.id`). */
  readonly actor: string;
  readonly verb: "approve" | "reject";
  /** Required in practice for `reject` (the chip); defaults to `other` if the UI omitted it. */
  readonly reason?: RejectReason | null;
}

export interface HandleDecisionResult {
  readonly applied: boolean;
  readonly ignoredReason?:
    "not-binding-actor" | "request-not-found" | "not-in-review";
  readonly newStatus?: ShotRequestStatus;
  readonly decisionId?: string;
}

export async function handleDecision(
  deps: HandleDecisionDeps,
  input: HandleDecisionInput,
): Promise<HandleDecisionResult> {
  const { repo, clock, gateway, config } = deps;

  // The binding actor. With `OPEN_APPROVAL` on (the open-by-default) whoever tapped is
  // treated as the binding actor, so anyone in the channel can drive the loop; with it off, only
  // the configured approver id counts (ASSUMPTIONS.md A2). An empty actor id is never binding either
  // way (`isBindingActor` rejects it).
  const bindingActor = config.slack.openApproval
    ? input.actor
    : config.slack.approverUserId;

  // Gate first — a non-binding tap does nothing at all.
  if (!isBindingActor(input.actor, bindingActor)) {
    return { applied: false, ignoredReason: "not-binding-actor" };
  }

  const request = repo.getRequest(input.requestId);
  if (!request) return { applied: false, ignoredReason: "request-not-found" };
  // Idempotent against Socket Mode redelivery / a double tap: only a Draft still awaiting a verdict
  // is actionable. `stale` counts — escalation to the escalation contact doesn't retract the review, and the approver's tap
  // on the still-live controls must land (`approveDraft` / `rejectDraft` both accept `stale`).
  if (request.status !== "in_review" && request.status !== "stale")
    return { applied: false, ignoredReason: "not-in-review" };

  const latestDraft = repo.getLatestReviewPostForRequest(request.id, "draft");
  const attemptId = latestDraft?.attemptId ?? null;
  const now = clock.now();

  let next: ShotRequest;
  let decision: Decision;
  if (input.verb === "approve") {
    next = approveDraft(request, input.actor, bindingActor);
    decision = {
      id: randomUUID(),
      requestId: request.id,
      attemptId,
      actor: input.actor,
      verb: "approve",
      reason: null,
      at: now,
    };
  } else {
    const reason: RejectReason = input.reason ?? "other";
    next = rejectDraft(request, input.actor, bindingActor);
    decision = {
      id: randomUUID(),
      requestId: request.id,
      attemptId,
      actor: input.actor,
      verb: "reject",
      reason,
      at: now,
    };
  }

  repo.saveDecision(decision);
  repo.saveRequest(next);
  await refreshBatchStatus({ repo, slack: gateway, clock }, next.sku);

  if (latestDraft) {
    const attempt = attemptId ? repo.getAttempt(attemptId) : null;
    const statusText =
      input.verb === "approve"
        ? `*${next.sku}* — ✅ Direction approved by <@${input.actor}> — generating Finals.`
        : `*${next.sku}* — ↩︎ Draft rejected by <@${input.actor}> — reason: ${decision.reason}.`;
    try {
      await gateway.updateMessage({
        channel: latestDraft.slackChannel,
        ts: latestDraft.slackTs,
        text: statusText,
        sku: next.sku,
        ...(attempt?.resultImageUrl
          ? { keepImageUrl: attempt.resultImageUrl }
          : {}),
      });
    } catch {
      // Cosmetic only — the Decision and the new status are already persisted.
    }
  }

  return { applied: true, newStatus: next.status, decisionId: decision.id };
}
