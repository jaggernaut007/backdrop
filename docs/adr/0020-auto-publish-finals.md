# 0020 — Finals auto-approve & auto-publish (retire the Keep/pick UI)

**Status:** Accepted · implemented Wave 9 (`src/domain/shot-request.ts` `completeFinals`,
`src/app/run-pipeline-tick.ts` `publishReadyFinals` / `sweepStrandedPicking`,
`src/ports/slack-gateway.ts` + `src/adapters/bolt-slack-gateway.ts` `postFinalsPublished`,
`src/app/ingest-catalog.ts` re-open rule). Supersedes ADR 0009 and ADR 0015's pick phase.

## Context

Finals previously required the approver to tap a Keep button per image after the Draft approval — a
second human gate on top of the direction approval. The user asked to make Finals generation
fully automated: **generate 2 Finals on Draft approval, auto-approve every successfully generated
Final, auto-publish them under deterministic filenames, and post the completion message (with
hyperlinked filenames) into the SKU's thread reply — not the channel root.**

## Decision

- **`approved → finalizing`** remains the only Finals-spend gate (`beginFinals`).
- **`finalizing → done | parked | failed`** resolves directly (`completeFinals`): ≥2 published
  Finals → `done`; exactly one → `parked` (partially done); zero → `failed`.
- `publishReadyFinals` re-hosts each succeeded Final under `publishedFilename(sku, sequence)` in
  generation order (idempotent per attempt), records a `pick` Decision with `actor: "system"`
  (pipeline bookkeeping — the approver's Draft approval was the real gate), then posts the hyperlinked
  completion message into the SKU's living thread reply (`SkuThreadPost.stage = "published"`).
- `postFinalsPublished` builds a mrkdwn headline (`<stableUrl|filename>` per image) plus one image
  block per published Final — no controls. The main channel never carries per-request messages.
- `sweepStrandedPicking` self-heals any legacy `picking` row left in a pre-upgrade DB, resolving it
  via the retained `finishPicking` against its already-published picks.
- The Keep/Finish buttons, `handle-pick.ts`, and the `final_keep` / `finals_finish` handlers are
  removed.

## Consequences

- **Positive:** Finals are now a deterministic hand-off; the only human tap is the Draft approval.
  Filenames stay `hg-002-styled-01.jpg` / `-02.jpg`; the completion message carries stable,
  hyperlinked URLs the web person can use immediately.
- **Re-open rule:** because there is no per-final veto, a product whose Request ends `parked` or
  `failed` is re-listed in the next batch (`ingestCatalog` re-opens terminal-but-not-done SKUs as a
  new `ideaRevision`). A prior `done` (or any active Request) still blocks re-opening.
- **Trade-off:** a wrong Final can no longer be vetoed in place; the Draft gate (and prompt) is now
  the only quality lever. Accepted per DECISIONS.md A1/A8.
- **Why the gate was deferred rather than kept:** a second gate is a second round of *manual work*
  for the one person who has "half of everything else to do", and it re-decides what the Draft
  approval already decided — the approver's approval of a direction is the insight the Finals are generated
  from. Dropping it is what keeps the UX calm while leaving her in control of the only decision that
  spends money. It rests on the approver rejecting directions that aren't right; the integrity of everything
  published now sits entirely on that one tap.
- **Why it must stay auto-generated at scale:** any design where a human adjudicates each Final has a
  per-product human cost that multiplies by catalog size. At 300+ products that stops being operable
  (see DESIGN.md, *What changes at 10×*). The long-term path is the opposite direction — using the
  recorded approve/reject history to make Finals better, and eventually to auto-run high-confidence
  Drafts — not adding review rounds.

## Alternatives considered

- **Per-final Approve/Reject + Approve-all/Reject-all** — richer control, but re-introduces N taps
  per request and the "what happens on a partial decision?" state the user explicitly simplified
  away ("keep it as all finals auto approved").
- **Veto window** — a timer before treating Finals as final; adds a waiting state and delays the
  batch CSV, with no clear owner for the timeout.
