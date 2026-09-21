Output dense, direct text. Omit pleasantries.

# Backdrop

A **Slack-native decision recorder that happens to generate images**. A CSV drop in one Slack
channel is the only entry point; the approver taps Approve/Reject on a cheap Draft; that tap
authorises Finals spend; the 2 Finals then auto-approve & auto-publish under deterministic
filenames + stable URLs, and the completion message lands in the SKU's thread reply. Priority
Notes render first; generation is throttled to respect the generation API's rate limits. Design is
locked across `docs/PRODUCT.md → docs/DISCOVERY.md → docs/DOMAIN.md → docs/SCOPE.md →
docs/DECISIONS.md → docs/DESIGN.md → docs/SPEC.md`. `docs/SPEC.md`'s features (F1–F4, F7) and 19
Given/When/Then scenarios are the contract.

## Stack (committed)
- **Language:** TypeScript, ESM (`NodeNext`), strict + `noUncheckedIndexedAccess`. Node ≥22.12
  (container runs `node:22-bookworm`; local dev on Node 26).
- **Slack:** `@slack/bolt@5.1.0` in **Socket Mode** (bot token + app-level token, no signing
  secret, no inbound webhook). Block Kit for Approve/Reject + thread-scoped Finals results.
- **HTTP:** `fastify@5.12.3` + `@fastify/static@10.1.3` — only `GET /healthz` and `GET /img/:file`
  (published-image hosting). Slack needs no HTTP.
- **DB:** `better-sqlite3@13.0.3`, one file on a persistent volume at `${DATA_DIR}/app.db`, raw
  SQL, synchronous, hand-rolled `SqliteRepository` behind a port. Schema created on boot.
- **Generation:** Luma Agents REST (`https://agents.lumalabs.ai/v1`) via `fetch`, `type:
  "image_edit"`, behind a `GenerationClient` port. No SDK.
- **CSV:** `csv-parse@7.0.2` sync.
- **Tests:** `vitest@5.0.0` + `@vitest/coverage-v8@5.0.0` + `fast-check@4.9.0`.
- **Deploy:** Railway, `Dockerfile` + persistent volume, single replica (volume forbids replicas;
  SQLite wants one writer). `PUBLIC_BASE_URL` = the `*.up.railway.app` domain.

Architecture is hexagonal: pure `src/domain/` (all invariants), ports in `src/ports/`, adapters in
`src/adapters/`, use-cases in `src/app/`, wiring in `src/runtime/` + `src/main.ts`. Grounding docs
for every library live in `docs/libraries/`; decisions in `docs/adr/`.

## Commands
- `npm run dev` — `tsx watch src/main.ts` (Fastify on `$PORT` 8080 + Slack socket if secrets set)
- `npm run build` — `tsc` → `dist/`
- `npm start` — `node dist/main.js`
- `npm run migrate` — create/upgrade the SQLite schema standalone
- `npm test` / `npm run coverage` — Vitest
- `npm run typecheck` — `tsc --noEmit`
- `npm run format` — Prettier (no separate lint step)

## Definition of Done
1. `npm test` green — the 19 `docs/SPEC.md` scenarios (verbatim `it()` names) + domain + property suites.
2. `npm run typecheck` clean; `docker build` succeeds; container shuts down gracefully (exit 0).
3. Live against the deployed URL + a real Slack workspace: drop a catalog CSV (e.g. `test/fixtures/catalog.sample.csv`) → summary
   posts; a real Draft posts for `HG-002` with Approve/Reject; with `OPEN_APPROVAL=false` the
   approver's tap moves it and no one else's does; approve → 2 Finals → auto-publish → two
   `hg-002-styled-0n.jpg` URLs return 200; Request `done`.
4. `docs/AUDIT-LOG.md` reflects current state.
