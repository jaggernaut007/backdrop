# 0014 — Generation lifecycle: create-then-persist, one poll loop resolves and posts

**Status:** Accepted · implemented Wave 2 (`src/app/run-draft.ts`, `src/app/run-pipeline-tick.ts`)

## Context

F3a turns a `confirmed` Request into a Draft posted for review. Luma's `image_edit` is asynchronous
— `POST /generations` returns `queued`, and the only completion mechanism is polling
`GET /generations/{id}` (docs/libraries/luma-vitest-railway.md §1.4). The output URL is an AWS
presigned link that **expires in ~1 hour**, but a Draft may sit un-tapped for up to the stale
threshold (3 days). The pipeline runs as one long-lived process with an in-process job loop
(ADR 0006); nothing may block a Slack ack (docs/libraries/slack-bolt.md §4).

Two ordering questions: (a) when a generation is kicked off, do we persist the attempt before or
after the API call; (b) is "poll to completion", "re-host the image", and "post to Slack" one step
or three.

## Decision

**Validate, kick, then persist.** `runDraft` first computes the `confirmed → drafting` transition
(`startDrafting` throws on any other state — no money is spent on a Request in the wrong state),
composes the prompt (`domain/prompt`), calls `GenerationClient.create`, and only then writes a
`pending` `GenerationAttempt` (carrying `lumaGenerationId` and the configured `draftCostCents`) and
saves the transition. If `create` throws, nothing is written and the Request stays `confirmed` for
the next tick. If the process dies between `create` and the two writes, the orphaned Luma
generation is abandoned and re-created next tick — one cheap draft (~$0.04). This mirrors
ADR 0013's stance: converge on the next run rather than add a transaction.

**One resolution step.** `resolvePendingGenerations` (half of `runPipelineTick`, the other half
being `startConfirmedDrafts`) walks every `pending` attempt:

- `queued` / `processing` → skip, try again next tick.
- `failed`, or `completed` with no usable image URL (the real Luma adapter returns this when
  `output` is empty) → mark the attempt `failed` (spend already booked — DOMAIN.md: every attempt
  records spend even on failure). Then, **only if** the Request is still `drafting` (guarding
  against Socket Mode redelivery / an already-resolved sibling attempt) and the attempt is a Draft
  (`final`-kind resolution is [0015](0015-finals-generation-and-publish.md)), move it
  `drafting → failed` and post a plain-language line
  to the channel.
- `completed` with an image → if the Request has moved on, settle the attempt `succeeded` and stop
  (no re-host, no post). Otherwise: download + re-host via `ImageStore.putFromUrl` (stable
  `/img/<name>` URL), post the Draft for review with Approve / Reject, save a `ReviewPost` bound to
  `(channel, ts)`, move the Request `drafting → in_review`, **and last** mark the attempt
  `succeeded` with the hosted URL. The attempt is marked succeeded _after_ the post so that a
  Slack failure leaves it `pending` — the next tick re-polls (Luma hands back a fresh presigned
  URL), re-hosts to the same attempt-derived name (idempotent overwrite) and re-posts; a paid-for
  Draft is never stranded. Draft images use a throwaway name (`hg-002-draft-<8hex>.jpg`); the
  deterministic `hg-002-styled-01.jpg` scheme (ADR 0008) is the _identity of a Final_, which a
  Draft has no claim to — and which is assigned only when a Final is picked
  ([0015](0015-finals-generation-and-publish.md)).

**Fault isolation.** Both halves process each Request / attempt inside its own try/catch: one that
throws is reported through `onItemError` and skipped, and the tick continues. A single bad SKU
(missing Product, an over-long prompt, a Luma 4xx) can't stall drafting or review for every other
one — the item stays `confirmed` / `pending` and is retried next tick. `startConfirmedDrafts` also
caps `create` calls at `MAX_DRAFTS_PER_TICK` (8) so the first 40-row import drains over a few ticks
rather than firing 40 creates into Luma's concurrent-jobs ceiling.

The review tap itself is a separate use-case (`handle-decision`), driven by Bolt `block_actions`,
not by the loop.

## Consequences

- Slack never receives an expiring Luma URL — the image is on our volume before the post goes out.
  A Draft that sits for days still renders.
- The loop is idempotent per tick: a `pending` attempt whose generation is still cooking is a
  no-op; a `succeeded` attempt is no longer `pending` so it is never re-posted; a post that failed
  left the attempt `pending`, so the next tick re-posts rather than stranding it. Two overlapping
  ticks are prevented by an `inFlight` guard in `job-loop`.
- `runPipelineTick` is pure orchestration over ports and is unit-tested directly with fakes and no
  timers (`test/app/run-pipeline-tick.test.ts`); `job-loop.ts` is a `setInterval` wrapper, excluded
  from coverage like the other live-only glue.
- Cost accepted: `runDraft` writes twice, non-transactionally — `saveAttempt` then `saveRequest`.
  A crash anywhere between `create` and the second write leaks one draft generation: the next tick
  still sees the Request `confirmed` and re-kicks. If the crash lands _between_ the two writes, the
  orphaned first attempt still resolves but posts nothing (the `drafting` status guard in
  `resolvePendingGenerations` settles it `succeeded` and returns), leaving one stray row carrying
  its ~$0.04 of booked spend. Not worth a durable "intent" record or a transaction at this scale.

## Alternatives considered

- **Persist a `pending` attempt with `lumaGenerationId: null`, then call `create`, then update.**
  Closes the leak window, but adds a partially-formed row the resolver must special-case, and the
  leak it prevents costs four cents. Revisit if Draft cost rises or volume makes the waste visible
  in the ledger.
- **Post the Draft straight from `create`'s eventual result inside `runDraft` (await the poll
  there).** Blocks the tick on Luma latency (seconds to minutes) and puts a network wait on the
  path that also kicks the _next_ Request's draft. The split keeps each tick bounded.
- **A dedicated `drafts` worker separate from the finals resolver.** Same `setInterval`, more
  moving parts; at 40 products one loop doing both is not a bottleneck (ADR 0006).
