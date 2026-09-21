/**
 * The Slack entry point: a Bolt app in Socket Mode (docs/libraries/slack-bolt.md §2, §4, §5).
 *
 * - `file_shared` (F1) — a CSV dropped in the channel is downloaded and handed to `ingestCatalog`,
 *   which also posts the batch status message (F7 / ADR 0019).
 * - `proposal_accept` / `proposal_edit` (+ its modal `proposal_edit_modal`) (F2) — the two ways a
 *   blank row's Shot Idea gets confirmed, both routed to `captureShotIdea`. No binding-actor gate
 *   here (DOMAIN.md draws that line at Review, not Capture — ADR 0018). Wave 7 / ADR 0019 dropped
 *   the third, free-text-thread-reply path: once every SKU in a batch shares one thread, Slack's
 *   flat threading can't tell which SKU a plain reply is about. Button `value`s are a compound
 *   `${importId}:${sku}` so a tap resolves the right batch even if a SKU is open in more than one.
 * - `draft_approve` / `draft_reject` + `reason_*` chips (F3a) — a review tap is routed to
 *   `handleDecision`, which enforces the binding-actor gate. Only the approver's tap moves the Request.
 * - F4 Finals auto-approve & auto-publish on the pipeline tick (`publishReadyFinals`, ADR 0020) —
 *   no block actions; the hyperlinked result is posted into the SKU's living thread reply.
 * - `app_mention` — acknowledged, no action (ASSUMPTIONS.md A6: no command surface).
 *
 * Not covered by the unit suite (needs a live socket); excluded from coverage. The use-cases it
 * calls (`ingestCatalog`, `handleDecision`) are covered directly. Handlers ack first, then work.
 */
import { App } from "@slack/bolt";

import { BoltSlackGateway } from "../adapters/bolt-slack-gateway.js";
import { captureShotIdea } from "../app/capture-shot-idea.js";
import { handleDecision } from "../app/handle-decision.js";
import { ingestCatalog } from "../app/ingest-catalog.js";
import type { Config } from "../config.js";
import type { RejectReason, ShotIdeaOrigin } from "../domain/types.js";
import type { Clock } from "../ports/clock.js";
import type { Repository } from "../ports/repository.js";

/** Split a button `value` of the form `${importId}:${sku}` (Wave 7 / ADR 0019). SKUs never
 *  contain `:` (the catalog's `HG-NNN` scheme), so a single split is unambiguous. */
function splitImportSku(value: string): { importId: string; sku: string } | undefined {
  const i = value.indexOf(":");
  if (i <= 0 || i === value.length - 1) return undefined;
  return { importId: value.slice(0, i), sku: value.slice(i + 1) };
}

export interface SlackRuntimeDeps {
  readonly repo: Repository;
  readonly clock: Clock;
}

export interface SlackRuntime {
  readonly app: App;
  /** The gateway built on `app.client` — shared with the job loop so both post to one channel. */
  readonly gateway: BoltSlackGateway;
}

/** Reject-reason chip `action_id` → the `RejectReason` it records (docs/libraries/slack-bolt.md §3b). */
const REASON_ACTIONS: ReadonlyArray<readonly [string, RejectReason]> = [
  ["reason_wrong_vibe", "wrong vibe"],
  ["reason_color_off", "color off"],
  ["reason_too_staged", "too staged"],
  ["reason_other", "other"],
];

function looksLikeCsv(
  name: string | undefined,
  mimetype: string | undefined,
  filetype: string | undefined,
): boolean {
  return (
    (name ?? "").toLowerCase().endsWith(".csv") ||
    (mimetype ?? "").includes("csv") ||
    (filetype ?? "").toLowerCase() === "csv"
  );
}

/** Bolt action payloads are broad unions; we only touch a few string fields. */
function actionValue(action: unknown): string | undefined {
  const v = (action as { value?: unknown }).value;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

type Block = Record<string, unknown>;

/** The Approve / Reject row a Draft is first posted with — matches `BoltSlackGateway`. */
function draftActionsBlock(requestId: string): Block {
  return {
    type: "actions",
    block_id: "draft_actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Approve" },
        style: "primary",
        action_id: "draft_approve",
        value: requestId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Reject…" },
        style: "danger",
        action_id: "draft_reject",
        value: requestId,
      },
    ],
  };
}

/** The reason chips + a "Never mind" escape, shown in place of the Approve/Reject row on Reject. */
function rejectReasonActionsBlock(requestId: string): Block {
  return {
    type: "actions",
    block_id: "reject_reason",
    elements: [
      ...REASON_ACTIONS.map(([actionId, reason]) => ({
        type: "button",
        text: {
          type: "plain_text",
          text: reason.replace(/^\w/, (c) => c.toUpperCase()),
        },
        action_id: actionId,
        value: requestId,
      })),
      {
        type: "button",
        text: { type: "plain_text", text: "Never mind" },
        action_id: "reason_cancel",
        value: requestId,
      },
    ],
  };
}

/**
 * Slack hydrates `image` blocks in a `block_actions` payload with read-only, server-computed
 * fields (`image_width`, `image_height`, `image_bytes`, `is_animated`, `fallback`) that are not
 * valid *inputs*. Echoing them back into `chat.update` makes Slack log
 * `ignored_extra_attributes_for_image_block` on every Reject / "Never mind" round-trip. Reduce a
 * kept block to the input-valid keys before re-submitting.
 */
function sanitizeKeptBlock(b: Block): Block {
  if (b?.["type"] !== "image") return b;
  const out: Block = {
    type: "image",
    image_url: b["image_url"],
    alt_text: b["alt_text"],
  };
  if (b["title"]) out["title"] = b["title"];
  if (b["block_id"]) out["block_id"] = b["block_id"];
  return out;
}

/** Swap one `actions` block for another, keeping the image + text blocks intact. */
function swapActionsBlock(priorBlocks: unknown, replacement: Block): Block[] {
  const kept = Array.isArray(priorBlocks)
    ? (priorBlocks as Block[])
        .filter((b) => b?.["type"] !== "actions")
        .map(sanitizeKeptBlock)
    : [{ type: "section", text: { type: "mrkdwn", text: "Draft review" } }];
  return [...kept, replacement];
}

export function createSlackApp(
  config: Config,
  deps: SlackRuntimeDeps,
): SlackRuntime {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  const gateway = new BoltSlackGateway(app.client, config.slack.channelId);
  const decisionDeps = { repo: deps.repo, clock: deps.clock, gateway, config };
  const captureDeps = { repo: deps.repo, gateway, clock: deps.clock };

  app.event("file_shared", async ({ event, client, logger }) => {
    // `file_shared` fires once per channel a file lands in, for every channel the bot is in.
    if (event.channel_id !== config.slack.channelId) return;
    const fileId = event.file_id;
    if (!fileId) return;
    try {
      const info = await client.files.info({ file: fileId });
      if (
        !looksLikeCsv(info.file?.name, info.file?.mimetype, info.file?.filetype)
      ) {
        return; // not a catalog Export — ignore
      }
      const downloaded = await gateway.downloadFile(fileId);
      const result = await ingestCatalog(
        { repo: deps.repo, slack: gateway, clock: deps.clock },
        { csv: downloaded.bytes, sourceRef: fileId },
      );
      logger.info(
        {
          importId: result.importId,
          alreadyIngested: result.alreadyIngested,
          requestsOpened: result.requestsOpened,
          summaryPosted: result.summaryPosted,
          batchStatusPosted: result.batchStatusPosted,
          blankRowAsksPosted: result.blankRowAsksPosted,
        },
        "catalog ingested",
      );
      if (result.summaryPosted === false) {
        await gateway.postImportSummary(
          `Import ${result.importId} landed: ${result.rowCount} products, ${result.requestsOpened} new Requests.`,
        );
      }
    } catch (err) {
      logger.error(err, "catalog ingest failed");
      await gateway.postMessage(
        "⚠ Couldn't ingest that CSV — see the server logs for details.",
      );
    }
  });

  // F3a — Approve. The binding-actor gate is inside `handleDecision`; a non-binding tap no-ops.
  app.action("draft_approve", async ({ ack, body, action, logger }) => {
    await ack();
    const requestId = actionValue(action);
    const actor = (body as { user?: { id?: string } }).user?.id ?? "";
    if (!requestId) return;
    const res = await handleDecision(decisionDeps, {
      requestId,
      actor,
      verb: "approve",
    });
    logger.info({ requestId, actor, res }, "draft_approve handled");
  });

  // F3a — Reject reveals the reason chips (only for the binding actor — anyone else's tap is inert;
  // with OPEN_APPROVAL on, everyone is the binding actor). The image + Shot Idea stay; only the
  // Approve/Reject row is swapped, and a "Never mind" chip restores it, so a mis-tap has a way back.
  const swapDraftControls = async (
    client: App["client"],
    body: unknown,
    replacement: Block,
    fallbackText: string,
    logger: { error: (e: unknown, m: string) => void },
  ): Promise<void> => {
    const b = body as {
      channel?: { id?: string };
      message?: { ts?: string; blocks?: unknown };
    };
    const channel = b.channel?.id;
    const ts = b.message?.ts;
    if (!channel || !ts) return;
    try {
      await client.chat.update({
        channel,
        ts,
        text: fallbackText,
        blocks: swapActionsBlock(b.message?.blocks, replacement) as never,
      });
    } catch (err) {
      logger.error(err, "failed to swap draft controls");
    }
  };

  app.action("draft_reject", async ({ ack, body, action, client, logger }) => {
    await ack();
    const requestId = actionValue(action);
    if (!requestId) return;
    if (
      !config.slack.openApproval &&
      (body as { user?: { id?: string } }).user?.id !== config.slack.approverUserId
    )
      return;
    await swapDraftControls(
      client,
      body,
      rejectReasonActionsBlock(requestId),
      "Reject — pick a reason",
      logger,
    );
  });

  // F3a — "Never mind" on the chip row: put the Approve/Reject controls back.
  app.action("reason_cancel", async ({ ack, body, action, client, logger }) => {
    await ack();
    const requestId = actionValue(action);
    if (!requestId) return;
    if (
      !config.slack.openApproval &&
      (body as { user?: { id?: string } }).user?.id !== config.slack.approverUserId
    )
      return;
    await swapDraftControls(
      client,
      body,
      draftActionsBlock(requestId),
      "Draft ready for review",
      logger,
    );
  });

  // F3a — a chip records the Decision with its reason.
  for (const [actionId, reason] of REASON_ACTIONS) {
    app.action(actionId, async ({ ack, body, action, logger }) => {
      await ack();
      const requestId = actionValue(action);
      const actor = (body as { user?: { id?: string } }).user?.id ?? "";
      if (!requestId) return;
      const res = await handleDecision(decisionDeps, {
        requestId,
        actor,
        verb: "reject",
        reason,
      });
      logger.info(
        { requestId, actor, reason, res },
        "draft reject reason handled",
      );
    });
  }

  // F2 — accept the proposal exactly as posted. `value` is `${importId}:${sku}` (Wave 7 / ADR 0019).
  app.action("proposal_accept", async ({ ack, action, logger }) => {
    await ack();
    const raw = actionValue(action);
    const parsed = raw ? splitImportSku(raw) : undefined;
    if (!parsed) return;
    const { importId, sku } = parsed;
    const thread = deps.repo.getSkuThreadPost(importId, sku);
    if (!thread?.proposedText) return;
    const res = await captureShotIdea(captureDeps, {
      sku,
      text: thread.proposedText,
      origin: "proposed",
      importId,
    });
    logger.info({ importId, sku, res }, "proposal_accept handled");
  });

  // F2 — open a modal pre-filled with the proposal so a person can edit before confirming.
  app.action("proposal_edit", async ({ ack, body, action, client, logger }) => {
    await ack();
    const raw = actionValue(action);
    const parsed = raw ? splitImportSku(raw) : undefined;
    if (!parsed) return;
    const { importId, sku } = parsed;
    const thread = deps.repo.getSkuThreadPost(importId, sku);
    if (!thread?.proposedText) return;
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!triggerId) return;
    try {
      await client.views.open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: "proposal_edit_modal",
          private_metadata: raw,
          title: { type: "plain_text", text: "Edit Shot Idea" },
          submit: { type: "plain_text", text: "Confirm" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "shot_idea_block",
              label: { type: "plain_text", text: "Shot Idea" },
              element: {
                type: "plain_text_input",
                action_id: "shot_idea_input",
                multiline: true,
                initial_value: thread.proposedText,
              },
            },
          ],
        } as never,
      });
    } catch (err) {
      logger.error(err, "failed to open proposal edit modal");
    }
  });

  // F2 — the modal submission: unchanged text confirms `proposed`, a change is
  // `proposed-then-edited`.
  app.view("proposal_edit_modal", async ({ ack, view, logger }) => {
    await ack();
    const parsed = splitImportSku(view.private_metadata);
    const submitted =
      view.state.values["shot_idea_block"]?.["shot_idea_input"]?.value ?? "";
    if (!parsed || submitted.trim() === "") return;
    const { importId, sku } = parsed;
    const thread = deps.repo.getSkuThreadPost(importId, sku);
    const origin: ShotIdeaOrigin =
      thread?.proposedText && submitted.trim() === thread.proposedText.trim()
        ? "proposed"
        : "proposed-then-edited";
    const res = await captureShotIdea(captureDeps, {
      sku,
      text: submitted,
      origin,
      importId,
      // A modal submit can't repaint the thread pane in place — delete + repost the reply.
      replaceThreadReply: true,
    });
    logger.info({ importId, sku, origin, res }, "proposal edit modal submitted");
  });

  app.event("app_mention", async ({ logger }) => {
    logger.info(
      "app_mention received — no command surface in scope (ASSUMPTIONS.md A6)",
    );
  });

  app.error(async (error) => {
    console.error("bolt error", error);
  });

  return { app, gateway };
}
