/**
 * Slack, behind one adapter. The app posts messages + buttons and reacts to taps; it does not
 * know about Bolt, Block Kit, or `chat.update`. See docs/libraries/slack-bolt.md.
 *
 * Every `post*` returns the message timestamp (`ts`) so a ReviewPost can bind the Slack message
 * to a ShotRequest + GenerationAttempt (DOMAIN.md ReviewPost entity).
 *
 * Wave 7 / ADR 0019: `postBlankRowAsk` / `postDraftForReview` / `postFinalsPublished` are now
 * post-OR-update — pass `existing` to edit a SKU's one living thread reply in place instead of
 * posting a new message, and `threadTs` (the batch status post's `ts`) so a first-time post lands
 * inside that batch's thread rather than top-level.
 */

export interface PostedMessage {
  readonly channel: string;
  readonly ts: string;
}

export interface DownloadedFile {
  readonly filename: string;
  readonly mimetype: string;
  readonly bytes: Buffer;
}

/** One auto-published Final in the completion message (ADR 0020) — filename + stable URL. */
export interface PublishedFinal {
  readonly filename: string;
  readonly stableUrl: string;
}

/** One row of the batch status post — already resolved to display text (`domain/batch-status.ts`). */
export interface BatchStatusRow {
  readonly sku: string;
  readonly productName: string;
  readonly label: string;
}

export interface SlackGateway {
  /** F1: one summary line to the channel after ingest. */
  postImportSummary(text: string): Promise<PostedMessage>;

  /**
   * F7 / ADR 0019: the batch status post — one message per CatalogImport listing every row's SKU,
   * product name, and current status. `existing` omitted → post fresh (always the case per the
   * "always start a new message per upload, no merging" rule); `existing` set → `chat.update` it
   * in place as rows change status.
   */
  upsertBatchStatus(input: {
    existing?: PostedMessage;
    rows: readonly BatchStatusRow[];
  }): Promise<PostedMessage>;

  /**
   * F2: for a blank row, the ask + a proposed Shot Idea, as a SKU's living thread reply (Wave 7).
   * `threadTs` anchors a first post to the batch's thread; `existing` edits that same reply in
   * place instead of posting new. `importId` is embedded in the button `value` (compound
   * `${importId}:${sku}`) so a tap can resolve which batch's thread reply to update even if the
   * SKU is open in more than one batch at once.
   */
  postBlankRowAsk(input: {
    importId: string;
    sku: string;
    productName: string;
    proposedText: string;
    threadTs: string;
    existing?: PostedMessage;
  }): Promise<PostedMessage>;

  /**
   * F3a: the Draft image with Approve / Reject controls (Reject reveals the four reason chips), as
   * a SKU's living thread reply. Button `value` carries the requestId.
   */
  postDraftForReview(input: {
    requestId: string;
    sku: string;
    imageUrl: string;
    shotIdea: string;
    riskFlags: readonly string[];
    threadTs: string;
    existing?: PostedMessage;
  }): Promise<PostedMessage>;

  /**
   * F4 (Wave 9 / ADR 0020): the Finals completion message, posted into the SKU's living thread
   * reply — a hyperlinked `done`/`parked` headline plus one image block per published Final, no
   * controls (Finals auto-approve). `failed` carries no images.
   */
  postFinalsPublished(input: {
    requestId: string;
    sku: string;
    status: "done" | "parked" | "failed";
    published: readonly PublishedFinal[];
    threadTs: string;
    existing?: PostedMessage;
  }): Promise<PostedMessage>;

  /**
   * After a binding tap: replace the review message's *controls* with a status line, while
   * keeping the image visible. `keepImageUrl` is re-rendered above the status text — omit it only
   * for messages that had no image (import summary, blank-row ask). `sku` optional: if passed, sets
   * the image's alt-text to the SKU for accessibility.
   */
  updateMessage(input: {
    channel: string;
    ts: string;
    text: string;
    keepImageUrl?: string;
    sku?: string;
  }): Promise<void>;

  /**
   * F2 (Wave 8): after an "Edit before using" modal submit, the SKU's stale ask reply is deleted
   * and a fresh confirmed-state reply is posted in its place — a `view_submission` can't force the
   * client to repaint an in-place `chat.update`, but a brand-new message always renders.
   */
  deleteMessage(input: { channel: string; ts: string }): Promise<void>;
  /** F2 (Wave 8): a plain text reply into a batch's thread (`threadTs` = the batch status post). */
  postSkuThreadReply(input: {
    threadTs: string;
    text: string;
  }): Promise<PostedMessage>;

  /** F3b: escalate a stale Draft by @-mentioning the escalation contact in the channel. */
  mentionEscalationContact(text: string): Promise<PostedMessage>;

  /** Generic channel post (e.g. NewIdeaRevisionDetected note in the import summary follow-up). */
  postMessage(text: string): Promise<PostedMessage>;

  /**
   * F7 / ADR 0019: upload the batch-completion CSV once, to the channel root (not the batch's
   * thread) so the finished file is visible without expanding a thread. Needs the `files:write`
   * scope (not covered by the existing `files:read`).
   */
  uploadBatchExportCsv(input: {
    filename: string;
    content: string;
  }): Promise<void>;

  /** F1: pull the bytes of a CSV shared in the channel. Verifies it is not an HTML login page. */
  downloadFile(fileId: string): Promise<DownloadedFile>;
}
