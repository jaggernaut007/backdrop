# Backdrop

**A Slack-native product-photography pipeline.** Drop a catalog CSV into one Slack
channel; Backdrop turns each row's shot idea into a cheap draft image, posts it for a
one-tap Approve / Reject, and — once approved — generates and publishes the full-quality
finals under deterministic filenames at stable URLs. The answer to *"which of these is
done, and which file is final?"* lives in the same channel the team already works in.

[![CI](https://github.com/jaggernaut007/backdrop/actions/workflows/ci.yml/badge.svg)](https://github.com/jaggernaut007/backdrop/actions/workflows/ci.yml)

---

## The problem it solves

Small direct-to-consumer brands run product photography out of a spreadsheet. One column
holds a free-text *shot idea* (`"morning kitchen counter, steam, warm light"`); there is
no status column. Decisions get made in Slack threads and then lost. Approved files land
in a shared drive under whatever name the camera gave them, and the storefront gets
updated "after asking in Slack which files are actually final" — sometimes the wrong one,
live for weeks.

Three people feel it:

| Archetype | The job that keeps failing |
|---|---|
| **The Content Lead** | Turn a wishlist of shot ideas into approved images without becoming a full-time image reviewer. Works from a phone; will not install a new tool or log into a dashboard. |
| **The Brand Owner** | See where the pipeline stands without asking the Content Lead — and without burning image budget on shots that get rejected. |
| **The Storefront Publisher** | Ship the *right* file to the product page, identified by name, not by guesswork. |

A creative-automation tool with a polished dashboard was already tried here and abandoned
after week one. That is the binding design constraint: **the work has to happen where the
team already is.** For this team, that is Slack.

## How it works

One import = one thread. Forty products arrive as a single live message, not forty
notifications.

1. **Drop a CSV** (`test/fixtures/catalog.sample.csv` is a sample, or any same-shape export — SKU, name, colour,
   price, photo URL, shot idea, notes) into the watched channel. Ingest fires on Slack's
   `file_shared` event.
2. **One batch status message** posts to the channel root within seconds — one line per
   SKU — and edits itself in place as the run progresses.
3. **Blank rows** (no shot idea) get a threaded reply with **Accept proposal** / **Edit**
   buttons; Edit opens a modal. A proposed idea is generated from category + colour +
   material so the row is never blocked on a human.
4. **Each SKU posts one cheap draft** as an image block in its thread, with **Approve** /
   **Reject** (Reject asks for a one-tap reason chip: *wrong vibe / colour off / too
   staged / other*).
5. **Approve authorises spend.** The two finals auto-generate, auto-publish under
   deterministic names (`hg-002-styled-01.jpg`) at stable URLs, and post back into the
   same thread. Two published finals = **done**.
6. **On completion**, the updated CSV (`Status` + `Final Image URL` columns) is posted to
   the channel root.

There is no slash command and no other surface. The Content Lead taps buttons and reads
one message.

## Design decisions that matter

- **Two-stage spend gate.** One low-cost draft goes out first; only an Approve authorises
  the full-quality finals. A rejection costs a fraction of a full run. Spend is bounded
  and visible, logged per attempt. — [ADR 0020](docs/adr/0020-auto-publish-finals.md)
- **Slack is the only surface.** No dashboard, because a dashboard is a known failure mode
  for this user. Approval lands in the same place the conversation already happens, and
  this time it is written down as a durable `Decision`. — [ADR 0001](docs/adr/0001-slack-socket-mode.md)
- **Deterministic filenames at stable URLs.** The pipeline owns the published artifact;
  `hg-002-styled-01.jpg` is derived from the SKU, not the camera. "Which file is final"
  becomes a property of the file. — [ADR 0008](docs/adr/0008-deterministic-filenames.md)
- **Approval is the sole authoriser of finals spend.** `OPEN_APPROVAL` decides *who* can
  tap (see below); nothing else can start a finals run.
- **One retry per rejection, conditioned on the reason chip.** A second rejection parks
  the request rather than looping spend on an uninterpreted signal.
- **An hourly staleness sweep** @-mentions the escalation contact for any draft left
  un-tapped past `STALE_THRESHOLD_DAYS` — the pipeline's own kill-signal instrument
  ([docs/SCOPE.md](docs/SCOPE.md)).

## Architecture

Hexagonal. Pure domain (`src/domain/`, all invariants), ports (`src/ports/`), adapters
(`src/adapters/` — Slack, SQLite, Luma, Cloudflare R2), use-cases (`src/app/`), wiring
(`src/runtime/` + `src/main.ts`).

| Layer | Tech |
|---|---|
| Language | TypeScript, ESM (`NodeNext`), `strict` + `noUncheckedIndexedAccess`, Node ≥ 22.12 |
| Slack | `@slack/bolt` 5 in **Socket Mode** — bot token + app-level token, no signing secret, no inbound webhook |
| HTTP | `fastify` 5 — only `GET /healthz` and `GET /img/:file` (published-image hosting) |
| Storage | `better-sqlite3` 13, one file on a persistent volume, hand-rolled repository behind a port |
| Generation | Luma Agents REST via `fetch`, `type: "image_edit"`, behind a `GenerationClient` port — no SDK |
| Images | Cloudflare R2 in production; local disk (`IMAGE_STORE=volume`) for zero-config dev |
| Tests | `vitest` 5 + `fast-check` 4 — **445 tests across 42 files**, covering all 19 spec scenarios plus domain and property suites |

Every library choice is grounded in [`docs/libraries/`](docs/libraries/); every decision
is an ADR in [`docs/adr/`](docs/adr/) (21 of them).

## Run locally

Requires **Node ≥ 22.12** (see `package.json` `engines`).

```bash
npm install
cp .env.example .env.local     # fill in the Luma + Slack values
npm test                       # unit + scenario suites — no credentials needed
npm run typecheck
npm run dev                    # Fastify on :8080 + Slack socket once Slack creds are present
```

## Run in Docker

```bash
docker build -t backdrop .
docker run --rm -p 8080:8080 --env-file .env.local -v backdrop-data:/app/data backdrop
curl localhost:8080/healthz
```

## Deploy (Railway)

Single replica, root `Dockerfile`, persistent volume at `/app/data` (SQLite wants one
writer; the volume forbids replicas) — [ADR 0011](docs/adr/0011-railway-single-replica.md).
`GET /healthz` gates the initial deploy.

```bash
npm install -g @railway/cli
export RAILWAY_TOKEN=<project token>
railway up --service <service-id>
railway volume add --mount-path /app/data
railway variables --set LUMA_AGENTS_API_KEY=... --set DATA_DIR=/app/data \
  --set SLACK_BOT_TOKEN=... --set SLACK_APP_TOKEN=... --set SLACK_CHANNEL_ID=... \
  --set APPROVER_SLACK_USER_ID=... --set ESCALATION_SLACK_USER_ID=...
railway domain
railway variables --set PUBLIC_BASE_URL=https://<that-domain>
railway up --service <service-id>
curl https://<that-domain>/healthz
```

`loadConfig` (`src/config.ts`) throws at boot on any missing Slack variable — the
container crash-loops until all five are set, by design (fail fast over a half-configured
Slack integration).

## Slack app setup

Create the app from [`slack-app-manifest.yaml`](slack-app-manifest.yaml), then:

1. **Install to Workspace** → copies the `xoxb-…` Bot User OAuth Token → `SLACK_BOT_TOKEN`.
2. **Generate an App-Level Token** (scope `connections:write`) → `xapp-…` → `SLACK_APP_TOKEN`.
3. **Invite the bot** to the one channel it watches (`/invite @Backdrop`) → channel ID →
   `SLACK_CHANNEL_ID`. Events from any other channel it is a member of are dropped.
4. The approver's and escalation contact's Slack member IDs → `APPROVER_SLACK_USER_ID` /
   `ESCALATION_SLACK_USER_ID`.

**`OPEN_APPROVAL`** (default `true`): any channel member's tap on a draft is binding and
their own Slack id is recorded as the actor — so anyone with a workspace invite can drive
the whole loop, which is the right posture for a shared demo. Set it to `false` to gate
approval to `APPROVER_SLACK_USER_ID` only; every other tap is then inert. It affects only
*who* can approve — the two-stage spend gate and `done` = ≥ 2 published finals are
unchanged.

## Documentation

| Doc | What |
|---|---|
| [docs/PRODUCT.md](docs/PRODUCT.md) | The problem, the three user archetypes, the constraints, the reference catalog |
| [docs/DISCOVERY.md](docs/DISCOVERY.md) | Domain discovery — the event timeline, aggregates, hotspots |
| [docs/DOMAIN.md](docs/DOMAIN.md) | Domain model — bounded context, ubiquitous language, entities, invariants |
| [docs/SCOPE.md](docs/SCOPE.md) | The value thesis, feature scoring, and what was deliberately cut |
| [docs/SPEC.md](docs/SPEC.md) | BDD acceptance criteria — 19 Given/When/Then scenarios, each a test name verbatim |
| [docs/DESIGN.md](docs/DESIGN.md) | What was built and why · tradeoffs · scope ledger · unit economics · the road not taken |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Every open question, the call taken, what it changed, and what to watch |
| [docs/adr/](docs/adr/) | 21 architecture decision records |
| [docs/AUDIT-LOG.md](docs/AUDIT-LOG.md) | Per-milestone code / test / docs audit synthesis |
