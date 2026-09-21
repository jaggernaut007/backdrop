# 0005 — Luma generation: REST via `fetch` vs the `luma-agents` SDK

**Status:** Accepted · Wave 0
**Evidence:** `docs/libraries/luma-vitest-railway.md` §1

## Context

Generation is via the Luma Agents API (`image_edit` from the product's white-background photo).
There is an official TypeScript SDK, `luma-agents`.

## Decision

**Call the REST API directly with `fetch`**, behind the `GenerationClient` port. Do not add the
SDK dependency.

## Consequences

- `create` → `POST /v1/generations` `{type:"image_edit", prompt, source:{url}, model}` (201);
  `get` → `GET /v1/generations/{id}`; states `queued|processing|completed|failed`; image at
  `output[0].url`.
- We own the two things the SDK doesn't document anyway: **polling** (the job loop) and
  **error/`failure_code` handling** (retryable vs not; `Retry-After` on 429).
- `output[0].url` is a presigned URL that **expires in ~1 hour** → the adapter downloads the bytes
  and re-hosts via `ImageStore` immediately ([0007](0007-app-served-images.md)).
- No dependency to track for a fast-moving 0.1.x package.
- Cost accepted: we hand-write request/response types instead of importing them.

## Alternatives considered

- **`luma-agents@0.1.2`** — official, zero-dependency, works on Node ≥20. Rejected: three
  releases in one week (May 2026) then four months quiet; the published README/api.md cover only
  text-to-image `create` — no `image_edit`, no `source` docs, no polling helper, no error types.
  The port boundary means adopting it later (when mature) is a one-adapter change.
