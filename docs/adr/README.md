# Architecture Decision Records

Short records of the load-bearing technical decisions for the Shot Pipeline. Format is
MADR-lite: **Status · Context · Decision · Consequences · Alternatives considered**. Product
and scope decisions live in the root docs (`DOMAIN.md`, `SCOPE.md`, `DECISIONS.md`,
`DESIGN.md`); these are the *engineering* choices underneath them.

| # | Title | Status |
|---|---|---|
| [0001](0001-slack-socket-mode.md) | Slack Socket Mode over HTTP events | Accepted |
| [0002](0002-hexagonal-ports-and-adapters.md) | Hexagonal ports & adapters | Accepted |
| [0003](0003-sqlite-datastore.md) | SQLite (single file on a volume) as the datastore | Accepted |
| [0004](0004-sqlite-driver.md) | SQLite driver: `better-sqlite3` vs built-in `node:sqlite` | Accepted |
| [0005](0005-luma-rest-vs-sdk.md) | Luma generation: REST via `fetch` vs the `luma-agents` SDK | Accepted |
| [0006](0006-in-process-job-loop.md) | In-process job loop + interval scheduler (no external queue/cron) | Accepted |
| [0007](0007-app-served-images.md) | App-served images from the volume vs S3/R2 now | Accepted |
| [0008](0008-deterministic-filenames.md) | Deterministic published-image filename scheme | Accepted |
| [0009](0009-finals-pick-ux.md) | Finals pick UX: auto-`done` at 2 picks + "Finish picking" for ≤1 | Accepted |
| [0010](0010-rule-based-notes-classification.md) | Rule-based `Notes` classification (not an LLM call) | Accepted |
| [0011](0011-railway-single-replica.md) | Railway + Dockerfile + single replica | Accepted |
| [0012](0012-typescript-esm-and-pinning.md) | Exact version pinning, NodeNext ESM, strict TypeScript | Accepted |
| [0013](0013-catalog-ingest-idempotency.md) | Catalog ingest idempotency: content hash + per-SKU guard, no DB transaction | Accepted |
| [0014](0014-generation-lifecycle.md) | Generation lifecycle: create-then-persist, one poll loop resolves and posts | Accepted |
| [0015](0015-finals-generation-and-publish.md) | Finals: fan out N, resolve all, post once; deterministic name only on the pick | Accepted |
| [0016](0016-luma-retry-backoff.md) | Luma transient-error retry: exponential backoff + jitter, inside the adapter | Accepted |
| [0017](0017-object-storage-for-images.md) | Object storage for published images (Cloudflare R2), cached immutably under the r2.dev rate limit | Accepted |
| [0018](0018-request-capture-ux.md) | Request capture UX: accept / edit-modal buttons, no binding-actor gate | Accepted |
| [0019](0019-batch-status-post-scoped-exception.md) | Batch status post: a scoped exception to "no dashboard" and "no CSV export" | Accepted |
| [0020](0020-auto-publish-finals.md) | Finals auto-approve & auto-publish (retire the Keep/pick UI) | Accepted |
| [0021](0021-generation-queue-throttling.md) | Generation queue throttling & priority-first ordering | Accepted |
