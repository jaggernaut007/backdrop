import { isTerminal } from "../../src/domain/lifecycle.js";
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
} from "../../src/domain/types.js";
import type { Repository } from "../../src/ports/repository.js";

/** Total order on ISO timestamps, then id — a strict weak ordering even when timestamps tie
 *  (same-tick writes under FakeClock, e.g. the three finals of one direction). */
function byCreatedAtThenId<T extends { createdAt: string; id: string }>(
  a: T,
  b: T,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Decisions order by `at` then `id` — matches the SQLite adapter's `ORDER BY at ASC, id ASC`. */
function byAtThenId(a: Decision, b: Decision): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Map-backed Repository. Mirrors the synchronous contract of the SQLite adapter. */
export class InMemoryRepository implements Repository {
  private imports = new Map<string, CatalogImport>();
  private products = new Map<string, Product>();
  private requests = new Map<string, ShotRequest>();
  private attempts = new Map<string, GenerationAttempt>();
  private reviewPosts = new Map<string, ReviewPost>();
  private published = new Map<string, PublishedImage>();
  private blankRowAsks = new Map<string, BlankRowAsk>();
  // Keyed by id so a re-save is a last-writer-wins upsert (port contract), matching the SQLite
  // adapter's `ON CONFLICT(id) DO UPDATE`. A Map also preserves first-insert order.
  private decisionsById = new Map<string, Decision>();
  // F7 (Wave 7 / ADR 0019) — batch status post state.
  private importRows: { importId: string; sku: string }[] = [];
  private batchStatusPosts = new Map<string, BatchStatusPost>(); // keyed by importId
  private skuThreadPosts = new Map<string, SkuThreadPost>(); // keyed by `${importId}\u0000${sku}`

  // --- CatalogImport ---------------------------------------------------------
  findImportByContentHash(hash: string): CatalogImport | null {
    for (const imp of this.imports.values()) {
      if (imp.contentHash === hash) return imp;
    }
    return null;
  }
  saveImport(record: CatalogImport): void {
    this.imports.set(record.id, record);
  }

  // --- Product -------------------------------------------------------------
  upsertProduct(product: Product): void {
    this.products.set(product.sku, product);
  }
  getProduct(sku: string): Product | null {
    return this.products.get(sku) ?? null;
  }
  listProducts(): Product[] {
    // SQLite adapter is `ORDER BY sku ASC`.
    return [...this.products.values()].sort((a, b) =>
      a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0,
    );
  }

  // --- ShotRequest ------------------------------------------------------------
  getActiveRequestForSku(sku: string): ShotRequest | null {
    // The single active Request = the highest idea revision that isn't terminal (SQLite adapter
    // is `... AND status NOT IN (terminal) ORDER BY idea_revision DESC LIMIT 1`).
    const active = [...this.requests.values()]
      .filter((r) => r.sku === sku && !isTerminal(r.status))
      .sort((a, b) =>
        a.ideaRevision !== b.ideaRevision
          ? b.ideaRevision - a.ideaRevision
          : byCreatedAtThenId(a, b),
      );
    return active[0] ?? null;
  }
  listRequestsForSku(sku: string): ShotRequest[] {
    return [...this.requests.values()]
      .filter((r) => r.sku === sku)
      .sort((a, b) =>
        a.ideaRevision !== b.ideaRevision
          ? a.ideaRevision - b.ideaRevision
          : byCreatedAtThenId(a, b),
      );
  }
  getRequest(id: string): ShotRequest | null {
    return this.requests.get(id) ?? null;
  }
  saveRequest(request: ShotRequest): void {
    this.requests.set(request.id, request);
  }
  listRequestsByStatus(status: ShotRequestStatus): ShotRequest[] {
    // SQLite adapter is `ORDER BY created_at ASC, id ASC`.
    return [...this.requests.values()]
      .filter((r) => r.status === status)
      .sort(byCreatedAtThenId);
  }
  /** Active (non-terminal) Requests only, priorityRank desc then createdAt asc then id asc. */
  listRequestsInQueueOrder(): ShotRequest[] {
    return [...this.requests.values()]
      .filter((r) => !isTerminal(r.status))
      .sort((a, b) => {
        if (a.priorityRank !== b.priorityRank)
          return b.priorityRank - a.priorityRank;
        return byCreatedAtThenId(a, b);
      });
  }

  // --- GenerationAttempt ----------------------------------------------------
  saveAttempt(attempt: GenerationAttempt): void {
    this.attempts.set(attempt.id, attempt);
  }
  getAttempt(id: string): GenerationAttempt | null {
    return this.attempts.get(id) ?? null;
  }
  listAttemptsForRequest(requestId: string): GenerationAttempt[] {
    return [...this.attempts.values()]
      .filter((a) => a.requestId === requestId)
      .sort(byCreatedAtThenId);
  }
  listPendingAttempts(): GenerationAttempt[] {
    // SQLite adapter is `WHERE status = 'pending' ORDER BY created_at ASC, id ASC`.
    return [...this.attempts.values()]
      .filter((a) => a.status === "pending")
      .sort(byCreatedAtThenId);
  }

  // --- ReviewPost ----------------------------------------------------------
  saveReviewPost(post: ReviewPost): void {
    // Mirror the SQLite adapter's `UNIQUE(slack_channel, slack_ts, kind)` (Wave 7 widened the
    // index from `(channel, ts)` so one shared thread reply can carry a `draft` row AND a `finals`
    // row): a *different* row at the same `(channel, ts, kind)` is a constraint violation — e.g. a
    // retry Draft that forgot to reuse the first Draft's `ReviewPost` id.
    for (const existing of this.reviewPosts.values()) {
      if (
        existing.id !== post.id &&
        existing.slackChannel === post.slackChannel &&
        existing.slackTs === post.slackTs &&
        existing.kind === post.kind
      ) {
        throw new Error(
          "UNIQUE constraint failed: review_posts.slack_channel, review_posts.slack_ts, review_posts.kind",
        );
      }
    }
    this.reviewPosts.set(post.id, post);
  }
  getReviewPostBySlackTs(channel: string, ts: string): ReviewPost | null {
    for (const p of this.reviewPosts.values()) {
      if (p.slackChannel === channel && p.slackTs === ts) return p;
    }
    return null;
  }
  getLatestReviewPostForRequest(
    requestId: string,
    kind: "draft" | "finals",
  ): ReviewPost | null {
    // "latest" = greatest createdAt (then id). The SQLite adapter uses the same ORDER BY … LIMIT 1,
    // so a retry's second draft ReviewPost (SPEC F3b) resolves identically in both.
    const matches = [...this.reviewPosts.values()]
      .filter((p) => p.requestId === requestId && p.kind === kind)
      .sort(byCreatedAtThenId);
    return matches.length > 0 ? (matches[matches.length - 1] ?? null) : null;
  }

  // --- Decision ----------------------------------------------------------
  saveDecision(decision: Decision): void {
    this.decisionsById.set(decision.id, decision);
  }
  listDecisionsForRequest(requestId: string): Decision[] {
    return [...this.decisionsById.values()]
      .filter((d) => d.requestId === requestId)
      .sort(byAtThenId);
  }

  // --- PublishedImage ----------------------------------------------------
  savePublishedImage(image: PublishedImage): void {
    this.published.set(image.filename, image);
  }
  listPublishedForRequest(requestId: string): PublishedImage[] {
    return [...this.published.values()]
      .filter((p) => p.requestId === requestId)
      .sort((a, b) => a.sequence - b.sequence);
  }
  allPublishedImages(): PublishedImage[] {
    return [...this.published.values()].sort(
      (a, b) => a.sequence - b.sequence || a.filename.localeCompare(b.filename),
    );
  }

  // --- BlankRowAsk -----------------------------------------------------
  saveBlankRowAsk(ask: BlankRowAsk): void {
    this.blankRowAsks.set(ask.sku, ask);
  }
  getBlankRowAskBySlackTs(channel: string, ts: string): BlankRowAsk | null {
    for (const b of this.blankRowAsks.values()) {
      if (b.slackChannel === channel && b.slackTs === ts) return b;
    }
    return null;
  }
  getBlankRowAskBySku(sku: string): BlankRowAsk | null {
    return this.blankRowAsks.get(sku) ?? null;
  }

  // --- CatalogImportRow (F7) ---------------------------------------------
  saveCatalogImportRow(importId: string, sku: string): void {
    // Mirror the SQLite adapter's FK: `catalog_import_rows.import_id REFERENCES catalog_imports(id)`
    // with `foreign_keys = ON` — the parent import must be persisted first (`ingest-catalog.ts`
    // writes rows *after* `saveImport`).
    if (!this.imports.has(importId)) {
      throw new Error("FOREIGN KEY constraint failed");
    }
    if (this.importRows.some((r) => r.importId === importId && r.sku === sku))
      return;
    this.importRows.push({ importId, sku });
  }
  listSkusForImport(importId: string): string[] {
    return this.importRows
      .filter((r) => r.importId === importId)
      .map((r) => r.sku);
  }
  listOpenImportIdsForSku(sku: string): string[] {
    // Oldest-open-batch-first — matches the SQLite adapter's `ORDER BY received_at ASC, id ASC`.
    const importIds = [
      ...new Set(
        this.importRows.filter((r) => r.sku === sku).map((r) => r.importId),
      ),
    ];
    return importIds
      .filter((importId) => {
        const post = this.batchStatusPosts.get(importId);
        return !post || post.completedAt === null;
      })
      .sort((a, b) => {
        const ia = this.imports.get(a);
        const ib = this.imports.get(b);
        const ra = ia?.receivedAt ?? "";
        const rb = ib?.receivedAt ?? "";
        if (ra !== rb) return ra < rb ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
  }

  // --- BatchStatusPost (F7) -----------------------------------------------
  saveBatchStatusPost(post: BatchStatusPost): void {
    this.batchStatusPosts.set(post.importId, post);
  }
  getBatchStatusPost(importId: string): BatchStatusPost | null {
    return this.batchStatusPosts.get(importId) ?? null;
  }
  getBatchStatusPostBySlackTs(
    channel: string,
    ts: string,
  ): BatchStatusPost | null {
    for (const p of this.batchStatusPosts.values()) {
      if (p.slackChannel === channel && p.slackTs === ts) return p;
    }
    return null;
  }
  markBatchCompleted(importId: string, at: string): void {
    // Mirrors the SQLite adapter's `AND completed_at IS NULL` — a second completer is a no-op.
    const post = this.batchStatusPosts.get(importId);
    if (post && post.completedAt === null)
      this.batchStatusPosts.set(importId, { ...post, completedAt: at });
  }
  markBatchExportUploaded(importId: string, at: string): void {
    // Mirrors the SQLite adapter's `AND export_uploaded_at IS NULL`.
    const post = this.batchStatusPosts.get(importId);
    if (post && post.exportUploadedAt === null)
      this.batchStatusPosts.set(importId, {
        ...post,
        exportUploadedAt: at,
      });
  }
  listOpenBatches(): CatalogImport[] {
    // SQLite adapter orders `received_at ASC, id ASC`.
    return [...this.imports.values()]
      .filter((imp) => {
        const post = this.batchStatusPosts.get(imp.id);
        return !post || post.completedAt === null;
      })
      .sort((a, b) =>
        a.receivedAt !== b.receivedAt
          ? a.receivedAt < b.receivedAt
            ? -1
            : 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
      );
  }

  // --- SkuThreadPost (F7) --------------------------------------------------
  private threadKey(importId: string, sku: string): string {
    return `${importId} ${sku}`;
  }
  saveSkuThreadPost(post: SkuThreadPost): void {
    this.skuThreadPosts.set(this.threadKey(post.importId, post.sku), post);
  }
  getSkuThreadPost(importId: string, sku: string): SkuThreadPost | null {
    return this.skuThreadPosts.get(this.threadKey(importId, sku)) ?? null;
  }
  getSkuThreadPostBySlackTs(channel: string, ts: string): SkuThreadPost | null {
    for (const p of this.skuThreadPosts.values()) {
      if (p.slackChannel === channel && p.slackTs === ts) return p;
    }
    return null;
  }

  // --- SpendLedger -----------------------------------------------------
  totalSpendCents(): number {
    let sum = 0;
    for (const a of this.attempts.values()) sum += a.spendCents;
    return sum;
  }
}
