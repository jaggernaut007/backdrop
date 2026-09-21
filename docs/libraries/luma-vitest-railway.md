# Grounding: Luma Agents API · Vitest/fast-check · Railway

Verified against official sources, 2026-09-06. Reference for `src/adapters/luma-generation-client.ts`,
`vitest.config.ts`, `Dockerfile`, and Railway deploy settings.

---

## 1. Luma Agents API — `image_edit` (image-to-image)

### 1.1 SDK decision

**The official SDK `luma-agents@0.1.2` is immature** — 3 releases in one week (May 2026), no
release in 4 months, the published README/api.md document only text-to-image `create` (no
`image_edit` docs, no polling helper, no error type exports). It works in Node ≥ 20 and is
zero-dependency, but the API surface is incomplete.

**Recommendation: call REST directly via `fetch`** (below). The SDK's two methods (`create` /
`get`) would just wrap the HTTP calls and add type safety — valuable if the SDK were mature, but
here you pay the maintenance cost with no gain. Keep `GenerationClient` port behind an adapter so
a SDK upgrade is a config swap later (ADR 0005).

Repo: <https://github.com/lumalabs/luma-agents-typescript> · <https://www.npmjs.com/package/luma-agents>

### 1.2 REST — base URL & auth

- Base URL: **`https://agents.lumalabs.ai/v1`**
- Auth: **`Authorization: Bearer $LUMA_AGENTS_API_KEY`** on every request. Key format:
  `luma-api-...`. Wrong/missing key → `401 "Missing or invalid API key"`.
- Response headers: `X-Request-Id` (UUID for support), `X-API-Version` (currently `2026-04-01`).

Docs: <https://docs.agents.lumalabs.ai/index.md>

### 1.3 Create edit — `POST /v1/generations`

```json
{
  "type": "image_edit",
  "prompt": "Change the sky to a dramatic sunset with orange and purple clouds",
  "source": { "url": "https://example.com/landscape.jpg" },
  "model": "uni-1"
}
```

| Field | Rules |
|---|---|
| `type` | `"image_edit"` (required) |
| `prompt` | required, **1–6,000 characters** (enforced; `400` on violation) |
| `source` | **exactly one form** (url / base64 + media_type / generation_id / file_id) |
| `model` | `"uni-1"` (default) or `"uni-1-max"` |
| `style` | optional, e.g. `"manga"` |
| `image_ref` | optional, **up to 8** reference images |

`source` options:
- `{ "url": "https://…" }` — **URL accepted directly**, publicly reachable, ≤ 50 MB, ≤ 8000 px/side.
- `{ "data": "<base64>", "media_type": "image/jpeg" }` — base64 + media type, ≤ 50 MB.
- `{ "generation_id": "<uuid>" }` — prior generation from the same client.
- `{ "file_id": "<uuid>" }` — from Files API, must be `state: "ready"`.

Success: **HTTP 201** with generation object:

```json
{
  "id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "type": "image",
  "state": "queued",
  "model": "uni-1",
  "created_at": "2026-04-08T12:00:00Z",
  "output": [],
  "failure_reason": null,
  "failure_code": null
}
```

Docs: <https://docs.agents.lumalabs.ai/guides/images/editing/index.md>

### 1.4 Polling — `GET /v1/generations/{id}`

`state` values (exact strings): **`queued`, `processing`, `completed`, `failed`**. (No `dreaming`
— that was the legacy Dream Machine API.) Terminal: `completed` / `failed`.

Completed response:

```json
{
  "id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "state": "completed",
  "output": [
    { "type": "image", "url": "https://storage.../output.png?X-Amz-Expires=3600&..." }
  ]
}
```

**The URL is an AWS presigned URL that expires in 1 hour** (`X-Amz-Expires=3600`). Docs: download
immediately, store in your own storage (volume), do not expose to end users, re-poll if needed for
a fresh URL. → **Download the bytes and re-host in `/data/images/` for stable permanent URLs.**

No webhook; polling is the only completion mechanism. Docs: <https://docs.agents.lumalabs.ai/guides/images/generation/index.md>

### 1.5 Error handling

| Code | Meaning | Retry? |
|---|---|---|
| 201 | accepted / queued | — |
| 400 | bad params | no |
| 401 | auth failure | no |
| 402 | insufficient funds | no |
| 403 | suspended account | no |
| 413 | input > 50 MB or > 8000 px | no |
| 422 | param conflicts / corrupted media | no |
| 429 | rate limit (RPM or concurrent) | yes |
| 502 | upstream unavailable | yes |
| 503 | ingestion unavailable | yes |
| 404 | generation not found (GET only) | no |

Body: `{ "detail": "<human message>" }`.

Async failure (`state == "failed"`): `failure_code` enum:

| Code | Action |
|---|---|
| `content_moderated` | modify prompt, do not retry |
| `generation_failed` | transient, retry |
| `budget_exhausted` | add funds, resubmit |
| `output_not_found` | retry same |
| `image_too_large` | resize input |
| `unsupported_format` | convert input |
| `corrupt_input` | re-encode |
| `invalid_request` | fix params |
| `rate_limited` | exponential backoff + jitter |

Rate limits (per client, two independent):
1. **RPM** — requests per rolling 60s window.
2. **Concurrent jobs** — max active non-terminal generations.

On RPM-429: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix ts),
`Retry-After` (seconds). On concurrent-429: `Retry-After: 60` (no `X-RateLimit-*`).

Backoff: honour `Retry-After` if present; else exponential `2^attempt` s; **add 0–1 s random
jitter**; for concurrent limits, poll every ~5 s until a slot frees.

Docs: <https://docs.agents.lumalabs.ai/guides/error-handling/index.md> · <https://docs.agents.lumalabs.ai/guides/rate-limits/index.md>

### 1.6 Output resolution & pricing

All images (edit or generation, both models) output **2048 px (2K) resolution**. Cost per generation
(flat, regardless of output size):

| Model | Text-to-image | Image edit |
|---|---|---|
| `uni-1` | $0.0404 | **$0.0434** ✅ |
| `uni-1-max` | $0.1000 | **$0.1030** ✅ |

Pricing: <https://docs.agents.lumalabs.ai/guides/pricing/index.md>

---

## 2. Vitest + fast-check

### 2.1 Vitest — `vitest@5.0.0`

**Version pinned: `vitest@5.0.0`** (published 2026-09-03). `engines.node`: **`^22.12 || ^24 || >=26`**.
Node 26 satisfies it. No published `vite` peer; broadly compatible with v6/7/8.

Breaking changes in 5.0.0: `vitest list` parses files statically by default; coverage internals
split to `@vitest/istanbuljs` (optional).

Minimal `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
```

`package.json` scripts:

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "coverage": "vitest run --coverage"
}
```

Test structure:

```ts
import { describe, it, expect } from 'vitest';

describe('draft generation', () => {
  it('posts one image to the channel', async () => {
    const draft = await runDraft(requestId);
    expect(draft.attempts).toHaveLength(1);
  });
});
```

Run a single file: `npx vitest run test/scenarios/f1.test.ts` (or `vitest run f1` for substring;
append `-t "test name"` to filter by title).

### 2.2 Coverage provider

**`@vitest/coverage-v8@5.0.0`** — V8's built-in coverage (fastest, no instrumentation). Keep the
version **exactly in sync with Vitest**. With Vitest 4.1.x, use `@vitest/coverage-v8@4.1.x`.

Docs: <https://vitest.dev/guide/coverage.html>

### 2.3 fast-check — `fast-check@4.9.0`

**Version: `4.9.0`** (zero framework coupling). Use `fc.assert(fc.property(...))` inside any
`it()`:

```ts
import fc from 'fast-check';

it('rejects prompts outside 1–6000 chars', () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 6000 }),
      (prompt) => {
        expect(validatePrompt(prompt)).toBe(true);
      },
    ),
    { numRuns: 500 }, // default 100
  );
});
```

Common arbitraries: `fc.integer()`, `fc.string()`, `fc.array(…)`, `fc.record({…})`,
`fc.constantFrom('a', 'b')`.

### 2.4 `@fast-check/vitest` wrapper — NOT for Vitest 5

`@fast-check/vitest` peer deps: `vitest: ^4.1.0`. **It does not support Vitest 5.** Skip it.
Use `fc.assert(fc.property(...))` inside `it()` and the integration is seamless.

Docs: <https://github.com/dubzzz/fast-check/tree/main/packages/fast-check>

---

## 3. Railway deployment

Docs root: <https://docs.railway.com>

### 3.1 Dockerfile-based service

A **`Dockerfile` at the repo root is auto-detected**. To be explicit, add `railway.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "startCommand": "node dist/main.js",
    "healthcheckPath": "/healthz",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

Docs: <https://docs.railway.com/reference/config-as-code>

### 3.2 Persistent volumes

- **Volumes forbid replicas** — "Each service can only have a single volume" and "Replicas cannot
  be used with volumes."
- **Redeploy is briefly downtime** — to prevent data corruption, old deployment unmounts before
  new one mounts. This is exactly the single-writer guarantee SQLite needs.
- **Mount at runtime, not build** — volumes are attached during `start`, not during `docker build`
  or `preDeployCommand` → **migrations must run in-process on boot**, not in pre-deploy.
  This project calls `runMigrations()` from `src/main.ts` before the HTTP server starts, so
  `startCommand` is a plain `node dist/main.js` (§3.1). Avoid a shell start command like
  `sh -c "node dist/migrate.js && node dist/main.js"`: under `ENTRYPOINT ["tini","--"]` the tree
  becomes `tini → sh → node`, `tini` signals only `sh`, and the `SIGTERM` handler in `main.ts`
  never runs on a redeploy. If you must use a shell form, `exec` the final process.

- Convention: mount at **`/app/data`** (aligned with your app's working directory / relative paths).
- Railway injects `RAILWAY_VOLUME_MOUNT_PATH` (the mount point) and `RAILWAY_VOLUME_NAME` into env.

Docs: <https://docs.railway.com/guides/volumes>

### 3.3 Public domain & `PORT`

- Railway **injects `$PORT`** (default 8080). The app **must bind `0.0.0.0:$PORT`**.
- Binding `127.0.0.1` or a hardcoded port → "Application failed to respond".
- Public domain: service Settings → Networking → **"Generate Domain"** → instant `*.up.railway.app`
  URL.

```ts
const port = Number(process.env.PORT) || 8080;
app.listen({ port, host: '0.0.0.0' });
```

Docs: <https://docs.railway.com/public-networking>

### 3.4 Secrets / env vars

- Dashboard: service → **Variables** tab.
- CLI: `railway variable set KEY=value` (or `echo secret | railway variable set KEY --stdin` to
  avoid shell history). List: `railway variable list --kv`.
- Scopes: service variables vs project **Shared Variables** (per environment).
- Sealing: 3-dot menu → "Seal" → value hidden from UI / API / `railway variables` list
  (irreversible).

Docs: <https://docs.railway.com/variables>

### 3.5 Health checks

Railway sends `GET /healthz` (your configured path) after the container starts. **Any `2xx`
response = pass.** Request uses **Host `healthcheck.railway.app`** — if the app filters by host,
allowlist it.

- `healthcheckTimeout` default 300 s (5 min). No 2xx in the window → deploy marked failed; new
  version stays inactive, traffic on the previous deployment.
- **Railway does not poll after the deploy is live** → combine with
  `restartPolicyType: "ON_FAILURE"` for crash recovery.

Example:

```ts
app.get('/healthz', () => ({ status: 'ok' }));
```

Docs: <https://docs.railway.com/guides/healthchecks>
