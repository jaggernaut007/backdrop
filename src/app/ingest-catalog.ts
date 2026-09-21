/**
 * F1 — Catalog intake. Idempotent ingest of a customer Export: upsert Products, open one Request
 * per SKU that carries a Shot Idea, summarise to the channel. A blank row opens a `proposed`
 * Request instead; a human then confirms it via `captureShotIdea`.
 *
 * Wave 7 / ADR 0019: every row (blank or not) is registered against this import
 * (`catalog_import_rows`), and — after the summary — the batch status post goes up fresh (always a
 * new message per upload, never merged with a still-open prior batch), one line per row. A blank
 * row's ask is then posted as that SKU's living thread reply underneath it (`postBlankRowAsk` with
 * `threadTs`), replacing the old top-level per-SKU message.
 *
 * Orchestration only — every rule lives in `domain/` (price, colorset, notes, import-summary,
 * shot-idea-proposal, batch-status) or in the aggregate. Idempotency is two layers (ADR 0013): a
 * content-hash short-circuit for an identical re-drop, and a per-SKU guard (`prior.length === 0`,
 * checked against ALL statuses — not just active ones, so an already-`done`/`parked`/`failed` SKU
 * is never re-opened) so a *different* Export that re-lists a known SKU opens nothing new.
 * `NewIdeaRevisionDetected` (changed Shot Idea on a known SKU) is named in the summary and opens
 * nothing — superseding revisions are out of scope (ASSUMPTIONS.md B2).
 */
import { createHash, randomUUID } from "node:crypto";

import { parseCatalogCsv } from "../adapters/csv.js";
import { toColorSet } from "../domain/colorset.js";
import { renderImportSummary } from "../domain/import-summary.js";
import { interpretNotes } from "../domain/notes.js";
import { parsePriceCents } from "../domain/price.js";
import { composeShotIdeaProposal } from "../domain/shot-idea-proposal.js";
import type { CatalogImport, Product, ShotRequest } from "../domain/types.js";
import type { Clock } from "../ports/clock.js";
import type { Repository } from "../ports/repository.js";
import type { SlackGateway } from "../ports/slack-gateway.js";
import { refreshBatchById } from "./refresh-batch-status.js";

/** Notes-derived priority lifts a Request above the un-prioritised ones (SPEC F1 queue scenario). */
const PRIORITY_RANK = 100;

/**
 * ADR 0020 / ASSUMPTIONS.md — "rejected products return in the next batch": a SKU whose prior
 * Requests are all terminal-but-not-done (`parked` / `failed`) is re-openable by a fresh CSV drop
 * (as a new `ideaRevision`). A prior `done` — or any still-active Request — still blocks, preserving
 * the F1 idempotency invariant that a finished SKU is never silently re-opened.
 */
function isReopenable(prior: readonly ShotRequest[]): boolean {
  return (
    prior.length > 0 &&
    prior.every((r) => r.status === "parked" || r.status === "failed")
  );
}

/** Next `ideaRevision` for a re-opened SKU — one past its highest prior revision. */
function nextIdeaRevision(prior: readonly ShotRequest[]): number {
  return prior.reduce((max, r) => Math.max(max, r.ideaRevision), 0) + 1;
}

export interface IngestCatalogDeps {
  readonly repo: Repository;
  readonly slack: SlackGateway;
  readonly clock: Clock;
}

export interface IngestCatalogInput {
  readonly csv: string | Buffer;
  /** Where the CSV came from — a Slack file id in production, a label in tests. */
  readonly sourceRef: string;
}

export interface IngestCatalogResult {
  /** True when this exact CSV content was already ingested — nothing was written, nothing posted. */
  readonly alreadyIngested: boolean;
  readonly importId: string;
  readonly rowCount: number;
  readonly nWithIdea: number;
  readonly nBlank: number;
  /** SKUs in this Export that already have a `done` Request in our system (not a CSV column). */
  readonly nDone: number;
  readonly productsUpserted: number;
  readonly requestsOpened: number;
  /** SKUs whose Shot Idea text changed since a prior import — flagged, not acted on. */
  readonly newIdeaRevisionSkus: string[];
  /**
   * False when the ingest fully succeeded but the summary post to Slack threw. The durable state
   * (Products, Requests, CatalogImport) is committed either way; the caller decides whether to
   * retry the post or alert. Undefined on an `alreadyIngested` short-circuit.
   */
  readonly summaryPosted?: boolean;
  /** Whether the batch status post (Wave 7 / ADR 0019) went up. Self-heals via `refreshBatchStatus`
   *  / the pipeline-tick sweep if this is false. Undefined on an `alreadyIngested` short-circuit. */
  readonly batchStatusPosted?: boolean;
  /**
   * How many blank-row asks were successfully posted to Slack (F2). The `proposed` Request is
   * durable either way; a post that throws is skipped here and retried by the pipeline-tick sweep.
   * Undefined on an `alreadyIngested` short-circuit.
   */
  readonly blankRowAsksPosted?: number;
}

/**
 * Ingest one customer Export. Idempotent (ADR 0013):
 *  - an identical re-drop short-circuits on the SHA-256 content hash — returns
 *    `{ alreadyIngested: true }`, writes nothing, posts nothing;
 *  - a *different* Export re-listing a known SKU with the *same* Shot Idea text is a per-row no-op;
 *  - the same SKU with *changed* Shot Idea text is returned in `newIdeaRevisionSkus` and named on
 *    the summary's second line, but opens no Request (superseding revisions cut — ASSUMPTIONS.md B2).
 *
 * Side effects on a fresh Export: upsert one Product per row; open one `confirmed`, `sheet`-origin
 * Request at revision 1 per new Shot Idea (a priority note lifts `priorityRank`), or one `proposed`
 * Request per new blank row; write the `CatalogImport` row last; post the summary, then the batch
 * status post (one row per SKU in this import), then one thread-reply ask per new blank row.
 * `throw`s only if a row's `Price` won't parse or the CSV is structurally invalid — a failed
 * *summary post*, *batch status post*, or *blank-row ask post* is caught and surfaced on the
 * result, not a rejection (best-effort, same posture as before Wave 7).
 */
export async function ingestCatalog(
  deps: IngestCatalogDeps,
  input: IngestCatalogInput,
): Promise<IngestCatalogResult> {
  const { repo, slack, clock } = deps;

  const buf =
    typeof input.csv === "string" ? Buffer.from(input.csv, "utf8") : input.csv;
  const contentHash = createHash("sha256").update(buf).digest("hex");

  const seen = repo.findImportByContentHash(contentHash);
  if (seen) {
    return {
      alreadyIngested: true,
      importId: seen.id,
      rowCount: seen.rowCount,
      nWithIdea: seen.nWithIdea,
      nBlank: seen.nBlank,
      nDone: seen.nDone,
      productsUpserted: 0,
      requestsOpened: 0,
      newIdeaRevisionSkus: [],
    };
  }

  const rows = parseCatalogCsv(buf);
  const now = clock.now();
  const importId = randomUUID();

  let nWithIdea = 0;
  let nBlank = 0;
  let nDone = 0;
  let requestsOpened = 0;
  const newIdeaRevisionSkus: string[] = [];
  const pendingAsks: { sku: string; productName: string; proposedText: string }[] =
    [];

  // --- synchronous span: hash-check above → saveImport + row registration below. No `await` in
  //     here, so two concurrent file_shared handlers cannot both pass the guard (ADR 0013).
  //     Blank-row asks are only *staged* here (`pendingAsks`) — the Slack post itself happens after
  //     this span. Row registration (`catalog_import_rows`, Wave 7) is deferred to *after*
  //     `saveImport` because its `import_id` has an FK to `catalog_imports(id)` — the parent row
  //     must exist first. ---
  for (const row of rows) {
    const product: Product = {
      sku: row.sku,
      name: row.productName,
      category: row.category,
      colorRaw: row.colorFinish,
      colorSet: toColorSet(row.colorFinish),
      material: row.material,
      priceCents: parsePriceCents(row.price),
      photoUrl: row.photo,
      notesRaw: row.notes,
      updatedAt: now,
    };
    repo.upsertProduct(product);

    const prior = repo.listRequestsForSku(row.sku);
    if (prior.some((r) => r.status === "done")) {
      nDone += 1; // "J already done" in the summary — a fact about our state, not the file
    }

    const notes = interpretNotes(row.notes);
    const ideaText = row.shotIdea.trim();
    if (ideaText === "") {
      nBlank += 1;
      // Idempotency (F2): a re-drop that still lists this SKU blank must not re-propose or
      // re-post the ask — except when its prior Requests are all `parked`/`failed` (ADR 0020: the
      // product returns in the next batch), in which case re-propose as a fresh revision.
      if (prior.length === 0 || isReopenable(prior)) {
        const proposedText = composeShotIdeaProposal(product);
        const proposedRequest: ShotRequest = {
          id: randomUUID(),
          sku: row.sku,
          ideaRevision: nextIdeaRevision(prior),
          status: "proposed",
          shotIdeaText: proposedText,
          shotIdeaOrigin: "proposed",
          priorityRank: notes.priority ? PRIORITY_RANK : 0,
          riskFlags: notes.generationRisk,
          lifecycleFlag: notes.lifecycleConcern,
          bundlingFlag: notes.bundlingIntent,
          retryUsed: false,
          createdAt: now,
          draftPostedAt: null,
          escalatedAt: null,
        };
        repo.saveRequest(proposedRequest);
        pendingAsks.push({
          sku: row.sku,
          productName: row.productName,
          proposedText,
        });
      }
      continue;
    }
    nWithIdea += 1;

    if (prior.some((r) => r.shotIdeaText === ideaText) && !isReopenable(prior)) {
      continue; // this exact Shot Idea already has a live/finished Request — re-drop, no-op
    }
    if (prior.length > 0 && !isReopenable(prior)) {
      newIdeaRevisionSkus.push(row.sku); // changed idea on a known SKU — flag, open nothing
      continue;
    }

    const request: ShotRequest = {
      id: randomUUID(),
      sku: row.sku,
      ideaRevision: nextIdeaRevision(prior),
      status: "confirmed",
      shotIdeaText: ideaText,
      shotIdeaOrigin: "sheet",
      priorityRank: notes.priority ? PRIORITY_RANK : 0,
      riskFlags: notes.generationRisk,
      lifecycleFlag: notes.lifecycleConcern,
      bundlingFlag: notes.bundlingIntent,
      retryUsed: false,
      createdAt: now,
      draftPostedAt: null,
      escalatedAt: null,
    };
    repo.saveRequest(request);
    requestsOpened += 1;
  }

  const counts = { rowCount: rows.length, nWithIdea, nBlank, nDone };

  const record: CatalogImport = {
    id: importId,
    receivedAt: now,
    sourceRef: input.sourceRef,
    contentHash,
    rowCount: counts.rowCount,
    nWithIdea,
    nBlank,
    nDone,
  };
  repo.saveImport(record); // the guard commit: a crash before here re-ingests cleanly (ADR 0013)

  // Register every row (blank or not) against this import so the batch status post's row list
  // covers the whole Export, not just newly-created Requests. After `saveImport` (FK parent) and
  // still inside the synchronous span. Idempotent (`ON CONFLICT DO NOTHING`), so a crash between
  // `saveImport` and here just means the re-drop — no-op'd by the hash guard — leaves a thin row
  // list that the next real transition's `refreshBatchStatus` cannot widen; acceptable for a
  // microsecond window of purely synchronous code.
  for (const row of rows) {
    repo.saveCatalogImportRow(importId, row.sku);
  }

  // The post is best-effort: the ingest has already committed. A failure here must not make the
  // whole call reject (that would drive slack-events into its "couldn't ingest" error path for a
  // success) and must not be retried by re-dropping the file (the hash guard would no-op it).
  let summaryPosted = true;
  try {
    await slack.postImportSummary(
      renderImportSummary(counts, newIdeaRevisionSkus),
    );
  } catch {
    summaryPosted = false;
  }

  // Wave 7 / ADR 0019 (revised Wave 8): the batch status post goes up through the SAME code path
  // every later transition uses — `refreshBatchById` — rather than a bespoke first-post here. That
  // path is serialized per import (a lock in `refresh-batch-status.ts`) and derives each row's
  // label from `resolveSkuStatus` (active-or-latest Request), so a concurrent job-loop
  // `refreshBatchStatus` can't race us into a duplicate message, and a re-listed already-terminal
  // SKU is labelled from its real last status instead of an "assume done" fallback. Best-effort:
  // `refreshBatchById` swallows its own Slack errors, so we detect success by whether the post row
  // landed. `sweepOpenBatches` retries a miss on the next tick.
  try {
    await refreshBatchById({ repo, slack, clock }, importId);
  } catch {
    // refreshBatchById is best-effort and shouldn't throw; fall through to the row check.
  }
  const batchPost = repo.getBatchStatusPost(importId);
  const batchStatusPosted = batchPost !== null;
  const threadTs: string | null = batchPost?.slackTs ?? null;

  // F2: one ask per blank row, posted as that SKU's living thread reply under the batch status
  // post. Skipped entirely if the batch status post itself failed (no thread to anchor into) — the
  // pipeline-tick sweep retries both together once the batch post self-heals.
  let blankRowAsksPosted = 0;
  if (threadTs) {
    for (const ask of pendingAsks) {
      try {
        const posted = await slack.postBlankRowAsk({ ...ask, importId, threadTs });
        repo.saveSkuThreadPost({
          importId,
          sku: ask.sku,
          slackChannel: posted.channel,
          slackTs: posted.ts,
          stage: "ask",
          requestId: null,
          proposedText: ask.proposedText,
          updatedAt: now,
        });
        blankRowAsksPosted += 1;
      } catch {
        // best-effort — the `proposed` Request stays open; the pipeline-tick sweep retries the post.
      }
    }
  }

  return {
    alreadyIngested: false,
    importId,
    rowCount: counts.rowCount,
    nWithIdea,
    nBlank,
    nDone,
    productsUpserted: rows.length,
    requestsOpened,
    newIdeaRevisionSkus,
    summaryPosted,
    batchStatusPosted,
    blankRowAsksPosted,
  };
}
