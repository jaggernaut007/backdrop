# 0010 — Rule-based `Notes` classification (not an LLM call)

**Status:** Accepted · implemented Wave 1 (`src/domain/notes.ts`)

## Context

`Notes` is one unstructured column doing five jobs (priority, generation risk, source-asset
quality, lifecycle, bundling) and is "the richest signal in the file and the biggest junk risk"
(DOMAIN.md). DECISIONS.md A4: only `priority` and `generationRisk` act; `sourceAssetQuality`,
`lifecycleConcern` and `bundlingIntent` are surfaced for a human and **never auto-acted**; bias
toward false-negatives on `generationRisk`.

## Decision

Classify with **deterministic keyword/phrase rules** in `src/domain/notes.ts`, producing a
`NotesInterpretation` value object. No model call.

- `priority` ← `first`, `bestseller`, `top seller`, `priority`, `push`
- `generationRisk[]` ← `careful`, `photographs badly`, `too shiny` / `shiny`, `look premium` /
  `premium`, `matte`, `glare`, `reflect*` — stored as the whole cleaned note (speaker prefix
  a short `word:` speaker prefix stripped) so `"smoke glass photographs badly, careful"` (SPEC F3a)
  is carried verbatim into the prompt
- `sourceAssetQuality` ← `underexposed` / `overexposed`, `out of focus` / `blurr*` / `grainy`,
  `low-res`, `washed out`, `too dark` / `too bright`
- `lifecycleConcern` ← `discontinu*`, `phas* out`, `end of life` / `eol`, `after spring`,
  `clearance`, `sunset*`
- `bundlingIntent` ← `shoot with` / `shoot together` / `shoot alongside`, `styled with`,
  `bundle*`, `w/ the …`, `with the {mugs,towels,set,blanket}`

A note that trips no rule (e.g. `"plant not included lol"`, `"holiday table story?"`) classifies
to the empty interpretation — no field set.

## Consequences

- Fully deterministic → every classification is a unit test; the SPEC F1 priority scenario is
  exact.
- No latency, no cost, no prompt-injection surface from customer free text entering an LLM.
- The `NotesInterpretation` VO is the seam: swapping in an LLM classifier later changes one
  module, no callers.
- Cost accepted: rules miss novel phrasings. Mitigation matches A4 — when a phrase is ambiguous,
  do **not** classify it as `generationRisk` (false-negative bias); `lifecycle`/`bundling` only
  ever flag, so a miss there is low-harm.

## Alternatives considered

- **LLM classification (Claude) per row** — better recall on unseen phrasing, but adds a provider,
  latency, cost, non-determinism in tests, and puts untrusted text in a prompt. Worth it at
  catalog scale with feedback data; not for 40 rows on day one.
