# 0009 — Finals pick UX: auto-`done` at 2 picks + "Finish picking" for ≤1

**Status:** Accepted · implemented Wave 3 (`src/app/handle-pick.ts`, `src/domain/shot-request.ts`
`finishPicking`). Engineering detail of the Finals flow it sits in: [0015](0015-finals-generation-and-publish.md).

## Context

SPEC F4 has two pick scenarios that must both be deterministic:

- *"The approver picks two Finals and the Request is Done"* — publish both, Request `done`.
- *"The approver picks only one Final and the Request is Parked, not Done"* — publish it, Request
  `parked` as partially done.

Finals are posted in **one** Slack message with a Keep control per image. "Done = ≥2 picked"
(DOMAIN.md). The hard part: the one-pick outcome needs to know the approver is *finished* picking, and
Slack gives no natural "I'm done" signal.

## Decision

- Each Keep tap **publishes that image immediately** (deterministic name, [0008](0008-deterministic-filenames.md))
  and records a `pick` Decision.
- On the **2nd distinct pick**, the Request auto-transitions to `done`.
- The finals message also carries a **"Finish picking"** button. Tapping it evaluates: ≥2 picks →
  already `done`; exactly 1 → `parked` (partially done); 0 → stays `picking`.

## Consequences

- "Picks two → done" passes on the 2nd Keep tap, no extra interaction.
- "Picks one → parked" passes when the one-pick test simulates the Finish tap — a real, visible
  affordance, not a timeout to tune.
- Binding-actor check gates Keep and Finish just like Approve/Reject.
- A 3rd Keep tap after `done`/`parked` is ignored outright (`ignoredReason: "not-in-picking"`),
  not a silent re-publish — a new pick is only actionable while `picking`. Re-tapping a Final that
  is *already* kept is an idempotent re-publish to its existing name, with no new Decision.

## Alternatives considered

- **A timeout that parks a single-pick Request after N minutes** — a parameter to get wrong, and
  non-deterministic in tests. Rejected.
- **Require an explicit "Finish" for every outcome** (no auto-done) — adds a tap to the common
  2-pick path, which the whole product exists to minimise. Rejected.
