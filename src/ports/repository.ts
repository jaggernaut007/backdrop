import type {
  BatchStatusPost,
  BlankRowAsk,
  CatalogImport,
  Decision,
  GenerationAttempt,
  Product,
  PublishedImage,
  ReviewPost,
  ShotRequest,
  ShotRequestStatus,
  SkuThreadPost,
} from "../domain/types.js";

/**
 * The persistence surface. Synchronous by design — the adapter is better-sqlite3, whose API is
 * fully synchronous (docs/libraries/datastore-and-http.md). The in-memory fake mirrors that.
 *
 * All writes are last-writer-wins upserts keyed by the entity's identity.
 */
export interface Repository {
  // --- CatalogImport ---------------------------------------------------------
  /** Idempotency check: has this exact CSV content already been ingested? */
  findImportByContentHash(hash: string): CatalogImport | null;
  saveImport(record: CatalogImport): void;

  // --- Product -------------------------------------------------------------
  upsertProduct(product: Product): void;
  getProduct(sku: string): Product | null;
  listProducts(): Product[];

  // --- ShotRequest ------------------------------------------------------------
  /** The single active (non-terminal) Request for a SKU, if any (DOMAIN.md invariant). */
  getActiveRequestForSku(sku: string): ShotRequest | null;
  /**
   * Every Request ever opened for a SKU, all statuses, oldest Idea revision first. The F1
   * idempotency guard and `NewIdeaRevisionDetected` both need to see terminal Requests, which
   * `getActiveRequestForSku` hides.
   */
  listRequestsForSku(sku: string): ShotRequest[];
  getRequest(id: string): ShotRequest | null;
  saveRequest(request: ShotRequest): void;
  /**
   * Every Request in exactly this status, oldest first (`createdAt` asc, then `id`). Drives the
   * pipeline tick's `confirmed` / `approved` / `finalizing` sweeps.
   */
  listRequestsByStatus(status: ShotRequestStatus): ShotRequest[];
  /** Queue order: priorityRank desc, then createdAt asc. */
  listRequestsInQueueOrder(): ShotRequest[];

  // --- GenerationAttempt ----------------------------------------------------
  saveAttempt(attempt: GenerationAttempt): void;
  getAttempt(id: string): GenerationAttempt | null;
  listAttemptsForRequest(requestId: string): GenerationAttempt[];
  /** Attempts whose Luma generation is still in flight (status = pending). */
  listPendingAttempts(): GenerationAttempt[];

  // --- ReviewPost ----------------------------------------------------------
  saveReviewPost(post: ReviewPost): void;
  getReviewPostBySlackTs(channel: string, ts: string): ReviewPost | null;
  getLatestReviewPostForRequest(
    requestId: string,
    kind: "draft" | "finals",
  ): ReviewPost | null;

  // --- Decision ----------------------------------------------------------
  saveDecision(decision: Decision): void;
  listDecisionsForRequest(requestId: string): Decision[];

  // --- PublishedImage ----------------------------------------------------
  /** Upsert keyed by `filename` — re-publishing a pick overwrites its row (ADR 0008). */
  savePublishedImage(image: PublishedImage): void;
  /**
   * Every published pick for a Request, `sequence` (pick order) ascending. `handle-pick` reads the
   * count to assign the next sequence and de-dupes by `sourceAttemptId`, so the ordering is
   * load-bearing; the contract suite pins it against InMemory and SQLite.
   */
  listPublishedForRequest(requestId: string): PublishedImage[];
  /** Every published image across all Requests (for self-healing / audits). */
  allPublishedImages?(): PublishedImage[];

  // --- BlankRowAsk (F2 correlation) --------------------------------------
  saveBlankRowAsk(ask: BlankRowAsk): void;
  getBlankRowAskBySlackTs(channel: string, ts: string): BlankRowAsk | null;
  getBlankRowAskBySku(sku: string): BlankRowAsk | null;

  // --- CatalogImportRow (F7 batch membership) ----------------------------
  saveCatalogImportRow(importId: string, sku: string): void;
  /** Every SKU one CatalogImport touched, insertion order. */
  listSkusForImport(importId: string): string[];
  /**
   * Every still-open (no `batch_status_posts` row yet, or one with `completedAt` unset) import
   * that lists this SKU — a SKU can be open in more than one batch at once (Wave 7 rule: a CSV
   * re-upload always starts a fresh batch, no merging with a still-open prior one).
   */
  listOpenImportIdsForSku(sku: string): string[];

  // --- BatchStatusPost (F7) ----------------------------------------------
  saveBatchStatusPost(post: BatchStatusPost): void;
  getBatchStatusPost(importId: string): BatchStatusPost | null;
  getBatchStatusPostBySlackTs(channel: string, ts: string): BatchStatusPost | null;
  markBatchCompleted(importId: string, at: string): void;
  markBatchExportUploaded(importId: string, at: string): void;
  /** Batches with no `completedAt` yet — the periodic-sweep retry target. */
  listOpenBatches(): CatalogImport[];

  // --- SkuThreadPost (F7 — one living reply per {batch, sku}) -------------
  saveSkuThreadPost(post: SkuThreadPost): void;
  getSkuThreadPost(importId: string, sku: string): SkuThreadPost | null;
  getSkuThreadPostBySlackTs(channel: string, ts: string): SkuThreadPost | null;

  // --- SpendLedger (read model) ----------------------------------------
  /** Running total across every GenerationAttempt, success or failure. */
  totalSpendCents(): number;
}
