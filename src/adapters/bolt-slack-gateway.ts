/**
 * `SlackGateway` over a Bolt `WebClient` (docs/libraries/slack-bolt.md §3–§5). Block Kit builders
 * for the review posts; a `files.info` + authenticated `fetch` for CSV download that checks the
 * content-type (the `url_private_download` login-page trap).
 *
 * Wave 7 / ADR 0019: `postBlankRowAsk` / `postDraftForReview` / `postFinalsPublished` are now
 * post-OR-update (`existing` present → `chat.update` that SKU's one living thread reply in place;
 * absent → `chat.postMessage` with `thread_ts` into the batch's thread). `upsertBatchStatus` is the
 * batch status post itself (never threaded — it's the thread root). `uploadBatchExportCsv` uses
 * `filesUploadV2` (needs the `files:write` scope).
 *
 * This adapter talks to a live workspace, so it is exercised manually in the demo, not by the unit
 * suite (which drives `FakeSlackGateway`). Keep behaviour thin and the shapes faithful to the port.
 */
import type { App } from "@slack/bolt";

import type {
  BatchStatusRow,
  DownloadedFile,
  PostedMessage,
  PublishedFinal,
  SlackGateway,
} from "../ports/slack-gateway.js";

/** Bolt's bundled Web API client — reached via `app.client`, so no direct `@slack/web-api` import. */
type SlackWebClient = App["client"];

// Block Kit is deeply typed in `@slack/types`; the port speaks plain shapes. Build as `unknown[]`
// and hand to the client once — a single narrow cast at the boundary beats threading block unions.
type Block = Record<string, unknown>;

/** Rows per batch-status section block — keeps each block comfortably under Slack's ~3000-char
 *  mrkdwn ceiling and the whole message under its 50-block ceiling at catalog-scale (~40 SKUs). */
const BATCH_STATUS_ROWS_PER_BLOCK = 15;

function buildBatchStatusBlocks(rows: readonly BatchStatusRow[]): Block[] {
  const blocks: Block[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Batch status* — ${rows.length} item${rows.length === 1 ? "" : "s"}`,
      },
    },
  ];
  for (let i = 0; i < rows.length; i += BATCH_STATUS_ROWS_PER_BLOCK) {
    const chunk = rows.slice(i, i + BATCH_STATUS_ROWS_PER_BLOCK);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: chunk
          .map((r) => `*${r.sku}* — ${r.productName}: ${r.label}`)
          .join("\n"),
      },
    });
  }
  return blocks;
}

export class BoltSlackGateway implements SlackGateway {
  constructor(
    private readonly client: SlackWebClient,
    private readonly channel: string,
  ) {}

  private async post(
    text: string,
    blocks?: Block[],
    threadTs?: string,
  ): Promise<PostedMessage> {
    const res = await this.client.chat.postMessage({
      channel: this.channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(blocks ? { blocks: blocks as never } : {}),
    });
    // Store Slack's canonical `C…` id, not the configured value — a tap's `body.channel.id` is
    // always the id, and Wave 2 correlates ReviewPosts on it.
    return {
      channel: String(res.channel ?? this.channel),
      ts: String(res.ts ?? ""),
    };
  }

  /** Full block rebuild on an existing message — distinct from `updateMessage`'s narrow "swap
   *  controls for a status line", which stays as-is for its existing callers. */
  private async update(
    channel: string,
    ts: string,
    text: string,
    blocks?: Block[],
  ): Promise<PostedMessage> {
    await this.client.chat.update({
      channel,
      ts,
      text,
      ...(blocks ? { blocks: blocks as never } : {}),
    });
    return { channel, ts };
  }

  private async postOrUpdate(
    text: string,
    blocks: Block[] | undefined,
    threadTs: string,
    existing?: PostedMessage,
  ): Promise<PostedMessage> {
    if (existing) return this.update(existing.channel, existing.ts, text, blocks);
    return this.post(text, blocks, threadTs);
  }

  postImportSummary(text: string): Promise<PostedMessage> {
    return this.post(text);
  }

  postMessage(text: string): Promise<PostedMessage> {
    return this.post(text);
  }

  mentionEscalationContact(text: string): Promise<PostedMessage> {
    return this.post(text);
  }

  async deleteMessage(input: { channel: string; ts: string }): Promise<void> {
    await this.client.chat.delete({ channel: input.channel, ts: input.ts });
  }

  postSkuThreadReply(input: {
    threadTs: string;
    text: string;
  }): Promise<PostedMessage> {
    return this.post(input.text, undefined, input.threadTs);
  }

  upsertBatchStatus(input: {
    existing?: PostedMessage;
    rows: readonly BatchStatusRow[];
  }): Promise<PostedMessage> {
    const text = `Batch status — ${input.rows.length} item${input.rows.length === 1 ? "" : "s"}`;
    const blocks = buildBatchStatusBlocks(input.rows);
    if (input.existing) {
      return this.update(input.existing.channel, input.existing.ts, text, blocks);
    }
    return this.post(text, blocks);
  }

  postBlankRowAsk(input: {
    importId: string;
    sku: string;
    productName: string;
    proposedText: string;
    threadTs: string;
    existing?: PostedMessage;
  }): Promise<PostedMessage> {
    // Compound value — a SKU can be open in more than one batch at once (Wave 7 / ADR 0019), so a
    // tap must say which batch's thread reply it came from.
    const value = `${input.importId}:${input.sku}`;
    const blocks: Block[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${input.sku}* — ${input.productName}: no Shot Idea yet. Use this, or edit it first:\n> ${input.proposedText}`,
        },
      },
      {
        type: "actions",
        block_id: "proposal_actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Use this" },
            style: "primary",
            action_id: "proposal_accept",
            value,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Edit before using" },
            action_id: "proposal_edit",
            value,
          },
        ],
      },
    ];
    return this.postOrUpdate(
      `*${input.sku}* — ${input.productName}: no Shot Idea yet. Use this, or edit it first: "${input.proposedText}"`,
      blocks,
      input.threadTs,
      input.existing,
    );
  }

  postDraftForReview(input: {
    requestId: string;
    sku: string;
    imageUrl: string;
    shotIdea: string;
    riskFlags: readonly string[];
    threadTs: string;
    existing?: PostedMessage;
  }): Promise<PostedMessage> {
    const blocks: Block[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${input.sku}* — approve this direction?\n_${input.shotIdea}_`,
        },
      },
    ];
    if (input.riskFlags.length > 0) {
      blocks.push({
        type: "context",
        elements: [
          { type: "mrkdwn", text: `⚠ ${input.riskFlags.join(" · ")}` },
        ],
      });
    }
    blocks.push(
      {
        type: "image",
        image_url: input.imageUrl,
        alt_text: `Styled draft for ${input.sku}`,
      },
      {
        type: "actions",
        block_id: "draft_actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            action_id: "draft_approve",
            value: input.requestId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Reject…" },
            style: "danger",
            action_id: "draft_reject",
            value: input.requestId,
          },
        ],
      },
    );
    return this.postOrUpdate(
      `Draft ready for review — ${input.sku}`,
      blocks,
      input.threadTs,
      input.existing,
    );
  }

  postFinalsPublished(input: {
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
    const headline =
      input.status === "done"
        ? `✅ *${input.sku}* — done. Published: ${links}.`
        : input.status === "parked"
          ? `🅿 *${input.sku}* — parked: only one Final published (${links}). It needs two to be done.`
          : `⚠ *${input.sku}* — every Finals generation failed. Nothing was published.`;
    const blocks: Block[] = [
      {
        type: "section",
        text: { type: "mrkdwn", text: headline },
      },
    ];
    for (const p of input.published) {
      blocks.push({
        type: "image",
        image_url: p.stableUrl,
        alt_text: `Published final ${p.filename} for ${input.sku}`,
        title: { type: "plain_text", text: p.filename },
      });
    }
    return this.postOrUpdate(headline, blocks, input.threadTs, input.existing);
  }

  async updateMessage(input: {
    channel: string;
    ts: string;
    text: string;
    keepImageUrl?: string;
    /** Optional SKU to set as the image alt-text (makes the thumbnail accessible). */
    sku?: string;
  }): Promise<void> {
    const blocks: Block[] = [];
    if (input.keepImageUrl) {
      blocks.push({
        type: "image",
        image_url: input.keepImageUrl,
        alt_text: input.sku ? `Final image for ${input.sku}` : "reviewed image",
      });
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: input.text },
    });
    await this.client.chat.update({
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      blocks: blocks as never,
    });
  }

  async uploadBatchExportCsv(input: {
    filename: string;
    content: string;
  }): Promise<void> {
    // Channel root, not the batch thread — the finished file should be visible without expanding
    // a thread (Wave 8). Exactly-once is enforced upstream (`exportUploadedAt` + the per-import
    // lock in `refresh-batch-status.ts`).
    await this.client.filesUploadV2({
      channel_id: this.channel,
      filename: input.filename,
      content: input.content,
      initial_comment: "Batch complete — updated catalog CSV attached.",
    });
  }

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    const info = await this.client.files.info({ file: fileId });
    const file = info.file;
    const url = file?.url_private_download ?? file?.url_private;
    if (!url) {
      throw new Error(`file ${fileId}: no url_private_download in files.info`);
    }
    // A catalog Export is a few KB. Reject anything that would OOM the box before buffering it.
    const MAX_BYTES = 10 * 1024 * 1024;
    if (typeof file?.size === "number" && file.size > MAX_BYTES) {
      throw new Error(
        `file ${fileId}: ${file.size} bytes exceeds the ${MAX_BYTES}-byte ceiling`,
      );
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.client.token ?? ""}` },
    });
    if (!res.ok) {
      throw new Error(
        `file ${fileId}: download failed with HTTP ${res.status}`,
      );
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      // url_private_download answers 200 + an HTML login page on bad auth — status alone lies.
      throw new Error(
        `file ${fileId}: got an HTML login page — bad auth on url_private_download`,
      );
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      filename: file?.name ?? fileId,
      mimetype: file?.mimetype ?? contentType,
      bytes,
    };
  }
}
