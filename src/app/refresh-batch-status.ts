/**
 * F7 / ADR 0019 — the shared hook every status-changing `saveRequest` calls: recompute a batch's
 * status post from current repo state and push it to Slack (posting fresh if this batch's initial
 * post never landed — self-healing), and — once every row in the batch is terminal — export +
 * upload the completion CSV, exactly once (`markBatchExportUploaded` is the guard).
 *
 * Deps mirror the other app-layer use-cases: synchronous repo, async Slack gateway. Never throws —
 * a Slack failure here must not roll back the caller's already-durable `saveRequest` (same posture
 * as `handle-decision.ts`'s cosmetic swaps). A SKU can be open in more than one
 * batch at once (a CSV re-upload always starts a fresh batch, never merges with a still-open prior
 * one — Wave 7 rule), so this refreshes every open batch that lists the SKU, not just one.
 */
import { friendlyStatusLabel, isBatchComplete } from "../domain/batch-status.js";
import type { ShotRequestStatus } from "../domain/types.js";
import type { Clock } from "../ports/clock.js";
import type { Repository } from "../ports/repository.js";
import type { BatchStatusRow, SlackGateway } from "../ports/slack-gateway.js";
import { exportBatchCsv } from "./export-batch-csv.js";

export interface RefreshBatchStatusDeps {
  readonly repo: Repository;
  readonly slack: SlackGateway;
  readonly clock: Clock;
}

/**
 * Per-import serialization for everything that writes a batch's Slack surface — the initial status
 * post, every in-place `chat.update`, and the one-shot completion CSV. Without it, two callers
 * racing for the same import (ingest's first post vs. a concurrent job-loop `refreshBatchStatus`,
 * or two `refreshBatchById` entrants on completion) could **both** take the "no post row yet"
 * self-heal branch — a duplicate "Batch status" message — or **both** pass the `exportUploadedAt`
 * check — a duplicate CSV upload. In-process only; sufficient given the single Railway replica
 * (ADR 0011). The map holds one settled promise per import id ever seen — bounded by CSV uploads,
 * negligible.
 */
const importLocks = new Map<string, Promise<unknown>>();

function withImportLock<T>(
  importId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = importLocks.get(importId) ?? Promise.resolve();
  const run = prior.then(fn, fn); // run `fn` regardless of the prior holder's outcome
  importLocks.set(
    importId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** A SKU's current status for the row: the active Request if one exists, else the most recent
 *  (terminal) one. `null` only for a SKU that somehow never got a Request — not expected for a row
 *  that went through ingest, but resolved to "skip" rather than a throw. */
function resolveSkuStatus(
  repo: Repository,
  sku: string,
): ShotRequestStatus | null {
  const active = repo.getActiveRequestForSku(sku);
  if (active) return active.status;
  const all = repo.listRequestsForSku(sku);
  return all.length > 0 ? (all[all.length - 1]?.status ?? null) : null;
}

/**
 * Refresh (or self-heal, or complete+export) exactly one batch by id — the shared core also used
 * by `run-pipeline-tick.ts`'s `sweepOpenBatches`, which needs a batch's status post's `ts` to exist
 * before it can retry a blank-row ask into that thread.
 */
export function refreshBatchById(
  deps: RefreshBatchStatusDeps,
  importId: string,
): Promise<void> {
  return withImportLock(importId, () => refreshBatchByIdInner(deps, importId));
}

async function refreshBatchByIdInner(
  deps: RefreshBatchStatusDeps,
  importId: string,
): Promise<void> {
  const { repo, slack, clock } = deps;
  const skus = repo.listSkusForImport(importId);
  if (skus.length === 0) return;

  const rows: BatchStatusRow[] = [];
  const statuses: ShotRequestStatus[] = [];
  for (const sku of skus) {
    const status = resolveSkuStatus(repo, sku);
    if (!status) continue;
    const product = repo.getProduct(sku);
    const hasLivingPost = repo.getSkuThreadPost(importId, sku) !== null;
    rows.push({
      sku,
      productName: product?.name ?? sku,
      label: friendlyStatusLabel(status, hasLivingPost),
    });
    statuses.push(status);
  }

  const existingPost = repo.getBatchStatusPost(importId);
  try {
    if (existingPost) {
      await slack.upsertBatchStatus({
        existing: {
          channel: existingPost.slackChannel,
          ts: existingPost.slackTs,
        },
        rows,
      });
    } else {
      // Self-heal: this batch's initial post (normally made by `ingestCatalog`) never landed —
      // post it now rather than leaving the batch permanently invisible.
      const posted = await slack.upsertBatchStatus({ rows });
      repo.saveBatchStatusPost({
        importId,
        slackChannel: posted.channel,
        slackTs: posted.ts,
        completedAt: null,
        exportUploadedAt: null,
      });
    }
  } catch {
    // Best-effort — durable Request state is unaffected. Retried on the next transition or by the
    // periodic sweep (`run-pipeline-tick.ts` `sweepOpenBatches`).
    return;
  }

  const post = repo.getBatchStatusPost(importId);
  if (!post || post.exportUploadedAt || !isBatchComplete(statuses)) return;

  // Export + upload the completion CSV, THEN mark the batch done. `markBatchCompleted` is last: if
  // the export/upload throws, `completedAt` stays null so the batch is still returned by
  // `listOpenBatches` / `listOpenImportIdsForSku` and the next transition or sweep retries it.
  // `exportUploadedAt` (checked at the top of this function) is the exactly-once guard.
  const now = clock.now();
  try {
    await exportBatchCsv(deps, importId);
    repo.markBatchExportUploaded(importId, now);
    repo.markBatchCompleted(importId, now);
  } catch {
    // Best-effort — the batch stays open; `sweepOpenBatches` retries the export next tick.
  }
}

export async function refreshBatchStatus(
  deps: RefreshBatchStatusDeps,
  sku: string,
): Promise<void> {
  const importIds = deps.repo.listOpenImportIdsForSku(sku);
  for (const importId of importIds) {
    try {
      await refreshBatchById(deps, importId);
    } catch {
      // Never let a batch-refresh failure propagate to the caller — see file header.
    }
  }
}
