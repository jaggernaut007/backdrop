# 0013 — Catalog ingest idempotency: content hash + per-SKU guard, no DB transaction

**Status:** Accepted · implemented Wave 1 (`src/app/ingest-catalog.ts`)

## Context

SPEC F1 requires ingest to be idempotent: *"Re-ingesting the same Export changes nothing — no
Product is duplicated and no second Request is opened for any SKU."* DOMAIN.md adds that a
re-import with **changed** Shot Idea text on a known SKU raises `NewIdeaRevisionDetected`, is named
in the import summary, and opens **no** superseding Request (DECISIONS.md B2, out of scope).

The Export is ~40 rows today, ~300 later. Ingest spans many small writes (upsert 40 Products,
open N Requests, save one CatalogImport). `better-sqlite3` offers `db.transaction(fn)`, but the
port is deliberately a set of single-entity methods (Wave 0 audit hardened it) and the writes
cross method boundaries.

## Decision

Two guard layers in the use-case, and **no transaction** — instead, a write ordering that
self-heals on a crash:

1. **Content-hash short-circuit.** SHA-256 the raw bytes; if `findImportByContentHash` hits, return
   `{ alreadyIngested: true }` immediately — no writes, no Slack post. Covers the identical re-drop.
2. **Per-SKU idea guard.** For each row with a Shot Idea, `listRequestsForSku` (all statuses,
   including terminal — a new port method): if a Request already carries that exact Shot Idea text,
   skip; if Requests exist but none match, record the SKU in `newIdeaRevisionSkus` and open
   nothing; otherwise open one Request at revision 1, status `confirmed` (a sheet Idea needs no
   confirmation step), origin `sheet`. Covers a *different* Export that re-lists a known SKU.
3. **CatalogImport row written last, summary post best-effort after it.** Products upsert by SKU
   (re-running overwrites identically); Requests are guarded by (2). A crash *before* `saveImport`
   leaves no hash record and the next ingest redoes the whole thing cleanly; a crash *after* it
   means the durable work is already done. The Slack summary is posted *after* `saveImport` and
   wrapped in try/catch — a post failure sets `summaryPosted: false` on the result rather than
   rejecting the call (which would drive `slack-events` into its "couldn't ingest" path for a
   success) or being retried via a re-drop (the hash guard would no-op it). `slack-events` retries
   the post once directly on `summaryPosted === false`.

## Consequences

- The two SPEC idempotency assertions hold without a transaction. `test/scenarios/f1-catalog-intake`
  proves the identical re-drop (no Product duplicated, no Request re-opened, one summary posted),
  the *different Export re-listing a known SKU* no-op, the `NewIdeaRevisionDetected` path (flagged,
  no Request, named in the summary), and the `nDone` count; `test/property/ingest-idempotency`
  covers "a second ingest opens nothing new" across randomised catalogs, identical and re-listed.
- `Repository` gains `listRequestsForSku(sku)` — a pure read, added to the port, the fake, the
  SQLite adapter, and the shared contract suite.
- `NewIdeaRevisionDetected` is a summary line only (`renderImportSummary`'s second line); the
  superseding-Request machinery stays unbuilt, and the `ShotRequest` *domain* identity is still
  SKU + revision (the table is keyed on a UUID `id`), so it can be added later without a migration.
- Cost accepted: ingest is not atomic. A crash mid-loop can leave Products from a new Export
  partially updated with the CatalogImport unrecorded — but because every write is a keyed upsert
  and the hash isn't stored until the end, the next ingest converges. At 300 rows this is still
  well under a second of work to repeat.

## Alternatives considered

- **`db.transaction(fn)` around the whole ingest.** True atomicity, and `better-sqlite3` makes it
  cheap. Rejected for now because it forces a `transaction`/`unitOfWork` method onto the port (or
  leaks the DB handle into the use-case), for a failure window that keyed upserts + last-write
  ordering already close. Revisit if ingest grows side effects that *aren't* idempotent.
- **Upsert Requests by (SKU, revision) and let the DB dedupe.** Doesn't express
  `NewIdeaRevisionDetected` (which must open nothing, not upsert), and hides the "one active
  Request per SKU" invariant in a constraint instead of the aggregate.
