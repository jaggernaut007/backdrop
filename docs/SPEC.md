# Acceptance Criteria

BDD acceptance criteria for **Styled Shot Production**. Reads from `DOMAIN.md` and `SCOPE.md`.
This is the alignment gate: every `Then`-clause below is a behaviour a non-technical stakeholder
recognizes as the thing they asked for, and each scenario name becomes a test name verbatim.

Ubiquitous language is from `DOMAIN.md` **verbatim** — *Shot Idea*, *Request*, *Idea revision*,
*Draft*, *Finals*, *the pick*, *Done*, *Parked*, *Stale*, *Export*, *the drop*, *ColorSet*,
*Notes*, *risk flag*, *Decision*.

---

## Feature list

Derived from `SCOPE.md` feature scoring (13 keeps), clustered to the hard cap of 5. **F3 was split**
into F3a and F3b during spec review; **Status digest (was F5) moved to Out of Scope** to
hold the cap.

| # | Feature | Core? | Absorbs (`SCOPE.md` #) | Serves |
|---|---|---|---|---|
| **F1** | **Catalog intake** | supporting | 7 import, 8 priority, 12 import summary | The drop; queue order |
| **F2** | **Request capture** | **core** | 3 idea proposal | The 24 blank rows |
| **F3a** | **Draft generation & review loop** | **core** ⭐ | 1 Slack review, 2 spend gate, 6 prompt, 8 risk | **The value moment** |
| **F3b** | **Retry & stale escalation** | **core** | 9 one retry, 10 stale escalation | The reject button; the kill signal |
| **F4** | **Finals & publish** | supporting | 4 deterministic publish, 5 auto-publish finals | *Done*; the `IMG_43xx` scar |

**Demoable spine:** F1 → F3a → F4. F2 and F3b are the first things to shrink if time runs out.

Two `[decided]` calls from the domain interview hold and are specified below (stale → escalate;
one completed Final ⇒ `parked`). Two were reversed by the value pass and appear in Out of Scope (palette
check, superseding revisions).

---

## F1 — Catalog intake

*Idempotent ingest of a real customer CSV: SKU identity, `$`-prices, multi-word colours, sequence
gaps, `Notes`-driven priority, and one summary message to the channel.*

### Scenario: A fresh Export is parsed into Products despite its quirks
- **Given** an Export CSV lands in the Slack channel with 40 rows, prices written as `$48`, a
  `Color / Finish` value of `"Cream Terracotta Sage"`, and the SKUs HG-007, HG-015, HG-023, HG-031
  and HG-039 absent from the sequence
- **When** the pipeline ingests the Export
- **Then** 40 Products are upserted keyed by SKU, `$48` is stored as `4800` cents, `"Cream
  Terracotta Sage"` becomes an ordered ColorSet of the brand-palette terms Cream, Terracotta, Sage,
  and no error is raised for the missing SKUs

### Scenario: Re-ingesting the same Export changes nothing
- **Given** an Export has already been ingested and its Requests opened
- **When** the identical Export is ingested a second time
- **Then** no Product is duplicated and no second Request is opened for any SKU

### Scenario: The import is summarised to the channel
- **Given** an Export with 16 rows carrying a Shot Idea, 24 rows blank, and 0 SKUs already Done
- **When** ingest completes
- **Then** one Slack message is posted to the channel stating 40 products received, 16 with a Shot
  Idea, 24 blank, 0 done

### Scenario: A Notes priority moves a Request up the queue
- **Given** two ingested rows, one whose `Notes` reads `"El: bestseller, do this one first"` and
  one whose `Notes` carries no priority
- **When** their Requests are opened
- **Then** the bestseller Request is ordered ahead of the Request with no priority

---

## F2 — Request capture *(core)*

*Turning vague human intent — from the sheet, or a system proposal a human accepts or edits — into
a confirmed Request. The team's actual disease: ideas that live in a head or a thread and therefore
don't exist.*

Wave 7 / ADR 0019: the ask is posted as the SKU's living reply in that upload's batch thread
(F7), and confirmed by button only (`proposed` / `proposed-then-edited`) — a free-typed thread
reply (`slack-reply`) is no longer offered in the Slack UI, since Slack's flat threading can't
identify which SKU a plain reply in a shared batch thread is about once every SKU shares one
thread. `slack-reply` remains a legal `ShotIdeaOrigin` in the domain model (any future non-Slack
capture path could still use it) but has no runtime entry point.

### Scenario: A row that already carries a Shot Idea opens a Request directly
- **Given** an ingested row whose Shot Idea column reads `"morning kitchen counter, steam, warm light"`
- **When** the Request is captured
- **Then** a Request is opened for that SKU with that Shot Idea text unchanged, at Idea revision 1,
  origin `sheet`

### Scenario: A blank row gets the ask and a proposal in one message
- **Given** an ingested row for `HG-014, Sage linen napkins` with no Shot Idea
- **When** the pipeline processes the row
- **Then** one Slack message is posted, as that SKU's living reply in the batch's thread (F7),
  asking for a Shot Idea and containing a proposed Shot Idea built from the category, ColorSet and
  material, and no Request is confirmed for that SKU yet

### Scenario: An edited proposal becomes the Shot Idea
- **Given** a proposed Shot Idea has been posted for a blank row
- **When** a person edits the proposal text before accepting it
- **Then** the Request is opened with the edited text as its Shot Idea, origin `proposed-then-edited`

---

## F3a — Draft generation & review loop *(core)* ⭐

*The value moment. A composed GenerationPrompt, one cheap Draft, posted to Slack with Approve /
Reject, and only the Content Lead's tap moves the Request. A rejection never spends on Finals.*

### Scenario: A confirmed Request produces one Draft posted for review
- **Given** a Request with the Shot Idea `"on a set dinner table, with food in it?"` whose `Notes`
  carry the risk flag `"smoke glass photographs badly, careful"`
- **When** the pipeline runs the Request
- **Then** a GenerationPrompt is composed from the Shot Idea plus the Product's ColorSet and the
  risk flag, exactly one Draft image is generated from the white-background photo, and it is posted
  to Slack with Approve and Reject buttons

### Scenario: the Content Lead taps Approve and the direction is locked
- **Given** a Draft posted for review
- **When**The Content Lead taps Approve
- **Then** the Request moves to `approved` and a Decision is recorded with actor the Content Lead and verb
  `approve`

### Scenario: A tap by anyone other than the Content Lead is ignored
- **Given** a Draft posted for review
- **When** a person who is not the configured binding actor taps Approve
- **Then** the Request does not change state and no Finals are generated

### Scenario: the Content Lead taps Reject with a reason and no Finals spend is recorded
- **Given** a Draft posted for review
- **When**The Content Lead taps Reject and selects `too staged`
- **Then** the Request is recorded as DraftRejected with reason `too staged`, and no finals-spend
  entry is written for that Request

---

## F3b — Retry & stale escalation *(core)*

*One retry per rejection, conditioned on the reason chip. Two rejections park the Request. A Draft
The Content Lead never taps goes Stale and escalates to the Brand Owner — this instruments the kill signal.*

### Scenario: A rejected Draft is retried exactly once, using the reason
- **Given** a Draft was rejected with reason `color off`
- **When** the pipeline retries the Request
- **Then** exactly one new Draft is generated with a GenerationPrompt that carries the `color off`
  reason forward, and it is posted for review

### Scenario: A second rejection parks the Request
- **Given** a Request whose retry Draft has been posted for review
- **When**The Content Lead rejects it a second time
- **Then** the Request moves to `parked`, no further Draft is generated, and no finals-spend entry
  is written

### Scenario: A Draft un-tapped for the stale threshold escalates to the Brand Owner
- **Given** a Draft was posted for review 3 days ago and the Content Lead has not tapped it
- **When** the staleness check runs
- **Then** the Request is marked `stale` and a Slack message @-mentioning the Brand Owner is posted in the
  channel

### Scenario: A Draft still within the threshold does not escalate
- **Given** a Draft was posted for review 2 days ago and the Content Lead has not tapped it
- **When** the staleness check runs
- **Then** the Request is not marked `stale` and the Brand Owner is not @-mentioned

---

## F4 — Finals & publish

*`DraftApproved` is the only authoriser of Finals spend. Two Finals per approved direction; every
completed Final is auto-published with deterministic filenames and stable URLs. Two completed
Finals = `done`; one completed Final = `parked` (partially done); the completion message hyperlinks
each published image and posts into the SKU's living thread reply (never the channel root). Once
every row in a batch is terminal, the batch CSV is generated and posted to the channel.*

### Scenario: An approved direction generates two Finals
- **Given** a Request in `approved` because the Content Lead approved its Draft
- **When** the pipeline runs Finals
- **Then** 2 Finals are generated on the approved direction

### Scenario: Finals are never generated without an approved direction
- **Given** a Request that has no `DraftApproved` — it is `in_review` or `parked`
- **When** the pipeline runs
- **Then** no Finals are generated for that Request and no finals-spend entry is written

### Scenario: Completed Finals are auto-published and the Request is Done
- **Given** 2 Finals for SKU HG-002 have completed generation
- **When** the pipeline publishes ready Finals
- **Then** both are published with the deterministic filenames `hg-002-styled-01.jpg` and
  `hg-002-styled-02.jpg` and stable URLs, and the Request is `done`

### Scenario: A single completed Final is published and the Request is Parked, not Done
- **Given** 1 of 2 Finals for a Request completed generation and the other failed
- **When** the pipeline publishes ready Finals
- **Then** the completed one is published and the Request is `parked` as partially done, and the
  Request is not `done`

### Scenario: the Finals completion message hyperlinks each published image to its stable URL
- **Given** a Request whose Finals have all been auto-published
- **When** the pipeline posts the completion message
- **Then** the message lists each deterministic filename as a hyperlink to its stable URL, in the
  SKU's living thread reply (not the channel root)

---

## Out of Scope

Each item does not move the Content Lead's tap, the Brand Owner's answer, or the Storefront Publisher's file this build. Full
10-item list and per-cut reasoning live in `SCOPE.md` and `DECISIONS.md`.

1. **Status digest** *(was F5 — a `SCOPE.md` keep, cut here to hold the 5-feature cap after F3 was
   split)*. Counts by state, spend total, and named stale/parked Requests as a scheduled Slack post.
   **Reason:** it is a read model over data the other four features already record — per-attempt
   spend in cents is still written on every GenerationAttempt, and `stale`/`parked` are already
   states — so it is a later addition, not new plumbing. **Cost:**The Brand Owner's verbatim ask ("see where
   things stand without asking the Content Lead") is unmet until it ships; the demoable spine (F1→F3a→F4) does
   not depend on it.

2. **Palette adherence check** *(reverses a `[decided]` call)*. Sampling the rendered product colour
   against the ColorSet and annotating the review post. **Reason:** non-blocking by design, so
   The Content Lead's decision is identical with or without it — she looks at the image and taps. **Cost:** a
   Terracotta-reads-as-Ochre render ships if her phone screen misses it; the palette is still in
   the prompt as an explicit constraint.

3. **Superseding idea revisions on re-import** *(reverses a `[decided]` call)*. A re-import with
   changed Shot Idea text on an already-`done` SKU raises `NewIdeaRevisionDetected` and is named in
   the import summary — and opens no superseding Request. **Reason:** fires only in a narrow case
   that is not in the drop (new SKUs, not re-imports of finished ones). **Cost:** a human reads
   "HG-002's idea changed since it was completed" in the summary and decides manually.

4. **Spend ceiling with pipeline pause.** A channel-wide cost cap that halts generation and asks
   The Brand Owner. **Reason:** the two-stage spend gate (F3a/F4) is the real budget control — nothing
   generates Finals without the Content Lead's tap, and Drafts are cheap; at 40 products the worst case is a
   bounded, small number of cheap Draft generations. **Cost:** no hard stop if a bug loops
   generation; returns at the 300-product catalog.

5. **Updated CSV export.** The catalog CSV written back out with a status column. **Reason:** the
   Storefront Publisher's only question — "which file is final?" — is answered by the deterministic filename
   and stable URL from F4; a CSV is a third status surface to keep in sync. **Cost:**The Storefront Publisher reads the published filenames instead of opening a spreadsheet. *Except* one CSV per
   batch status post (F7), generated once on that batch's completion and posted to the channel root
   — not a running file kept in sync (ADR 0019, amended Wave 8).

6. **Non-binding tap recording and in-thread acknowledgement.** Recording taps by people other than
   The Content Lead and replying "noted — waiting on the Content Lead". **Reason:** the enforceable rule is the
   binding-actor check in F3a; the reply is manners, not mechanism. **Cost:** someone else's tap is
   silently inert rather than acknowledged.

7. **A dashboard, of any kind.** **Reason:** the documented failure mode — the team abandoned one in
   week one. **Cost:** none. This is the point. *Except* the batch status post (F7): one Slack
   message per CSV import, live only until every row in that import reaches a terminal outcome,
   then inert — no cross-import view, no standing surface (ADR 0019).
