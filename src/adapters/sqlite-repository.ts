/**
 * The `Repository` port, backed by `better-sqlite3@13.0.3` (docs/libraries/datastore-and-http.md §1).
 * Raw SQL, one file on the Railway volume, fully synchronous. Schema is created on boot by
 * `migrate()` — the volume mounts at runtime, so this cannot be a pre-deploy step (ADR 0011).
 *
 * Write methods are last-writer-wins upserts on the entity's identity, matching the port contract
 * and `InMemoryRepository`. Ordering guarantees (`listRequestsInQueueOrder`, `listAttemptsForRequest`,
 * `getLatestReviewPostForRequest`) are expressed as `ORDER BY` here and as comparators in the fake;
 * `test/contracts/repository.contract.test.ts` runs one suite against both so they can't drift.
 */
import Database from "better-sqlite3";

import { TERMINAL_STATUSES } from "../domain/lifecycle.js";
import type {
  BatchStatusPost,
  BlankRowAsk,
  CatalogImport,
  ColorSet,
  Decision,
  GenerationAttempt,
  Product,
  PublishedImage,
  ReviewPost,
  ShotRequest,
  ShotRequestStatus,
  SkuThreadPost,
} from "../domain/types.js";
import type { Repository } from "../ports/repository.js";

const TERMINAL = [...TERMINAL_STATUSES];
const TERMINAL_PLACEHOLDERS = TERMINAL.map(() => "?").join(", ");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS catalog_imports (
  id           TEXT PRIMARY KEY,
  received_at  TEXT NOT NULL,
  source_ref   TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  row_count    INTEGER NOT NULL,
  n_with_idea  INTEGER NOT NULL,
  n_blank      INTEGER NOT NULL,
  n_done       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  sku            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL,
  color_raw      TEXT NOT NULL,
  color_set_json TEXT NOT NULL,
  material       TEXT NOT NULL,
  price_cents    INTEGER NOT NULL,
  photo_url      TEXT NOT NULL,
  notes_raw      TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shot_requests (
  id              TEXT PRIMARY KEY,
  sku             TEXT NOT NULL,
  idea_revision   INTEGER NOT NULL,
  status          TEXT NOT NULL,
  shot_idea_text  TEXT NOT NULL,
  shot_idea_origin TEXT NOT NULL,
  priority_rank   INTEGER NOT NULL,
  risk_flags_json TEXT NOT NULL,
  lifecycle_flag  TEXT,
  bundling_flag   TEXT,
  retry_used      INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  draft_posted_at TEXT,
  escalated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_sku ON shot_requests (sku);
CREATE INDEX IF NOT EXISTS idx_requests_status ON shot_requests (status);

CREATE TABLE IF NOT EXISTS generation_attempts (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL,
  kind              TEXT NOT NULL,
  prompt_text       TEXT NOT NULL,
  input_photo_url   TEXT NOT NULL,
  luma_generation_id TEXT,
  result_image_url  TEXT,
  spend_cents       INTEGER NOT NULL,
  status            TEXT NOT NULL,
  reject_reason     TEXT,
  created_at        TEXT NOT NULL,
  completed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_request ON generation_attempts (request_id);
CREATE INDEX IF NOT EXISTS idx_attempts_status ON generation_attempts (status);

CREATE TABLE IF NOT EXISTS review_posts (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL,
  attempt_id    TEXT NOT NULL,
  slack_channel TEXT NOT NULL,
  slack_ts      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_request ON review_posts (request_id);
-- NB: no idx_review_slack_ts here. WIDEN_REVIEW_POSTS_INDEX dropped it; if SCHEMA re-created
-- it (IF NOT EXISTS is true after the drop), any boot with a draft + finals row sharing one
-- (channel, ts) would fail migration with a UNIQUE violation. The 3-column index below owns
-- review_posts' slack uniqueness.

CREATE TABLE IF NOT EXISTS decisions (
  id         TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  attempt_id TEXT,
  actor      TEXT NOT NULL,
  verb       TEXT NOT NULL,
  reason     TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_request ON decisions (request_id);

CREATE TABLE IF NOT EXISTS published_images (
  filename          TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL,
  source_attempt_id TEXT NOT NULL,
  sequence          INTEGER NOT NULL,
  stable_url        TEXT NOT NULL,
  published_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_published_request ON published_images (request_id);

CREATE TABLE IF NOT EXISTS blank_row_asks (
  sku           TEXT PRIMARY KEY,
  slack_channel TEXT NOT NULL,
  slack_ts      TEXT NOT NULL,
  proposed_text TEXT NOT NULL
);

-- Wave 7 / ADR 0019: the batch status post. Additive only — see SCHEMA's header comment.
CREATE TABLE IF NOT EXISTS catalog_import_rows (
  import_id TEXT NOT NULL REFERENCES catalog_imports(id),
  sku       TEXT NOT NULL,
  PRIMARY KEY (import_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_catalog_import_rows_sku ON catalog_import_rows (sku);

CREATE TABLE IF NOT EXISTS batch_status_posts (
  import_id          TEXT PRIMARY KEY REFERENCES catalog_imports(id),
  slack_channel       TEXT NOT NULL,
  slack_ts             TEXT NOT NULL,
  completed_at         TEXT,
  export_uploaded_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_status_slack_ts ON batch_status_posts (slack_channel, slack_ts);

CREATE TABLE IF NOT EXISTS sku_thread_posts (
  import_id      TEXT NOT NULL REFERENCES catalog_imports(id),
  sku            TEXT NOT NULL,
  slack_channel  TEXT NOT NULL,
  slack_ts       TEXT NOT NULL,
  stage          TEXT NOT NULL,
  request_id     TEXT,
  proposed_text  TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (import_id, sku)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sku_thread_slack_ts ON sku_thread_posts (slack_channel, slack_ts);
`;

// Wave 7: widen `review_posts`' uniqueness to include `kind` so one shared Slack message (the
// living per-SKU thread reply) can carry a 'draft' row and, later, a 'finals' row at the SAME
// (channel, ts). Safe to run unconditionally on every boot — every row valid under the old
// UNIQUE(slack_channel, slack_ts) stays valid under the wider one. Run separately from `SCHEMA`
// (not `CREATE TABLE IF NOT EXISTS`-shaped) so it stays a one-line, clearly-labelled exception to
// the file's additive-only convention.
const WIDEN_REVIEW_POSTS_INDEX = `
DROP INDEX IF EXISTS idx_review_slack_ts;
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_slack_ts_kind ON review_posts (slack_channel, slack_ts, kind);
`;

// --- row shapes (snake_case, as SQLite returns them) -------------------------
interface ImportRow {
  id: string;
  received_at: string;
  source_ref: string;
  content_hash: string;
  row_count: number;
  n_with_idea: number;
  n_blank: number;
  n_done: number;
}
interface ProductRow {
  sku: string;
  name: string;
  category: string;
  color_raw: string;
  color_set_json: string;
  material: string;
  price_cents: number;
  photo_url: string;
  notes_raw: string;
  updated_at: string;
}
interface RequestRow {
  id: string;
  sku: string;
  idea_revision: number;
  status: string;
  shot_idea_text: string;
  shot_idea_origin: string;
  priority_rank: number;
  risk_flags_json: string;
  lifecycle_flag: string | null;
  bundling_flag: string | null;
  retry_used: number;
  created_at: string;
  draft_posted_at: string | null;
  escalated_at: string | null;
}
interface AttemptRow {
  id: string;
  request_id: string;
  kind: string;
  prompt_text: string;
  input_photo_url: string;
  luma_generation_id: string | null;
  result_image_url: string | null;
  spend_cents: number;
  status: string;
  reject_reason: string | null;
  created_at: string;
  completed_at: string | null;
}
interface ReviewRow {
  id: string;
  request_id: string;
  attempt_id: string;
  slack_channel: string;
  slack_ts: string;
  kind: string;
  created_at: string;
}
interface DecisionRow {
  id: string;
  request_id: string;
  attempt_id: string | null;
  actor: string;
  verb: string;
  reason: string | null;
  at: string;
}
interface PublishedRow {
  filename: string;
  request_id: string;
  source_attempt_id: string;
  sequence: number;
  stable_url: string;
  published_at: string;
}
interface BlankRowAskRow {
  sku: string;
  slack_channel: string;
  slack_ts: string;
  proposed_text: string;
}
interface BatchStatusPostRow {
  import_id: string;
  slack_channel: string;
  slack_ts: string;
  completed_at: string | null;
  export_uploaded_at: string | null;
}
interface SkuThreadPostRow {
  import_id: string;
  sku: string;
  slack_channel: string;
  slack_ts: string;
  stage: string;
  request_id: string | null;
  proposed_text: string | null;
  updated_at: string;
}

function toImport(r: ImportRow): CatalogImport {
  return {
    id: r.id,
    receivedAt: r.received_at,
    sourceRef: r.source_ref,
    contentHash: r.content_hash,
    rowCount: r.row_count,
    nWithIdea: r.n_with_idea,
    nBlank: r.n_blank,
    nDone: r.n_done,
  };
}
function toProduct(r: ProductRow): Product {
  return {
    sku: r.sku,
    name: r.name,
    category: r.category,
    colorRaw: r.color_raw,
    colorSet: JSON.parse(r.color_set_json) as ColorSet,
    material: r.material,
    priceCents: r.price_cents,
    photoUrl: r.photo_url,
    notesRaw: r.notes_raw,
    updatedAt: r.updated_at,
  };
}
function toRequest(r: RequestRow): ShotRequest {
  return {
    id: r.id,
    sku: r.sku,
    ideaRevision: r.idea_revision,
    status: r.status as ShotRequestStatus,
    shotIdeaText: r.shot_idea_text,
    shotIdeaOrigin: r.shot_idea_origin as ShotRequest["shotIdeaOrigin"],
    priorityRank: r.priority_rank,
    riskFlags: JSON.parse(r.risk_flags_json) as string[],
    lifecycleFlag: r.lifecycle_flag,
    bundlingFlag: r.bundling_flag,
    retryUsed: r.retry_used !== 0,
    createdAt: r.created_at,
    draftPostedAt: r.draft_posted_at,
    escalatedAt: r.escalated_at,
  };
}
function toAttempt(r: AttemptRow): GenerationAttempt {
  return {
    id: r.id,
    requestId: r.request_id,
    kind: r.kind as GenerationAttempt["kind"],
    promptText: r.prompt_text,
    inputPhotoUrl: r.input_photo_url,
    lumaGenerationId: r.luma_generation_id,
    resultImageUrl: r.result_image_url,
    spendCents: r.spend_cents,
    status: r.status as GenerationAttempt["status"],
    rejectReason: r.reject_reason as GenerationAttempt["rejectReason"],
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}
function toReviewPost(r: ReviewRow): ReviewPost {
  return {
    id: r.id,
    requestId: r.request_id,
    attemptId: r.attempt_id,
    slackChannel: r.slack_channel,
    slackTs: r.slack_ts,
    kind: r.kind as ReviewPost["kind"],
    createdAt: r.created_at,
  };
}
function toDecision(r: DecisionRow): Decision {
  return {
    id: r.id,
    requestId: r.request_id,
    attemptId: r.attempt_id,
    actor: r.actor,
    verb: r.verb as Decision["verb"],
    reason: r.reason as Decision["reason"],
    at: r.at,
  };
}
function toPublished(r: PublishedRow): PublishedImage {
  return {
    filename: r.filename,
    requestId: r.request_id,
    sourceAttemptId: r.source_attempt_id,
    sequence: r.sequence,
    stableUrl: r.stable_url,
    publishedAt: r.published_at,
  };
}
function toBlankRowAsk(r: BlankRowAskRow): BlankRowAsk {
  return {
    sku: r.sku,
    slackChannel: r.slack_channel,
    slackTs: r.slack_ts,
    proposedText: r.proposed_text,
  };
}
function toBatchStatusPost(r: BatchStatusPostRow): BatchStatusPost {
  return {
    importId: r.import_id,
    slackChannel: r.slack_channel,
    slackTs: r.slack_ts,
    completedAt: r.completed_at,
    exportUploadedAt: r.export_uploaded_at,
  };
}
function toSkuThreadPost(r: SkuThreadPostRow): SkuThreadPost {
  return {
    importId: r.import_id,
    sku: r.sku,
    slackChannel: r.slack_channel,
    slackTs: r.slack_ts,
    stage: r.stage as SkuThreadPost["stage"],
    requestId: r.request_id,
    proposedText: r.proposed_text,
    updatedAt: r.updated_at,
  };
}

export class SqliteRepository implements Repository {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
  }

  /** Idempotent — `CREATE TABLE IF NOT EXISTS` (+ one index widening, see its own comment). Safe
   *  to call on every boot. */
  migrate(): void {
    this.db.exec(SCHEMA);
    this.db.exec(WIDEN_REVIEW_POSTS_INDEX);
  }

  /** Close the underlying handle. Called from the `onClose` hook / graceful shutdown. */
  close(): void {
    this.db.close();
  }

  // --- CatalogImport -------------------------------------------------------
  findImportByContentHash(hash: string): CatalogImport | null {
    const row = this.db
      .prepare("SELECT * FROM catalog_imports WHERE content_hash = ?")
      .get(hash) as ImportRow | undefined;
    return row ? toImport(row) : null;
  }
  saveImport(record: CatalogImport): void {
    // Upserts on `id`. Safe only because `ingestCatalog` short-circuits on
    // `findImportByContentHash` before it ever gets here — a second id for the same bytes would
    // otherwise hit the `content_hash` UNIQUE index and throw.
    this.db
      .prepare(
        `INSERT INTO catalog_imports
           (id, received_at, source_ref, content_hash, row_count, n_with_idea, n_blank, n_done)
         VALUES (@id, @receivedAt, @sourceRef, @contentHash, @rowCount, @nWithIdea, @nBlank, @nDone)
         ON CONFLICT(id) DO UPDATE SET
           received_at = excluded.received_at,
           source_ref  = excluded.source_ref,
           content_hash = excluded.content_hash,
           row_count   = excluded.row_count,
           n_with_idea = excluded.n_with_idea,
           n_blank     = excluded.n_blank,
           n_done      = excluded.n_done`,
      )
      .run({
        id: record.id,
        receivedAt: record.receivedAt,
        sourceRef: record.sourceRef,
        contentHash: record.contentHash,
        rowCount: record.rowCount,
        nWithIdea: record.nWithIdea,
        nBlank: record.nBlank,
        nDone: record.nDone,
      });
  }

  // --- Product -----------------------------------------------------------
  upsertProduct(product: Product): void {
    this.db
      .prepare(
        `INSERT INTO products
           (sku, name, category, color_raw, color_set_json, material, price_cents, photo_url, notes_raw, updated_at)
         VALUES (@sku, @name, @category, @colorRaw, @colorSetJson, @material, @priceCents, @photoUrl, @notesRaw, @updatedAt)
         ON CONFLICT(sku) DO UPDATE SET
           name = excluded.name,
           category = excluded.category,
           color_raw = excluded.color_raw,
           color_set_json = excluded.color_set_json,
           material = excluded.material,
           price_cents = excluded.price_cents,
           photo_url = excluded.photo_url,
           notes_raw = excluded.notes_raw,
           updated_at = excluded.updated_at`,
      )
      .run({
        sku: product.sku,
        name: product.name,
        category: product.category,
        colorRaw: product.colorRaw,
        colorSetJson: JSON.stringify(product.colorSet),
        material: product.material,
        priceCents: product.priceCents,
        photoUrl: product.photoUrl,
        notesRaw: product.notesRaw,
        updatedAt: product.updatedAt,
      });
  }
  getProduct(sku: string): Product | null {
    const row = this.db
      .prepare("SELECT * FROM products WHERE sku = ?")
      .get(sku) as ProductRow | undefined;
    return row ? toProduct(row) : null;
  }
  listProducts(): Product[] {
    return (
      this.db
        .prepare("SELECT * FROM products ORDER BY sku ASC")
        .all() as ProductRow[]
    ).map(toProduct);
  }

  // --- ShotRequest -------------------------------------------------------
  getActiveRequestForSku(sku: string): ShotRequest | null {
    const row = this.db
      .prepare(
        `SELECT * FROM shot_requests
         WHERE sku = ? AND status NOT IN (${TERMINAL_PLACEHOLDERS})
         ORDER BY idea_revision DESC LIMIT 1`,
      )
      .get(sku, ...TERMINAL) as RequestRow | undefined;
    return row ? toRequest(row) : null;
  }
  listRequestsForSku(sku: string): ShotRequest[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM shot_requests WHERE sku = ? ORDER BY idea_revision ASC, created_at ASC, id ASC",
        )
        .all(sku) as RequestRow[]
    ).map(toRequest);
  }
  getRequest(id: string): ShotRequest | null {
    const row = this.db
      .prepare("SELECT * FROM shot_requests WHERE id = ?")
      .get(id) as RequestRow | undefined;
    return row ? toRequest(row) : null;
  }
  saveRequest(request: ShotRequest): void {
    this.db
      .prepare(
        `INSERT INTO shot_requests
           (id, sku, idea_revision, status, shot_idea_text, shot_idea_origin, priority_rank,
            risk_flags_json, lifecycle_flag, bundling_flag, retry_used, created_at, draft_posted_at, escalated_at)
         VALUES (@id, @sku, @ideaRevision, @status, @shotIdeaText, @shotIdeaOrigin, @priorityRank,
            @riskFlagsJson, @lifecycleFlag, @bundlingFlag, @retryUsed, @createdAt, @draftPostedAt, @escalatedAt)
         ON CONFLICT(id) DO UPDATE SET
           sku = excluded.sku,
           idea_revision = excluded.idea_revision,
           status = excluded.status,
           shot_idea_text = excluded.shot_idea_text,
           shot_idea_origin = excluded.shot_idea_origin,
           priority_rank = excluded.priority_rank,
           risk_flags_json = excluded.risk_flags_json,
           lifecycle_flag = excluded.lifecycle_flag,
           bundling_flag = excluded.bundling_flag,
           retry_used = excluded.retry_used,
           created_at = excluded.created_at,
           draft_posted_at = excluded.draft_posted_at,
           escalated_at = excluded.escalated_at`,
      )
      .run({
        id: request.id,
        sku: request.sku,
        ideaRevision: request.ideaRevision,
        status: request.status,
        shotIdeaText: request.shotIdeaText,
        shotIdeaOrigin: request.shotIdeaOrigin,
        priorityRank: request.priorityRank,
        riskFlagsJson: JSON.stringify([...request.riskFlags]),
        lifecycleFlag: request.lifecycleFlag,
        bundlingFlag: request.bundlingFlag,
        retryUsed: request.retryUsed ? 1 : 0,
        createdAt: request.createdAt,
        draftPostedAt: request.draftPostedAt,
        escalatedAt: request.escalatedAt,
      });
  }
  listRequestsByStatus(status: ShotRequestStatus): ShotRequest[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM shot_requests WHERE status = ? ORDER BY created_at ASC, id ASC",
        )
        .all(status) as RequestRow[]
    ).map(toRequest);
  }
  listRequestsInQueueOrder(): ShotRequest[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM shot_requests
           WHERE status NOT IN (${TERMINAL_PLACEHOLDERS})
           ORDER BY priority_rank DESC, created_at ASC, id ASC`,
        )
        .all(...TERMINAL) as RequestRow[]
    ).map(toRequest);
  }

  // --- GenerationAttempt ----------------------------------------------
  saveAttempt(attempt: GenerationAttempt): void {
    this.db
      .prepare(
        `INSERT INTO generation_attempts
           (id, request_id, kind, prompt_text, input_photo_url, luma_generation_id, result_image_url,
            spend_cents, status, reject_reason, created_at, completed_at)
         VALUES (@id, @requestId, @kind, @promptText, @inputPhotoUrl, @lumaGenerationId, @resultImageUrl,
            @spendCents, @status, @rejectReason, @createdAt, @completedAt)
         ON CONFLICT(id) DO UPDATE SET
           request_id = excluded.request_id,
           kind = excluded.kind,
           prompt_text = excluded.prompt_text,
           input_photo_url = excluded.input_photo_url,
           luma_generation_id = excluded.luma_generation_id,
           result_image_url = excluded.result_image_url,
           spend_cents = excluded.spend_cents,
           status = excluded.status,
           reject_reason = excluded.reject_reason,
           created_at = excluded.created_at,
           completed_at = excluded.completed_at`,
      )
      .run({
        id: attempt.id,
        requestId: attempt.requestId,
        kind: attempt.kind,
        promptText: attempt.promptText,
        inputPhotoUrl: attempt.inputPhotoUrl,
        lumaGenerationId: attempt.lumaGenerationId,
        resultImageUrl: attempt.resultImageUrl,
        spendCents: attempt.spendCents,
        status: attempt.status,
        rejectReason: attempt.rejectReason,
        createdAt: attempt.createdAt,
        completedAt: attempt.completedAt,
      });
  }
  getAttempt(id: string): GenerationAttempt | null {
    const row = this.db
      .prepare("SELECT * FROM generation_attempts WHERE id = ?")
      .get(id) as AttemptRow | undefined;
    return row ? toAttempt(row) : null;
  }
  listAttemptsForRequest(requestId: string): GenerationAttempt[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM generation_attempts WHERE request_id = ? ORDER BY created_at ASC, id ASC",
        )
        .all(requestId) as AttemptRow[]
    ).map(toAttempt);
  }
  listPendingAttempts(): GenerationAttempt[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM generation_attempts WHERE status = 'pending' ORDER BY created_at ASC, id ASC",
        )
        .all() as AttemptRow[]
    ).map(toAttempt);
  }

  // --- ReviewPost ----------------------------------------------------
  saveReviewPost(post: ReviewPost): void {
    this.db
      .prepare(
        `INSERT INTO review_posts (id, request_id, attempt_id, slack_channel, slack_ts, kind, created_at)
         VALUES (@id, @requestId, @attemptId, @slackChannel, @slackTs, @kind, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           request_id = excluded.request_id,
           attempt_id = excluded.attempt_id,
           slack_channel = excluded.slack_channel,
           slack_ts = excluded.slack_ts,
           kind = excluded.kind,
           created_at = excluded.created_at`,
      )
      .run({
        id: post.id,
        requestId: post.requestId,
        attemptId: post.attemptId,
        slackChannel: post.slackChannel,
        slackTs: post.slackTs,
        kind: post.kind,
        createdAt: post.createdAt,
      });
  }
  getReviewPostBySlackTs(channel: string, ts: string): ReviewPost | null {
    const row = this.db
      .prepare(
        "SELECT * FROM review_posts WHERE slack_channel = ? AND slack_ts = ?",
      )
      .get(channel, ts) as ReviewRow | undefined;
    return row ? toReviewPost(row) : null;
  }
  getLatestReviewPostForRequest(
    requestId: string,
    kind: "draft" | "finals",
  ): ReviewPost | null {
    const row = this.db
      .prepare(
        `SELECT * FROM review_posts WHERE request_id = ? AND kind = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(requestId, kind) as ReviewRow | undefined;
    return row ? toReviewPost(row) : null;
  }

  // --- Decision ----------------------------------------------------
  saveDecision(decision: Decision): void {
    this.db
      .prepare(
        `INSERT INTO decisions (id, request_id, attempt_id, actor, verb, reason, at)
         VALUES (@id, @requestId, @attemptId, @actor, @verb, @reason, @at)
         ON CONFLICT(id) DO UPDATE SET
           request_id = excluded.request_id,
           attempt_id = excluded.attempt_id,
           actor = excluded.actor,
           verb = excluded.verb,
           reason = excluded.reason,
           at = excluded.at`,
      )
      .run({
        id: decision.id,
        requestId: decision.requestId,
        attemptId: decision.attemptId,
        actor: decision.actor,
        verb: decision.verb,
        reason: decision.reason,
        at: decision.at,
      });
  }
  listDecisionsForRequest(requestId: string): Decision[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM decisions WHERE request_id = ? ORDER BY at ASC, id ASC",
        )
        .all(requestId) as DecisionRow[]
    ).map(toDecision);
  }

  // --- PublishedImage --------------------------------------------
  savePublishedImage(image: PublishedImage): void {
    this.db
      .prepare(
        `INSERT INTO published_images (filename, request_id, source_attempt_id, sequence, stable_url, published_at)
         VALUES (@filename, @requestId, @sourceAttemptId, @sequence, @stableUrl, @publishedAt)
         ON CONFLICT(filename) DO UPDATE SET
           request_id = excluded.request_id,
           source_attempt_id = excluded.source_attempt_id,
           sequence = excluded.sequence,
           stable_url = excluded.stable_url,
           published_at = excluded.published_at`,
      )
      .run({
        filename: image.filename,
        requestId: image.requestId,
        sourceAttemptId: image.sourceAttemptId,
        sequence: image.sequence,
        stableUrl: image.stableUrl,
        publishedAt: image.publishedAt,
      });
  }
  listPublishedForRequest(requestId: string): PublishedImage[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM published_images WHERE request_id = ? ORDER BY sequence ASC",
        )
        .all(requestId) as PublishedRow[]
    ).map(toPublished);
  }
  allPublishedImages(): PublishedImage[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM published_images ORDER BY sequence ASC, filename ASC",
        )
        .all() as PublishedRow[]
    ).map(toPublished);
  }

  // --- BlankRowAsk ---------------------------------------------
  saveBlankRowAsk(ask: BlankRowAsk): void {
    this.db
      .prepare(
        `INSERT INTO blank_row_asks (sku, slack_channel, slack_ts, proposed_text)
         VALUES (@sku, @slackChannel, @slackTs, @proposedText)
         ON CONFLICT(sku) DO UPDATE SET
           slack_channel = excluded.slack_channel,
           slack_ts = excluded.slack_ts,
           proposed_text = excluded.proposed_text`,
      )
      .run({
        sku: ask.sku,
        slackChannel: ask.slackChannel,
        slackTs: ask.slackTs,
        proposedText: ask.proposedText,
      });
  }
  getBlankRowAskBySlackTs(channel: string, ts: string): BlankRowAsk | null {
    const row = this.db
      .prepare(
        "SELECT * FROM blank_row_asks WHERE slack_channel = ? AND slack_ts = ?",
      )
      .get(channel, ts) as BlankRowAskRow | undefined;
    return row ? toBlankRowAsk(row) : null;
  }
  getBlankRowAskBySku(sku: string): BlankRowAsk | null {
    const row = this.db
      .prepare("SELECT * FROM blank_row_asks WHERE sku = ?")
      .get(sku) as BlankRowAskRow | undefined;
    return row ? toBlankRowAsk(row) : null;
  }

  // --- CatalogImportRow (F7) ---------------------------------------------
  saveCatalogImportRow(importId: string, sku: string): void {
    this.db
      .prepare(
        `INSERT INTO catalog_import_rows (import_id, sku) VALUES (?, ?)
         ON CONFLICT(import_id, sku) DO NOTHING`,
      )
      .run(importId, sku);
  }
  listSkusForImport(importId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT sku FROM catalog_import_rows WHERE import_id = ? ORDER BY rowid ASC",
        )
        .all(importId) as { sku: string }[]
    ).map((r) => r.sku);
  }
  listOpenImportIdsForSku(sku: string): string[] {
    // Oldest-open-batch-first — `run-pipeline-tick.ts` picks the LAST entry as the "most recently
    // opened" batch to root a fresh review post in when a SKU has no living thread reply yet.
    return (
      this.db
        .prepare(
          `SELECT DISTINCT cir.import_id AS import_id, ci.received_at AS received_at
           FROM catalog_import_rows cir
           JOIN catalog_imports ci ON ci.id = cir.import_id
           LEFT JOIN batch_status_posts bsp ON bsp.import_id = cir.import_id
           WHERE cir.sku = ? AND (bsp.import_id IS NULL OR bsp.completed_at IS NULL)
           ORDER BY ci.received_at ASC, ci.id ASC`,
        )
        .all(sku) as { import_id: string; received_at: string }[]
    ).map((r) => r.import_id);
  }

  // --- BatchStatusPost (F7) -----------------------------------------------
  saveBatchStatusPost(post: BatchStatusPost): void {
    this.db
      .prepare(
        `INSERT INTO batch_status_posts
           (import_id, slack_channel, slack_ts, completed_at, export_uploaded_at)
         VALUES (@importId, @slackChannel, @slackTs, @completedAt, @exportUploadedAt)
         ON CONFLICT(import_id) DO UPDATE SET
           slack_channel = excluded.slack_channel,
           slack_ts = excluded.slack_ts,
           completed_at = excluded.completed_at,
           export_uploaded_at = excluded.export_uploaded_at`,
      )
      .run({
        importId: post.importId,
        slackChannel: post.slackChannel,
        slackTs: post.slackTs,
        completedAt: post.completedAt,
        exportUploadedAt: post.exportUploadedAt,
      });
  }
  getBatchStatusPost(importId: string): BatchStatusPost | null {
    const row = this.db
      .prepare("SELECT * FROM batch_status_posts WHERE import_id = ?")
      .get(importId) as BatchStatusPostRow | undefined;
    return row ? toBatchStatusPost(row) : null;
  }
  getBatchStatusPostBySlackTs(
    channel: string,
    ts: string,
  ): BatchStatusPost | null {
    const row = this.db
      .prepare(
        "SELECT * FROM batch_status_posts WHERE slack_channel = ? AND slack_ts = ?",
      )
      .get(channel, ts) as BatchStatusPostRow | undefined;
    return row ? toBatchStatusPost(row) : null;
  }
  markBatchCompleted(importId: string, at: string): void {
    // `AND completed_at IS NULL` — a second concurrent completer is a no-op, not a re-stamp.
    this.db
      .prepare(
        "UPDATE batch_status_posts SET completed_at = ? WHERE import_id = ? AND completed_at IS NULL",
      )
      .run(at, importId);
  }
  markBatchExportUploaded(importId: string, at: string): void {
    // `AND export_uploaded_at IS NULL` — belt-and-braces against a double CSV upload if two callers
    // ever slip past the check in `refresh-batch-status.ts` (the per-import lock is the primary
    // guard).
    this.db
      .prepare(
        "UPDATE batch_status_posts SET export_uploaded_at = ? WHERE import_id = ? AND export_uploaded_at IS NULL",
      )
      .run(at, importId);
  }
  listOpenBatches(): CatalogImport[] {
    return (
      this.db
        .prepare(
          `SELECT ci.* FROM catalog_imports ci
           LEFT JOIN batch_status_posts bsp ON bsp.import_id = ci.id
           WHERE bsp.import_id IS NULL OR bsp.completed_at IS NULL
           ORDER BY ci.received_at ASC, ci.id ASC`,
        )
        .all() as ImportRow[]
    ).map(toImport);
  }

  // --- SkuThreadPost (F7) --------------------------------------------------
  saveSkuThreadPost(post: SkuThreadPost): void {
    this.db
      .prepare(
        `INSERT INTO sku_thread_posts
           (import_id, sku, slack_channel, slack_ts, stage, request_id, proposed_text, updated_at)
         VALUES (@importId, @sku, @slackChannel, @slackTs, @stage, @requestId, @proposedText, @updatedAt)
         ON CONFLICT(import_id, sku) DO UPDATE SET
           slack_channel = excluded.slack_channel,
           slack_ts = excluded.slack_ts,
           stage = excluded.stage,
           request_id = excluded.request_id,
           proposed_text = excluded.proposed_text,
           updated_at = excluded.updated_at`,
      )
      .run({
        importId: post.importId,
        sku: post.sku,
        slackChannel: post.slackChannel,
        slackTs: post.slackTs,
        stage: post.stage,
        requestId: post.requestId,
        proposedText: post.proposedText,
        updatedAt: post.updatedAt,
      });
  }
  getSkuThreadPost(importId: string, sku: string): SkuThreadPost | null {
    const row = this.db
      .prepare(
        "SELECT * FROM sku_thread_posts WHERE import_id = ? AND sku = ?",
      )
      .get(importId, sku) as SkuThreadPostRow | undefined;
    return row ? toSkuThreadPost(row) : null;
  }
  getSkuThreadPostBySlackTs(channel: string, ts: string): SkuThreadPost | null {
    const row = this.db
      .prepare(
        "SELECT * FROM sku_thread_posts WHERE slack_channel = ? AND slack_ts = ?",
      )
      .get(channel, ts) as SkuThreadPostRow | undefined;
    return row ? toSkuThreadPost(row) : null;
  }

  // --- SpendLedger ---------------------------------------------
  totalSpendCents(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(spend_cents), 0) AS total FROM generation_attempts",
      )
      .get() as { total: number };
    return row.total;
  }
}
