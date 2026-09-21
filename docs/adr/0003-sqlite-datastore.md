# 0003 — SQLite (single file on a volume) as the datastore

**Status:** Accepted · Wave 0

## Context

The catalog is 40 products now, ~300 at full scale. The pipeline is one process (Socket Mode,
[0001](0001-slack-socket-mode.md)). State: products, requests, attempts, decisions, review posts,
published images, a spend total. Writes are low-frequency (an import, a tap, a generation
completing). Deploy target is Railway with an attachable volume.

## Decision

**SQLite, one file (`app.db`) on the Railway volume**, accessed through a hand-written repository
with raw SQL (~8 tables). No ORM.

## Consequences

- Zero external services, zero connection strings, `:memory:` for tests. The whole datastore is a
  file that ships on the volume and survives redeploys.
- Railway forbids replicas on a volume and unmounts the old deployment before mounting the new —
  which *is* the single-writer guarantee SQLite needs. Documented as a constraint, not a
  workaround ([0011](0011-railway-single-replica.md)).
- Raw SQL keeps the persistence layer transparent for the walkthrough; the cost is hand-mapping
  rows to domain types (JSON columns for `ColorSet`, `riskFlags`).
- `PRAGMA journal_mode=WAL` + `foreign_keys=ON` + `busy_timeout` set once on open.

## Alternatives considered

- **Postgres (Railway plugin)** — a network hop, a connection pool, and migration tooling for a
  workload that never exceeds a few writes a minute. Unearned. Revisit at multi-instance scale.
- **An ORM (Prisma/Drizzle)** — schema-as-code and typed queries are nice, but add a codegen or a
  query-builder layer over 8 tables. The repository interface already gives the type safety at
  the boundary that matters.
- **JSON file / lowdb** — no transactions, no query, no concurrent-read safety. Rejected.
