# Domain Model

DDD-lite model — bounded context, ubiquitous language, entities, invariants. Reads from
[`PRODUCT.md`](PRODUCT.md) and [`DISCOVERY.md`](DISCOVERY.md).

Four product decisions are marked **[decided]** below; a later scope pass reversed two of them
(see [Out of scope](#out-of-scope-value-cut)). Everything else is an assumption, listed at the
end and carried into [`DECISIONS.md`](DECISIONS.md).

---

## Bounded context

**Styled Shot Production.**

One capability: *turn a vague, human-written Shot Idea for one SKU into 2–3 approved, published
images — with every dollar of generation spend gated by a human tap in Slack.*

The context owns the **Request lifecycle** end to end. It does **not** own: the Google Sheet
(receives exports — no live sync, and this build emits no updated one back;
[see Assumption 8](#assumptions)), the Luma model (called through one
adapter), Slack itself (posts and reads buttons), or the team's Drive folder (hands back stable
URLs and a filename, does not write there — [see Assumption 3](#assumptions)).

Everything upstream of a confirmed Request and downstream of a pick is mechanical. The two places
where judgment lives — **Request Capture** and **Review** — are the core. See
[Core vs. supporting](#core-vs-supporting).

---

## Ubiquitous language

Team's words, verbatim from the problem statement and the export wherever they exist. Coined terms are marked.

| Term | Meaning in this context |
|---|---|
| **Shot Idea** | Free-text intent for one SKU — a spreadsheet column, a Slack reply, or a system proposal a human edited. Underspecified by design; one is literally a question. |
| **Idea revision** | *(coined)* A version number on a Shot Idea. New text for a SKU = new revision, never an edit in place. Identity component of a Request. |
| **Request** | One Shot Idea revision for one SKU. The thing that moves through the pipeline. Sixteen exist today; the drop adds ~40. |
| **The pick** | the Content Lead's tap on a final image. It *is* the approval — there is no second step. |
| **Draft** | One low-cost image, generated first, from the white-background photo. What the Content Lead approves or rejects a *direction* on. |
| **Finals** | 2–3 full-quality images generated only on an approved direction. |
| **Done** | ≥2 **auto-published** images, published with stable names and URLs. Mechanically checkable for the first time. |
| **Parked** | A Request where spend has stopped and a human is needed — rejected twice, or partially picked. A *state*, shown by name in the digest, not a silence. |
| **Stale** | *(coined)* A Draft posted for review that the Content Lead hasn't tapped in N days. Triggers escalation. **[decided]** |
| **Risk flag** | A generation caution parsed from `Notes` — *"smoke glass photographs badly"*. Feeds the prompt. |
| **Notes** | One unstructured column doing five jobs: priority, generation risk, source-asset quality, lifecycle, bundling. The richest signal in the file and the biggest junk risk. |
| **Export** | The catalog CSV. the Brand Owner sends new ones; the drop is one. The pipeline emits an updated export back. |
| **The drop** | ~40 products landing next month. The first real test. Re-imports SKUs that already exist. |
| **Digest** | A scheduled Slack message: counts by state + dollars spent + named stale/parked requests. the Brand Owner's answer without asking the Content Lead. Deliberately not a dashboard. (Not to be confused with the **BatchStatusPost** below — ADR 0019 — which is scoped to one import's lifetime, not a scheduled cross-batch view.) |
| **BatchStatusPost** | One Slack message per CatalogImport (F7), listing every row's SKU/name/status, edited in place until every row is terminal, then inert. Its thread is where blank-row asks, Draft review, and Finals review live for that import. Scoped exception to "no dashboard" (ADR 0019) — lives only for one import's lifetime, never a standing cross-batch surface. |

---

## Entities & value objects

### CatalogImport — aggregate
- **Identity:** import id.
- **Attributes:** received-at, source (Slack file ref), row count, `ImportSummary` (N with a Shot Idea, K blank, J already done).
- **Invariants:** idempotent — re-running on the same content upserts Products and opens no duplicate Requests. Parses the customer's real quirks: `$48` → cents, `"Cream Terracotta Sage"` → `ColorSet`, sequence gaps (HG-007, -015…) are normal, no status column expected on input.

### Product — entity
- **Identity:** **SKU** — the only stable key in the file. Never assume contiguity.
- **Attributes:** name, `ColorSet`, price (cents), white-background photo URL, category, material, raw `Notes` string.
- **Note:** referenced by Requests, never evented itself. A re-import updates product facts (price, photo URL) in place.

### ColorSet — value object
- Ordered brand-palette terms parsed from `Color / Finish`. Each term resolves to a known palette
  colour (Terracotta, Sage, Ochre, Dusty Blue, Clay Pink, Charcoal, Cream, Forest, Amber, Smoke)
  or is kept as unmatched. Input to the `GenerationPrompt`.

### ShotIdea — value object
- **Attributes:** text, revision number, origin (`sheet` | `slack-reply` | `proposed` | `proposed-then-edited`).
- **Invariant:** immutable once confirmed. Different text for the same SKU mints the next revision.

### NotesInterpretation — value object
- Classifies the raw `Notes` string into: `priority`, `generationRisk[]`, `sourceAssetQuality`, `lifecycleConcern`, `bundlingIntent`.
- **Invariant:** only `priority` and `generationRisk` influence the pipeline (queue order, prompt
  risk flags). `lifecycleConcern` (*"discontinued after spring?"*) and `bundlingIntent`
  (*"shoot with the mugs maybe"*) are flagged for a human and **never auto-acted**
  ([see Assumption 4](#assumptions)).

### ShotRequest — aggregate root ⭐
- **Identity:** SKU + idea revision. A re-imported SKU with new idea text raises
  `NewIdeaRevisionDetected` and is **named in the import summary** — it does **not** open a
  superseding Request. Superseding-revision handling is out of scope for this build
  ([value cut](#out-of-scope-value-cut); was **[decided]**).
- **Attributes:** status, `ShotIdea`, `priority`, `riskFlags[]`, `lifecycleFlag`, `bundlingFlag`, created-at, escalated-at.
- **Lifecycle:**
  `proposed → confirmed → drafting → in_review → approved → finalizing → done`
  branches: `parked` (rejected twice, or partially picked), `failed` (generation unrecoverable),
  `stale` (Draft un-tapped N days → escalated to the Brand Owner).
- **Invariants:**
  - At most **one active** Request per SKU — the latest revision. Older revisions are terminal.
  - Finals spend is authorised **only** by `DraftApproved`. No other transition may spend on finals.
  - `done` requires **≥2 auto-published images**. Exactly one completed Final ⇒ `parked` as *partially done*, not `done`. **[decided]**
  - A Request may hold at most **one retry per rejection**.

### GenerationAttempt — entity (child of ShotRequest)
- **Identity:** attempt id.
- **Attributes:** kind (`draft` | `retry` | `final`), `GenerationPrompt`, input photo URL, result image refs[], spend (cents), status (`succeeded` | `failed`).
- **Invariants:** every attempt records spend **even on failure**. `retry` carries the rejection reason forward into the prompt. `final` attempts only exist under an `approved` Request.

### GenerationPrompt — value object
- Composed from `ShotIdea` + product facts + `ColorSet` + risk flags. The judgment step —
  not a string copy of the Shot Idea.

### ReviewPost — entity
- **Identity:** Slack `channel + ts`.
- **Purpose:** binds one Slack message to one `ShotRequest` and one `GenerationAttempt`. Records
  which buttons were shown and every tap (actor + verb + time).

### Decision — value object
- **Attributes:** actor (Slack user id), verb (`approve` | `reject` | `pick`), reason (reject only:
  `wrong vibe` | `color off` | `too staged` | `other`), at.
- **Invariant:** only **the Content Lead's** decision is binding — a binding-actor check gates every
  transition. Any other tap is ignored ([see Assumption 2](#assumptions)); recording non-binding
  taps and replying in-thread is out of scope ([value cut](#out-of-scope-value-cut)).

### PublishedImage — entity
- **Identity:** deterministic filename — `hg-002-styled-01.jpg` (SKU + sequence).
- **Attributes:** stable URL, source attempt id, published-at.
- **Invariant:** name is derived, stable, and collision-free. The filename answers "is this the
  final one?" without a Slack question — the `IMG_43xx.jpg` scar.

### SpendLedger — read model *(not an aggregate)*
- Per-attempt cost entries (cents) keyed by period, plus a running total. Every `GenerationAttempt`
  writes one entry, **even on failure**.
- **No ceiling in this build.** The draft-before-finals gate is the budget control; a hard cap that
  pauses and posts is out of scope ([value cut](#out-of-scope-value-cut); see
  [Assumption 5](#assumptions)). The running total feeds the digest and the unit-economics math.

### StatusDigest — read model *(not an aggregate)*
- Counts by state, spend to date, and **named** stale / parked / partially-done Requests. Scheduled Slack post.

---

## Domain events

Past tense, grouped by phase. New/changed vs `DISCOVERY.md` marked **[+]**.

**Ingest** — `CatalogExportReceived` · `ProductsUpserted` · `ImportSummarized`
**[+]** `NewIdeaRevisionDetected` (re-import, changed idea on a known SKU — named in the import
summary, no superseding Request opened; [value cut](#out-of-scope-value-cut))

**Capture (core)** — `ShotIdeaFound` · `ShotIdeaRequested` · `ShotIdeaProposed` · `ShotIdeaSupplied`
· `ShotIdeaEdited` · `ShotIdeaConfirmed` · `RequestOpened` · `RequestPrioritized`
· `GenerationRiskFlagged`
**[+]** `BundlingIntentFlagged` · `LifecycleConcernFlagged` (flag only — no pipeline action)

**Generate (supporting)** — `PromptComposed` · `DraftGenerated` · `DraftPostedForReview`
· `GenerationFailed` · `SpendRecorded`

**Review (core)** — `DraftRejected` · `DraftRetried` · `RequestParked` · `DraftApproved`
· `FinalsGenerated` · `FinalsPosted` · `FinalPicked`
**[+]** `DraftWentStale` · `RequestEscalated`

**Publish (supporting)** — `ImagePublished` · `RequestCompleted`
**[+]** `RequestPartiallyCompleted` (exactly one pick → parked)

**Report (generic)** — `SpendRecorded` (running total) · `StatusDigestPosted`

---

## Core vs. supporting

| Sub-area | Classification | Why |
|---|---|---|
| **Request Capture** | **Core** | The team's actual disease: ideas that live in a head, a thread, or an inbox and therefore don't exist. Turning vague intent — including a *question* — into a structured Request is judgment, not transcription. If this is weak, nothing downstream has anything true to act on. |
| **Review** | **Core** | The entire adoption thesis. Three taps on a phone, no install, no login, decision written down where the conversation happens. The team abandoned a beautiful dashboard in week one — if Review isn't effortless, the product dies the same way. |
| Catalog Ingestion | Supporting | Real logic (SKU identity, `$`-prices, multi-word colours, re-import), but its job is to make the rest of the system never think about CSV again. Bounded and well-understood. |
| Generation | Supporting | Prompt composition is genuine domain logic; the Luma call is plumbing behind one adapter so a model swap touches nothing else. |
| Publication | Supporting | Deterministic naming + the definition of Done. Mechanical once the rule is fixed. |
| Spend & Status | Generic | A running cost total and a scheduled post. Deliberately not a dashboard, and no ceiling. |

**The aggregate that matters is `ShotRequest`.** Every other entity exists to serve its lifecycle.

---

## Hotspot resolutions

From `DISCOVERY.md` — each hotspot now has an answer or an assumption.

| Hotspot | Resolution |
|---|---|
| the Content Lead never taps | `stale` after N days → `RequestEscalated` (@-mention in channel). **[decided]** |
| Re-import changes a done SKU's idea | `NewIdeaRevisionDetected` → named in the import summary, no action. Superseding Requests are out of scope for this build. *Value cut; was **[decided]**.* |
| Only one final picked | `parked` as *partially done*; digest names it; no auto-spend. **[decided]** |
| Product colour survives the scene? | Out of scope. Trusted to the model and to the Content Lead's eye on the draft. *Value cut; was **[decided]**.* |
| Who may tap Approve | Only the Content Lead's tap is binding; others recorded + answered in-thread. *Assumption 2.* |
| `Notes` as prompt input | Classified into 5 intents; only `priority` + `generationRisk` feed the pipeline; `lifecycle` + `bundling` flag for a human. *Assumption 4.* |
| Retry budget ceiling | One retry per rejection (per-Request). No channel-wide ceiling in this build — the draft-first gate is the budget control. *Value cut; see Assumption 5.* |
| Drive ownership | Pipeline owns the filename and a stable URL from its own store; does not write to the team's Drive. *Assumption 3.* |
| How long before proposing an idea | Proposal is co-posted with the ask ("here's one if you don't have a better idea") — no timer. *Assumption 6.* |
| Two Requests, one scene (bundling) | Out of scope; `BundlingIntentFlagged` records it, nothing acts. *Assumption 4.* |

---

## Assumptions

Destined for `DECISIONS.md` — each with the question I'd have asked and what it changed.

1. **Unit of approval.** *Q: concept-level or per-image?* → **Both, in sequence:** one tap approves
   the Draft *direction*; then one tap per Final to keep. Keeps taps ≈3–4 per Request, matches
   "the pick is the decision." Changed: `ShotRequest` has distinct `approved` and `picking` states;
   `DraftApproved` is the only finals-spend authoriser.
2. **Who may approve.** *Q: restrict to the Content Lead or let the channel self-police?* → **Only the Content Lead's tap
   is binding.** Any other tap is ignored. Changed: `Decision` carries an actor; a binding check
   gates every transition. (Recording non-binding taps + in-thread replies: cut by the value pass.)
3. **Drive ownership.** *Q: own the folder or hand back URLs?* → **Hand back URLs + filenames.**
   Drive write access is an install-shaped commitment for a team that rejects those. Changed:
   `PublishedImage` holds a URL from the pipeline's own store; the digest carries those URLs and
   filenames for the Storefront Publisher to place.
4. **`Notes` handling.** *Q: does the column feed generation?* → **Classified, partially trusted.**
   `priority` orders the queue; `generationRisk` enters the prompt; `sourceAssetQuality` surfaces a
   warning; `lifecycleConcern` and `bundlingIntent` flag for a human and never auto-act. Changed:
   adds `NotesInterpretation` VO and four flag events; bundling is explicitly out of scope.
5. **Spend ceiling.** *Q: what happens at the cap mid-batch?* → **No ceiling in this build.** The
   value pass cut it: the draft-before-finals gate already prevents the runaway a cap would guard,
   at 40 products. `SpendLedger` stays a read model — a running total that feeds the digest and the
   unit-economics math. At 300 products a hard cap comes back.
6. **Proposal timing.** *Q: timer or immediate?* → **Co-posted with the ask.** No timer to tune;
   the proposal is text ("reject costs nothing"), posted beside "give us an idea." Changed:
   `ShotIdeaRequested` and `ShotIdeaProposed` fire together for a blank row.
7. **Trigger model.** *Q: bot she commands, or pipeline she receives from?* → **Receives from.**
   The import is the entry point; the Content Lead only ever taps buttons and reads the digest. Changed: no
   Slack slash-command surface in scope; `CatalogExportReceived` drives everything.
8. **Updated CSV export.** *Q: still worth producing given the digest?* → **No — cut by the value
   pass.** The digest plus deterministic stable filenames already answer the Storefront Publisher's only
   question ("which file is final?"). A third status surface would have to stay in sync with two
   others. Changed: `UpdatedExport` read model and `UpdatedExportProduced` removed.

---

## Out of scope (value cut)

From `SCOPE.md`. Each was scored 1 on user-outcome contribution — it does not move the Content Lead's tap,
The Brand Owner's answer, or the Storefront Publisher's file this quarter.

| Cut | Was | Reason | Cost of cutting |
|---|---|---|---|
| **Palette adherence check** | **[decided]** — `PaletteCheck` VO + `PaletteDeviationFlagged` | Non-blocking by design, so the Content Lead's decision is identical with or without it | A Terracotta-reads-as-Ochre render ships if her phone screen misses it |
| **Superseding idea revisions** | **[decided]** — `SupersedingRequestOpened` | Fires only on re-import with changed idea text on an already-`done` SKU — an edge case next month, not this week | A re-import with new text is flagged and otherwise no-ops |
| **Spend ceiling + pause** | Assumption 5 — `SpendLedger` aggregate, `SpendCeilingReached`, `PipelinePaused` | The draft-first gate is the real budget control at this scale | No hard stop; returns at 300 products |
| **Updated CSV export** | Assumption 8 — `UpdatedExport` read model, `UpdatedExportProduced` | Digest + stable filenames already answer "which file is final?" | The Storefront Publisher reads the digest, not a file |
| **Non-binding tap recording** | Assumption 2 — `NonBindingTapRecorded` + in-thread replies | The enforceable rule is the binding-actor check; the reply is manners | Someone else's tap is ignored silently, not acknowledged |

Full out-of-scope list (10 items) lives in `SCOPE.md`; the reasoning per cut lives in `DECISIONS.md`.

---

## Gate

**Confirm the core domain before the spec:**

- Bounded context = **Styled Shot Production**, core capability = *vague Shot Idea → 2–3 approved
  published images, every spend gated by a Slack tap.*
- Core sub-areas = **Request Capture** + **Review**. Everything else supporting/generic.
- Aggregate root = **`ShotRequest`**, identity **SKU + idea revision**.
- Of the four **[decided]** answers, two hold (stale → escalate; one pick ⇒ `parked`); two were
  reversed by the value pass (palette check, superseding revisions) — see
  [Out of scope](#out-of-scope-value-cut).

