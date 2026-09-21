/**
 * F4 — kick off the Finals generations for an `approved` Request.
 *
 * Orchestration only: validate the `approved → finalizing` transition FIRST (`beginFinals` throws
 * otherwise — this is the guard that makes `DraftApproved` the sole authoriser of Finals spend,
 * SPEC F4), reuse the *approved direction's* prompt (the prompt text of the Draft attempt the approver
 * approved), and fire generations at `uni-1-max` until the Request has `finalsPerDirection` of them.
 *
 * Each attempt row is written *immediately* after its `create` returns — not batched after every
 * `create` — so a billed generation always has a ledger row (DOMAIN.md: spend on every attempt,
 * success or failure) and a mid-fan-out failure (a Luma 429, say) can't strand a paid-for
 * generation with nothing recording it. The loop is a **top-up**: it counts the Request's existing
 * `final`-kind attempts and only creates the shortfall, so a retry after a partial run (a `create`
 * threw, or the process died before `saveRequest`) converges on exactly `finalsPerDirection`
 * rather than stacking a second batch. The Request moves to `finalizing` only once the full set
 * exists; until then it stays `approved` and the next tick tops it up.
 *
 * `resolvePendingGenerations` polls each attempt and re-hosts it; `postReadyFinals` (both in
 * `run-pipeline-tick`) posts the single review message once every attempt has resolved.
 */
import { randomUUID } from "node:crypto";

import { beginFinals } from "../domain/shot-request.js";
import { composeGenerationPrompt } from "../domain/prompt.js";
import type { GenerationAttempt, ShotRequest } from "../domain/types.js";
import type { Config } from "../config.js";
import type { Clock } from "../ports/clock.js";
import type { GenerationClient } from "../ports/generation-client.js";
import type { Repository } from "../ports/repository.js";
import type { SlackGateway } from "../ports/slack-gateway.js";
import { refreshBatchStatus } from "./refresh-batch-status.js";

export interface RunFinalsDeps {
  readonly repo: Repository;
  readonly clock: Clock;
  readonly generationClient: GenerationClient;
  readonly config: Config;
  /** F7 / ADR 0019 — refreshes the SKU's batch status post(s) after the transition below. */
  readonly slack: SlackGateway;
}

export interface RunFinalsResult {
  /** Every `final`-kind attempt of the Request after this run — prior rows plus the ones just created. */
  readonly attemptIds: readonly string[];
  /** How many `create` calls this run actually issued (0 if the Request was already topped up). */
  readonly created: number;
  readonly promptText: string;
}

/**
 * The prompt the approved direction was drawn with. Prefer the exact Draft attempt the approver approved
 * (the `approve` Decision's `attemptId`); fall back to the most recent succeeded attempt's prompt;
 * last resort, recompose from the Product so Finals are never blocked by missing history.
 */
function approvedDirectionPrompt(
  repo: Repository,
  request: ShotRequest,
): string | null {
  const approve = repo
    .listDecisionsForRequest(request.id)
    .find((d) => d.verb === "approve");
  const approved = approve?.attemptId
    ? repo.getAttempt(approve.attemptId)
    : null;
  if (approved?.promptText) return approved.promptText;

  const succeeded = repo
    .listAttemptsForRequest(request.id)
    .filter((a) => a.status === "succeeded" && a.promptText.length > 0);
  const last = succeeded[succeeded.length - 1];
  return last?.promptText ?? null;
}

export async function runFinals(
  deps: RunFinalsDeps,
  input: { requestId: string },
): Promise<RunFinalsResult> {
  const { repo, clock, generationClient, config } = deps;

  const request = repo.getRequest(input.requestId);
  if (!request) throw new Error(`runFinals: no Request ${input.requestId}`);
  // Validate before spending: `beginFinals` throws unless the Request is `approved`.
  const finalizing = beginFinals(request);

  const product = repo.getProduct(request.sku);
  if (!product) {
    throw new Error(
      `runFinals: no Product for SKU ${request.sku} (Request ${request.id})`,
    );
  }

  const promptText =
    approvedDirectionPrompt(repo, request) ??
    composeGenerationPrompt({
      shotIdea: request.shotIdeaText,
      category: product.category,
      material: product.material,
      colorSet: product.colorSet,
      riskFlags: request.riskFlags,
    });

  // Top up to `finalsPerDirection`, counting whatever a prior (possibly partial) run already
  // wrote. Every `create` is followed by its own `saveAttempt` before the next one is issued.
  const existing = repo
    .listAttemptsForRequest(request.id)
    .filter((a) => a.kind === "final");
  const attemptIds = existing.map((a) => a.id);
  let created = 0;

  for (
    let i = existing.length;
    i < config.pipeline.finalsPerDirection;
    i += 1
  ) {
    const handle = await generationClient.create({
      prompt: promptText,
      sourceImageUrl: product.photoUrl,
      quality: "final",
    });
    const now = clock.now();
    const attempt: GenerationAttempt = {
      id: randomUUID(),
      requestId: request.id,
      kind: "final",
      promptText,
      inputPhotoUrl: product.photoUrl,
      lumaGenerationId: handle.id,
      resultImageUrl: null,
      spendCents: config.pipeline.finalCostCents,
      status: "pending",
      rejectReason: null,
      createdAt: now,
      completedAt: null,
    };
    repo.saveAttempt(attempt);
    attemptIds.push(attempt.id);
    created += 1;
  }

  repo.saveRequest(finalizing);
  await refreshBatchStatus(deps, finalizing.sku);

  return { attemptIds, created, promptText };
}
