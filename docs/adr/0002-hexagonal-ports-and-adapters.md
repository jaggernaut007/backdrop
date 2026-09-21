# 0002 — Hexagonal ports & adapters

**Status:** Accepted · Wave 0

## Context

DOMAIN.md is explicit that the context "owns the Request lifecycle end to end" and does **not**
own the Google Sheet, the Luma model ("called through one adapter"), Slack ("posts and reads
buttons"), or the Drive folder. The two places judgment lives — Request Capture and Review — are
the core; everything upstream and downstream is mechanical. SPEC's 19 scenarios must be testable
without a network.

## Decision

**Ports & adapters (hexagonal).** Pure `src/domain/` (no IO, holds every invariant). Narrow
ports in `src/ports/` (`Repository`, `SlackGateway`, `GenerationClient`, `ImageStore`, `Clock`).
Adapters in `src/adapters/` implement them against real infra. `src/app/` use-cases orchestrate
ports only — no business rules. `src/runtime/` wires Bolt, the job loop, the scheduler, and HTTP.

## Consequences

- Every SPEC scenario is an in-process test: real domain + use-case code, fakes for the four IO
  ports, `FakeClock` for time. No mocking framework, no network, deterministic.
- A Luma model swap or an S3 image-store swap is one adapter file.
- Slight upfront cost: an interface + a fake per port, and mapping between row types and domain
  objects. Judged worth it for a lifecycle aggregate with this many invariants.

## Alternatives considered

- **Framework-first (services calling SDKs directly)** — faster to first line, but SPEC scenarios
  would need network mocks or a live Slack/Luma, making the acceptance suite slow and flaky.
- **Full CQRS / event sourcing** — the domain events in DOMAIN.md invite it, but it is far more
  machinery than a one-day build with one aggregate needs. Events are modelled as method names
  and audit rows, not a store.
