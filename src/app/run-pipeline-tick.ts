/**
 * One pass of the in-process pipeline (ADR 0006). `runPipelineTick` is what `runtime/job-loop`
 * calls on its interval; the halves are exported separately so they can be driven directly in
 * tests with no timers.
 *
 *  1. `startConfirmedDrafts` — every `confirmed` Request, in queue order (priority first — SPEC F1),
 *     gets a Draft generation kicked off (`runDraft`), capped per tick.
 *  1b. `startRetryDrafts` — every Request that the approver rejected once (`drafting` + `retryUsed`, no
 *     generation in flight) gets its one retry Draft kicked off (`retryDraft`, F3b), same cap.
 *  2. `startApprovedFinals` — every `approved` Request gets its `finalsPerDirection` Finals kicked
 *     off (`runFinals` — the `DraftApproved` guard lives there), also capped per tick.
 *  3. `resolvePendingGenerations` — every in-flight `GenerationAttempt` is polled. A completed Draft
 *     is re-hosted (Luma URLs expire in ~1h) and posted for review (`drafting → in_review`); a
 *     completed Final is re-hosted under a throwaway name and left `succeeded` for step 4; a failed
 *     one records the failure (spend already booked).
 *  4. `publishReadyFinals` — every `finalizing` Request whose Finals have all resolved has its
 *     succeeded Finals auto-published under deterministic names and transitions `finalizing → done`
 *     (all published) | `parked` (one) | `failed` (none); the hyperlinked result is posted into the
 *     SKU's living thread reply (ADR 0020). `sweepStrandedPicking` then resolves any legacy
 *     `picking` row left over from before the Keep/Finish UI was retired.
 *
 * Fault isolation (ADR 0014): each Request / attempt is processed inside its own try/catch. One
 * that throws is logged via `onItemError` and skipped — it does not abort the tick.
 *
 * The review tap itself is a separate use-case (`handle-decision`), driven by Bolt `block_actions`;
 * Finals auto-approve on this loop (ADR 0020), so there is no pick use-case.
 */
import { randomUUID } from "node:crypto";

import {
  completeFinals,
  failDraftGeneration,
  failFinalsGeneration,
  finishPicking,
  postDraftForReview,
} from "../domain/shot-request.js";
import { publishedFilename } from "../domain/publish.js";
import type { Config } from "../config.js";
import type { Clock } from "../ports/clock.js";
import type { GenerationClient } from "../ports/generation-client.js";
import type { GenerationAttempt } from "../domain/types.js";
import type { ImageStore } from "../ports/image-store.js";
import type { Repository } from "../ports/repository.js";
import type { SlackGateway } from "../ports/slack-gateway.js";
import { refreshBatchById, refreshBatchStatus } from "./refresh-batch-status.js";
import { retryDraft } from "./retry-draft.js";
import { runDraft } from "./run-draft.js";
import { runFinals } from "./run-finals.js";
import { SlackFailureTracker } from "./slack-failure-tracker.js";

/**
 * Number of Luma generations currently in flight (pending attempts). The shared global budget
 * (ADR 0021): no start sweep issues a new `create` while the queue is at
 * `config.pipeline.maxInFlightGenerations`, so priority requests get first claim on the available
 * concurrency and the adapter's per-call retry is no longer fighting a whole batch's worth of
 * simultaneous jobs.
 */
function pendingCount(repo: Repository): number {
  return repo.listPendingAttempts().length;
}

export interface PipelineTickDeps {
  readonly repo: Repository;
  readonly clock: Clock;
  readonly generationClient: GenerationClient;
  readonly imageStore: ImageStore;
  readonly gateway: SlackGateway;
  readonly config: Config;
  /** Where a skipped-item error goes. Defaults to `console.error`; `main` passes the Fastify logger. */
  readonly onItemError?: (context: string, err: unknown) => void;
  /**
   * General backstop against retrying a doomed Slack post forever (slack-failure-tracker.ts).
   * Optional so existing tests that don't care about this path keep working; `main.ts` wires one
   * real instance that lives for the process lifetime, same as `repo`/`clock`.
   */
  readonly slackFailureTracker?: SlackFailureTracker;
}

function reportItemError(
  deps: PipelineTickDeps,
  context: string,
  err: unknown,
): void {
  (deps.onItemError ?? ((c, e) => console.error(`pipeline tick: ${c}`, e)))(
    context,
    err,
  );
}

/**
 * A generated image needs a stable URL for the days it may sit un-tapped, so it goes through the
 * image store — but under a throwaway name. The deterministic `hg-002-styled-01.jpg` scheme
 * (`domain/publish`, ADR 0008) is the identity of a *published* Final and is assigned only when
 * a Draft/Final is auto-published (`publishReadyFinals`, ADR 0020); an un-published image has no
 * claim to it.
 */
function draftImageFilename(sku: string, attemptId: string): string {
  return `${sku.toLowerCase()}-draft-${attemptId.slice(0, 8)}.jpg`;
}

/**
 * F7 / ADR 0019: which open batch a SKU's review card (Draft/Finals) should live in, when a SKU is
 * open in more than one at once (rare — a re-upload re-listing the same SKU before its prior batch
 * completes). Prefer whichever batch already has a living thread reply for this SKU (continuity —
 * a blank row's ask stays the same message through draft/finals); otherwise the most recently
 * opened open batch (`listOpenImportIdsForSku` is oldest-first).
 */
function resolvePrimaryImportId(repo: Repository, sku: string): string | null {
  const openIds = repo.listOpenImportIdsForSku(sku);
  if (openIds.length === 0) return null;
  for (const id of openIds) {
    if (repo.getSkuThreadPost(id, sku)) return id;
  }
  return openIds[openIds.length - 1] ?? null;
}

function finalImageFilename(sku: string, attemptId: string): string {
  return `${sku.toLowerCase()}-final-${attemptId.slice(0, 8)}.jpg`;
}

/**
 * Kick a Draft for every `confirmed` Request, up to `config.pipeline.maxDraftsPerTick`, in queue
 * order (priority first), and only while the shared in-flight budget has room. Returns how many
 * were started. A `runDraft` throw for one Request is logged and skipped — the Request stays
 * `confirmed` and is retried next tick.
 */
export async function startConfirmedDrafts(
  deps: PipelineTickDeps,
): Promise<number> {
  let started = 0;
  for (const request of deps.repo.listRequestsInQueueOrder()) {
    if (request.status !== "confirmed") continue;
    if (started >= deps.config.pipeline.maxDraftsPerTick) break;
    if (pendingCount(deps.repo) >= deps.config.pipeline.maxInFlightGenerations)
      break;
    try {
      await runDraft({ ...deps, slack: deps.gateway }, { requestId: request.id });
      started += 1;
    } catch (err) {
      reportItemError(
        deps,
        `runDraft failed for Request ${request.id} (${request.sku})`,
        err,
      );
    }
  }
  return started;
}

/**
 * F3b — kick the one retry Draft for every Request the approver rejected once. Such a Request is left in
 * `drafting` with `retryUsed` set but no generation in flight (`handleDecision`'s `rejectDraft`),
 * which `startConfirmedDrafts` (only `confirmed`) never picks up. Eligible = `drafting` +
 * `retryUsed` + no `retry`-kind attempt yet; `retryDraft` re-checks the same guards. A second
 * rejection parks the Request in the domain, so this can only ever fire once per Request. Same
 * per-tick cap and fault isolation as `startConfirmedDrafts`.
 */
export async function startRetryDrafts(deps: PipelineTickDeps): Promise<number> {
  let started = 0;
  for (const request of deps.repo.listRequestsInQueueOrder()) {
    if (request.status !== "drafting") continue;
    if (!request.retryUsed) continue; // a fresh confirmed→drafting already has its pending attempt
    if (started >= deps.config.pipeline.maxDraftsPerTick) break;
    if (pendingCount(deps.repo) >= deps.config.pipeline.maxInFlightGenerations)
      break;
    if (
      deps.repo
        .listAttemptsForRequest(request.id)
        .some((a) => a.kind === "retry")
    ) {
      continue; // retry already kicked off (pending) or resolved — one retry only
    }
    try {
      await retryDraft(
        { ...deps, slack: deps.gateway },
        { requestId: request.id },
      );
      started += 1;
    } catch (err) {
      reportItemError(
        deps,
        `retryDraft failed for Request ${request.id} (${request.sku})`,
        err,
      );
    }
  }
  return started;
}

/**
 * Kick the Finals for every `approved` Request, up to `config.pipeline.maxFinalsStartsPerTick`, in
 * queue order (priority first) and within the shared in-flight budget. `runFinals` enforces the
 * `DraftApproved` guard (`beginFinals` throws for any non-`approved` state), so this can never
 * spend on a Request that was not approved. Returns how many Requests were moved into Finals.
 */
export async function startApprovedFinals(
  deps: PipelineTickDeps,
): Promise<number> {
  let started = 0;
  for (const request of deps.repo.listRequestsInQueueOrder()) {
    if (request.status !== "approved") continue;
    if (started >= deps.config.pipeline.maxFinalsStartsPerTick) break;
    if (pendingCount(deps.repo) >= deps.config.pipeline.maxInFlightGenerations)
      break;
    try {
      await runFinals({ ...deps, slack: deps.gateway }, { requestId: request.id });
      started += 1;
    } catch (err) {
      reportItemError(
        deps,
        `runFinals failed for Request ${request.id} (${request.sku})`,
        err,
      );
    }
  }
  return started;
}

/** Poll every pending generation; post completed Drafts for review, re-host completed Finals, fail dead ones. */
export async function resolvePendingGenerations(
  deps: PipelineTickDeps,
): Promise<void> {
  for (const attempt of deps.repo.listPendingAttempts()) {
    try {
      await resolveOneGeneration(deps, attempt);
    } catch (err) {
      reportItemError(
        deps,
        `resolve failed for attempt ${attempt.id} (Request ${attempt.requestId})`,
        err,
      );
    }
  }
}

async function resolveOneGeneration(
  deps: PipelineTickDeps,
  attempt: GenerationAttempt,
): Promise<void> {
  const { repo, clock, generationClient } = deps;
  if (!attempt.lumaGenerationId) return;

  const result = await generationClient.get(attempt.lumaGenerationId);
  if (result.state === "queued" || result.state === "processing") return; // still cooking

  const now = clock.now();
  if (attempt.kind === "final") {
    await resolveFinalGeneration(deps, attempt, result, now);
  } else {
    await resolveDraftGeneration(deps, attempt, result, now);
  }
}

async function resolveDraftGeneration(
  deps: PipelineTickDeps,
  attempt: GenerationAttempt,
  result: Awaited<ReturnType<GenerationClient["get"]>>,
  now: string,
): Promise<void> {
  const { repo, clock, imageStore, gateway } = deps;
  const request = repo.getRequest(attempt.requestId);

  // `failed`, or `completed` with no usable image (the real Luma adapter can return this when
  // `output` is empty — ADR 0014). Spend is already booked on the pending row.
  if (result.state === "failed" || !result.imageUrl) {
    repo.saveAttempt({ ...attempt, status: "failed", completedAt: now });
    if (request && request.status === "drafting") {
      repo.saveRequest(failDraftGeneration(request));
      await refreshBatchStatus({ repo, slack: gateway, clock }, request.sku);
      const why =
        result.failureReason ?? result.failureCode ?? "no image returned";
      await gateway.postMessage(
        `⚠ ${request.sku}: Draft generation failed — ${why}. Nothing was spent on Finals.`,
      );
    }
    return;
  }

  // The Request may have moved on (Socket Mode redelivery, an already-resolved sibling): settle the
  // attempt so it stops being polled, but do not re-host or re-post.
  if (!request || request.status !== "drafting") {
    repo.saveAttempt({ ...attempt, status: "succeeded", completedAt: now });
    return;
  }

  const hostedUrl = await imageStore.putFromUrl(
    draftImageFilename(request.sku, attempt.id),
    result.imageUrl,
  );

  // F7 / ADR 0019: post into the SKU's one living thread reply — update it in place if it already
  // exists (e.g. a blank row's ask becoming its draft-review card), else post fresh into the
  // batch's thread. No open batch / no batch post yet → leave the attempt `pending` and retry next
  // tick (rare — self-heals once `ingestCatalog` or the sweep lands the batch post).
  const primaryImportId = resolvePrimaryImportId(repo, request.sku);
  const batchPost = primaryImportId
    ? repo.getBatchStatusPost(primaryImportId)
    : null;
  if (!primaryImportId || !batchPost) return;
  const existingThread = repo.getSkuThreadPost(primaryImportId, request.sku);

  // Post + record the ReviewPost + move the aggregate BEFORE marking the attempt succeeded. If the
  // post throws, the attempt stays `pending` and the next tick re-polls (Luma hands back a fresh
  // presigned URL), re-hosts to the same deterministic name (idempotent overwrite) and re-posts —
  // no paid-for Draft is stranded (ADR 0014). But that retry must not be unbounded: a post Slack
  // can never render (image bytes unfetchable) is failed on the first try, and any other error
  // that keeps failing is given up after `MAX_CONSECUTIVE_SLACK_FAILURES` ticks — retrying the
  // identical doomed call forever is what hammers the whole app's Slack token
  // (`classifySlackPostFailure`, slack-failure-tracker.ts). Mirrors `publishReadyFinals`.
  const failureKey = `draft:${attempt.id}`;
  let posted;
  try {
    posted = await gateway.postDraftForReview({
      requestId: request.id,
      sku: request.sku,
      imageUrl: hostedUrl,
      shotIdea: request.shotIdeaText,
      riskFlags: request.riskFlags,
      threadTs: batchPost.slackTs,
      ...(existingThread
        ? {
            existing: {
              channel: existingThread.slackChannel,
              ts: existingThread.slackTs,
            },
          }
        : {}),
    });
  } catch (err) {
    const verdict = classifySlackPostFailure(
      err,
      deps.slackFailureTracker,
      failureKey,
    );
    if (verdict === "retry") throw err; // keep retrying next tick, as before this backstop existed
    deps.slackFailureTracker?.clear(failureKey);
    repo.saveAttempt({ ...attempt, status: "failed", completedAt: now });
    repo.saveRequest(failDraftGeneration(request));
    await refreshBatchStatus({ repo, slack: gateway, clock }, request.sku);
    const why =
      verdict === "unrenderable"
        ? "the generated Draft could not be loaded for review (image hosting issue)"
        : "repeated Slack failures posting the Draft for review";
    await gateway
      .postMessage(`⚠ ${request.sku}: ${why}. Nothing was spent on Finals.`)
      .catch(() => undefined);
    return;
  }
  deps.slackFailureTracker?.clear(failureKey);
  repo.saveSkuThreadPost({
    importId: primaryImportId,
    sku: request.sku,
    slackChannel: posted.channel,
    slackTs: posted.ts,
    stage: "draft",
    requestId: request.id,
    proposedText: existingThread?.proposedText ?? null,
    updatedAt: now,
  });
  // A retry Draft is posted into the SAME living thread reply, so `posted.ts` matches the first
  // Draft's — reuse that `ReviewPost` row's id (`saveReviewPost` upserts on `id`) instead of
  // inserting a second one, which would collide on `UNIQUE(slack_channel, slack_ts, kind)`.
  const priorDraftPost = repo.getLatestReviewPostForRequest(request.id, "draft");
  repo.saveReviewPost({
    id: priorDraftPost?.id ?? randomUUID(),
    requestId: request.id,
    attemptId: attempt.id,
    slackChannel: posted.channel,
    slackTs: posted.ts,
    kind: "draft",
    createdAt: now,
  });
  repo.saveRequest(postDraftForReview(request, now));
  repo.saveAttempt({
    ...attempt,
    status: "succeeded",
    resultImageUrl: hostedUrl,
    completedAt: now,
  });
  await refreshBatchStatus({ repo, slack: gateway, clock }, request.sku);
}

/**
 * Resolve one Final attempt: re-host a completed image under a throwaway name and leave it
 * `succeeded` (the request is resolved by `publishReadyFinals` once *every* Final has resolved),
 * or mark a dead one `failed` (spend already booked). No Request transition here.
 */
async function resolveFinalGeneration(
  deps: PipelineTickDeps,
  attempt: GenerationAttempt,
  result: Awaited<ReturnType<GenerationClient["get"]>>,
  now: string,
): Promise<void> {
  const { repo, imageStore } = deps;

  if (result.state === "failed" || !result.imageUrl) {
    repo.saveAttempt({ ...attempt, status: "failed", completedAt: now });
    return;
  }

  const request = repo.getRequest(attempt.requestId);
  if (!request) {
    // Orphaned attempt (its Request was deleted): settle it so it stops being polled, don't re-host.
    repo.saveAttempt({ ...attempt, status: "succeeded", completedAt: now });
    return;
  }
  const hostedUrl = await imageStore.putFromUrl(
    finalImageFilename(request.sku, attempt.id),
    result.imageUrl,
  );
  repo.saveAttempt({
    ...attempt,
    status: "succeeded",
    resultImageUrl: hostedUrl,
    completedAt: now,
  });
}

/**
 * True when Slack rejected the post with `invalid_blocks` *and every* sub-error is "downloading
 * image failed" — i.e. it could not fetch any of the Final images. That is a permanent failure
 * for this Request (the hosted bytes are gone — e.g. a volume purge before the R2 cutover,
 * ADR 0017), not a transient Slack hiccup, so it must fail the Request rather than retry the
 * identical post every tick forever.
 */
function isUnrenderableImagesError(err: unknown): boolean {
  const data = (err as { data?: { error?: string; errors?: unknown } }).data;
  if (!data || data.error !== "invalid_blocks" || !Array.isArray(data.errors)) {
    return false;
  }
  return (
    data.errors.length > 0 &&
    data.errors.every(
      (e) => typeof e === "string" && e.includes("downloading image failed"),
    )
  );
}

/**
 * How a caller should treat a throw from a Slack review post. Shared by the Draft
 * (`resolveDraftGeneration`) and Finals (`publishReadyFinals`) paths so both react to a doomed post
 * the same way — retrying the identical call every tick is exactly the sustained volume that
 * turned one bad batch into rate-limit pressure on the whole app's token (slack-failure-tracker.ts).
 *
 *  - `"unrenderable"` — Slack can't fetch the image bytes (`isUnrenderableImagesError`). Permanent
 *    for this Request; give up on the FIRST occurrence, don't burn `MAX_CONSECUTIVE_SLACK_FAILURES`
 *    ticks (each of which makes Slack re-fetch the image) discovering that.
 *  - `"exhausted"` — some other error, but it has now failed `MAX_CONSECUTIVE_SLACK_FAILURES` times
 *    in a row (expired token, malformed block, sustained outage, an unseen bug). Give up.
 *  - `"retry"` — a transient failure under the ceiling; the caller should retry next tick.
 */
function classifySlackPostFailure(
  err: unknown,
  tracker: SlackFailureTracker | undefined,
  key: string,
): "unrenderable" | "exhausted" | "retry" {
  if (isUnrenderableImagesError(err)) return "unrenderable";
  if (tracker?.recordFailure(key)) {
    tracker.clear(key);
    return "exhausted";
  }
  return "retry";
}

/**
 * Wave 9 / ADR 0020 — auto-approve & auto-publish. For every `finalizing` Request whose Final
 * attempts have all resolved, publish each succeeded Final under its deterministic name
 * (`publishedFilename`, generation order), record a `pick` Decision with actor `"system"` (the
 * auto-approval is pipeline bookkeeping; the approver's Draft approval was the real gate), then move
 * `finalizing → done` (all published) | `parked` (one published). Every Final failed → `failed`.
 * Posted into the SKU's living thread reply — never the channel root. Idempotent: a Slack or
 * hosting failure leaves the Request `finalizing` (already-published attempts are skipped) so the
 * next tick retries only the shortfall.
 */
export async function publishReadyFinals(deps: PipelineTickDeps): Promise<void> {
  const { repo, clock, gateway, imageStore, config } = deps;
  for (const request of repo.listRequestsInQueueOrder()) {
    if (request.status !== "finalizing") continue;
    try {
      const finals = repo
        .listAttemptsForRequest(request.id)
        .filter((a) => a.kind === "final")
        .slice(0, config.pipeline.finalsPerDirection);
      if (finals.length === 0) continue;
      if (finals.some((a) => a.status === "pending")) continue; // wait for the rest

      const succeeded = finals.filter(
        (a) => a.status === "succeeded" && a.resultImageUrl,
      );

      const primaryImportId = resolvePrimaryImportId(repo, request.sku);
      const batchPost = primaryImportId
        ? repo.getBatchStatusPost(primaryImportId)
        : null;
      if (!primaryImportId || !batchPost) continue; // no thread yet — retry next tick
      const existingThread = repo.getSkuThreadPost(primaryImportId, request.sku);

      if (succeeded.length === 0) {
        // Post BEFORE the transition (ADR 0014 B2): if the Slack call throws, the Request stays
        // `finalizing` and the next sweep retries — a `failed` Request would drop out of the scan
        // with the approver never told her approved direction died.
        const posted = await gateway.postFinalsPublished({
          requestId: request.id,
          sku: request.sku,
          status: "failed",
          published: [],
          threadTs: batchPost.slackTs,
          ...(existingThread
            ? {
                existing: {
                  channel: existingThread.slackChannel,
                  ts: existingThread.slackTs,
                },
              }
            : {}),
        });
        repo.saveSkuThreadPost({
          importId: primaryImportId,
          sku: request.sku,
          slackChannel: posted.channel,
          slackTs: posted.ts,
          stage: "published",
          requestId: request.id,
          proposedText: existingThread?.proposedText ?? null,
          updatedAt: clock.now(),
        });
        repo.saveRequest(failFinalsGeneration(request));
        await refreshBatchStatus({ repo, slack: gateway, clock }, request.sku);
        continue;
      }

      // Publish each succeeded Final in generation order, idempotent per attempt so a mid-fan-out
      // hosting failure leaves the already-published rows durable and retries only the shortfall.
      for (const attempt of succeeded) {
        if (
          repo
            .listPublishedForRequest(request.id)
            .some((p) => p.sourceAttemptId === attempt.id)
        ) {
          continue;
        }
        const sequence = repo.listPublishedForRequest(request.id).length + 1;
        const filename = publishedFilename(request.sku, sequence);
        const stableUrl = await imageStore.putFromUrl(
          filename,
          attempt.resultImageUrl!,
        );
        repo.savePublishedImage({
          filename,
          requestId: request.id,
          sourceAttemptId: attempt.id,
          sequence,
          stableUrl,
          publishedAt: clock.now(),
        });
        repo.saveDecision({
          id: randomUUID(),
          requestId: request.id,
          attemptId: attempt.id,
          actor: "system",
          verb: "pick",
          reason: null,
          at: clock.now(),
        });
      }

      const published = repo.listPublishedForRequest(request.id);
      if (published.length < succeeded.length) continue; // partial — retry next tick

      const next = completeFinals(request, { publishedCount: published.length });
      const posted = await gateway.postFinalsPublished({
        requestId: request.id,
        sku: request.sku,
        status: next.status === "done" ? "done" : "parked",
        published: published.map((p) => ({
          filename: p.filename,
          stableUrl: p.stableUrl,
        })),
        threadTs: batchPost.slackTs,
        ...(existingThread
          ? {
              existing: {
                channel: existingThread.slackChannel,
                ts: existingThread.slackTs,
              },
            }
          : {}),
      });
      repo.saveSkuThreadPost({
        importId: primaryImportId,
        sku: request.sku,
        slackChannel: posted.channel,
        slackTs: posted.ts,
        stage: "published",
        requestId: request.id,
        proposedText: existingThread?.proposedText ?? null,
        updatedAt: clock.now(),
      });
      const priorFinalsPost = repo.getLatestReviewPostForRequest(
        request.id,
        "finals",
      );
      repo.saveReviewPost({
        id: priorFinalsPost?.id ?? randomUUID(),
        requestId: request.id,
        attemptId: succeeded[0]!.id,
        slackChannel: posted.channel,
        slackTs: posted.ts,
        kind: "finals",
        createdAt: clock.now(),
      });
      repo.saveRequest(next);
      await refreshBatchStatus({ repo, slack: gateway, clock }, request.sku);
      deps.slackFailureTracker?.clear(request.id);
    } catch (err) {
      // Same doomed-post backstop as the Draft path (ADR 0014 / slack-failure-tracker.ts): a post
      // Slack can never render is failed on the first try, and any other error that keeps failing
      // is given up after MAX_CONSECUTIVE_SLACK_FAILURES ticks, rather than retrying the identical
      // call every tick forever.
      const verdict = classifySlackPostFailure(
        err,
        deps.slackFailureTracker,
        request.id,
      );
      if (verdict !== "retry") {
        const why =
          verdict === "unrenderable"
            ? "the generated Finals are no longer retrievable (image hosting was migrated). Nothing was published; the approval still stands."
            : "repeated Slack failures posting the Finals completion. Nothing was published; the approval still stands.";
        await gateway.postMessage(`⚠ ${request.sku}: ${why}`).catch(() => undefined);
        repo.saveRequest(failFinalsGeneration(request));
        await refreshBatchStatus({ repo, slack: gateway, clock }, request.sku);
        deps.slackFailureTracker?.clear(request.id);
        continue;
      }
      reportItemError(
        deps,
        `publishReadyFinals failed for Request ${request.id} (${request.sku})`,
        err,
      );
    }
  }
}

/**
 * Wave 9 / ADR 0020 — self-heal for legacy `picking` rows written before the Keep/Finish UI was
 * retired: resolve them against their already-published picks (`finishPicking`) so a pre-upgrade
 * DB converges to `done` / `parked` on the first tick instead of stranding forever.
 */
export async function sweepStrandedPicking(deps: PipelineTickDeps): Promise<void> {
  const { repo, clock, gateway } = deps;
  for (const request of repo.listRequestsInQueueOrder()) {
    if (request.status !== "picking") continue;
    try {
      const pickCount = repo.listPublishedForRequest(request.id).length;
      const next = finishPicking(request, { pickCount });
      if (next.status === request.status) continue; // 0 picks — nothing to resolve
      repo.saveRequest(next);
      await refreshBatchStatus({ repo, slack: gateway, clock }, next.sku);
    } catch (err) {
      reportItemError(
        deps,
        `sweepStrandedPicking failed for Request ${request.id} (${request.sku})`,
        err,
      );
    }
  }
}

/**
 * Self-heal: re-host any published image whose bytes went missing from the volume (e.g. due to a
 * previous hosting failure that persisted the row but not the bytes). Idempotent — checks each
 * PublishedImage against the store; re-hosts if missing. Best-effort; errors are logged and
 * skipped (a re-host from the same source URL may fail the same way, but the row is durable).
 * Runs on every tick.
 */
export async function rehostMissingPublishedImages(
  deps: PipelineTickDeps,
): Promise<void> {
  const { repo, imageStore, onItemError } = deps;

  // ImageStore.exists is optional; skip if not implemented (e.g. cloud storage).
  if (!imageStore.exists) return;

  for (const published of repo.allPublishedImages?.() ?? []) {
    try {
      const exists = await imageStore.exists(published.filename);
      if (exists) continue;

      // Bytes are missing; fetch the source attempt and re-host if it has a URL.
      const attempt = repo.getAttempt(published.sourceAttemptId);
      if (!attempt || !attempt.resultImageUrl) continue;

      await imageStore.putFromUrl(published.filename, attempt.resultImageUrl);
    } catch (err) {
      reportItemError(
        deps,
        `re-host failed for published image ${published.filename} (Request ${published.requestId})`,
        err,
      );
    }
  }
}

/**
 * F7 / ADR 0019 — periodic self-heal for every still-open batch: (1) re-run the shared refresh
 * routine, which posts the batch status message fresh if it never landed, and retries the
 * completion CSV export if the batch is done but not yet exported; (2) retry any blank-row ask
 * that never posted (a `proposed` SKU with no living thread reply yet) now that the batch's thread
 * root is known to exist. Mirrors the general "keep retrying every tick, self-heal" posture the
 * rest of this file already uses for Drafts/Finals — this is the same idea applied to the batch
 * status surface, so a Slack hiccup at exactly the wrong moment can't permanently strand a batch.
 */
export async function sweepOpenBatches(deps: PipelineTickDeps): Promise<void> {
  const { repo, gateway, clock } = deps;
  const refreshDeps = { repo, slack: gateway, clock };
  for (const imp of repo.listOpenBatches()) {
    try {
      await refreshBatchById(refreshDeps, imp.id);
      const post = repo.getBatchStatusPost(imp.id);
      if (!post) continue; // still couldn't post — retry again next tick

      for (const sku of repo.listSkusForImport(imp.id)) {
        const request = repo.getActiveRequestForSku(sku);
        if (!request || request.status !== "proposed") continue;
        if (repo.getSkuThreadPost(imp.id, sku)) continue; // ask already landed
        const product = repo.getProduct(sku);
        try {
          const posted = await gateway.postBlankRowAsk({
            importId: imp.id,
            sku,
            productName: product?.name ?? sku,
            proposedText: request.shotIdeaText,
            threadTs: post.slackTs,
          });
          repo.saveSkuThreadPost({
            importId: imp.id,
            sku,
            slackChannel: posted.channel,
            slackTs: posted.ts,
            stage: "ask",
            requestId: null,
            proposedText: request.shotIdeaText,
            updatedAt: clock.now(),
          });
        } catch (err) {
          reportItemError(
            deps,
            `sweepOpenBatches: failed to post blank-row ask for ${sku} (import ${imp.id})`,
            err,
          );
        }
      }
    } catch (err) {
      reportItemError(deps, `sweepOpenBatches failed for import ${imp.id}`, err);
    }
  }
}

export async function runPipelineTick(deps: PipelineTickDeps): Promise<void> {
  await startConfirmedDrafts(deps);
  await startRetryDrafts(deps);
  await startApprovedFinals(deps);
  await resolvePendingGenerations(deps);
  await rehostMissingPublishedImages(deps);
  await publishReadyFinals(deps);
  await sweepStrandedPicking(deps);
  await sweepOpenBatches(deps);
}
