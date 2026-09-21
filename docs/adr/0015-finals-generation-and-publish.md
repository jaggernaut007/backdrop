# 0015 — Finals: fan out N, resolve all, post once; deterministic name only on the pick

**Status:** Accepted · implemented Wave 3 (`src/app/run-finals.ts`, `src/app/run-pipeline-tick.ts`,
`src/app/handle-pick.ts`, `src/domain/publish.ts`)

## Context

F4 turns an `approved` Request into `finalsPerDirection` (3) Finals posted to Slack **in one
message** with a Keep control on each; ≥2 picks is `Done`, exactly one is `parked` (ADR 0009).
`DraftApproved` is the _only_ authoriser of Finals spend (DOMAIN.md / SPEC F4). Builds on the
Draft lifecycle in [0014](0014-generation-lifecycle.md): async Luma `image_edit`, presigned output
URLs that expire in ~1h, one in-process poll loop, nothing may block a Slack ack.

Three questions specific to Finals: (a) where the "only after approval" guard lives; (b) whether
"generate 3, then post the one review message" is one loop step or two; (c) when the deterministic
`hg-002-styled-01.jpg` name (ADR 0008) is assigned.

## Decision

**The guard is a state transition.** `beginFinals` (`approved → finalizing`) throws for a Request
in any other state. `runFinals` computes it _first_, before composing a prompt or calling Luma —
so a Request that was never approved cannot reach a `create` call. `startApprovedFinals` (half of
`runPipelineTick`) only ever iterates `listRequestsByStatus("approved")`. Two layers, same
invariant.

**Reuse the approved direction's prompt.** Finals are generated from the exact `promptText` of the
Draft attempt the approver approved (found via the `approve` Decision's `attemptId`); failing that, the
most recent succeeded attempt's prompt; last resort, a fresh `composeGenerationPrompt` from the
Product. Finals are never a re-judgement — they are the approved look at `uni-1-max`.

**Two steps, not one.**

- `startApprovedFinals` → `runFinals`: **top up** to `finalsPerDirection` at `uni-1-max`. It counts
  the Request's existing `final`-kind attempts and issues only the shortfall; each `create` is
  followed immediately by its own `saveAttempt` (a `pending` `final` row carrying `finalCostCents`)
  before the next `create`. `saveRequest(finalizing)` runs last, once the full set exists — until
  then the Request stays `approved` and the next tick tops it up. (`run-draft` gets away with
  create-then-write because N = 1; a 3-wide fan-out does not — see Consequences.)
- `resolvePendingGenerations` → `resolveFinalGeneration`: poll each Final attempt; re-host a
  completed image under a **throwaway** name (`hg-002-final-<8hex>.jpg`) and mark it `succeeded`;
  mark a dead one `failed` (spend already booked). **No Request transition, no Slack post here.**
- `postReadyFinals` (a separate pass): for every `finalizing` Request whose Final attempts have
  _all_ resolved, post the single review message (one Keep per succeeded image), save a `finals`
  `ReviewPost`, and move `finalizing → picking`. If every Final failed, `finalizing → failed` with
  a plain-language line.

Splitting the post into its own pass is the [0014](0014-generation-lifecycle.md) B2 fix applied to
Finals: a Slack failure leaves the Request `finalizing` with its attempts already `succeeded`, and
the next `postReadyFinals` sweep re-posts — no paid-for Finals batch is stranded, and nothing is
re-generated.

**The deterministic name is the identity of a _picked_ Final, assigned by `handle-pick`.** A Keep
tap re-hosts the chosen attempt's image under `publishedFilename(sku, sequence)` =
`${sku.toLowerCase()}-styled-${NN}.jpg` (`NN` = 1-based pick order), writes a `PublishedImage`,
and records a `pick` Decision. The 2nd distinct pick calls `finishPicking(r, { pickCount: 2 })` →
`done` automatically; "Finish picking" runs the same function against the live count (≥2 → `done`,
1 → `parked`, 0 → unchanged). Binding-actor gate first, exactly as `handle-decision`. Re-tapping an
already-kept Final is an idempotent re-publish with no new Decision.

## Consequences

- Slack only ever sees a `finalizing → picking` Request once _every_ Final attempt has resolved and
  its surviving images are on our volume; the review message is one atomic post, never "2 of 3,
  third to follow". The fewer-than-three case is the "Partial failure" bullet below.
- **Every billed generation has a ledger row, and a mid-fan-out failure can't compound.** Because
  each `create` is followed by its own `saveAttempt` before the next, a `create` that throws on the
  2nd or 3rd call (a Luma 429 at the concurrent-jobs ceiling, no `Retry-After` backoff yet — Wave 6)
  unwinds with the already-issued generations recorded as `pending` rows: `resolvePendingGenerations`
  polls and re-hosts them, and the next tick's `runFinals` sees them and issues only the remaining
  shortfall. The count converges on exactly `finalsPerDirection`; it never re-kicks a whole second
  batch, and no paid-for generation is invisible to the ledger (DOMAIN.md / DECISIONS.md — the
  "no hard spend stop" cut is only safe because every attempt logs cents). Same for a crash between
  the last `saveAttempt` and `saveRequest(finalizing)`: the rows are `pending`, the Request is still
  `approved`, and the next tick just re-applies the transition. The residual exposure is a `create`
  that _succeeds_ then the process dies before its `saveAttempt` — one orphaned `uni-1-max`
  generation (~11¢) per such death, re-attempted on the next tick. Bounded to one, and Finals run
  only after the approver's explicit approval tap (≈16 times for the sample catalog, never unattended).
- Two re-hosts per published Final: once to the throwaway name at resolution, once to the
  deterministic name on the pick. The second reads the first's stable `/img/` URL (served by the
  same process), so it never touches an expired Luma URL. Idempotent overwrites on both names.
- A 3rd Keep tap after `done`/`parked` is ignored (`not-in-picking`), not a silent re-publish —
  tightening ADR 0009's "harmless no-op re-publish" to "no-op".
- **Partial failure.** If some but not all Finals of a batch die, `postReadyFinals` posts the
  survivors (1 or 2 images) and still moves to `picking` — a review with fewer than 3 options
  beats blocking the Request on a re-generation loop. Spend is booked on the dead attempts, and
  `postReadyFinals` caps the message at `finalsPerDirection` (defence in depth). SPEC F4's happy
  path assumes 3 succeed; _regenerating_ a failed Final to reach 3 (as opposed to topping up
  never-created ones, which `runFinals` already does) is a Wave 6 hardening item.
- **`handle-pick` runs the pick as one synchronous critical section.** The sequence is read,
  the `PublishedImage` + `pick` Decision written, and the auto-`done` transition saved with **no
  `await` in between** — Node runs it to completion before the next event, so two rapid Keep taps
  can't both compute sequence `01` or both slip past the "already kept" guard. The image bytes
  are hosted (`putFromUrl`) only after; a failure there leaves the row pointing at the
  deterministic name, which the next re-tap (or a retry) re-hosts to. `stableUrl` is taken from
  `ImageStore.urlFor` (no write) so the row is complete before the bytes land. Same
  persist-first / best-effort-IO order as `handle-decision`. If `putFromUrl` or the Slack line
  throws, it is swallowed and surfaced as `hostFailed` on the result — never a rollback.
- **Every tap gets Slack feedback.** A Keep posts a one-line ack naming the deterministic filename
  (ADR 0008's point is that the name answers "is this the final one?" without a Slack question, so
  the name has to actually appear in Slack); the terminal transition (`done`/`parked`, from either
  a 2nd Keep or "Finish picking") also swaps the Finals message's now-dead controls for a status
  line, mirroring `handle-decision`'s Approve/Reject swap. All of it best-effort.
- `MAX_FINALS_STARTS_PER_TICK` (2) bounds concurrent `uni-1-max` jobs; like `MAX_DRAFTS_PER_TICK`
  it is a constant now, a config knob in Wave 6.

## Alternatives considered

- **Post each Final as it resolves, editing the message to add controls.** Three `chat.update`s
  racing the poll loop, and a partial message visible to the approver mid-batch. The single atomic post
  is simpler and matches SPEC F4's "in one message".
- **Assign `hg-002-styled-0N.jpg` when the Final is generated, before the pick.** Then an
  un-picked Final owns a "styled" name it has no claim to (DOMAIN.md: the name _means_ "this is a
  final one"), and pick order — the actual sequence source — isn't known yet.
- **A `transaction()` on the Repository port for `runFinals`' writes.** Rejected for the same
  reason as ADR 0013 / 0014: one process, one writer. The interleaved-write + top-up design gets
  the same guarantee (converge on the next tick, every billed generation recorded) without the
  abstraction, and the residual one-generation death window is cheaper than a durable intent record.
- **A dedicated finals worker.** Same `setInterval`; at 40 products one loop doing drafts +
  finals + resolution is not a bottleneck (ADR 0006).
