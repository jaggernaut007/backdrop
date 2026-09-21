# 0011 — Railway + Dockerfile + single replica

**Status:** Accepted · Wave 0
**Evidence:** `docs/libraries/luma-vitest-railway.md` §3

## Context

The build must be "deployed and demoed live, not on localhost" (PRODUCT.md). The runtime is one
long-lived Node process (Socket Mode, [0001](0001-slack-socket-mode.md)) with a SQLite file and
served images on local disk ([0003](0003-sqlite-datastore.md), [0007](0007-app-served-images.md)).

## Decision

Deploy to **Railway** from a root **`Dockerfile`** (base image **Node 22**, an LTS line
`@slack/bolt` v5 is CI-tested against; local dev / vitest run on Node 26 and nothing in the
runtime path depends on the difference), with a **single replica** and a **persistent volume**
mounted at `/app/data`. Config pinned in `railway.json`.

## Consequences

- `Dockerfile` is auto-detected; `railway.json` sets `startCommand: "node dist/main.js"`,
  `healthcheckPath: /healthz`, `restartPolicyType: ON_FAILURE`, `numReplicas: 1`.
- **Migrations run inside `main.ts` on boot**, not as a separate `startCommand` step. The volume
  mounts at runtime (not build, not pre-deploy), so migrations must run in-process; and folding
  them into `main.ts` avoids a `sh -c "migrate && main"` start command, where `tini` would signal
  only the shell and the graceful-shutdown handler ([0006](0006-in-process-job-loop.md)) would
  never fire on a redeploy.
- Railway injects `PORT` (default 8080); the server binds `0.0.0.0:$PORT`.
- **Volumes forbid replicas**, and a redeploy unmounts the old deployment before mounting the new
  — brief downtime, and exactly the single-writer property SQLite needs. Accepted as designed.
- Health checks only gate the *initial* deploy; `ON_FAILURE` restart covers a wedged socket or a
  crash after go-live.
- `PUBLIC_BASE_URL` is set to the generated `*.up.railway.app` domain so image URLs resolve.

## Alternatives considered

- **Fly.io** — comparable (Dockerfile + volume), slightly more CLI ceremony. Fine; Railway chosen
  for the fastest path to a live URL.
- **Render / a VPS** — Render's persistent disk is paid-tier; a VPS is more ops than a one-day
  build warrants.
- **Multi-replica for HA** — impossible with the volume, and Socket Mode delivers each event to
  one connection anyway. A backup approver (config field) is the real answer to bus-factor, and
  it's in DESIGN.md "what's next".
