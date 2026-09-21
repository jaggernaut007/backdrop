# 0021 — Generation queue throttling & priority-first ordering

**Status:** Accepted · implemented Wave 9 (`src/config.ts`,
`src/app/run-pipeline-tick.ts` `startConfirmedDrafts` / `startRetryDrafts` / `startApprovedFinals`).

## Context

The live demo hit Luma rate limits hard: three Finals per direction × several Requests per tick
bursted into the concurrent-jobs ceiling, and the 3s poll loop re-fired throttle errors with no
delay. Notes-derived priority only ordered the Draft queue, not Finals.

## Decision

- **Global in-flight budget** — `MAX_IN_FLIGHT_GENERATIONS` (default **4**). No start sweep issues
  a new `create` while `listPendingAttempts().length` is at the budget; the adapter's per-call retry
  no longer fights a whole batch's worth of simultaneous jobs.
- **Per-tick caps moved to config** — `MAX_DRAFTS_PER_TICK` (default **2**, shared by fresh drafts
  and retries) and `MAX_FINALS_STARTS_PER_TICK` (default **1**); `FINALS_PER_DIRECTION` lowered 3 →
  **2**. Poll interval default raised 3s → **5s**.
- **Priority-first everywhere** — every start sweep walks `listRequestsInQueueOrder()`
  (`priorityRank` desc → `createdAt` asc), so notes-priority SKUs get first claim on the budget at
  every stage (drafts, retries, finals).

## Consequences

- **Positive:** the queue drains over several ticks instead of bursting; priority SKUs are rendered
  first, not merely drafted first.
- **Negative:** lower defaults mean a 40-row catalog takes more ticks to fully drain; the knobs are
  env-tunable for a higher-RPM account.

## Alternatives considered

- **Per-request serialization** (one generation at a time) — simplest, but needlessly slow at this
  scale and starves the resolution loop.
- **A dedicated queue/worker** — overkill for a single-replica SQLite pipeline (ADR 0011/0006).
