/**
 * Shared domain vocabulary — the ubiquitous language from DOMAIN.md, as types.
 * Kept verbatim where the team has a word for it (*Draft*, *Finals*, *the pick*, *Parked*, …).
 */

import type { BrandColor } from "./palette.js";

// ---------------------------------------------------------------------------
// ShotRequest lifecycle
// proposed → confirmed → drafting → in_review → approved → finalizing → picking → done
// branches: parked (rejected twice / partially picked), failed (generation dead), stale (un-tapped)
// ---------------------------------------------------------------------------
export type ShotRequestStatus =
  | "proposed"
  | "confirmed"
  | "drafting"
  | "in_review"
  | "approved"
  | "finalizing"
  | "picking"
  | "done"
  | "parked"
  | "failed"
  | "stale";

/** Where a confirmed Shot Idea's text came from. DOMAIN.md ShotIdea VO. */
export type ShotIdeaOrigin =
  "sheet" | "slack-reply" | "proposed" | "proposed-then-edited";

/** The four reject-reason chips (SPEC F3a/F3b). `retry` carries this forward into the prompt. */
export type RejectReason = "wrong vibe" | "color off" | "too staged" | "other";

/** Decision verbs. Only the approver's is binding (DOMAIN.md Decision VO invariant). */
export type DecisionVerb = "approve" | "reject" | "pick";

/** GenerationAttempt kind. `final` only exists under an `approved` Request. */
export type AttemptKind = "draft" | "retry" | "final";

export type AttemptStatus = "pending" | "succeeded" | "failed";

/** Maps to Luma model choice: draft → uni-1 (cheap), final → uni-1-max (full quality). */
export type GenerationQuality = "draft" | "final";

// ---------------------------------------------------------------------------
// Value objects
// ---------------------------------------------------------------------------

/**
 * Ordered brand-palette terms parsed from `Color / Finish`, plus any un-branded
 * descriptors kept verbatim (e.g. "Natural", "Wood"). Input to the GenerationPrompt.
 */
export interface ColorSet {
  readonly matched: readonly BrandColor[];
  readonly unmatched: readonly string[];
}

/**
 * Classification of the raw `Notes` junk-drawer column into its five jobs.
 * Invariant (DOMAIN.md / ASSUMPTIONS.md A4): only `priority` and `generationRisk`
 * influence the pipeline. `lifecycleConcern` + `bundlingIntent` are flagged, never auto-acted.
 */
export interface NotesInterpretation {
  readonly priority: boolean;
  readonly generationRisk: readonly string[];
  readonly sourceAssetQuality: string | null;
  readonly lifecycleConcern: string | null;
  readonly bundlingIntent: string | null;
}

export interface ShotIdea {
  readonly text: string;
  readonly revision: number;
  readonly origin: ShotIdeaOrigin;
}

// ---------------------------------------------------------------------------
// Entities (persistence-facing shapes; the Repository port speaks these)
// ---------------------------------------------------------------------------

export interface Product {
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly colorRaw: string;
  readonly colorSet: ColorSet;
  readonly material: string;
  readonly priceCents: number;
  readonly photoUrl: string;
  readonly notesRaw: string;
  readonly updatedAt: string;
}

export interface CatalogImport {
  readonly id: string;
  readonly receivedAt: string;
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly rowCount: number;
  readonly nWithIdea: number;
  readonly nBlank: number;
  readonly nDone: number;
}

export interface ShotRequest {
  readonly id: string;
  readonly sku: string;
  readonly ideaRevision: number;
  readonly status: ShotRequestStatus;
  readonly shotIdeaText: string;
  readonly shotIdeaOrigin: ShotIdeaOrigin;
  /** Higher sorts earlier in the queue. Notes-derived priority bumps this. */
  readonly priorityRank: number;
  readonly riskFlags: readonly string[];
  readonly lifecycleFlag: string | null;
  readonly bundlingFlag: string | null;
  readonly retryUsed: boolean;
  readonly createdAt: string;
  readonly draftPostedAt: string | null;
  readonly escalatedAt: string | null;
}

export interface GenerationAttempt {
  readonly id: string;
  readonly requestId: string;
  readonly kind: AttemptKind;
  readonly promptText: string;
  readonly inputPhotoUrl: string;
  readonly lumaGenerationId: string | null;
  readonly resultImageUrl: string | null;
  /** Configured cents constant per kind — written on EVERY attempt, success or failure. */
  readonly spendCents: number;
  readonly status: AttemptStatus;
  readonly rejectReason: RejectReason | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface ReviewPost {
  readonly id: string;
  readonly requestId: string;
  readonly attemptId: string;
  /** DOMAIN.md identity: the (`slackChannel`, `slackTs`) pair uniquely identifies a ReviewPost. */
  readonly slackChannel: string;
  readonly slackTs: string;
  readonly kind: "draft" | "finals";
  /** Monotonic — lets "the latest ReviewPost for a Request" be a real ORDER BY, not Map order. */
  readonly createdAt: string;
}

export interface Decision {
  readonly id: string;
  readonly requestId: string;
  readonly attemptId: string | null;
  /** A Slack user id. Only the one that equals the configured approver id is binding (ASSUMPTIONS.md A2). */
  readonly actor: string;
  readonly verb: DecisionVerb;
  readonly reason: RejectReason | null;
  readonly at: string;
}

export interface PublishedImage {
  /** Deterministic filename — `hg-002-styled-01.jpg` (SKU + sequence). The identity. */
  readonly filename: string;
  readonly requestId: string;
  readonly sourceAttemptId: string;
  readonly sequence: number;
  readonly stableUrl: string;
  readonly publishedAt: string;
}

/**
 * Correlates a blank-row "give us a Shot Idea" Slack post to its SKU (F2). Superseded by
 * `SkuThreadPost` for batch-scoped ingest (Wave 7 / ADR 0019) — kept for schema compatibility,
 * no runtime call sites write to it anymore.
 */
export interface BlankRowAsk {
  readonly sku: string;
  readonly slackChannel: string;
  readonly slackTs: string;
  readonly proposedText: string;
}

// ---------------------------------------------------------------------------
// Batch status post (Wave 7 / ADR 0019) — one Slack message + thread per CatalogImport
// ---------------------------------------------------------------------------

/** Which SKUs one CatalogImport touched — every row, blank or not (the batch post's row list). */
export interface CatalogImportRow {
  readonly importId: string;
  readonly sku: string;
}

/**
 * The one status message for a CatalogImport's rows — edited in place (`chat.update`) until every
 * row reaches a terminal status, then inert. Scoped to exactly one import's lifetime (ADR 0019);
 * not a standing, cross-batch surface.
 */
export interface BatchStatusPost {
  readonly importId: string;
  readonly slackChannel: string;
  readonly slackTs: string;
  /** Set once every row in the batch is terminal (`domain/batch-status.ts` `isBatchComplete`). */
  readonly completedAt: string | null;
  /** Set once the completed batch's CSV export has been uploaded — the upload idempotency guard. */
  readonly exportUploadedAt: string | null;
}

/** Which review stage a `SkuThreadPost`'s current content shows. */
export type SkuThreadStage = "ask" | "draft" | "finals" | "published";

/**
 * The ONE living Slack thread reply for a {CatalogImport, sku} pair — edited in place as the SKU
 * moves ask → draft → finals, rather than a new reply per stage. Single source of truth for "what
 * message currently represents this SKU's review state in this batch."
 */
export interface SkuThreadPost {
  readonly importId: string;
  readonly sku: string;
  readonly slackChannel: string;
  readonly slackTs: string;
  readonly stage: SkuThreadStage;
  readonly requestId: string | null;
  /** Frozen at ask-time — the proposal text the "Use this" / "Edit before using" buttons target. */
  readonly proposedText: string | null;
  readonly updatedAt: string;
}
