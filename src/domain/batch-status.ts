/**
 * Presentation + completion rules for the batch status post (Wave 7 / ADR 0019) — one Slack
 * message per `CatalogImport`, listing every row's SKU, product name, and current status, live
 * until every row reaches a terminal outcome. Pure; no Slack, no persistence.
 *
 * Deliberately not named `dashboard.ts` — see ADR 0019 for why that distinction is load-bearing:
 * SPEC.md/VALUE.md rule out "a dashboard, of any kind" as an anti-pattern, and this feature is a
 * scoped exception to that rule, not a reversal of it.
 */
import { isTerminal } from "./lifecycle.js";
import type { ShotRequestStatus } from "./types.js";

/** One row of the batch status post, already resolved to display text. */
export interface BatchStatusRow {
  readonly sku: string;
  readonly productName: string;
  readonly label: string;
}

/**
 * Emoji-prefixed label for the batch status post. `proposed` branches on whether the blank row's
 * ask has actually reached Slack yet (`postBlankRowAsk` is best-effort and can fail) — before that,
 * there's nothing yet for a human to act on; after, the ball is in their court.
 *
 * `stale` is reachable once the staleness scheduler escalates an un-tapped Draft (Wave 5 / F3b).
 */
export function friendlyStatusLabel(
  status: ShotRequestStatus,
  hasLivingPost: boolean,
): string {
  switch (status) {
    case "proposed":
      return hasLivingPost ? "📝 Proposal sent" : "💬 Awaiting idea";
    case "confirmed":
      return "🕐 Queued for drafting";
    case "drafting":
      return "🎨 Drafting";
    case "in_review":
      return "👀 Awaiting review";
    case "approved":
      return "✅ Approved — queued for finals";
    case "finalizing":
      return "🎨 Generating finals";
    case "picking":
      return "🖼️ Awaiting pick";
    case "done":
      return "✅ Done";
    case "parked":
      return "⏸️ Parked";
    case "failed":
      return "❌ Failed";
    case "stale":
      return "⏰ Stale — escalated";
  }
}

/** Terse, emoji-free status text for the CSV export's `Status` column. Covers the same statuses as
 *  `friendlyStatusLabel` but with its own shorter wording (e.g. `approved`, not "Approved — queued
 *  for finals"); keep the two in sync when a status is added. */
export function plainStatusLabel(status: ShotRequestStatus): string {
  switch (status) {
    case "proposed":
      return "awaiting idea";
    case "confirmed":
      return "queued for drafting";
    case "drafting":
      return "drafting";
    case "in_review":
      return "awaiting review";
    case "approved":
      return "approved";
    case "finalizing":
      return "generating finals";
    case "picking":
      return "awaiting pick";
    case "done":
      return "done";
    case "parked":
      return "parked";
    case "failed":
      return "failed";
    case "stale":
      return "stale";
  }
}

/** A batch is complete once every row's status is terminal (`domain/lifecycle.ts`). Empty = complete. */
export function isBatchComplete(
  statuses: readonly ShotRequestStatus[],
): boolean {
  return statuses.every(isTerminal);
}
