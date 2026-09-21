# Audit Log

Running log of the code / test / docs audit run after each wave — correctness review, test-coverage
review, and documentation review, synthesised into one prioritised list. BLOCK/high findings are
cleared before the next wave; medium findings are fixed-if-cheap or carried to the hardening wave.

---

## Wave 0 — Scaffold + grounding

**Shipped:** repo structure; 3 version-pinned grounding docs (`docs/libraries/`); 11 ADRs;
`package.json` pinned exact; `tsconfig` strict; `vitest.config.ts`; ports + domain types +
`palette.ts`; fakes; `config.ts`; `runtime/http.ts`; `main.ts` + graceful shutdown; `migrate.ts`;
`Dockerfile` + `.dockerignore` + `railway.json`; `slack-app-manifest.yaml`; `.env.example`.

**Gates (pre-audit):** typecheck clean · build → `dist/` · `npm test` 4/4 · `docker build` OK ·
container `/healthz` 200.

### Triple-agent audit — verdicts

| Agent | Verdict |
|---|---|
| code-reviewer | **ITERATE** — no security issue, no broken test; 5 seam/lifecycle issues that would cost Wave 1–3 rework |
| testing-audit | **Partial coverage** + 1 real bug (`loadConfig` env mutation); palette VO & repo fake under-tested |
| docs-audit | **Consistent**; 4 Wave-0 decisions had no ADR; `.env.local` workflow unwired; `startCommand` defeats graceful shutdown |

### Synthesis — actions and resolution

**Fixed before Wave 1 (BLOCK / high):**

| # | Finding (agents) | Fix |
|---|---|---|
| 1 | `loadConfig(env)` mutated `process.env`; helpers read globals not the arg → Wave 1 config fixtures would cross-contaminate (CR, TA, DA) | `config.ts` rewritten pure — `req/num/opt/posInt` take the `env` map; no mutation. `test/config.test.ts` added (missing-var, non-numeric, non-positive count, defaults, no-leak, override-from-arg). |
| 2 | `ImageStore.put(Buffer)` — nothing produces a Buffer from Luma's URL → F4 would call global `fetch`, breaking "testable without network" (CR) | port → `putFromUrl(filename, sourceUrl)` (download lives in the adapter, matches ADR 0007). `InMemoryImageStore` fake added (was the missing 4th IO-port fake). |
| 3 | `railway.json` `startCommand: "…migrate.js && …main.js"` → `tini` signals only the shell → graceful shutdown never runs on redeploy (CR, DA) | migrations folded into `main.ts` (`runMigrations()`); `startCommand` = plain `node dist/main.js`. Verified in-container: `docker stop` → exit 0 + `"shutting down"` logged. ADR 0011 + grounding §3.1/§3.2 reconciled. |
| 4 | `InMemoryRepository`: `listRequestsInQueueOrder()` returned terminal Requests; `TERMINAL` set lived only in the fake; sort never returned 0 on ties (CR, TA) | `src/domain/lifecycle.ts` — shared `TERMINAL_STATUSES` / `isTerminal` (note: `stale` is **not** terminal). Queue list filters terminal; strict-weak `byCreatedAtThenId` tiebreak. `test/fakes/in-memory-repository.test.ts` added. |
| 5 | `FakeGenerationClient.get()` completed **any** string → a use-case persisting the wrong generation id passes on a broken impl (CR, TA) | throws on an id it never issued (real Luma 404s). `test/fakes/fake-generation-client.test.ts` added (fail toggles, manual completion). |
| 6 | `ReviewPost` had no timestamp → `getLatestReviewPostForRequest` relied on Map order; SQLite adapter would only have rowid (CR, DA) | `ReviewPost.createdAt` added; fake orders by it; documented so the SQL adapter's `ORDER BY … LIMIT 1` matches. |
| 7 | `SlackGateway.updateMessage` text-only → the Draft image vanishes when the Content Lead taps Approve (CR) | optional `keepImageUrl` on the port; fake records it. Adapter re-renders image + status line in Wave 2/3. |
| 8 | `.env.local` promised by `.env.example` but nothing loads it → Wave 1 live demo blocked (DA) | `start`/`dev`/`migrate` scripts use `node --env-file-if-exists=.env.local`; `.env.example` header updated. |

**Fixed now (cheap / low-risk):**

- `num()` split into `num` (non-negative) + `posInt` (positive integer) for counts/intervals.
- `config.ts` header comment corrected (`main.ts`/`migrate.ts` legitimately read `process.env` for bootstrap).
- ADR **0012** added (exact-version pinning · NodeNext ESM · strict TS set); index updated; ADR 0011 gains the "why Node 22 container" line.
- `Dockerfile`: dropped the dead `python3 make g++` layer (better-sqlite3@13 has no install script, ships prebuilds — verified); added `USER node` + `chown`. Verified `uid=1000(node)` at runtime.
- `README.md`: "where to look" section added (full run/deploy content still Wave 6).
- grounding-doc fixes: cache 30d→1d in `datastore-and-http.md`; `startCommand` reconciled; Node-22 note in `slack-bolt.md`.
- `types.ts`: identity note on `ReviewPost`, "Slack user id / binding" note on `Decision.actor`.
- `http.ts`: dropped redundant `existsSync` guard, documented the mkdir side effect. `test/runtime/http-img.test.ts` added (serve / 404 / path-traversal / no-listing).
- `test/contracts/clock.contract.test.ts` added — one contract run against `SystemClock` + `FakeClock`.
- `FakeGenerationClient` docstring corrected (`failNext`/`failAll` → real method names).
- `FakeSlackGateway.reset()` no longer resets `tsSeq` (was colliding timestamps).
- `slack-app-manifest.yaml`: `app_mention` annotated as reserved for ASSUMPTIONS A6.

**Carried forward (not blocking):**
- Full `README.md` run/deploy/CSV-entry-point content → Wave 6.
- `SqliteRepository` gets a shared `repository.contract.ts` suite when it lands in Wave 1 (run against the fake now, the real adapter then).
- `main.ts` vs `config.ts` `PORT=0` disagreement — resolves when `loadConfig` is wired into `main.ts` in Wave 1.
- `SlackGateway`/`GenerationClient` contract suites — deferred until their real adapters exist (Wave 1/2).

**Post-fix gates:** typecheck clean · `npm test` **58 passed (7 files)** · `docker build` OK ·
container `docker stop` → exit 0 + graceful `"shutting down"` · runs as non-root `node`.

**Palette VO:** code-reviewer independently ran `resolvePaletteTokens` over all 21 unique catalog
`Color / Finish` values — all correct, order preserved. Now also locked by `test/domain/palette.test.ts`
(15 example rows + 5 fast-check properties).

---

## Wave 1 — F1 Catalog intake

**Shipped:** `domain/{price,colorset,notes,import-summary}`; `adapters/{csv,sqlite-repository,
bolt-slack-gateway}`; `app/ingest-catalog`; `runtime/slack-events`; `main.ts` wired; `migrate.ts`
runs the schema; `Repository.listRequestsForSku` added; ADR 0013; `vitest.config` coverage excludes
for the two live-workspace files + `migrate.ts`.

**Gates (pre-audit):** typecheck clean · `npm test` 129/129 (15 files) · `npm run build` OK ·
`DATA_DIR=… node dist/migrate.js` creates all 8 tables + `images/`.

### Triple-agent audit — verdicts

| Agent | Verdict |
|---|---|
| code-reviewer | **ITERATE** — no security hole, no failing test; 8 findings. Independently verified `interpretNotes` over all 13 real catalog Notes values (0 false pos / 0 false neg), `parseCatalogCsv` over 8 quirk shapes, the queue `ORDER BY`, the ingest guard's single synchronous span, and that Bolt acks events before listeners run. |
| testing-audit | **Partial** — every changed file has a mapped test; the holes cluster on `ingest-catalog.ts`'s re-import branches. 3 HIGH, 4 medium/low, all with paste-ready stubs. Coverage 90.76% stmts / 82.47% branch. |
| docs-audit | **2 stale files fed into every session** (`AGENTS.md` is `@import`ed by `CLAUDE.md`; the session-start orient doc was one) — both still described a Next.js/Supabase/Vercel build. ADR 0013 / 0010 accuracy nits. 2 docstrings applied by the agent. Grounding docs: no drift. `.env.example` + `slack-app-manifest.yaml`: complete. |

### Synthesis — actions and resolution

**Fixed before Wave 2 (BLOCK / high):**

| # | Finding (agents) | Fix |
|---|---|---|
| 1 | `InMemoryRepository` ≠ `SqliteRepository` on 6 methods the contract suite never caught: `listProducts` / `listRequestsByStatus` / `listPendingAttempts` unordered; `saveDecision` **appended** instead of upserting (fake violated the port's own "last-writer-wins" header); `listDecisionsForRequest` unordered; `getActiveRequestForSku` returned first-match not highest-revision (CR #5) | fake rewritten: `listProducts` sorts `sku` asc; the two list methods sort `createdAt,id`; `decisions` moved to a `Map` keyed by id (upsert) with a `byAtThenId` sort; `getActiveRequestForSku` sorts `ideaRevision` desc. Contract suite gained out-of-order-insert cases for every list, a re-save-by-id upsert case, a 2-active-revisions case, and `getRequest` + point-lookup-null-on-miss (was untested — TA #5). |
| 2 | ADR 0013 layer-2 (per-SKU idea guard + `NewIdeaRevisionDetected`) had **zero** end-to-end coverage — SPEC scenario 2 only drops the identical file and short-circuits on the hash (CR #2, TA #1/#2, docs) | 4 new F1 scenarios: different Export re-listing a known SKU with the same idea (no 2nd Request), changed idea text (flagged, no Request, named in summary), `nDone` counts our `done` Requests not a CSV column, failed summary post doesn't fail the ingest. New `test/property/ingest-idempotency.property.test.ts` (randomised catalogs, identical + re-listed). |
| 3 | `nDone` hardcoded `0` — becomes a lie on the second import at scale; DOMAIN.md defines J as SKUs already Done *in our system* (CR #1) | `ingestCatalog` now counts rows whose SKU has a `done` Request (moved above the blank-row `continue`); `IngestCatalogResult.nDone` + summary reflect it. |
| 4 | `file_shared` had no channel filter — a CSV dropped in *any* channel the bot is in triggered a full ingest + summary into the watched channel (CR #4) | `slack-events` guards `event.channel_id === config.slack.channelId`; dropped the unneeded cast (real `FileSharedEvent` type carries `channel_id`). |
| 5 | Summary posted *after* the durable hash record → a transient Slack failure = permanently no summary for that Export **and** `slack-events` posts a false "couldn't ingest" error (CR #3) | post wrapped in try/catch inside the use-case; `summaryPosted: boolean` on the result; the sync guard span (hash-check → `saveImport`) is preserved — *not* reordered. `slack-events` retries the post once on `summaryPosted === false` and logs it. |
| 6 | `AGENTS.md` and the session notes described a Next.js/Supabase/Vercel/mobile-UI build — the opposite of this one, and `CLAUDE.md` pulls both into context every session (docs HIGH) | both rewritten to the committed stack (TS ESM · Bolt Socket Mode · better-sqlite3 · Fastify · Railway), the F1-through-F4 wave state, and `SPEC.md`'s 19 scenarios as the DoD. |

**Fixed now (cheap / low-risk):**

- `parsePriceCents` tightened to `/^\d+(\.\d+)?$/` — `Number()` alone accepted `0x10`, `1e3`,
  `Infinity` (CR #8). Tests: `$12.34→1234` (the float-trap `Math.round` covers), `$9.99`, `$0.05`,
  a fast-check property that the result is always `dollars*100 + cents`, and the hex/exp rejections.
- `parseCatalogCsv` validates the **header row** (via the `columns` function) — a renamed `SKU`
  header used to drop every row and post "0 products received"; now throws (CR #8). Tests: missing
  header throws, separator/blank-SKU row dropped, short trailing row tolerated (TA #6).
- `BoltSlackGateway.post` returns Slack's canonical `res.channel`, not the configured value — a
  landmine for Wave 2's `getReviewPostBySlackTs(body.channel.id, …)` correlation (CR #7).
- `downloadFile` rejects a file over 10 MB before buffering it (CR #8).
- `main.ts`: `PORT=0` now honoured (was coerced to 8080), consistent with `config.ts`'s `num()`;
  `slackApp` cleared + `.stop()`'d on a start failure so shutdown can't `.stop()` a dead app, and
  the log distinguishes "not configured" from "failed to start" (CR #6 — also closes the Wave 0
  `PORT=0` carry-forward).
- `slack-events` error path posts a generic line to the channel; `err.message` (could carry a path
  / SQL fragment) stays in the logs (CR #8 security note).
- `interpretNotes` tests: `matte`/`glare`/`reflect*` risk wording; `the Brand Owner:`/`the Content Lead:` speaker strip
  (only `El:` was covered) (TA #7). ADR 0010 keyword list + `notes.ts` docstring reconciled;
  dead `|phasing out` alternative removed.
- ADR 0013: reconciled the coverage claim, added `status: confirmed` and "domain identity" notes,
  documented the best-effort summary post. `sqlite-repository.saveImport` gained a comment on the
  `UNIQUE(content_hash)` coupling it relies on the use-case to never hit.

**Accepted divergence (documented, not fixed):**
- `saveImport` with a fresh id + a duplicate `content_hash`: SQLite throws on the UNIQUE index,
  `InMemoryRepository` stores both. Unreachable — `ingestCatalog` always checks
  `findImportByContentHash` first. Not worth teaching the fake to throw.

**Carried forward (not blocking):**
- `SlackGateway` / `GenerationClient` contract suites — deferred until Wave 2 gives them real
  adapters. `bolt-slack-gateway.ts` + `slack-events.ts` stay coverage-excluded (live workspace,
  verified in the demo).
- Duplicate `files.info` call per `file_shared` event (once to sniff, once in `downloadFile`) —
  cosmetic, hardening wave.
- Full `README.md` run/deploy content → Wave 6.
- Re-import that adds a priority Note to a row whose idea text is unchanged doesn't re-prioritise
  the existing Request (keyed on `shotIdeaText`). Defensible; noted for Wave 6.

**Post-fix gates:** typecheck clean · `npm test` **153 passed (16 files)** · `npm run build` OK ·
coverage **93.65% stmts / 89.69% branch** · standalone migrate creates all 8 tables.

---

## Wave 2 — F3a Draft generation & review loop

**Shipped:** `domain/{prompt,shot-request}`; `adapters/{luma-generation-client,volume-image-store}`;
`app/{run-draft,run-pipeline-tick,handle-decision}`; `runtime/job-loop`; `runtime/slack-events`
(`draft_approve` / `draft_reject` + reason chips + `reason_cancel`), `createSlackApp → { app, gateway }`;
`main.ts` starts the loop; ADR 0014; `vitest.config` coverage-excludes `job-loop.ts`.

**Gates (pre-audit):** typecheck clean · `npm test` 202/202 (24 files) · `npm run build` OK ·
coverage 97.75% stmts / 89.65% branch.

### Triple-agent audit — verdicts

| Agent | Verdict |
|---|---|
| code-reviewer | **BLOCK** — 1 blocking defect (reproduced with a runnable test), 6 medium, 8 low. The binding-actor gate (the spec's core concern) verified correct and well-tested; failure handling in the tick loop was not. |
| testing-audit | **9 ranked gaps.** Every changed file has a mapped test; the holes clustered on `resolvePendingGenerations`' failure / re-entrancy branches and the fake↔real `GenerationClient` divergence. Paste-ready stubs for each. |
| docs-audit | **PASS with 4 fixes** — 2 MED on ADR 0014 accuracy (failure-path overreach, understated crash window), 2 LOW (`hg-041`→`hg-002` example, stale `(Wave 2.)` marker in `AGENTS.md`). No drift in grounding docs, `.env.example`, session notes. Ubiquitous language used verbatim. |

### Synthesis — actions and resolution

**BLOCK / high — fixed before Wave 3:**

| # | Finding | Fix |
|---|---|---|
| B1 | **A single failing Request permanently killed the whole pipeline.** `startConfirmedDrafts` / `resolvePendingGenerations` looped with no try/catch — a throw from `runDraft` (over-long prompt, missing Product, Luma 4xx) aborted the tick *before* `resolvePendingGenerations` ran, and the poisoned Request stayed `confirmed` so the loop died at the same spot every 3 s forever (CR B1 = TA G3). Contradicted ADR 0014's convergence claim. | Both halves now process each item inside its own try/catch → report via `onItemError` → `continue`. `resolveOneGeneration` extracted as the per-attempt body. The item stays `confirmed`/`pending` and retries next tick. Tests: one missing-Product Request doesn't block the rest of the queue; the default `console.error` sink; `runDraft` create-throws leaves nothing written and the Request `confirmed`. |
| B2 | **A paid-for Draft was lost if the Slack post failed.** The attempt was marked `succeeded` *before* `postDraftForReview`; a transient Slack 503 then left the attempt off `listPendingAttempts` (never re-polled), the Request stuck `drafting`, spend booked, no post, no `ReviewPost`. | Reordered: `putFromUrl` → `postDraftForReview` → `saveReviewPost` → `saveRequest(postDraftForReview)` → **then** `saveAttempt(succeeded)`. A post failure leaves the attempt `pending`; the next tick re-polls (fresh presigned URL), re-hosts to the same attempt-derived name (idempotent), re-posts. Test: `slack.failNext("draft-review")` then a healthy tick recovers, spend billed once. |
| M1 | `runDraft` called `generationClient.create` (spends) *before* validating the `confirmed` transition — invisible spend with no attempt row on a wrong-state Request. Latent; Wave 5's retry calls `runDraft` from `drafting`. | `startDrafting(request)` is computed first (throws `IllegalTransition` on any other state); the result is saved only after `create` succeeds. Test: a non-`confirmed` Request throws with zero `create` calls. |
| M4 | **The "one retry" invariant was unreachable** — `rejectDraft` read `r.retryUsed` but nothing ever set it `true`, so SPEC F3b's "second rejection parks" only fired from a hand-built fixture. | first reject now returns `{ status: "drafting", retryUsed: true }`. Test + property updated to assert the flag is set. |
| M5 | Re-host + `saveAttempt` happened unconditionally; the `status === "drafting"` guard was only around the post — an orphaned file + booked spend if the Request had moved on. | The guard now wraps the whole completed-branch: if the Request isn't `drafting`, settle the attempt `succeeded` and return before `putFromUrl`. Test: pending attempt whose Request went `parked` is settled, not re-hosted or re-posted. |
| M6 | `mapState` threw on an unrecognised state inside `create` — a billed generation with no attempt row, which under B1 became a re-spend every 3 s. | `create` uses a lenient `mapCreateState` (unknown → `queued`, the poller sorts it out); `get` keeps the strict throw. Test: `create` tolerates `"provisioning"`. |

**Fixed now (medium / cheap):**

- **M2 — no `fetch` timeout** anywhere. `AbortSignal.timeout(30_000)` added to both Luma calls and
  the image download; a hung socket + the job-loop `inFlight` guard would otherwise wedge the
  pipeline with no log. Tests assert the signal is passed.
- **M3 (partial) — unbounded draft fan-out.** `MAX_DRAFTS_PER_TICK = 8` in `startConfirmedDrafts`
  so a 40-row import drains over ~5 ticks instead of firing 40 `create`s into Luma's
  concurrent-jobs ceiling. Honouring `Retry-After` on a 429 with backoff is carried to Wave 6.
  Test: 11 confirmed Requests → 8 drafted, 3 left `confirmed`.
- **`lumaError` lost the detail on non-JSON bodies** — `res.json()` consumed the stream so the
  `res.text()` fallback threw "Body is unusable". Now reads once as text, then tries `JSON.parse`.
  Test: a 502 HTML body still surfaces with the status.
- **`volume-image-store`**: 25 MB byte ceiling; the empty-`content-type` accept path is now covered
  by a test (some presigned stores omit the header — accepting it is deliberate).
- **`draft_reject` destroyed the message with no way back** — it replaced every block with chips.
  Now it swaps only the `actions` block (image + Shot Idea stay) and adds a **"Never mind"** chip
  (`reason_cancel`) that restores Approve / Reject.

**Test gaps closed (testing-audit G1–G9):** `FakeGenerationClient.completeWithoutImage()` + a test
that `completed`-with-null-image is treated as a failure (G1, and the fake↔real divergence);
repeated-tick idempotency, final-kind skip, Request-moved-on settle (G2); queue fault isolation +
`runDraft` crash-safety (G3); binding tap with no `ReviewPost` → Decision with `attemptId: null`
(G4); `FakeSlackGateway.failNext(kind)` + a `chat.update` failure doesn't lose the Decision (G5);
Luma non-JSON error body / empty-output / `create` non-2xx / lenient state (G6); image-store
invalid-filename / missing-content-type / byte-cap (G7); property tests for the reject invariant
and the ≤6000-char prompt bound under adversarial input (G8); new
`test/contracts/generation-client.contract.test.ts` — one behavioural contract run against
`FakeGenerationClient` **and** `LumaGenerationClient` (stubbed `fetch`), closing the Wave 1
carry-forward (G9).

**Docs fixes applied:** ADR 0014 failure-path bullet reconciled to the guarded code; the
crash-window consequence rewritten to name both non-transactional writes and the stray `succeeded`
row; `hg-041`→`hg-002` in the filename example; `AGENTS.md` stale `(Wave 2.)` marker removed. ADR
0014 also gained the fault-isolation + `MAX_DRAFTS_PER_TICK` paragraph.

**Carried forward (not blocking):**
- 429 / `Retry-After` handling with exponential backoff + jitter on the Luma adapter (Wave 6);
  `MAX_DRAFTS_PER_TICK` → a config value.
- `draftImageFilename` hardcodes `.jpg` while Luma output is described as `.png` — revisit with the
  Wave 3 `domain/publish` filename module (finals are `.jpg` per SPEC F4).
- `getLatestReviewPostForRequest` tie-break is `id DESC` on a UUID — only matters for two draft
  posts in the same millisecond (Wave 5 retry). Note only.
- One fake-timer test for the `job-loop` `inFlight` no-overlap guard (Wave 6).
- CSV drop is the one unauthenticated spend trigger (anyone in the channel) — by design (F1 / A6),
  worth an explicit line in ASSUMPTIONS at hardening.

**Post-fix gates:** typecheck clean · `npm test` **230 passed (25 files)** · `npm run build` OK ·
coverage **98.4% stmts / 95.21% branch**.

---

## Wave 3 — F4 Finals & publish

**Shipped:** `domain/publish` (`publishedFilename` — ADR 0008); `domain/shot-request`
+`beginFinals` / `openFinalsPicking` / `failFinalsGeneration` / `finishPicking`; `app/run-finals`
(the `beginFinals` spend gate + approved-prompt reuse); `app/handle-pick` (Keep / Finish +
binding-actor gate); `app/run-pipeline-tick` +`startApprovedFinals` / `resolveFinalGeneration` /
`postReadyFinals`; `runtime/slack-events` wires `final_keep` / `finals_finish`; `main.ts` shares
one `VolumeImageStore`; ADR 0015; ADR 0009 marked implemented.

**Gates (pre-audit):** typecheck clean · `npm test` 278/278 (29 files) · `npm run build` OK ·
coverage 98.65% stmts / 96.41% branch.

### Audit method

Two rounds, both scoped to `git diff 6f89aff..HEAD`.

- **Round 1 (self-audit, commit `5450ef9`).** The three-agent run was launched but all three
  two of the three review passes returned no output on this run, so a single-reviewer
  pass over the five dimensions took its place. Fixed W3-1/W3-2/W3-3 below.
- **Round 2 (the real three-agent run, this section's fixes).** `code-reviewer` +
  `testing-audit` + `docs-audit` re-run once the limit reset, over the range including `5450ef9`.
  code-reviewer returned **BLOCK** (one unbounded unrecorded spend loop + one SPEC-visible
  duplication path); testing-audit returned 10 gaps (mostly assertion gaps, no dead code);
  docs-audit returned PASS with one docstring gap + two ADR-0015 inaccuracies + port-doc gaps.

### Round 1 — self-audit (in `5450ef9`)

| # | Severity | Finding | Fix |
|---|---|---|---|
| W3-1 | MEDIUM (correctness) | `handle-pick`'s pick path `await`ed `imageStore.putFromUrl` *between* reading the pick count and writing the `PublishedImage` row. Two rapid Keep taps (Bolt does not serialise action handlers) could both compute sequence `01` — colliding on `hg-002-styled-01.jpg`, losing a row, leaving a 2-pick Request stuck at `picking`. | The pick is now one synchronous critical section (count → `savePublishedImage` with `stableUrl` from `ImageStore.urlFor` → `saveDecision` → recount → `saveRequest`), **no `await` between them**; `putFromUrl` moved to the end. Regression tests for overlapping taps on different / same Finals. |
| W3-2 | LOW (hardening) | `publishedFilename` interpolated the raw SKU; a quirky SKU produced a name the image-store adapter then silently `basename`-stripped. | `publishedFilename` sanitises to an `[a-z0-9-]` slug (`HG-002` → `hg-002` unchanged); throws if nothing alphanumeric survives. |
| W3-3 | LOW (docs) | Partial-Finals-failure behaviour wasn't written down. | ADR 0015 "Partial failure" consequence added. |

### Round 2 — three-agent audit

**BLOCK / HIGH — fixed before Wave 4:**

| # | Agent(s) | Finding | Fix |
|---|---|---|---|
| H1 | code-reviewer **BLOCK** + testing-audit G5 | `runFinals` issued all `finalsPerDirection` `create`s (real spend) *before* writing a single attempt row. A `create` that throws on call 2/3 (a Luma 429 at the concurrent-jobs ceiling — no `Retry-After` backoff yet) unwound out of `runFinals`; `startApprovedFinals` caught it; the Request stayed `approved`; the **next tick re-fanned-out**. Each pass leaked one *successful* billed `uni-1-max` generation with **zero `GenerationAttempt` rows** — unbounded (~$0.10/tick forever), invisible to the ledger, violating DOMAIN.md "every attempt records spend even on failure" and defeating the DECISIONS.md mitigation the "no hard spend stop" cut was bought with. Structurally the Wave-2 M6 leak reintroduced by the 3-wide fan-out. | `runFinals` reworked to **interleave + top-up**: each `create` is followed immediately by its own `saveAttempt` before the next; the loop counts the Request's existing `final`-kind attempts and issues only the shortfall, so a re-run converges on exactly `finalsPerDirection` and every billed generation has a row. Residual window is now one generation per process death between a `create` and its `saveAttempt`. Tests: create-throws-mid-fan-out leaves 2 rows + $0.22 booked + Request `approved`; a re-run tops up only the shortfall (never a 2nd batch); a re-run over a complete batch creates nothing. |
| H2 | code-reviewer HIGH | A partial persist (attempt rows land, `saveRequest` doesn't → Request stays `approved`) let the next tick's `runFinals` stack a **second** full batch; `postReadyFinals` took *every* `final` attempt uncapped → the Content Lead gets 6 images / 6 Keep buttons in the "one message" at 2× cost, violating SPEC F4. | The H1 top-up (count existing, issue only the shortfall) fixes the root cause. Belt-and-suspenders: `postReadyFinals` now `.slice(0, finalsPerDirection)` (oldest first). Test: 5 `final` attempts → the message still carries 3. |

**MEDIUM — fixed now (on the demo path):**

| # | Agent | Finding | Fix |
|---|---|---|---|
| M1 | code-reviewer | `handle-pick` declared `gateway` but never used it — a Keep tap produced **zero Slack feedback** (F3a swaps controls for a status line; F4 did nothing), so the Content Lead taps Keep, the Request goes `done`, the deterministic filenames are written — and Slack is unchanged. Defeats ADR 0008's "the name answers the question without a Slack question". | Every tap now posts a best-effort line: a Keep names the published filename + running count; the terminal transition (`done`/`parked`, from a 2nd Keep or "Finish picking") also swaps the Finals message's dead controls for a status line. Tests for the ack line, the done line + control swap, and the parked line. |
| M2 | code-reviewer | The final `putFromUrl` (and the `already`-path one) threw *after* the pick was committed, so `handlePick` threw instead of returning and the result was never logged. `handle-decision` wraps its best-effort call in try/catch; this didn't. | Both `putFromUrl` calls wrapped; `hostFailed: true` added to `HandlePickResult` and surfaced as a "tap Keep again" Slack line. Tests: a failing re-host still persists the row + Decision + reports `hostFailed`; a later re-tap re-hosts to the deterministic name with no new row/Decision. |

**LOW — fixed now:**

| # | Agent | Finding | Fix |
|---|---|---|---|
| L1 | code-reviewer | `postReadyFinals`' all-failed branch saved `failFinalsGeneration` **before** `postMessage`; a Slack throw then lost the "every Final died" notice and the Request vanished into `failed`. | Post first, transition last (the ADR 0014 B2 order). Test: `slack.failNext("message")` keeps the Request `finalizing` and retryable. |
| L2 | code-reviewer | Pick sequence was `list.length + 1`; with `published_images.filename` a *global* PK, two Requests for one SKU (after a park frees the slot) both start at `01` → row-move. | `handle-pick` now uses `max(existing.sequence) + 1` (robust to any gap). The composite-key fix is deferred with the rest of superseding-revision support; ADR 0008 consequence extended to name the row-move. |

**Test gaps closed (testing-audit G1–G9):** the W3-1 heal path (row persisted, re-host fails,
re-tap re-hosts — G1); a property over arbitrary Keep/Finish sequences that `done ⇔ ≥2 distinct
published`, sequences contiguous, no dup names (G2); the Finals post's per-image Keep control +
stable re-hosted URL asserted per entry, not just `.length` (G3); the `runFinals` prompt-reuse
ladder middle rungs — approve Decision with `attemptId: null`, approved attempt with empty
`promptText` (G4); the H1 create-fail leak window (G5); `publishedFilename` slug-shape +
all-separator-throws properties (G6); a repository-contract `savePublishedImage` upsert/round-trip
run against InMemory **and** SQLite (G7); `postReadyFinals` with zero `final` attempts,
`resolvePendingGenerations` skipping a null `lumaGenerationId` (G8); Finish-after-auto-done
idempotency (G9). Also fixed a **pre-existing flake** testing-audit spotted:
`clock.contract.test.ts > "now() and nowMs() agree"` sampled `SystemClock` twice across a
millisecond — now brackets the ISO instant between a `nowMs()` pair.

**Docs fixes (docs-audit):** `publishedFilename` got a full param/throws docstring; ADR 0015's
Consequences rewritten for the H1/H2 interleave + top-up design (the old "leak up to 3 orphaned
generations (~$0.31)" bullet is gone) and its "all three images" bullet reconciled with partial
failure; ADR 0014's stale "(Wave 3)" is now a link to 0015; ADR 0008 records the slug sanitize and
the global-filename-PK row-move; `Repository` port docstrings added for `listRequestsByStatus` /
`savePublishedImage` / `listPublishedForRequest` (all now load-bearing and contract-pinned).

**Verified, no change:** `DraftApproved` is the only Finals-spend *authoriser* — two layers
(`startApprovedFinals` scans only `approved`; `beginFinals` throws otherwise), and no interleaving
of a mid-tick `handleDecision` approve with the status snapshot can spend *without* approval (H1/H2
were unrecorded/duplicated spend on a Request that *was* approved). `finishPicking` can't yield
`done` with <2 published (example + property + the new sequence property). W3-1's "one synchronous
critical section" holds (no `await` from the count read to `saveRequest`; `urlFor` is pure in both
image-store impls). `postReadyFinals` replayability holds — it scans `listRequestsByStatus`
independently of `listPendingAttempts`. TypeScript strict clean; no InMemory↔SQLite port drift.

**Carried forward (not blocking):**
- 429 / `Retry-After` backoff + jitter on the Luma adapter (Wave 6) — H1 makes a `create` storm
  ledger-visible and bounded, but a tight retry loop on a Request whose `create` *always* fails is
  still wasteful of API quota until the backoff lands.
- `MAX_FINALS_STARTS_PER_TICK` / `MAX_DRAFTS_PER_TICK` → config values (Wave 6).
- Regenerating a *failed* Final to reach 3 (vs. topping up never-created ones, which `runFinals`
  now does) — Wave 6.
- `published_images` composite `(request_id, filename)` key for superseding revisions — deferred
  with the rest of that cut (ADR 0008).
- `finalImageFilename` / `draftImageFilename` hardcode `.jpg` while Luma output is `.png` — only
  the throwaway intermediates; the *published* name is `.jpg` by SPEC F4. Content-type-derived
  extension at hardening.
- A thin wiring test for `slack-events.ts`'s `final_keep` / `finals_finish` → `handlePick` mapping
  (coverage-excluded; Wave 6).
- All Wave 1–2 carry-forwards still open (full README, `job-loop` fake-timer test, dedupe the
  double `files.info`, ASSUMPTIONS line on the unauthenticated CSV spend trigger).

**Post-fix gates:** typecheck clean · `npm test` **305 passed (29 files)** · `npm run build` OK ·
`prettier --check` clean on `.ts` · coverage **99.27% stmts / 97.0% branch** · no design-doc churn.

---

## Wave 6 — Luma 429 backoff (ADR 0016)

**Trigger:** not an audit finding — a live-run failure. The first real Railway E2E stalled
permanently on `Luma create failed: HTTP 429 — Rate limit exceeded`, every `runFinals` `create`
for ~14 approved SKUs re-firing on every 3s tick. Root cause: `LumaGenerationClient` did a single
`fetch` + throw; nothing in the tick loop delays a retry, so a transient throttle re-fired forever
and fed the RPM limit. This is the "429 / `Retry-After` backoff + jitter" item carried forward
from the Wave 2 and Wave 3 audits.

**Shipped:**
- `src/adapters/luma-retry.ts` — pure decision math (no timers/IO): `isRetryableStatus` (429/502/
  503), `parseRetryAfterSeconds`, `millisUntilRateLimitReset`, `backoffDelayMs`
  (`Retry-After` → `X-RateLimit-Reset` → `min(base·2^n, maxDelay)`; +`floor(rand·1000)`ms jitter;
  120s hard ceiling). Example + fast-check tested.
- `src/adapters/luma-generation-client.ts` — optional 2nd ctor arg `{ sleep, random, onRetry, now }`
  (real defaults; tests inject instant `sleep` + fixed `random`); private `send()` retry loop
  wrapping `fetch` + the non-2xx check. `create` = `idempotent:false` (retries only explicit
  429/502/503 — a thrown POST may have queued a paid `uni-1-max` job); `get` = `idempotent:true`
  (also retries thrown network/timeout). Give-up throws the same tagged `lumaError` as before.
- `src/config.ts` — `luma.maxRetries` / `retryBaseMs` / `retryMaxDelayMs` (env `LUMA_MAX_RETRIES=5`
  / `LUMA_RETRY_BASE_MS=1000` / `LUMA_RETRY_MAX_DELAY_MS=30000`); new `nonNegInt` helper so
  `LUMA_MAX_RETRIES=0` (disable) is legal. `main.ts` wires `onRetry` → `http.log.warn(info, "luma
  retry")`.
- `run-pipeline-tick.ts` — the stale "config knob + `Retry-After` … is Wave 6 hardening" comment
  updated to point at ADR 0016.

**Unchanged surface:** `GenerationClient` port contract (resolve-or-throw); `FakeGenerationClient`;
`generation-client.contract.test.ts` (single-arg ctor still valid); all 19 SPEC scenarios.

**Still carried forward:** async `failure_code: "rate_limited"` on a completed poll needs a new
attempt + spend row (use-case concern, not HTTP) — noted in ADR 0016's "Out of scope". The other
Wave 3 carry-forwards (per-tick caps → config, regenerate a *failed* Final, `.jpg`/`.png`
extension, `slack-events` wiring test, README, unauthenticated-CSV spend note) remain open.

**Gates:** typecheck clean · `npm test` **338 passed (30 files)** (+33: 25 retry-math, 8 adapter
retry) · `npm run build` OK · `docker build .` OK · `prettier --write` clean on changed `.ts`.

---

## Waves 4 + 5 + 7 — F2 Request capture · F3b Retry & stale escalation · F7 Batch status post

Audited together — all three shipped uncommitted on `build/shot-pipeline` and were squashed into
one commit (`0a6b6c0`) because they share hunks in `run-pipeline-tick.ts`, `shot-request.ts`,
`types.ts`, `prompt.ts`, `ingest-catalog.ts`, `main.ts`. Run against commit `0a6b6c0`
(`cf56983..0a6b6c0`, 57 files, +4282/−86).

**Shipped:** F2 — `app/capture-shot-idea`, `domain/shot-idea-proposal`, `confirmRequest` edge,
button/modal capture (no free-text reply), ADR 0018. F3b — `app/retry-draft`, `app/staleness-check`,
`runtime/scheduler` (2nd interval), `domain/shot-request.markStale`, `startRetryDrafts` tick step,
`prompt.retryReason`. F7 — `domain/batch-status`, `domain/export-csv`, `app/export-batch-csv`,
`app/refresh-batch-status`, the `catalog_import_rows` / `batch_status_posts` / `sku_thread_posts`
tables, `review_posts` unique index widened to `(channel, ts, kind)`, `files:write` +
`filesUploadV2`, ADR 0019.

**Gates (pre-audit):** typecheck clean · `npm test` **458 passed (42 files)** · `npm run build` OK
· `docker build .` OK.

### Triple-agent audit — verdicts

| Agent | Verdict |
|---|---|
| code-reviewer | **BLOCK** — 2 runtime-fatal bugs invisible to the suite (the in-memory fake models neither SQLite FKs nor its unique indexes); 2 HIGH correctness holes the ADRs claim are handled; 8 medium/low. |
| testing-audit | 458 green; **F7 has no verbatim SPEC scenarios** (top finding — its 4 test files trace to nothing in the alignment gate); error/recovery paths in `sweepOpenBatches`, `refresh-batch-status`, `export-batch-csv` uncovered (branch 58–80%); no property test for `composeShotIdeaProposal`; 10 gaps with paste-ready stubs. |
| docs-audit | 4 in-code comment miscitations fixed in place; **ADR 0018 self-contradicts ADR 0019** (same commit) — describes the removed `app.message()` free-text path as live; SPEC.md never got an F7 section yet README claims "six scoped features"; SPEC "hard cap of 5" / "demoable spine … first to shrink" now counterfactual; ASSUMPTIONS A5 still describes the dropped reply path. |

### Synthesis — actions and resolution

**BLOCK — reproduced against the real `SqliteRepository`, not yet fixed:**

| # | Finding | Repro | Fix |
|---|---|---|---|
| 1 | `ingestCatalog` writes `saveCatalogImportRow(importId, sku)` **inside** the row loop (`ingest-catalog.ts:138`) but the parent `saveImport(record)` only after it (`:237`). `catalog_import_rows.import_id REFERENCES catalog_imports(id)` + `pragma foreign_keys = ON` → **every fresh CSV ingest throws `FOREIGN KEY constraint failed`**; `slack-events.ts` swallows it and posts "⚠ Couldn't ingest that CSV". F1/F2/F7's only entry point is dead against the real DB. All 458 pass because `InMemoryRepository` has no FK. | `repo.migrate(); repo.saveCatalogImportRow("x","HG-001")` → `FOREIGN KEY constraint failed` (witnessed). | Stage the SKUs in the sync span, write them in a loop *after* `saveImport`; or hoist `saveImport` above the row loop (keeps the ADR 0013 "saveImport is the last durable write" property by moving the row writes with it). Add a repo-contract case: import row before its import → throws. |
| 2 | The F3b retry Draft posts into the SKU's **existing** living thread reply (`run-pipeline-tick.ts:304-319`, `existing:{channel,ts}`); `BoltSlackGateway.update` returns the **same** `{channel,ts}`; then `:351` unconditionally inserts a second `review_posts` row (fresh `randomUUID()`) at that same `(channel, ts, kind='draft')`. Post-Wave-7 index `idx_review_slack_ts_kind` is `UNIQUE(channel, ts, kind)` — `draft`+`finals` at one ts is fine, **two `draft` rows is not**. Throw lands **after** the Slack `chat.update` succeeded and **outside** its try/catch, so `slackFailureTracker` never sees it; `saveRequest(postDraftForReview)` + `saveAttempt(succeeded)` never run → attempt stuck `pending`, Request stuck `drafting`, **every 3s tick re-polls Luma + re-hosts to R2 + re-updates Slack + throws again** — the exact unbounded retry storm `8e96eae` / `30d4761` were written to stop. `f3b-retry-stale.test.ts` "retried exactly once" passes only because the fake's `saveReviewPost` is `map.set(id, post)`. | `saveReviewPost(...draft, ts=T)` then again `saveReviewPost(...draft, ts=T)` → `UNIQUE constraint failed: review_posts.slack_channel, review_posts.slack_ts, review_posts.kind` (witnessed; `draft`+`finals` at T confirmed still OK). | On the retry, `update` the existing `draft` `review_posts` row in place (look it up by `(channel, ts, kind)` or carry its id on the thread post) instead of inserting; or key the row on `attempt_id`. Add a repo-contract case: two `draft` review posts at one `(channel, ts)` → throws. |

**HIGH — correctness holes the ADRs/comments claim are handled (fix in the same pass):**

- **#3 A completed batch whose CSV upload fails is stranded forever.** `refresh-batch-status.ts:98-105`
  sets `completedAt` *before* attempting `exportBatchCsv`; both open-batch queries key off
  `completed_at IS NULL`, so a failed upload drops the batch out of *both* `sweepOpenBatches` and
  `refreshBatchStatus` and `exportUploadedAt` stays null permanently. ADR 0019:104-105 claims the
  sweep retries it. Fix: don't mark completed until the export succeeds, or widen `listOpenBatches`
  to also return `completed_at IS NOT NULL AND export_uploaded_at IS NULL`. No test covers a failing
  `uploadBatchExportCsv`.
- **#4 `stale` is a dead-end.** No transition has `stale` in its `requireStatus` set, so after
  escalation the Content Lead's Approve/Reject buttons are inert (`handleDecision` → `not-in-review`, no
  feedback) — contradicting `lifecycle.ts:19-21` ("the Content Lead can still tap it"). The SKU's one active
  slot is held forever and, because `stale` is non-terminal, `isBatchComplete` never trips for its
  batch → swept + `chat.update`d every tick indefinitely, never exported. Decide: allow
  `stale → in_review` (and/or `stale → parked`), **or** make `stale` terminal — the current
  combination is the worst of both. Whichever way, reconcile `lifecycle.ts`, `markStale`'s comment,
  and DOMAIN.md.

**MEDIUM (carried to a hardening pass unless the fix is a one-liner):**

- **#5 Lost-update race:** `staleness-check.ts:52-63` reads the Request, `await`s `mentionEscalationContact`,
  then writes `markStale` on the **pre-await snapshot**. An Approve landing in that window is
  silently overwritten by `stale` — discarding the only Finals-spend authoriser. Re-read
  `repo.getRequest(id)` and re-check `status === "in_review"` after the await. (Same read→await→write
  shape at `run-pipeline-tick.ts:252→360` and `:460→533`, but those states aren't user-mutable.)
- **#6 `sweepOpenBatches` unconditional `chat.update` per open batch every 3s** (~1,200/hr/batch) on
  top of the per-transition refreshes now wired into 8 call sites. No "rows unchanged since last
  push" check. Given ADR 0017's rate-limit history: diff rendered rows against last-pushed and skip
  when identical, and/or run the sweep on a slower cadence than the 3s drafting loop.
- **#7 F7 has no verbatim SPEC scenarios** — add a `## F7 — Batch status post & threaded review
  *(scoped addition, ADR 0019)*` section to SPEC.md with 4 scenario names the F7 tests adopt
  verbatim (SPEC.md:4 rule), and change "hard cap of 5" → "5 core + 1 scoped addition"; fix SPEC:27
  ("demoable spine … F2/F3b first to shrink" — both shipped) and README "six scoped features" / SPEC
  five.
- **#8 ADR 0018 ↔ ADR 0019 contradiction** (same commit): 0018 still describes the removed
  `app.message()` free-text `slack-reply` runtime path as live ("handles all three", "scope list
  unchanged"). Add the supersession note docs-audit drafted under 0018's **Status**. Also
  ASSUMPTIONS A5 (still describes the reply path minting `ShotIdeaSupplied`/`ShotIdeaEdited`).
- **#9 Fake-repo fidelity:** `repository.contract.test.ts` pins neither the FK (#1) nor the
  `review_posts` composite uniqueness (#2) — its two `saveReviewPost` cases use distinct `slackTs`.
  Both new cases above go here so #1/#2 can't regress.

**LOW:**

- `refreshBatchStatus`'s "never throws" isn't total — `listOpenImportIdsForSku` is called *outside*
  the try (`refresh-batch-status.ts:112`); a repo throw propagates into `handleDecision` /
  `handlePick` / `runDraft` / `runFinals`. Move inside.
- Batch post at `ingest-catalog.ts:263` uses `req?.status ?? "done"` — a re-listed `parked`/`failed`
  SKU is mislabelled Done until the next refresh; use `resolveSkuStatus`.
- CSV formula injection: `csvField` (`adapters/csv.ts`) quotes only `[",\n]`; `shotIdea` is
  Slack-modal free text → `=HYPERLINK(...)` round-trips into the export the Content Lead opens in Sheets.
  Prefix fields starting `= + - @ \t \r` with `'`.
- Two independent `MAX_DRAFTS_PER_TICK = 8` caps (`startConfirmedDrafts` + `startRetryDrafts`) → a
  tick can issue 16 Luma `create`s, not 8; comment says "same per-tick cap". Share a counter.
- Settling a moved-on Draft attempt (`run-pipeline-tick.ts:273`) omits `resultImageUrl` → after a
  crash between `saveRequest` and `saveAttempt`, `keepImageUrl` drops the image from the post-tap
  message.
- No backfill for pre-Wave-7 rows: `resolvePrimaryImportId` returns `null` for any SKU with no
  `catalog_import_rows` entry and both draft/finals posters then bail — in-flight Requests already
  in the live Railway DB would loop without ever posting. Backfill, or drain legacy Requests before
  deploy (note it).

**Applied during this audit (docs-audit, in place — uncommitted):** `retry-draft.ts` header
("skip" → "`retryDraft` throws; the caller skips"); `staleness-check.ts` header (dropped the
"DECISIONS.md C: hourly" miscitation → "hourly by default — `STALE_SWEEP_INTERVAL_MS`");
`export-batch-csv.ts` header gains the `@throws`; `batch-status.ts` `plainStatusLabel` docstring
("Same mapping as `friendlyStatusLabel`" → "its own shorter wording; keep in sync").

**Reverted during this audit:** an automated edit had also touched the session notes + `slack-app-manifest.yaml`
to assert a `files:write` Slack reinstall was performed and verified on 2026-09-07 — unverifiable,
no such work is on record — `git checkout --` on both.

### Fix pass (follow-up commit)

| # | Fix shipped |
|---|---|
| 1 | `ingest-catalog.ts` — `saveCatalogImportRow` loop moved to *after* `saveImport(record)` (still inside the synchronous guard span). FK parent now exists first. |
| 2 | `run-pipeline-tick.ts` — `resolveDraftGeneration` and `postReadyFinals` now reuse the existing `draft` / `finals` `ReviewPost` row's id (`getLatestReviewPostForRequest` → upsert on `id`) instead of always inserting a fresh `randomUUID()`; a retry Draft (same thread `ts`) no longer collides on `UNIQUE(channel, ts, kind)`. |
| 3 | `refresh-batch-status.ts` — `markBatchCompleted` moved to *last*, after a successful `exportBatchCsv` + `markBatchExportUploaded`. A failed CSV upload now leaves `completedAt` null, so `listOpenBatches` / `listOpenImportIdsForSku` keep returning the batch and the next sweep retries the export. |
| 4 | `shot-request.ts` — `approveDraft` / `rejectDraft` now accept `stale` as well as `in_review`; `handle-decision.ts`'s guard widened to match. An escalated Draft is a nudge, not a dead-end: `stale → approved`, `stale → drafting` (first reject) or `stale → parked` (second). `stale` stays non-terminal. Comments in `shot-request.ts` header, `markStale`, and `lifecycle.ts` reconciled. |
| fake fidelity | `InMemoryRepository.saveCatalogImportRow` throws `FOREIGN KEY constraint failed` when the import is absent; `saveReviewPost` throws on a different row at the same `(channel, ts, kind)`. |
| regression tests | 2 `repository.contract.test.ts` cases (FK on orphan import row; composite-unique on a 2nd `draft` post + `finals` at the same `ts` still allowed); `test/scenarios/ingest-catalog.sqlite.test.ts` — `ingestCatalog` end-to-end against the real `SqliteRepository`; a `shot-request.test.ts` case for the tappable `stale` Draft. |

Docs-audit's 4 in-code comment fixes carried in the same commit.

**Post-fix gates:** typecheck clean · `npm test` **464 passed (43 files)** (+6) · `npm run build` OK
· `docker build .` OK.

**Not fixed (carried forward):** #5 staleness-sweep lost-update race · #6 per-tick unconditional
`chat.update` per open batch · #7 F7 SPEC section + stale SPEC/README lines · #8 ADR 0018↔0019
contradiction + ASSUMPTIONS A5 · #9 contract cases now guard the fake fidelity but the remaining
testing-audit stubs (`export-batch-csv` dedicated file, `composeShotIdeaProposal` property test,
multi-item `staleness-check` fault isolation) are unwritten · LOW items (CSV formula injection,
doubled per-tick Luma cap, `resolvePrimaryImportId` legacy backfill, `refreshBatchStatus`
`listOpenImportIdsForSku` outside the try). Repo-wide Prettier drift predates `0a6b6c0` (~28 `.ts`
files, the whole Wave 4/5/7 delta went in unformatted) — a standalone `prettier --write` sweep,
not this commit.

---

---

## Wave 9 — Finals auto-approve & auto-publish + throttled priority queue

**Shipped:** `FINALS_PER_DIRECTION` 3→2; `domain/shot-request.ts` `completeFinals`
(`finalizing → done | parked`); `run-pipeline-tick.ts` `publishReadyFinals` (auto-publish succeeded
Finals under deterministic names, `pick` Decision actor `"system"`, hyperlinked completion message
into the SKU's living thread reply) + `sweepStrandedPicking` (legacy-row self-heal); the
Keep/Finish pick UI, `handle-pick.ts`, and `final_keep`/`finals_finish` retired; generation
throttling (`MAX_IN_FLIGHT_GENERATIONS` + `MAX_DRAFTS_PER_TICK` / `MAX_FINALS_STARTS_PER_TICK` +
5s poll) with priority-first start sweeps; `ingestCatalog` re-open rule (terminal-but-not-done SKUs
re-list as a new `ideaRevision`). ADR 0020 + 0021; SPEC/ASSUMPTIONS/DOMAIN/APPROACH/EVENT_STORM
reconciled.

**Gates (pre-audit):** typecheck clean · `npm run build` OK · `npm test` 441 passed (42 files).

### Triple-agent audit — verdicts

| Agent | Verdict |
|---|---|
| code-reviewer | **ITERATE** — no security/broken-test issue; 2 correctness items (below) fixed |
| testing-audit | **Partial coverage** — ingest re-open path had no test; legacy-picking self-heal untested |
| docs-audit | **Consistent** — DOMAIN/APPROACH/EVENT_STORM still asserted "3 finals / ≥2 picks / the pick"; fixed |

### Synthesis — actions and resolution

| # | Finding (agent) | Fix |
|---|---|---|
| 1 | `publishReadyFinals` dropped the `classifySlackPostFailure` backstop — a doomed Finals post would retry every tick forever (CR) | Restored the same unrenderable/exhausted backstop in the catch (keyed by `request.id`), mirroring the Draft path |
| 2 | `ingestCatalog` re-open rule (next-batch assumption) had **zero** coverage; SPEC F1 scenario set still only covered the non-reopenable guard (TA) | New `f1-catalog-intake` test: a `parked` SKU re-lists as `ideaRevision 2` on the next drop |
| 3 | `DOMAIN.md` / `DESIGN.md` / `DISCOVERY.md` drift — "picking", "3 finals", "≥2 picks", "the pick" (docs) | Canonical Done/lifecycle/F4 rows reconciled |

**Not fixed (carried forward):** in-flight budget is per-Request-start, not per-`create`, so a
Finals start can overshoot by `finalsPerDirection - 1` (harmless at these defaults);
`sweepStrandedPicking` has no dedicated test; `resolveFinalGeneration` still double-hosts
(throwaway name then deterministic name) as before; Prettier drift predates this wave.

**Post-fix gates:** typecheck clean · `npm test` **441 passed (42 files)**.


### Post-Wave 9 — F7 flake + binary-flagged fake (2026-09-07)

| # | Finding | Fix |
|---|---|---|
| 1 | `f7-batch-status.test.ts` flaked ~50%: `driveToDone` assumed one `startApprovedFinals` pass finalizes the target Request, but ADR 0021 caps it at 1 per tick and same-timestamp Requests tie-break in queue order by random UUID id — the other approved SKU could finalize instead, leaving the target `approved` | `driveToDone` now loops the tick halves until the target Request is `done` (production job-loop semantics), so the scenario is order-independent |
| 2 | `test/fakes/in-memory-repository.ts` contained a raw NUL byte in the line-48 comment (`keyed by ${importId}⟨NUL⟩${sku}`) — `grep`/editors treated the file as binary | Replaced the NUL with the literal `\u0000` text the comment meant; file is clean UTF-8 |

**Post-fix gates:** F7 stressed 10× green · `npm test` **441 passed (42 files)** · typecheck clean.
