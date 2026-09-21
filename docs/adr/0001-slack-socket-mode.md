# 0001 — Slack Socket Mode over HTTP events

**Status:** Accepted · Wave 0

## Context

The product surface is Slack (PRODUCT.md decision 1: nothing installed, works from the approver's phone).
Bolt supports two transports: HTTP events (Slack POSTs to a public Request URL, verified with a
signing secret) and Socket Mode (the app holds an outbound WebSocket to Slack; no inbound URL).
The runtime is a single long-lived Node process on Railway (see [0011](0011-railway-single-replica.md)).

## Decision

Use **Socket Mode** (`@slack/bolt@5.1.0`, `socketMode: true`, bot token + app-level token with
`connections:write`, no signing secret).

## Consequences

- No public webhook, no request-URL round-trip during app setup, no signing-secret verification
  code. Local dev and production behave identically.
- Requires a long-running process — this is fine on Railway, and it is why a Cloudflare Workers
  deployment was rejected (Workers are request-scoped and cannot hold the socket).
- Slack cycles the socket every few hours; `@slack/socket-mode` auto-reconnects, but the process
  must treat a socket close as normal and a supervisor must restart on crash
  (`restartPolicyType: ON_FAILURE`). Handlers are made idempotent on Slack `ts` regardless.
- Each app-level token delivers an event to exactly one connection — so exactly one replica
  (also forced by the volume, [0011](0011-railway-single-replica.md)).

## Alternatives considered

- **HTTP events mode** — the more common production shape, but adds a public URL, signing-secret
  verification, and a request-URL challenge to configure. No benefit here; more to get green in a
  one-day build.
- **Cloudflare Workers + HTTP events** — attractively serverless, but cannot hold a Socket Mode
  connection and complicates the single-writer SQLite story. Rejected.
