import type { ShotRequestStatus } from "./types.js";

/**
 * ShotRequest lifecycle:
 *   proposed → confirmed → drafting → in_review → approved → finalizing → picking → done
 * branches: parked (rejected twice / partially picked), failed (generation dead),
 *           stale (Draft un-tapped past the threshold → escalated to the escalation contact).
 *
 * Single source of truth for "is this state terminal" — consumed by the repository (SQLite adapter
 * and the in-memory fake both filter on it) so the "at most one active Request per SKU" invariant
 * (DOMAIN.md) can't drift between implementations.
 */

/**
 * Terminal = spend has permanently stopped and the Request no longer occupies the SKU's single
 * active slot.
 *
 * NOTE: `stale` is deliberately **not** terminal. A stale Draft has been escalated to the escalation contact, but
 * The approver can still tap it — so the Request stays active and still blocks a new Request for that SKU.
 */
export const TERMINAL_STATUSES: ReadonlySet<ShotRequestStatus> =
  new Set<ShotRequestStatus>(["done", "parked", "failed"]);

export function isTerminal(status: ShotRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
