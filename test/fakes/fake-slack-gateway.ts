import type {
  BatchStatusRow,
  DownloadedFile,
  PublishedFinal,
  PostedMessage,
  SlackGateway,
} from "../../src/ports/slack-gateway.js";

export interface RecordedPost {
  kind:
    | "import-summary"
    | "batch-status"
    | "blank-row-ask"
    | "draft-review"
    | "finals-published"
    | "mention-escalation"
    | "message"
    | "update"
    | "delete"
    | "sku-thread-reply"
    | "csv-upload";
  text: string;
  channel: string;
  ts: string;
  /** True when this call edited an existing message (`existing` was passed) rather than posting
   *  new — the leverage point for asserting "updated in place" vs "posted new" (Wave 7 / ADR 0019). */
  updated?: boolean;
  meta?: Record<string, unknown>;
}

/**
 * Records every outbound Slack call and hands back deterministic timestamps. Scenario tests assert
 * on `posts` (what the channel saw) and use `files` to stage a CSV for the ingest path.
 */
export class FakeSlackGateway implements SlackGateway {
  readonly channel = "C_TEST";
  readonly posts: RecordedPost[] = [];
  private tsSeq = 0;
  private files = new Map<string, DownloadedFile>();
  private failKinds = new Set<RecordedPost["kind"]>();
  private failWith = new Map<RecordedPost["kind"], unknown>();

  private nextTs(): string {
    this.tsSeq += 1;
    return `1700000000.${String(this.tsSeq).padStart(6, "0")}`;
  }

  private failIfArmed(kind: RecordedPost["kind"]): void {
    if (this.failWith.has(kind)) {
      const err = this.failWith.get(kind);
      this.failWith.delete(kind);
      throw err;
    }
    if (this.failKinds.delete(kind)) {
      throw new Error(`FakeSlackGateway: simulated failure on ${kind}`);
    }
  }

  private record(
    kind: RecordedPost["kind"],
    text: string,
    meta?: Record<string, unknown>,
  ): PostedMessage {
    this.failIfArmed(kind);
    const ts = this.nextTs();
    const entry: RecordedPost = { kind, text, channel: this.channel, ts };
    if (meta !== undefined) entry.meta = meta;
    this.posts.push(entry);
    return { channel: this.channel, ts };
  }

  /** Post-or-update: `existing` set → edit that message in place (`updated: true`, same `ts`);
   *  otherwise post fresh with a new `ts` (Wave 7 / ADR 0019 living per-SKU thread reply). */
  private recordPostOrUpdate(
    kind: RecordedPost["kind"],
    text: string,
    existing: PostedMessage | undefined,
    meta?: Record<string, unknown>,
  ): PostedMessage {
    this.failIfArmed(kind);
    if (existing) {
      const entry: RecordedPost = {
        kind,
        text,
        channel: existing.channel,
        ts: existing.ts,
        updated: true,
      };
      if (meta !== undefined) entry.meta = meta;
      this.posts.push(entry);
      return existing;
    }
    const ts = this.nextTs();
    const entry: RecordedPost = { kind, text, channel: this.channel, ts };
    if (meta !== undefined) entry.meta = meta;
    this.posts.push(entry);
    return { channel: this.channel, ts };
  }

  async postImportSummary(text: string): Promise<PostedMessage> {
    return this.record("import-summary", text);
  }

  async upsertBatchStatus(input: {
    existing?: PostedMessage;
    rows: readonly BatchStatusRow[];
  }): Promise<PostedMessage> {
    return this.recordPostOrUpdate(
      "batch-status",
      `Batch status — ${input.rows.length} item(s)`,
      input.existing,
      { rows: input.rows.map((r) => ({ ...r })) },
    );
  }

  async postBlankRowAsk(input: {
    importId: string;
    sku: string;
    productName: string;
    proposedText: string;
    threadTs: string;
    existing?: PostedMessage;
  }): Promise<PostedMessage> {
    return this.recordPostOrUpdate(
      "blank-row-ask",
      `${input.sku} ${input.productName} — no shot idea yet. Use this, or edit it first: "${input.proposedText}"`,
      input.existing,
      {
        importId: input.importId,
        sku: input.sku,
        productName: input.productName,
        proposedText: input.proposedText,
        threadTs: input.threadTs,
      },
    );
  }

  async postDraftForReview(input: {
    requestId: string;
    sku: string;
    imageUrl: string;
    shotIdea: string;
    riskFlags: readonly string[];
    threadTs: string;
    existing?: PostedMessage;
  }): Promise<PostedMessage> {
    return this.recordPostOrUpdate(
      "draft-review",
      `Draft for ${input.sku}: ${input.shotIdea}`,
      input.existing,
      {
        requestId: input.requestId,
        sku: input.sku,
        imageUrl: input.imageUrl,
        shotIdea: input.shotIdea,
        riskFlags: [...input.riskFlags],
        threadTs: input.threadTs,
      },
    );
  }

  async postFinalsPublished(input: {
    requestId: string;
    sku: string;
    status: "done" | "parked" | "failed";
    published: readonly PublishedFinal[];
    threadTs: string;
    existing?: PostedMessage;
  }): Promise<PostedMessage> {
    const links = input.published
      .map((p) => `<${p.stableUrl}|${p.filename}>`)
      .join(", ");
    const text =
      input.status === "done"
        ? `✅ *${input.sku}* — done. Published: ${links}.`
        : input.status === "parked"
          ? `🟣 *${input.sku}* — parked: only one Final published (${links}). It needs two to be done.`
          : `⚠ *${input.sku}* — every Finals generation failed. Nothing was published.`;
    return this.recordPostOrUpdate(
      "finals-published",
      text,
      input.existing,
      {
        requestId: input.requestId,
        sku: input.sku,
        status: input.status,
        published: input.published.map((p) => ({ ...p })),
        threadTs: input.threadTs,
      },
    );
  }

  async updateMessage(input: {
    channel: string;
    ts: string;
    text: string;
    keepImageUrl?: string;
    sku?: string;
  }): Promise<void> {
    this.failIfArmed("update");
    const entry: RecordedPost = {
      kind: "update",
      text: input.text,
      channel: input.channel,
      ts: input.ts,
    };
    if (input.keepImageUrl !== undefined || input.sku !== undefined) {
      entry.meta = {};
      if (input.keepImageUrl !== undefined) entry.meta.keepImageUrl = input.keepImageUrl;
      if (input.sku !== undefined) entry.meta.sku = input.sku;
    }
    this.posts.push(entry);
  }

  async mentionEscalationContact(text: string): Promise<PostedMessage> {
    return this.record("mention-escalation", text);
  }

  async deleteMessage(input: { channel: string; ts: string }): Promise<void> {
    this.failIfArmed("delete");
    this.posts.push({
      kind: "delete",
      text: input.ts,
      channel: input.channel,
      ts: input.ts,
    });
  }

  async postSkuThreadReply(input: {
    threadTs: string;
    text: string;
  }): Promise<PostedMessage> {
    return this.record("sku-thread-reply", input.text, {
      threadTs: input.threadTs,
    });
  }

  async postMessage(text: string): Promise<PostedMessage> {
    return this.record("message", text);
  }

  async uploadBatchExportCsv(input: {
    filename: string;
    content: string;
  }): Promise<void> {
    this.failIfArmed("csv-upload");
    this.posts.push({
      kind: "csv-upload",
      text: input.filename,
      channel: this.channel,
      ts: this.nextTs(),
      meta: { filename: input.filename, content: input.content },
    });
  }

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    const f = this.files.get(fileId);
    if (!f) throw new Error(`FakeSlackGateway: no staged file ${fileId}`);
    return f;
  }

  // --- test controls -----------------------------------------------------
  stageFile(fileId: string, file: DownloadedFile): void {
    this.files.set(fileId, file);
  }
  /** Arm a one-shot failure: the next call that would record `kind` throws instead. */
  failNext(kind: RecordedPost["kind"]): void {
    this.failKinds.add(kind);
  }
  /** Arm a one-shot failure that throws a specific error value (e.g. a Slack `invalid_blocks`). */
  failNextWith(kind: RecordedPost["kind"], error: unknown): void {
    this.failWith.set(kind, error);
  }
  postsOfKind(kind: RecordedPost["kind"]): RecordedPost[] {
    return this.posts.filter((p) => p.kind === kind);
  }
  reset(): void {
    this.posts.length = 0;
    // tsSeq is intentionally NOT reset — timestamps stay globally unique across resets.
    this.files.clear();
  }
}
