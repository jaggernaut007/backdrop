# 0007 — App-served images from the volume vs S3/R2 now

**Status:** Accepted · Wave 0

## Context

Luma's `output[0].url` is a presigned URL that expires in ~1 hour. Published images need
**permanent, stable URLs** — that stability is half the fix for the `IMG_43xx.jpg` scar
(DECISIONS.md A3: "the pipeline hands back stable URLs and filenames; it does not touch Drive").
The pipeline must not write to the team's Drive (an install-shaped commitment).

## Decision

The `ImageStore` adapter **downloads the Luma bytes and writes them to `DATA_DIR/images/` on the
Railway volume**, served by Fastify at `GET /img/:filename`. The stable URL is
`${PUBLIC_BASE_URL}/img/hg-002-styled-01.jpg`.

## Consequences

- Stable URLs with no new cloud account, no credentials, no bucket policy. The volume persists
  across redeploys, so the URLs outlive any single process ([0003](0003-sqlite-datastore.md),
  [0011](0011-railway-single-replica.md)).
- `@fastify/static` with an absolute `root` and a 1-day `Cache-Control` (not `immutable` — a
  regenerated pick reuses its filename).
- Cost accepted: durability is "as durable as one Railway volume" — no cross-region replication,
  no lifecycle policy. Fine for a 40-product drop; a real object store is the upgrade.

## Alternatives considered

- **S3 / Cloudflare R2 now** — genuinely durable object storage and the closest match to the
  DECISIONS.md wording. Deferred only to avoid a credential + bucket setup in a one-day build;
  the `ImageStore` port is exactly one adapter, so the swap is cheap and pre-planned.
- **Serve straight from SQLite (BLOB)** — keeps everything in one file, but bloats the DB and
  couples image delivery to DB reads. Rejected.
- **Re-poll Luma for a fresh URL on demand** — the docs allow it, but it makes every image view a
  third-party API call and still isn't a *stable* URL. Rejected.
