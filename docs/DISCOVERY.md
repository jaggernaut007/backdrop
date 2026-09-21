# Domain Discovery

The event timeline, aggregates, and hotspots that feed the domain model. Reads from
[`PRODUCT.md`](PRODUCT.md).

> **Status:** discovery artifact, kept as the original record. Hotspot answers live in `DOMAIN.md`;
> a later scope pass then cut four of them — palette check, superseding revisions, spend
> ceiling, updated CSV export (see `SCOPE.md` / `DECISIONS.md`). Events and hotspots below are
> annotated where that cut applies.

Vocabulary is the team's, verbatim where it exists: **Shot Idea**, **Request**, **Draft**,
**Finals**, **The pick**, **Done**, **The drop**, **Export**.

---

## Event timeline

Past tense, in sequence. One full pass from "the Brand Owner sends the export" to "the Storefront Publisher ships
the right file."

### Ingest

1. **CatalogExportReceived** — a CSV landed in the Slack channel (the Brand Owner's export today; the
   40-product drop next month). Same columns, new SKUs, new photo URLs.
2. **ProductsUpserted** — rows became Products keyed by SKU. Sequence gaps are normal
   (HG-007, -015, -023, -031, -039 absent); `$48` parsed to cents; `"Cream Terracotta Sage"`
   split into a color set.
3. **ImportSummarized** — the channel got told what arrived: *N products, M with a Shot Idea,
   K blank, J already done.* This is the first moment anyone can answer "where do we stand."

### Capture — turning vague intent into a Request

4. **ShotIdeaFound** — a row carried a human-written Shot Idea (16 of 40 today). Straight to a
   Request.
5. **ShotIdeaRequested** — for a blank row, the bot asked the channel for one. This is the fix
   for *"a Slack message everyone 👍'd and nobody wrote down"* — the ask happens where the
   conversation already happens, and the answer gets written down as structured data.
6. **ShotIdeaSupplied** — a human replied in-thread with an idea. Captured.
7. **ShotIdeaProposed** — nobody replied, so the system proposed one from category + color +
   material + Notes. Posted as *text*, not an image — a concept costs nothing to reject.
8. **ShotIdeaEdited** — someone rewrote the proposal before accepting it. The edit is the idea.
9. **ShotIdeaConfirmed** — a Shot Idea now exists for this SKU. A **Request** is born.
10. **RequestPrioritized** — `Notes` moved it up the queue (`"El: bestseller, do this one
    first"`, `"top seller, gets reordered constantly"`).
11. **GenerationRiskFlagged** — `Notes` warned the generator (`"smoke glass photographs badly,
    careful"`, `"came out too shiny in last shoot"`, `"pricey, needs to look premium"`).

### Generate — draft first, cheap

12. **PromptComposed** — Shot Idea + product facts + brand palette + risk flags became a
    generation prompt. The judgment step; not a string copy.
13. **DraftGenerated** — one low-cost image, from the white-background photo. Spend recorded.
14. **DraftPostedForReview** — posted to Slack with `Approve` / `Reject`. Nothing installed,
    no login, works on a phone.

### Review — the pick

15. **DraftRejected** — the Content Lead tapped Reject and picked a reason (wrong vibe / color off / too
    staged / other). The reason is the signal we refused to spend money guessing at.
16. **DraftRetried** — one varied re-generation using that reason. Once.
17. **RequestParked** — rejected twice. Spend stops; it waits for a human, visibly, in the
    status digest. Parked is a state, not a silence.
18. **DraftApproved** — the direction is locked. This authorizes finals spend and nothing else.
19. **FinalsGenerated** — 2–3 full-quality images on the approved direction.
20. **FinalsPosted** — one Slack message, all finals, tap to keep.
21. **FinalsPublished** — **auto-publish.**The Content Lead's Draft tap *is* the approval; Finals auto-approve and auto-publish.

### Publish — the end of the `IMG_43xx.jpg` scar

22. **ImagePublished** — each picked image got a deterministic SKU-based name
    (`hg-002-styled-01.jpg`) and a stable URL. The filename now answers "is this the final one?"
    without a Slack question.
23. **RequestCompleted** — ≥2 auto-published images published. This is **Done**, mechanically, for the
    first time.
24. **GenerationFailed** — the API errored or returned nothing usable. Surfaced, not swallowed.

### Report

25. **SpendRecorded** — every generation attempt, draft or final, cost logged against the
    Request. (Fires throughout; grouped here.)
26. **StatusDigestPosted** — the Brand Owner's answer, in Slack: done / in review / parked / failed, and
    dollars spent. Without asking the Content Lead, without a dashboard.
27. ~~**UpdatedExportProduced**~~ — *cut by the value pass.* Status ships in the digest; the Storefront Publisher gets deterministic filenames + stable URLs there, not a third file to keep in sync.

---

## Aggregates

| Aggregate | Identity | Owns these events |
|---|---|---|
| **CatalogImport** | import id | CatalogExportReceived, ProductsUpserted, ImportSummarized |
| **Product** | **SKU** (the only stable key in the file) | — referenced, not evented |
| **ShotRequest** | SKU + idea revision | ShotIdeaRequested → ShotIdeaConfirmed, RequestPrioritized, GenerationRiskFlagged, DraftApproved / DraftRejected, FinalsPicked, RequestParked, RequestCompleted |
| **GenerationAttempt** | attempt id, child of ShotRequest | PromptComposed, DraftGenerated, FinalsGenerated, GenerationFailed, SpendRecorded |
| **ReviewPost** | Slack `channel + ts` | DraftPostedForReview, FinalsPosted — binds a Slack message to a ShotRequest |
| **PublishedImage** | deterministic filename | ImagePublished |
| **SpendLedger** | period | SpendRecorded (running total) — *read model; value pass cut the ceiling + pause/post* |
| **StatusDigest** | — *read model, not an aggregate* | StatusDigestPosted *(UpdatedExportProduced cut)* |

**ShotRequest is the aggregate root that matters.** Everything else exists to serve its
lifecycle: `proposed → confirmed → drafting → in_review → approved → finalizing →
done`, with `parked` and `failed` as terminal-ish branches.

---

## Hotspots

Each is followed by where it landed — **→** the resolution in `DOMAIN.md`, and whether the
scope pass later changed it.

⚡ **the Content Lead never taps anything.** What happens to a draft posted 6 days ago? Dormancy is the
incumbent failure mode — the 👍 that nobody wrote down. Does an unanswered draft expire, escalate
to the Brand Owner, or sit forever in the digest?
**→** `stale` after 3 days → `RequestEscalated` (@-mention). **[decided]** — holds; the
value pass made it load-bearing (it instruments the kill signal).

⚡ **Who is allowed to tap Approve?** The buttons are in a shared channel. *"Her pick is the
decision"* — so is a tap by the Storefront Publisher the decision? Restrict to the Content Lead, or record who tapped
and let the channel self-police?
**→** Only the Content Lead's configured user ID is binding; any other tap is ignored. Recording non-binding
taps + in-thread replies: cut by the value pass. *Assumption 2.*

⚡ **the Content Lead picks only one final.** Done is "2–3 approved images." One pick is under the bar. Is
that request done, partially done, or does it re-generate to fill the gap — and on whose money?
**→** `parked` as *partially done*; the digest names it; no auto-spend. **[decided]** — holds.

⚡ **A re-import changes a Shot Idea on a completed SKU.** New export, same SKU, different idea.
Does the Request re-open, does a second Request exist for that SKU, or does the old one win?
This fires for real next month when the drop lands alongside today's 40.
**→** `NewIdeaRevisionDetected` → named in the import summary, no action. Superseding Requests
**cut by the value pass** (was **[decided]**) — an edge case that isn't in month one.

⚡ **How long does the bot wait before proposing a Shot Idea?** Too fast and it steps on the Content Lead;
too slow and the drop stalls. Is the wait a timer, or does the proposal post immediately
alongside the ask as "here's one if you don't have a better idea"?
**→** No timer. The proposal is co-posted with the ask. *Assumption 6.*

⚡ **`Notes` is free text going into a generation prompt.** `"smoke glass photographs badly"` is
expert guidance worth thousands. `"plant not included lol"` and `"discontinued after spring?"`
are not. Trusting the column blindly puts junk in the prompt; ignoring it throws away the richest
signal in the file. Where's the filter?
**→** Classified into 5 intents; only `priority` + `generationRisk` act; `lifecycle` + `bundling`
flag for a human. *Assumption 4.*

⚡ **Nothing verifies the product survived the scene.** Terracotta going ochre in a warm-light
render is a silent brand failure that only the Content Lead's eye catches — and she's approving on a phone.
Is palette adherence a check, or trusted to the model?
**→** Palette check **cut by the value pass** (was **[decided]**): non-blocking by design, so it
changed no decision. Trusted to the model, the palette in the prompt, and the Content Lead's eye on the draft.

⚡ **The retry budget has no ceiling yet.** One retry per rejection is bounded per Request, but
40 products × drafts × retries needs a channel-wide stop. What does the system do when it hits
the cap mid-batch — pause and ask, or halt?
**→** One retry per rejection holds. The channel-wide ceiling + pause/post is **cut by the value
pass** — the draft-first gate is the budget control at this scale. Returns at 300 products.
*Assumption 5.*

⚡ **Does the pipeline own the Drive folder, or just hand back stable URLs?** The scar is real
(wrong `IMG_43xx.jpg`, live for three weeks) but Drive write access is an install-shaped
commitment for a team that rejects those.
**→** Hand back stable URLs + deterministic filenames; no Drive writes. *Assumption 3.*

⚡ **Two Requests, one scene.** `"El: shoot with the mugs maybe"`, `"bathroom set w/ the
towels?"` — the Notes column asks for multi-product shots. One image satisfying two Requests
breaks the SKU-keyed model. Out of scope, or a first-class concept?
**→** Out of scope. `BundlingIntentFlagged` records it; nothing acts. *Assumption 4.*

---

## Bounded context candidates

**1. Catalog Ingestion** — *events 1–3*
Owns SKU identity and the quirks of a customer's real file: sequence gaps, `$`-prefixed prices,
multi-word color fields, blank columns. Its job is to make the rest of the system never think
about CSV again. Re-runnable, idempotent — because new exports keep coming.

**2. Request Capture** — *events 4–11* · **core**
Owns the transformation of vague human intent into a Request the machine can act on: from the
sheet, from a Slack reply, or proposed by the system and edited by a human. This is where the
team's actual disease lives — ideas that exist in someone's head, a Slack thread, or an inbox,
and therefore don't exist at all. Everything downstream is mechanical; this is not.

**3. Generation** — *events 12–13, 19, 24* · supporting
Owns prompt composition and the Luma API. The prompt-building is real domain logic (Shot Idea +
product facts + palette + risk flags); the API call is plumbing. Isolate the vendor here so a
model swap doesn't touch anything else.

**4. Review** — *events 14–18, 20–21* · **core**
Owns the two-stage approval loop and the binding between a Slack message and a ShotRequest.
The product's entire adoption thesis lives here: if this context isn't three taps on a phone,
the team abandons it in week one like the last tool.

**5. Publication** — *events 22–23*
Owns deterministic naming and the definition of **Done**. Its single job is that nobody ever
again has to ask Slack which file is final.

**6. Spend & Status** — *events 25–26*
Owns a running cost total and the Brand Owner's question. A read model plus a scheduled post — deliberately
not a dashboard (the documented failure mode here), and no spend ceiling (value pass). The digest
also carries finals filenames + URLs, which is why *event 27, the separate CSV export, is cut*.

---

### Context map

```
  Catalog Ingestion ──products──> Request Capture ──confirmed request──> Generation
                                        ^                                    │
                                        │                                 draft/finals
                                   idea edits                                │
                                        │                                    v
                                        └────────── Review <─────────────────┘
                                                      │
                                                 the pick
                                                      │
                                                      v
                                                 Publication
                                                      │
                                                      v
                                               Spend & Status
                                       (Slack digest → the Brand Owner; carries finals
                                        filenames + URLs for the Storefront Publisher)
```

**Core:** Request Capture, Review. **Supporting:** Ingestion, Generation, Publication.
**Generic:** spend accounting.

---

*Every hotspot above is answered in [`DOMAIN.md`](DOMAIN.md) or recorded as an explicit
assumption in [`DECISIONS.md`](DECISIONS.md).*
