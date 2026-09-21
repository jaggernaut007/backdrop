# 0016 — Luma transient-error retry: exponential backoff + jitter, inside the adapter

**Status:** Accepted · implemented Wave 6 (`src/adapters/luma-retry.ts`,
`src/adapters/luma-generation-client.ts`, `src/config.ts`, `src/main.ts`)

## Context

The first real end-to-end run on Railway drove the pipeline into a **Luma HTTP 429 storm**.
`railway logs` showed every `runFinals` `create` for the ~14 approved SKUs failing with
`Luma create failed: HTTP 429 — Rate limit exceeded` on every 3 s tick, indefinitely.

`LumaGenerationClient.create` / `.get` did a single `fetch` and threw on any non-2xx. A 429
therefore bubbled straight out to `startApprovedFinals` / `startConfirmedDrafts`
(`run-pipeline-tick.ts`), whose per-item try/catch logged it via `onItemError` and dropped the
item to the next tick — which re-issued the identical burst, *adding* to the RPM pressure. With no
delay anywhere in the loop, a transient throttle became a permanent stall. ADR 0014/0015 both
name "honouring `Retry-After` on a 429" as deferred Wave 6 hardening; this is it.

Luma's own docs prescribe the policy (docs/libraries/luma-vitest-railway.md §1.5):

- **Retryable:** 429 (RPM *or* concurrent-jobs), 502, 503. **Terminal:** 400, 401, 402, 403,
  413, 422, 404.
- Honour `Retry-After` (delta-seconds) if present; on an RPM-429 also `X-RateLimit-Reset`
  (unix ts); on a concurrent-429, `Retry-After: 60`.
- Else exponential `2^attempt` seconds; **add 0–1 s random jitter**.

## Decision

**Retry lives in the adapter — the one place that speaks HTTP.** The `GenerationClient` port
contract is unchanged: `create` / `get` still either resolve or throw. Use-cases, the job loop,
`FakeGenerationClient`, and the scenario suite are untouched; the existing per-item try/catch in
`run-pipeline-tick.ts` stays as the outer net for *exhausted* retries.

**The decision math is a pure module** — `src/adapters/luma-retry.ts`: `isRetryableStatus`,
`parseRetryAfterSeconds`, `millisUntilRateLimitReset`, and `backoffDelayMs`. No timers, no I/O,
so it is example- and property-tested directly. Delay precedence: `Retry-After` →
`X-RateLimit-Reset` → `min(baseMs · 2^attempt, maxDelayMs)`; then `+ floor(random()·1000)` ms of
jitter; then clamp to a hard ceiling of 120 s so a pathological `Retry-After` can't wedge a tick.

**`LumaGenerationClient` gets an optional second constructor arg** (`{ sleep, random, onRetry,
now }`) — defaults are real `setTimeout` / `Math.random` / `console.warn` / `Date.now`; tests
inject an instant `sleep` and a fixed `random` for determinism. `main.ts` wires `onRetry` to the
Fastify logger (`http.log.warn(info, "luma retry")`) so the backoff is visible in `railway logs`.
The single-arg form (`new LumaGenerationClient(config)`) still works — the contract test relies
on it.

**A thrown `fetch` error (network drop, our own 30 s timeout abort) is retried only for `get`.**
`get` is an idempotent, free poll. `create` is `POST /generations` — a thrown error is ambiguous
(the request may have queued a billed `uni-1-max` generation, ~11¢), so a network-error retry
there could double-spend; it is deliberately *not* done. A retryable *status* (429/502/503) means
the server rejected the request before doing any work, so it is retried for both `create` and
`get`.

**Knobs, per DECISIONS.md Part C** (`config.luma`, all env-overridable):

| env | default | meaning |
|---|---|---|
| `LUMA_MAX_RETRIES` | `5` | retries after the first attempt; `0` disables retry entirely |
| `LUMA_RETRY_BASE_MS` | `1000` | exponential base — nth retry waits `base · 2^n` ms + jitter |
| `LUMA_RETRY_MAX_DELAY_MS` | `30000` | ceiling for the *exponential* branch; `Retry-After` still wins |

At the defaults a fully-throttled call sleeps `~1 + 2 + 4 + 8 + 16 s` (+ up to 5 s jitter) across
its 5 retries before giving up — ~31–36 s worst case, well inside a tick that the `inFlight`
guard already lets run long. In the common case (a brief RPM spike) the first one-second sleep
clears it.

## Consequences

- **The 429 storm self-heals.** A transient throttle is absorbed by a sleep instead of thrown;
  the queue drains over a few ticks as designed. Total request volume against Luma goes *down* —
  no more every-3 s re-fire of a doomed burst, which was itself feeding the RPM limit.
- **`create` retry is spend-safe.** Only explicit 429/502/503 (server rejected, nothing queued)
  is retried on `POST`; a thrown/timeout error is not. Combined with `run-finals.ts`'s
  write-after-each-`create` top-up (ADR 0015), the ledger invariant "every billed generation has
  a row" holds — a retry that eventually succeeds still produces exactly one `saveAttempt`.
- **A slow tick, by design.** A heavily-throttled batch can make one tick take ~30 s per stuck
  call. The job loop's no-overlap `inFlight` guard already tolerates this (the next intervals are
  skipped); `AbortSignal.timeout(30_000)` still caps each individual `fetch`. `LUMA_MAX_RETRIES=0`
  restores the old fail-fast behaviour if a deploy ever needs it.
- **Backoff is observable.** Each retry logs `{ op, attempt, delayMs, status, reqId }` at
  `warn`. In `railway logs` the old flood of `pipeline tick: runFinals failed … HTTP 429` errors
  is replaced by a handful of `luma retry` lines that then stop.
- **`get` retries thrown errors too**, so a flaky socket during polling no longer strands a
  `pending` attempt for a whole tick.
- Coverage: `luma-retry.ts` is pure and fully unit + property tested; `luma-generation-client.ts`
  gains a retry block (429→ok, 503→ok, no-retry-on-4xx, exhaustion, network-retry on `get`,
  no-network-retry on `create`, `Retry-After` honoured, `maxRetries: 0` = old behaviour).

## Alternatives considered

- **Retry in the use-cases (`run-draft` / `run-finals`).** They would need to know Luma's status
  taxonomy and carry a sleep dependency, leaking HTTP concerns across the port. The adapter is
  the only layer that already holds the `Response`.
- **A generic `p-retry` / `fetch-retry` dependency.** ADR 0012 pins every dependency and keeps
  the tree small; the policy here is ~40 lines of pure code with one exact behaviour to match
  (Luma's doc), and it needs injectable `sleep`/`random` for deterministic tests anyway.
- **Retry a thrown error on `create` as well.** Rejected — a `POST /generations` that times out
  may have queued a paid `uni-1-max` job; a blind retry risks a duplicate charge with no ledger
  row for the first. `get`'s idempotence makes it safe there only.
- **Also wrap `VolumeImageStore.putFromUrl`.** That downloads an AWS S3 presigned URL, not the
  rate-limited Agents API — different failure surface, out of scope here.

## Out of scope

- **Async** `state: "failed"` / `failure_code: "rate_limited"` on a completed poll. That is not an
  HTTP error — it needs a *new* attempt row and a fresh spend entry, a use-case concern
  (`resolvePendingGenerations` / `run-finals` regeneration). Current behaviour (mark the attempt
  `failed`; Finals top-up only re-creates *never-created* shortfall, not *failed* ones) is
  unchanged. Follow-up.
