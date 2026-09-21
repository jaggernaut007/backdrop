# 0004 — SQLite driver: `better-sqlite3` vs built-in `node:sqlite`

**Status:** Accepted · Wave 0
**Evidence:** `docs/libraries/datastore-and-http.md` §1

## Context

Given [0003](0003-sqlite-datastore.md), two drivers are viable on Node 26: `better-sqlite3` (a
native addon) and `node:sqlite` (built into Node, zero dependencies, zero native build).

## Decision

**`better-sqlite3@13.0.3`** (+ `@types/better-sqlite3` dev dep).

## Consequences

- `db.transaction(fn)` with automatic `BEGIN`/`COMMIT`/`ROLLBACK` and deferred/immediate/exclusive
  variants — the idempotent-import path ([SPEC F1](../../SPEC.md)) wraps a multi-row upsert in one.
- v13 moved to N-API prebuilts: **one binary covers Node 22–26**, published per platform/arch/libc,
  used on `npm install` with no compilation on `node:22-bookworm`. The classic "native module
  pain" is largely gone for server deploys. The Dockerfile keeps `python3 make g++` only as a
  fallback.
- Fully synchronous API → the `Repository` port has no `async`; the in-memory fake mirrors it.
- Downside accepted: a native dependency at all (vs none), and the runtime Docker stage must share
  the build stage's OS/libc so the `.node` binary loads.

## Alternatives considered

- **`node:sqlite`** — zero deps, nothing to compile, no arch/Node-bump breakage. Rejected for now
  because on the Node 26 releases shipping today it is still **Stability 1.2 (Release Candidate)**
  and it has **no `.transaction()` helper** (manual `BEGIN`/`COMMIT`/savepoints). Re-evaluate the
  swap once it reaches Stability 2 — the `Repository` port makes that a one-adapter change.
