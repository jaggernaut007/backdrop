/**
 * F3a — kick off one Draft generation for a confirmed Request.
 *
 * Orchestration only: compose the prompt (`domain/prompt`), call the model (`GenerationClient`
 * port), record a `pending` `GenerationAttempt` with its configured spend, and move the Request
 * `confirmed → drafting` (`domain/shot-request`). The generation is async — `resolvePendingGenerations`
 * (in `run-pipeline-tick`) polls it to completion and posts the Draft for review.
 *
 * Ordering: the `confirmed` transition is validated first (`startDrafting` throws otherwise — no
 * money is spent on a Request in the wrong state), then the model call, then the writes. If
 * `create` throws, nothing is written and the Request stays `confirmed` for the next tick; if the
 * process dies between `create` and the writes, the orphaned Luma generation is just re-created
 * next tick (one cheap draft) — same crash-safety stance as `ingest-catalog` (ADR 0013), see
 * ADR 0014.
 */
import { randomUUID } from "node:crypto";

import { composeGenerationPrompt } from "../domain/prompt.js";
import { startDrafting } from "../domain/shot-request.js";
import type { GenerationAttempt } from "../domain/types.js";
import type { Config } from "../config.js";
import type { Clock } from "../ports/clock.js";
import type { GenerationClient } from "../ports/generation-client.js";
import type { Repository } from "../ports/repository.js";
import type { SlackGateway } from "../ports/slack-gateway.js";
import { refreshBatchStatus } from "./refresh-batch-status.js";

export interface RunDraftDeps {
  readonly repo: Repository;
  readonly clock: Clock;
  readonly generationClient: GenerationClient;
  readonly config: Config;
  /** F7 / ADR 0019 — refreshes the SKU's batch status post(s) after the transition below. */
  readonly slack: SlackGateway;
}

export interface RunDraftResult {
  readonly attemptId: string;
  readonly lumaGenerationId: string;
  readonly promptText: string;
}

export async function runDraft(
  deps: RunDraftDeps,
  input: { requestId: string },
): Promise<RunDraftResult> {
  const { repo, clock, generationClient, config } = deps;

  const request = repo.getRequest(input.requestId);
  if (!request) throw new Error(`runDraft: no Request ${input.requestId}`);
  // Validate the transition before spending. `startDrafting` throws on a non-`confirmed` Request;
  // the result is persisted only after `create` succeeds.
  const drafting = startDrafting(request);

  const product = repo.getProduct(request.sku);
  if (!product) {
    throw new Error(
      `runDraft: no Product for SKU ${request.sku} (Request ${request.id})`,
    );
  }

  const promptText = composeGenerationPrompt({
    shotIdea: request.shotIdeaText,
    category: product.category,
    material: product.material,
    colorSet: product.colorSet,
    riskFlags: request.riskFlags,
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
    kind: "draft",
    promptText,
    inputPhotoUrl: product.photoUrl,
    lumaGenerationId: handle.id,
    resultImageUrl: null,
    // Configured constant, written now — Luma bills async, and DOMAIN.md wants spend on every
    // attempt regardless of outcome.
    spendCents: config.pipeline.draftCostCents,
    status: "pending",
    rejectReason: null,
    createdAt: now,
    completedAt: null,
  };
  repo.saveAttempt(attempt);
  repo.saveRequest(drafting);
  await refreshBatchStatus(deps, drafting.sku);

  return { attemptId: attempt.id, lumaGenerationId: handle.id, promptText };
}
