/**
 * F3b — generate the one allowed retry Draft for a rejected Request.
 *
 * `handleDecision` already moved the aggregate `in_review → drafting` and set `retryUsed` on the approver's
 * first Reject tap (`domain/shot-request` `rejectDraft`). That leaves the Request in `drafting` with
 * NO pending generation — unlike a fresh `confirmed → drafting`, which `runDraft` always pairs with
 * a pending attempt. This use-case fills that gap: it is `runDraft` for the retry, with the
 * reject-reason chip carried forward into the prompt (SPEC F3b: "a GenerationPrompt that carries the
 * `color off` reason forward").
 *
 * Exactly-once is enforced two ways: the domain (`rejectDraft` parks a second rejection, so a
 * Request only ever re-enters `drafting` once), and here (`retry`-kind attempt already present →
 * `retryDraft` throws; the `startRetryDrafts` caller filters the same case and skips instead).
 * Crash-safety matches `runDraft` (ADR 0014): if `create` throws nothing is written and the
 * next tick retries; an orphaned Luma generation from a crash mid-write is just re-created.
 */
import { randomUUID } from "node:crypto";

import { composeGenerationPrompt } from "../domain/prompt.js";
import type { GenerationAttempt, RejectReason } from "../domain/types.js";
import type { Config } from "../config.js";
import type { Clock } from "../ports/clock.js";
import type { GenerationClient } from "../ports/generation-client.js";
import type { Repository } from "../ports/repository.js";
import type { SlackGateway } from "../ports/slack-gateway.js";
import { refreshBatchStatus } from "./refresh-batch-status.js";

export interface RetryDraftDeps {
  readonly repo: Repository;
  readonly clock: Clock;
  readonly generationClient: GenerationClient;
  readonly config: Config;
  /** F7 / ADR 0019 — refreshes the SKU's batch status post after the retry attempt is booked. */
  readonly slack: SlackGateway;
}

export interface RetryDraftResult {
  readonly attemptId: string;
  readonly lumaGenerationId: string;
  readonly promptText: string;
  readonly retryReason: RejectReason;
}

/** The chip on the most recent Reject Decision for this Request — the reason to carry forward. */
function latestRejectReason(
  repo: Repository,
  requestId: string,
): RejectReason | null {
  const rejects = repo
    .listDecisionsForRequest(requestId)
    .filter((d) => d.verb === "reject");
  return rejects.length > 0 ? (rejects[rejects.length - 1]?.reason ?? null) : null;
}

export async function retryDraft(
  deps: RetryDraftDeps,
  input: { requestId: string },
): Promise<RetryDraftResult> {
  const { repo, clock, generationClient, config } = deps;

  const request = repo.getRequest(input.requestId);
  if (!request) throw new Error(`retryDraft: no Request ${input.requestId}`);
  // Guard: only a rejected Request awaiting its retry (`drafting` + `retryUsed`) is eligible, and
  // only if the retry hasn't already been kicked off.
  if (request.status !== "drafting" || !request.retryUsed) {
    throw new Error(
      `retryDraft: Request ${request.id} is "${request.status}"${
        request.retryUsed ? "" : " with no retry granted"
      } — not awaiting a retry`,
    );
  }
  if (repo.listAttemptsForRequest(request.id).some((a) => a.kind === "retry")) {
    throw new Error(
      `retryDraft: Request ${request.id} already has a retry attempt — one retry only (SPEC F3b)`,
    );
  }

  const product = repo.getProduct(request.sku);
  if (!product) {
    throw new Error(
      `retryDraft: no Product for SKU ${request.sku} (Request ${request.id})`,
    );
  }

  const retryReason = latestRejectReason(repo, request.id) ?? "other";
  const promptText = composeGenerationPrompt({
    shotIdea: request.shotIdeaText,
    category: product.category,
    material: product.material,
    colorSet: product.colorSet,
    riskFlags: request.riskFlags,
    retryReason,
  });

  const handle = await generationClient.create({
    prompt: promptText,
    sourceImageUrl: product.photoUrl,
    quality: "draft",
  });

  const now = clock.now();
  const attempt: GenerationAttempt = {
    id: randomUUID(),
    requestId: request.id,
    kind: "retry",
    promptText,
    inputPhotoUrl: product.photoUrl,
    lumaGenerationId: handle.id,
    resultImageUrl: null,
    spendCents: config.pipeline.draftCostCents,
    status: "pending",
    rejectReason: retryReason,
    createdAt: now,
    completedAt: null,
  };
  repo.saveAttempt(attempt);
  // The aggregate is already `drafting` — `resolvePendingGenerations` posts this retry for review
  // (`drafting → in_review`) once Luma returns, exactly as it does a first Draft.
  await refreshBatchStatus(deps, request.sku);

  return {
    attemptId: attempt.id,
    lumaGenerationId: handle.id,
    promptText,
    retryReason,
  };
}
