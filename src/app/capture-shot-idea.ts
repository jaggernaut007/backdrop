/**
 * F2 — Request capture. Turns a `proposed` blank-row Request into a `confirmed` one. Two ways,
 * both button-driven (Wave 7 / ADR 0019 dropped free-text thread replies — once every SKU in a
 * batch shares one thread, Slack's flat threading can't tell which SKU a plain reply is about):
 * the proposal accepted as posted (`proposed`), or the proposal edited before it was accepted
 * (`proposed-then-edited`). `slack-reply` stays a legal `ShotIdeaOrigin` for callers that supply
 * text directly (tests, and any future non-Slack capture path) — `captureShotIdea` itself doesn't
 * care which path produced `{ sku, text, origin }`.
 *
 * No binding-actor gate (contrast `handle-decision.ts`): DOMAIN.md draws that line at *Review*
 * (a Decision), not at *Capture* — any human's word is enough to fill in the SKU's one blank.
 */
import { confirmRequest } from "../domain/shot-request.js";
import type { ShotIdeaOrigin, ShotRequestStatus } from "../domain/types.js";
import type { Clock } from "../ports/clock.js";
import type { Repository } from "../ports/repository.js";
import type { SlackGateway } from "../ports/slack-gateway.js";
import { refreshBatchStatus } from "./refresh-batch-status.js";

export interface CaptureShotIdeaDeps {
  readonly repo: Repository;
  readonly gateway: SlackGateway;
  readonly clock: Clock;
}

export interface CaptureShotIdeaInput {
  readonly sku: string;
  readonly text: string;
  readonly origin: ShotIdeaOrigin;
  /** Which batch's living thread reply (Wave 7) to update — the button/modal's compound
   *  `${importId}:${sku}` value. Optional so direct callers (tests, a future non-batch path) can
   *  omit it; without it, no thread message is updated and no batch status refresh runs. */
  readonly importId?: string;
  /**
   * Wave 8: when the confirm came from the "Edit before using" **modal**, edit the SKU's reply by
   * deleting it and posting a fresh one rather than `chat.update`-ing in place. A `view_submission`
   * isn't bound to a message, so the Slack client won't repaint the thread pane for an in-place
   * edit until it's reopened; a brand-new message always renders. Button taps ("Use this") don't
   * need this — they repaint their own message. No-op without a living thread reply.
   */
  readonly replaceThreadReply?: boolean;
}

export interface CaptureShotIdeaResult {
  readonly applied: boolean;
  readonly ignoredReason?: "no-active-request" | "not-proposed" | "blank-text";
  readonly requestId?: string;
  readonly newStatus?: ShotRequestStatus;
}

export async function captureShotIdea(
  deps: CaptureShotIdeaDeps,
  input: CaptureShotIdeaInput,
): Promise<CaptureShotIdeaResult> {
  const { repo, gateway } = deps;

  const text = input.text.trim();
  if (text === "") return { applied: false, ignoredReason: "blank-text" };

  const request = repo.getActiveRequestForSku(input.sku);
  if (!request) return { applied: false, ignoredReason: "no-active-request" };
  // Idempotent against a stale button tap / duplicate reply after the SKU is already confirmed.
  if (request.status !== "proposed")
    return { applied: false, ignoredReason: "not-proposed" };

  const next = confirmRequest(request, { text, origin: input.origin });
  repo.saveRequest(next);

  if (input.importId) {
    const thread = repo.getSkuThreadPost(input.importId, input.sku);
    if (thread) {
      const confirmedText = `✅ Shot Idea confirmed for *${input.sku}*: _${text}_`;
      try {
        const batchPost = input.replaceThreadReply
          ? repo.getBatchStatusPost(input.importId)
          : null;
        if (input.replaceThreadReply && batchPost) {
          await gateway.deleteMessage({
            channel: thread.slackChannel,
            ts: thread.slackTs,
          });
          const reposted = await gateway.postSkuThreadReply({
            threadTs: batchPost.slackTs,
            text: confirmedText,
          });
          repo.saveSkuThreadPost({
            ...thread,
            slackChannel: reposted.channel,
            slackTs: reposted.ts,
            updatedAt: deps.clock.now(),
          });
        } else {
          await gateway.updateMessage({
            channel: thread.slackChannel,
            ts: thread.slackTs,
            text: confirmedText,
          });
        }
      } catch {
        // Cosmetic only — the Request is already confirmed and durable.
      }
    }
    await refreshBatchStatus(
      { repo, slack: gateway, clock: deps.clock },
      input.sku,
    );
  }

  return { applied: true, requestId: next.id, newStatus: next.status };
}
