# 0019 — Batch status post: a scoped exception to "no dashboard" and "no CSV export"

**Status:** Accepted · implemented Wave 7 (`src/domain/batch-status.ts`, `src/domain/export-csv.ts`,
`src/app/refresh-batch-status.ts`, `src/app/export-batch-csv.ts`, `src/app/ingest-catalog.ts`,
`src/app/run-pipeline-tick.ts` `sweepOpenBatches`, `src/adapters/bolt-slack-gateway.ts`,
`src/runtime/slack-events.ts`).

## Context

The user asked for a different Slack UX, directly: after a CSV upload, post **one** Slack message
listing every row (SKU, product name, status), kept up to date in place as generation progresses,
with all review interactions for that batch — blank-row propose/accept/edit (F2), Draft
approve/reject (F3a), Finals picking (F4) — happening as **thread replies** under it. On
completion, generate and re-upload the updated CSV (Shot Ideas filled in, plus new `Status` and
`Final Image URL` columns).

This reopens two things this build's own scope docs explicitly ruled out:

1. **SPEC.md Out of Scope #7 / SCOPE.md #9 — "a dashboard, of any kind."** Reason given: "the
   documented failure mode — the team abandoned one in week one." The sanctioned alternative
   DOMAIN.md designed for this need is a **`Digest`** — "a scheduled Slack message: counts by
   state + dollars spent + named stale/parked requests... deliberately not a dashboard" — i.e. a
   periodically-*posted new* message, never a single message continuously rewritten in place.
2. **SPEC.md Out of Scope #5 / SCOPE.md #3 — "Updated CSV export."** Reason given: "a CSV is a
   third status surface to keep in sync." Interestingly, DOMAIN.md's own **Export** glossary entry
   already anticipated this ("The pipeline emits an updated export back") — `SPEC.md` deferred it
   out of this build's five features, not out of the product's vision.

Both were confirmed with the user as **deliberate, scoped exceptions**, not reversals, before this
wave was built.

## Decision

**One Slack message, and its thread, per `CatalogImport` — live only for that one upload's
lifetime.**

- The batch status post is created once, immediately after a CSV ingest, listing every row from
  that upload (blank or not) with a friendly status label (`domain/batch-status.ts`
  `friendlyStatusLabel`). It is edited in place (`chat.update`) every time any of its rows'
  `ShotRequestStatus` changes (`refreshBatchStatus`, called from every status-changing
  `saveRequest` across the app layer), until every row reaches a terminal outcome
  (`done`/`parked`/`failed` — `domain/lifecycle.ts` `isTerminal`). After that it is inert: nothing
  edits it again, and there is no cross-batch or standing view of it.
- Each SKU gets exactly **one living thread reply**, edited in place as it moves through
  ask → draft-review → finals-review, rather than a new reply at each stage (confirmed with the
  user — this was the more expensive of two options, chosen for a cleaner thread).
- Each CSV re-upload always starts a **brand-new** batch status message — never merged into a
  still-open prior batch, even if the SKU sets overlap (confirmed with the user — simpler, matches
  the existing "one post per ingest run" convention, and content-hash idempotency already no-ops
  an unchanged re-drop).
- On batch completion, the updated CSV (original 9 columns, blank Shot Ideas now filled in, plus
  `Status` + `Final Image URL`) is generated once and posted **to the channel root** (not the
  batch's thread) so the finished file is visible without expanding a thread
  (`export-batch-csv.ts`, `uploadBatchExportCsv` / `filesUploadV2`) — not a running, synced
  export. Exactly-once is enforced by a per-import async lock around every batch-status Slack
  write + export (`refresh-batch-status.ts`) plus `AND … IS NULL` guards on the
  `markBatchExportUploaded` / `markBatchCompleted` updates (amended Wave 8, 2026-09-07: the
  original "file reply in that batch's own thread" both hid the artifact and raced into double
  uploads).

**Why this doesn't reintroduce the dashboard failure mode:** SCOPE.md's own account of that
failure is that it asked the approver "to go somewhere new to record" and became "the abandoned dashboard
with extra steps" — a second surface nobody was already looking at, that had to be separately
maintained. The batch status post fails neither test: it lives *inside* the exact channel the approver is
already watching for review taps, its thread *is* the review surface (not a link to one elsewhere),
and it self-terminates on completion rather than accumulating into a permanent parallel view that
needs its own upkeep. There is no "list of all batches" anywhere — an old batch's message simply
stops updating.

**Free-text thread replies are dropped for this design.** Today's third F2 confirm path (a plain
`slack-reply`, no button) worked because each blank row had its own top-level message, so a
reply's `thread_ts` uniquely identified the SKU. Slack's threading is flat — every reply inside a
shared batch thread reports the same `thread_ts` (the root), regardless of which SKU's card the
person was looking at. Once every SKU's ask lives inside one shared thread, there is no signal
left to say which SKU a plain reply is about. Blank-row capture keeps its two buttons only ("Use
this" / "Edit before using" → a modal); `slack-reply` remains a legal `ShotIdeaOrigin` in the
domain model but has no runtime entry point. `slack-app-manifest.yaml`'s `message.channels` event
subscription is dropped along with it — nothing subscribes to plain channel messages anymore.

## Alternatives considered

- **Keep it evergreen, app-wide** (one status message reused across every CSV upload forever): this
  *would* be the rejected dashboard pattern — a single, permanent second surface someone has to
  keep checking. Rejected outright; the batch scoping (one message per import, self-terminating) is
  the entire reason this reads as an exception rather than a reversal.
- **A periodic `Digest` post instead** (new message every tick/interval, per the pre-existing
  DOMAIN.md concept): stays fully inside the "no dashboard" rule, but doesn't deliver what was
  asked — a single place to watch one upload's rows update live, with review threaded underneath
  it. Not pursued this wave; still available as a separate, complementary feature later.
- **SKU-code-prefixed free text** (`"HG-014: folded on a sunlit oak table..."`) instead of dropping
  plain replies: keeps the third confirm path but requires typing the SKU and parsing it back out.
  Rejected — the buttons-only path is unambiguous and the UX cost is small (two buttons already
  covered the common cases).

## Consequences

- New schema (additive only — `catalog_import_rows`, `batch_status_posts`, `sku_thread_posts`;
  `review_posts`' `(slack_channel, slack_ts)` uniqueness widened to include `kind` so one shared
  message can carry both a `draft` and a `finals` `ReviewPost` row over its lifetime).
  `blank_row_asks` and its three read methods are superseded by `sku_thread_posts` — the table and
  port methods are left in place (no clean `IF NOT EXISTS`-only migration story for dropping a
  table) but nothing writes to them anymore.
- New `files:write` OAuth scope (`filesUploadV2`) — requires re-running "Install to Workspace" to
  reissue `SLACK_BOT_TOKEN` (see `slack-app-manifest.yaml` and `README.md`).
- A SKU can be open in more than one batch at once (a rare re-upload overlap) — `refreshBatchStatus`
  fans out over every open batch that lists the SKU; review posting (`resolvePrimaryImportId` in
  `run-pipeline-tick.ts`) picks a single "primary" batch to host the living reply in — whichever
  batch already has one, else the most recently opened open batch.
- A batch whose initial post or completion export fails is self-healing: `refreshBatchStatus` posts
  the status message fresh (or retries the export) the next time any of its rows change status, and
  `sweepOpenBatches` (a new step in `run-pipeline-tick.ts`) retries both, plus any blank-row ask
  that never landed, once per tick for every still-open batch — mirroring the existing
  `SlackFailureTracker` give-up-after-5 posture used elsewhere in this file.
