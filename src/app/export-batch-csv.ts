/**
 * F7 / ADR 0019 — build and upload the batch-completion CSV: the original 9 catalog columns (blank
 * Shot Ideas now filled in from the confirmed `ShotRequest`) plus `Status` and `Final Image URL`.
 * Called once per completed batch, from `refresh-batch-status.ts` (inline, right on completion)
 * and `run-pipeline-tick.ts`'s `sweepOpenBatches` (retry) — the `exportUploadedAt` idempotency
 * guard lives in both those callers, not here, so this function itself is a plain "do it" with no
 * upload-once bookkeeping of its own.
 *
 * Throws if the batch has no status post yet (`getBatchStatusPost` is null) — a defensive guard;
 * both callers only reach here after that post exists. A failed Slack upload propagates as a
 * rejected promise for the caller to swallow and retry on the next sweep.
 *
 * The CSV is uploaded once to the channel root (not the batch's thread) so the finished file is
 * visible without expanding a thread — the exactly-once guard (`exportUploadedAt`) plus the
 * per-import lock in `refresh-batch-status.ts` keep it to a single upload.
 */
import { renderExportCsv } from "../adapters/csv.js";
import { buildExportRow } from "../domain/export-csv.js";
import type { Repository } from "../ports/repository.js";
import type { SlackGateway } from "../ports/slack-gateway.js";

export interface ExportBatchCsvDeps {
  readonly repo: Repository;
  readonly slack: SlackGateway;
}

export async function exportBatchCsv(
  deps: ExportBatchCsvDeps,
  importId: string,
): Promise<void> {
  const { repo, slack } = deps;
  const post = repo.getBatchStatusPost(importId);
  if (!post) {
    throw new Error(
      `exportBatchCsv: no batch status post for import ${importId}`,
    );
  }

  const skus = repo.listSkusForImport(importId);
  const rows = skus.flatMap((sku) => {
    const product = repo.getProduct(sku);
    if (!product) return []; // shouldn't happen for a row that went through ingest; skip, don't throw
    const active = repo.getActiveRequestForSku(sku);
    const all = repo.listRequestsForSku(sku);
    const request = active ?? (all.length > 0 ? (all[all.length - 1] ?? null) : null);
    const published = request ? repo.listPublishedForRequest(request.id) : [];
    return [buildExportRow(product, request, published)];
  });

  const content = renderExportCsv(rows);
  await slack.uploadBatchExportCsv({
    filename: `catalog-export-${importId}.csv`,
    content,
  });
}
