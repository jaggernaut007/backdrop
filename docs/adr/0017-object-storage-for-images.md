# ADR 0017: Object Storage for Published Images (Cloudflare R2)

**Status:** Accepted  
**Date:** 2026-09-07

## Context

The Railway volume storing published images (`data/images/`) grows unbounded. Luma outputs are ~2–5 MB each (full-resolution product photography at 2048px); a busy pipeline can hit Railway's 5 GB default volume ceiling in weeks. As the service scales, static volumes become a storage-planning burden and incur increasing costs.

The `ImageStore` port (ADR 0002, 0007) already abstracts storage, with `VolumeImageStore` as the only implementation. Swapping to object storage requires a new adapter, not architecture changes.

## Decision

Implement `R2ImageStore` backed by **Cloudflare R2**, a S3-compatible object store with:
- **Free egress** (vs. GCS ~$0.12/GB)
- **Simple Railway credentials**: two API tokens (access key + secret)
- **S3-compatible API**: use `@aws-sdk/client-s3` with R2's endpoint
- **Unlimited scaling**: publish without storage ceiling

### The product reason (not just the storage reason)

Storage economics made the swap easy; they are not why it was chosen. R2 is **a place the web
designer can serve the site from directly** — the same public URL Slack unfurls into the SKU thread
is a URL a product page can point at, and the same object is reachable from a future MCP tool or UI
without going through this service. One artifact, three consumers, no copy step, and no Drive folder
to keep in sync (see DECISIONS.md A3, A12). That is what makes the deterministic filename
(ADR 0008) actually load-bearing for the `IMG_43xx` scar: the name *and* the address are stable.

### Deployment Options
- **Local dev & tests:** stay on `VolumeImageStore` (offline, no credentials needed)
- **Production (Railway):** set `IMAGE_STORE=r2` + R2 credentials → boots `R2ImageStore`

## Implementation

### New Files
- **`src/adapters/r2-image-store.ts`**: S3-compatible client, reuses download + validation logic from `VolumeImageStore`
- **`test/adapters/r2-image-store.test.ts`**: mocked S3 client + stubbed fetch (11 cases)
- **`src/migrate-images-to-r2.ts`** (`npm run migrate:images-to-r2`): one-shot backfill — uploads existing `data/images/*` to R2 and rewrites `generation_attempts.result_image_url` + `published_images.stable_url` from `/img/<name>` to the R2 URL. Idempotent.

### Changes
- **`src/config.ts`**: add optional `r2` block (bucket, endpoint, credentials, publicBaseUrl)
- **`src/main.ts`**: select `R2ImageStore` if `config.r2` is set, else `VolumeImageStore`
- **`.env.example`**: document `IMAGE_STORE`, R2 variables
- **`src/adapters/volume-image-store.ts`**: unchanged; backward compatible for local dev
- **`src/runtime/http.ts`**: unchanged; `/img/` route stays (empty when using R2, serves legacy URLs)

## Tradeoffs

| Aspect | Choice | Why |
|--------|--------|-----|
| **Provider** | Cloudflare R2 | Free egress, S3 API, simpler Railway secrets than GCS |
| **Adapter Strategy** | Conditional (R2 or Volume) | Preserves local dev offline, keeps existing tests green |
| **Migration** | Separate script, lazy | Can migrate existing images on-demand; `/img/` stays live during transition |
| **URL Format** | R2 public domain | Stable, no signing overhead; images are public shareable Slack links. `pub-*.r2.dev` for now (rate-limited — see below); a custom domain for production |

## r2.dev Rate Limits

`R2_PUBLIC_BASE_URL` currently points at the bucket's **`pub-*.r2.dev`** domain. Cloudflare
documents this as a **development** URL and rate-limits it (a per-domain cap that is not
published as a number and can throttle bursts of reads). Every image URL we mint is read
repeatedly by things we don't control: Slack unfurls the `image_url` block once per post
(and again on edits / re-renders), team members open the full image, and a retry loop can
re-post the same URL many times in a row.

### Mitigation in this deployment (done)

Objects are written with **`Cache-Control: public, max-age=31536000, immutable`**
(`IMAGE_CACHE_CONTROL` in `src/adapters/r2-image-store.ts`, mirrored by the backfill script).
Cloudflare's edge then serves essentially every repeat read from cache, so requests do not
reach the bucket and do not count against the r2.dev limit. This is safe because our
filenames are content-stable — `*-draft-<attemptId>.jpg` / `*-final-<attemptId>.jpg` are
unique per attempt, and a `*-styled-NN.jpg` republish is an idempotent same-bytes overwrite;
nothing serves *different* bytes under an existing name (a hypothetical future
regenerate-and-republish flow would need a cache-busting suffix or a targeted purge).

We also removed the largest read amplifier — a `finalizing` Request whose Final images were
unfetchable used to re-post (and have Slack re-fetch) the same URLs every tick forever; it
now fails permanently after the first "downloading image failed" (commit `fcd9fa7`).

### Resolution for production / client-facing (not done)

Attach a **custom domain** to the R2 bucket (Cloudflare Dash → R2 → bucket → Settings →
Custom Domains, or a bound Worker). Custom-domain traffic is **not** subject to the r2.dev
rate limit and gets normal Cloudflare caching, WAF, and analytics. This is a **config-only
change for us**: point `R2_PUBLIC_BASE_URL` at `https://images.<clientdomain>` and redeploy —
newly minted URLs use it immediately; a one-time DB rewrite (same shape as
`migrate:images-to-r2`) can move already-published URLs over if needed.

## Consequences

### Benefits
- Unbound storage growth
- No volume scaling/downtime risk
- Simplified Railway infra (volume shrinks to ~1 GB for DB only)
- Free data egress for published images (Slack re-fetch, team views)

### Tasks (in order)
1. ✅ Add `@aws-sdk/client-s3` dependency
2. ✅ Implement `R2ImageStore` adapter
3. ✅ Update config + wiring
4. ✅ Test R2 adapter against a mocked S3 client (11 cases green)
5. Enable R2 on the Cloudflare account (dashboard + card), create the bucket + a S3 API token, turn on public access
6. Deploy with `IMAGE_STORE=r2` to Railway
7. (Optionally) migrate existing `data/images/*` to R2 + rewrite URLs in DB
8. Shrink Railway volume to 1 GB (optional, after migration)

## References
- **ADR 0002** (Hexagonal Ports & Adapters): defines `ImageStore` port
- **ADR 0007** (App-Served Images): original volume-based design
- **Cloudflare R2 Docs**: https://developers.cloudflare.com/r2/
- **AWS SDK v3 S3 Client**: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/
