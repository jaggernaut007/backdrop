# 0006 — In-process job loop + interval scheduler (no external queue/cron)

**Status:** Accepted · Wave 0

## Context

Two things run outside a Slack tap: (a) driving a Request through
`drafting`/`finalizing` — compose prompt, call Luma, poll until the generation completes, post to
Slack; (b) the staleness sweep — un-tapped Drafts older than 3 days escalate to the escalation contact. Luma has no
webhook; completion is discovered only by polling. The runtime is already one always-on process.

## Decision

- **An in-process job loop** (`setInterval`, ~3 s) that, each tick: advances Requests needing a
  draft/finals, and polls in-flight `GenerationAttempt`s, applying the state transition when Luma
  reaches `completed`/`failed`.
- **An interval scheduler** (~hourly) that runs the staleness sweep.
- Both are plain timers in `src/runtime/`, started from `main.ts`, stopped on `SIGTERM`.

## Consequences

- Zero infra: no queue service, no external cron, no Durable Objects. Works identically local and
  deployed.
- A Slack tap never blocks on generation — it records the decision and returns; the loop picks up
  the work. `ack()` stays well inside Slack's 3 s deadline.
- Single-process, single-replica ([0011](0011-railway-single-replica.md)) means no distributed
  locking needed; a tick that overruns is skipped via a re-entrancy guard.
- Cost accepted: a crash loses in-memory timer state, but all durable state is in SQLite, so the
  next boot's first tick resumes pending attempts. No at-least-once delivery guarantees beyond
  "re-poll everything still pending".

## Alternatives considered

- **A real queue (BullMQ/SQS) + worker** — the right answer at ~300 products where draft volume
  and retries need backpressure and a dead-letter path. Over-built for 40. Named as "what's next"
  in DESIGN.md.
- **Railway cron service for the sweep** — a second deployable for one hourly function; the
  in-process timer is simpler and shares the DB handle.
