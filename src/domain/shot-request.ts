/**
 * `ShotRequest` aggregate — the lifecycle state machine and its invariants, as code (DOMAIN.md
 * "ShotRequest — aggregate root"). Every function is pure: it takes a `ShotRequest`, checks the
 * transition is legal, and returns the next one. Illegal transitions throw — a use-case that
 * reaches an impossible state is a bug, not a branch to handle.
 *
 * Lifecycle (Wave 2 covers drafting/review; Wave 3 covers the finals/pick arc; Wave 4 adds
 * `proposed → confirmed`, F2 Request capture; Wave 5 adds `in_review → stale`, F3b escalation):
 *   proposed → confirmed → drafting → in_review → approved → finalizing → done
 *   branches: parked (rejected twice / partial finals), failed (generation dead), stale (un-tapped)
 *   (`picking` is a deprecated pre-ADR-0020 state kept only for legacy-row self-heal)
 *   `stale` is not terminal — Approve/Reject still apply to it (`stale → approved`, `stale → drafting`
 *   or `stale → parked`), so an escalated Draft is a nudge, not a dead-end.
 *
 * Invariants enforced here:
 *  - transitions only along the legal edges (`IllegalTransition` otherwise);
 *  - a Slack-tap-driven transition happens only for the configured binding actor
 *    (`NonBindingActor` otherwise) — ASSUMPTIONS.md A2, "only the approver's tap is binding";
 *  - at most one retry per rejection: a first reject re-enters `drafting`, a second (retry already
 *    consumed) parks the Request — SPEC F3b. No transition here moves toward Finals spend; that is
 *    authorised only by `approveDraft` (→ `approved`), per DOMAIN.md.
 */
import type { ShotIdeaOrigin, ShotRequest, ShotRequestStatus } from "./types.js";

export class IllegalTransition extends Error {
  constructor(
    requestId: string,
    from: ShotRequestStatus,
    expected: readonly ShotRequestStatus[],
  ) {
    super(
      `ShotRequest ${requestId}: illegal transition from "${from}" (expected ${expected.join(" | ")})`,
    );
    this.name = "IllegalTransition";
  }
}

export class NonBindingActor extends Error {
  constructor(actor: string) {
    super(
      `actor "${actor}" is not the binding actor — tap ignored (ASSUMPTIONS.md A2)`,
    );
    this.name = "NonBindingActor";
  }
}

/** The single binding-actor check (ASSUMPTIONS.md A2). An empty actor id is never binding. */
export function isBindingActor(actor: string, bindingActor: string): boolean {
  return actor.length > 0 && actor === bindingActor;
}

function requireStatus(r: ShotRequest, ...expected: ShotRequestStatus[]): void {
  if (!expected.includes(r.status)) {
    throw new IllegalTransition(r.id, r.status, expected);
  }
}

/**
 * `proposed → confirmed`: a human supplied the Shot Idea for a blank row — replied in-thread,
 * accepted the system's proposal as posted, or edited it first (SPEC F2). No binding-actor gate:
 * Capture is not a Decision (DOMAIN.md draws that line at Review), so any human's word fills in
 * the SKU's one blank.
 */
export function confirmRequest(
  r: ShotRequest,
  opts: { text: string; origin: ShotIdeaOrigin },
): ShotRequest {
  requireStatus(r, "proposed");
  return { ...r, status: "confirmed", shotIdeaText: opts.text, shotIdeaOrigin: opts.origin };
}

/** `confirmed → drafting`: a draft generation has been kicked off for this Request. */
export function startDrafting(r: ShotRequest): ShotRequest {
  requireStatus(r, "confirmed");
  return { ...r, status: "drafting" };
}

/** `drafting → in_review`: the Draft image is posted to Slack with Approve / Reject. */
export function postDraftForReview(r: ShotRequest, at: string): ShotRequest {
  requireStatus(r, "drafting");
  return { ...r, status: "in_review", draftPostedAt: at };
}

/** `drafting → failed`: the generation came back unrecoverable. Spend is still recorded on the attempt. */
export function failDraftGeneration(r: ShotRequest): ShotRequest {
  requireStatus(r, "drafting");
  return { ...r, status: "failed" };
}

/**
 * `in_review → stale` when a Draft has sat un-tapped past the configured threshold (SPEC F3b — this
 * instruments VALUE.md's kill signal). Not a Slack-tap transition, so no binding-actor gate; the
 * staleness sweep (`app/staleness-check`) is the only caller. Only fires from `in_review`, so it
 * never re-fires once escalated. `stale` is deliberately NOT terminal (`domain/lifecycle.ts`): the
 * SKU's active slot stays occupied so a re-ingest doesn't open a fresh Request behind the escalation contact's back,
 * and `approveDraft` / `rejectDraft` still accept it — the escalation is a nudge, the Draft is
 * still live for the approver to tap. `escalatedAt` records when the escalation contact was pulled in.
 */
export function markStale(r: ShotRequest, at: string): ShotRequest {
  requireStatus(r, "in_review");
  return { ...r, status: "stale", escalatedAt: at };
}

/**
 * `in_review → approved` (or `stale → approved`) on the approver's Approve tap. This is the ONLY
 * transition that authorises Finals spend (DOMAIN.md). `stale` is accepted because escalation does
 * not retract the review — the Draft is still on screen with live controls and the approver (prompted by
 * the escalation contact's @-mention) can still approve it (`domain/lifecycle.ts`: "`stale` is deliberately not
 * terminal … the approver can still tap it"). Throws `NonBindingActor` for anyone else — the use-case
 * treats that as "tap ignored", it is defence-in-depth here.
 */
export function approveDraft(
  r: ShotRequest,
  actor: string,
  bindingActor: string,
): ShotRequest {
  if (!isBindingActor(actor, bindingActor)) throw new NonBindingActor(actor);
  requireStatus(r, "in_review", "stale");
  return { ...r, status: "approved" };
}

/**
 * the approver's Reject tap. First rejection: `→ drafting` and `retryUsed` is set — the one allowed retry
 * is now granted (Wave 5's `retry-draft` generates it). Second rejection (`retryUsed` already
 * true): `→ parked`, no further generation. Accepts `stale` as well as `in_review` for the same
 * reason as `approveDraft` — an escalated Draft is still tappable. Either way no Finals spend is
 * authorised.
 */
export function rejectDraft(
  r: ShotRequest,
  actor: string,
  bindingActor: string,
): ShotRequest {
  if (!isBindingActor(actor, bindingActor)) throw new NonBindingActor(actor);
  requireStatus(r, "in_review", "stale");
  return r.retryUsed
    ? { ...r, status: "parked" }
    : { ...r, status: "drafting", retryUsed: true };
}

/**
 * `approved → finalizing`: Finals generation is kicked off. This is the guard that makes
 * `DraftApproved` the *only* authoriser of Finals spend (DOMAIN.md / SPEC F4) — it throws for a
 * Request in any other state, so `runFinals` cannot spend on one that was never approved.
 */
export function beginFinals(r: ShotRequest): ShotRequest {
  requireStatus(r, "approved");
  return { ...r, status: "finalizing" };
}

/**
 * DEPRECATED (Wave 9 / ADR 0020): the human Keep/Finish pick phase is retired — Finals now
 * auto-approve and auto-publish. Kept only so a pre-upgrade DB with a `picking` row can be
 * self-healed by `sweepStrandedPicking` (`run-pipeline-tick.ts`); new Requests never enter it.
 * `finalizing → picking`.
 */
export function openFinalsPicking(r: ShotRequest): ShotRequest {
  requireStatus(r, "finalizing");
  return { ...r, status: "picking" };
}

/** `finalizing → failed`: every Finals generation came back unrecoverable. Spend stays booked on the attempts. */
export function failFinalsGeneration(r: ShotRequest): ShotRequest {
  requireStatus(r, "finalizing");
  return { ...r, status: "failed" };
}

/**
 * `finalizing → done | parked` once every succeeded Final has been auto-published (ADR 0020).
 *
 *  - `publishedCount >= 2` → `done` (all Finals approved — the only path to `done`);
 *  - `publishedCount === 1` → `parked` (partially done — one Final generation failed; the product
 *    returns in the next batch, ASSUMPTIONS.md).
 *
 * `publishedCount === 0` is not a legal input here — the all-failed case is `failFinalsGeneration`
 * (`finalizing → failed`), never `completeFinals`.
 */
export function completeFinals(
  r: ShotRequest,
  opts: { publishedCount: number },
): ShotRequest {
  requireStatus(r, "finalizing");
  if (opts.publishedCount >= 2) return { ...r, status: "done" };
  if (opts.publishedCount === 1) return { ...r, status: "parked" };
  throw new IllegalTransition(r.id, r.status, ["finalizing"]);
}

/**
 * Resolve the pick phase (ADR 0009). Called two ways, both with the current count of published
 * picks:
 *  - after the 2nd distinct Keep tap (`pickCount >= 2`) → `done`, automatically;
 *  - on the "Finish picking" tap → `done` if ≥2 were picked, `parked` (partially done) if exactly
 *    1, unchanged (still `picking`) if 0.
 */
export function finishPicking(
  r: ShotRequest,
  opts: { pickCount: number },
): ShotRequest {
  requireStatus(r, "picking");
  if (opts.pickCount >= 2) return { ...r, status: "done" };
  if (opts.pickCount === 1) return { ...r, status: "parked" };
  return r;
}
