# Decisions & Assumptions

The pipeline was designed without direct access to the people who would use it. Every gap below is
a question that would have been asked, the answer the build proceeded on, what that answer changed,
and what to watch after it ships to know if it was wrong.

These are decisions, not hedges. Where the problem statement gave evidence (the abandoned dashboard, the
`IMG_43xx.jpg` scar, "don't burn our budget"), I let the evidence pick the answer. Where it didn't,
I picked the answer that keeps the Content Lead's job smaller.

Cross-references: `DOMAIN.md` (the model these shaped), `SCOPE.md` (the scope cut).

---

## Part A — Assumptions that shaped what's IN

### A1. The unit of approval is the *direction*; Finals auto-publish (revised Wave 9)

**Q:** "Done = 2–3 approved images." Does the Content Lead approve the concept once, or every image?

**Proceeded on (revised):** One tap approves the **draft direction** (cheap, one image). The Finals
that follow are generated and published **automatically** — every successfully generated Final is
auto-approved and auto-published under its deterministic filename. There is no second per-image tap
and no Keep/pick UI. the Content Lead's Draft tap is the *only* approval in the system.

**Why this and not per-final approval:** per-final approval on a phone means she's judging every
expensive image cold, and the budget worry is answered only if she actually vetoes. The draft gate
already captures her one binding call ("this direction is worth Finals spend"); once she's said yes,
the 2 Finals are a deterministic hand-off, not a second decision.

**Changed:** `ShotRequest` has `approved` and `finalizing` states; `DraftApproved` is the **only**
transition that authorises Finals spend. `finalizing → done` needs ≥2 auto-published Finals; exactly
one completed Final is `parked` as *partially done*, never `done`. Auto-publish records `pick`
Decisions with `actor: "system"` (pipeline bookkeeping, not a second approver).

**What the deferral costs, named:** a second gate is *manual work* — a second round of judgement
for the person who has "half of everything else to do" — and the calm, one-tap UX is the reason
this gets adopted where a dashboard didn't. So the integrity of everything published now rests on
one assumption: **the Content Lead rejects the directions that aren't right.** If she approves loosely, wrong
Finals ship, and nothing downstream catches it. I'd rather state that plainly than pretend the
auto-publish is free.

**Watch after ship:** if Finals keep coming back wrong, the draft gate (or the prompt) is the lever
— reintroduce a finals review only if draft approval proves insufficient.

---

### A2. Only the Content Lead's tap is binding; everyone else's is ignored

**Q:** The Approve/Reject buttons sit in a shared channel. Is a tap by the Storefront Publisher the decision?
Restrict to the Content Lead, or record who tapped and let the channel self-police?

**Proceeded on:** Only the Content Lead's tap moves a request. A configured Slack user ID is the single
binding actor. Anyone else's tap does nothing.

**Why:** "Her pick is the decision; there's no other approval step" is verbatim. Self-policing is
how the current process already fails — the 👍 nobody wrote down was the whole channel "deciding."
One binding actor is the point of the product.

**Changed:** `Decision` carries an `actor`; a binding-actor check gates every lifecycle transition.

**Cut from this:** recording non-binding taps as `NonBindingTapRecorded` and replying in-thread
("noted — waiting on the Content Lead"). It's courtesy, not the rule. Cost: someone else's tap is silently
inert rather than acknowledged — a mild confusion the first time it happens, cheap to add later.

**Demo override (`OPEN_APPROVAL`):** this env flag **defaults to `true`**, so a deployed
instance is open — anyone with the workspace invite can tap Approve/Reject and their own Slack id
is recorded as the `actor`. It lifts the gate on F3a's Approve/Reject only; every other invariant
(two-stage spend gate, `done` = ≥2 published Finals) is unchanged, and an empty actor id is still
never binding. Set the flag to `false` and A2 holds exactly as stated above — that is the design I
would ship to this team, since *"her pick is the decision"* is what keeps published output honest;
open approval is a demo convenience, not the recommended posture.

**Watch after ship:** if people tap and are confused nothing happened, add the in-thread ack. If
The Content Lead is a bottleneck when she's away, that's a *delegation* feature (a named backup approver), not
channel self-policing.

---

### A3. The pipeline hands back stable URLs and filenames; it does not touch Drive

**Q:** The wrong-`IMG_43xx.jpg` incident is a real scar. Does the pipeline own the Drive folder, or
just hand back stable names?

**Proceeded on:** Hand back. Every published image gets a deterministic name
(`hg-002-styled-01.jpg` — SKU + sequence) and a stable public URL from the pipeline's own object
store. The pipeline never writes to the team's Drive.

**Why:** Drive write access is an OAuth scope, a consent screen, and a "which folder?" conversation
— install-shaped, for a team whose one hard constraint is "don't install anything new." The scar
isn't caused by *where* the file lives; it's caused by the filename not answering "is this final?"
A deterministic name fixes that wherever the file sits.

**Changed:** `PublishedImage` holds a URL from our store. The published Finals render in the SKU's
thread and the batch-completion CSV's `Final Image URL` column carries them for the Storefront Publisher to
place. No Drive integration in the codebase.

**Watch after ship:** if the Storefront Publisher keeps a Drive folder as their working set anyway, offer a
one-way "copy finals to Drive" button — still no live sync, still their folder.

---

### A4. `Notes` feeds generation — but only two of its five jobs

**Q:** `"smoke glass photographs badly"` is expert guidance worth thousands. `"plant not included
lol"` and `"discontinued after spring?"` are not. Does the column feed the prompt?

**Proceeded on:** Classify the raw string into five intents — `priority`, `generationRisk[]`,
`sourceAssetQuality`, `lifecycleConcern`, `bundlingIntent`. Only `priority` (orders the queue) and
`generationRisk` (enters the prompt as a caution) are trusted to act. `sourceAssetQuality` raises a
warning on the review post. `lifecycleConcern` and `bundlingIntent` are flagged for a human and
**never auto-acted**.

**Why:** the column is the richest signal in the file and the biggest junk risk, and those two
facts are true of *different substrings*. A blanket "trust it" puts "plant not included lol" in a
generation prompt; a blanket "ignore it" throws away "came out too shiny in last shoot." The split
is where the value is.

**Changed:** adds a `NotesInterpretation` value object and four flag events
(`GenerationRiskFlagged`, `RequestPrioritized`, `LifecycleConcernFlagged`, `BundlingIntentFlagged`).
Bundling is explicitly out of scope (A9).

**Watch after ship:** classification errors in either direction. A `generationRisk` that's actually
a joke poisons a prompt; a `lifecycleConcern` misread as risk is harmless. Tune toward
false-negatives on `generationRisk` — when unsure, flag for a human, don't feed the prompt.

---

### A5. Blank rows get a proposed Shot Idea, co-posted with the ask

**Q:** 24 of 40 rows are blank and the drop will be mostly blank. Does the system propose an idea
from category + colour + material, or stay strictly request-driven?

**Proceeded on:** Propose. For a blank row, the bot posts to the channel: *"HG-014, Sage linen
napkins — no shot idea yet. Reply with one, or use this: 'folded on a sunlit oak table, soft
morning shadows.'"* The ask and the proposal are one message. No timer.

**Why:** strictly request-driven means the drop stalls on 24 rows nobody writes up — which is
exactly today's failure, automated. A timer ("propose after N days of silence") is a parameter to
tune and get wrong. Co-posting makes the proposal free to ignore: it's text, rejecting it costs
nothing, and a better idea in the reply wins.

**Changed:** `ShotIdeaRequested` and `ShotIdeaProposed` fire together for a blank row. A human
reply mints `ShotIdeaSupplied`; an edit of the proposal mints `ShotIdeaEdited`; the edited or
supplied text is the idea. The proposal is generated from category + `ColorSet` + material + any
`generationRisk` from `Notes`.

**Watch after ship:** if proposals are accepted unedited at a high rate, they're good enough to
skip the ask for low-priority rows. If they're always rewritten, the proposal is noise — drop it
back to a bare ask.

---

### A6. The Content Lead receives from a pipeline; she doesn't command a bot

**Q:** Who triggers a run — a Slack command from the Content Lead, an upload, or a scheduled batch? This
decides whether the product is a bot she talks to or a pipeline she receives from.

**Proceeded on:** Receives from. The CSV import is the only entry point. From there the pipeline
opens requests, composes prompts, generates drafts, and posts them. the Content Lead only ever taps buttons
and reads the live batch status message in the thread. There is no slash-command surface.

**Why:** "It has to work from my phone and I don't want to install anything new" plus "half of
everything else to do" describes someone who will tap a button but will not learn a command
grammar. A bot she has to drive is a smaller dashboard.

**Changed:** no `/shot` command parser in scope. `CatalogExportReceived` (a CSV dropped in the
channel, or uploaded to a small web endpoint) drives everything downstream.

**Watch after ship:** if she asks "can you just re-run HG-002" in the channel, add a single
reply-to-post `retry` affordance — not a command language, one more button.

---

### A7. Finals live in the SKU's thread reply, never the channel root

**Q:** Where does the "done — published" message go?

**Proceeded on:** Everything about a SKU's finals — the auto-published images, the done/parked/failed
outcome, the hyperlinked filenames — is edited in place in that SKU's one living thread reply under
its batch status post. The main channel only carries the import summary, one batch status post per
drop (edited in place), the completion CSV upload, and the Brand Owner's stale-escalation mentions.

**Changed:** `SlackGateway.postFinalsPublished` is a post-OR-update into the thread (like the ask and
draft stages); `SkuThreadPost.stage` gains `"published"`. No per-request message ever posts to the
channel root.

---

### A8. Rejected / needs-more products return in the next batch

**Q:** When a product's Finals are rejected, or more/different images are wanted, what happens?

**Proceeded on:** Nothing regenerates in place. A product whose Request ends `parked` or `failed`
(draft rejected twice, generation failed, partial Finals) is handed back by re-listing it in the next
CSV drop — `ingestCatalog` re-opens it as a fresh `ideaRevision` (even with the same Shot Idea). An
already-`done` product that needs more variations is likewise re-listed as a new ask in a future batch.

**Changed:** `ingestCatalog` re-opens SKUs whose prior Requests are all terminal-but-not-done;
`ideaRevision` increments so the deterministic per-Request filename sequence restarts cleanly (a
next-batch re-publish overwrites the same stable URL's bytes).

---

### A9. The web designer is handed the batch CSV after generation

**Q:** What does the Storefront Publisher receive?

**Proceeded on:** The batch-completion CSV — original catalog columns + `Status` + `Final Image URL` —
is the hand-off artifact. It is generated and posted to the channel root exactly once per batch, only
after every row is terminal; its `Final Image URL` column carries the published stable URLs.

---

### A10. Generation is throttled and priority-first to respect Luma rate limits

**Q:** Luma rate-limits concurrent/RPM. How do we not burst the queue?

**Proceeded on:** A global in-flight budget (`MAX_IN_FLIGHT_GENERATIONS`, default 4) plus per-tick
caps (`MAX_DRAFTS_PER_TICK`, `MAX_FINALS_STARTS_PER_TICK`) queue work rather than burst it. All start
sweeps walk `priorityRank` desc → `createdAt` asc, so notes-derived priority gets first claim on the
budget at every stage (drafts, retries, finals).

**Changed:** the caps moved from constants to config; `startConfirmedDrafts` / `startRetryDrafts` /
`startApprovedFinals` consult the shared budget before each `create`.

---

### A11. Slack because it installs nothing — and threads because the channel must stay clean

**Q:** Slack, email, a web app, or a purpose-built tool? And once it's Slack, how do forty products
not become forty notifications?

**Proceeded on:** Slack, and *all* per-request work inside a thread. The choice isn't only "that's
where the conversation already happens" — it's that Slack is the only surface that costs this team
**no new install and no new account**, which is the Content Lead's one stated hard constraint, and it makes the
whole workflow portable: a bot token drops it into any workspace with zero per-user onboarding.

**Changed:** one live batch status message per import in the channel root; every ask, proposal,
Draft, decision, and published Final is edited in place into that SKU's single living thread reply
(ADR 0019). The channel root carries only the import summary, the batch status post, the completion
CSV, and the Brand Owner's escalations. Forty products land as one message.

**Watch after ship:** whether the thread itself gets long enough to be unusable at 40 SKUs. If so,
the fix is pacing/priority drip-feed inside the thread, not a new surface.

---

### A12. Published images live in Cloudflare R2 because the web designer can serve the site from it

**Q:** Where do finished images live — the app's disk, Drive, or an object store?

**Proceeded on:** Cloudflare R2, public stable URLs (ADR 0017). The deciding reason is not storage
cost: **it's a place the Storefront Publisher can point product pages at directly.** The same URL Slack
unfurls in the thread is a URL the site can use, and the same object is reachable from any future
MCP tool or UI without going through this service. One artifact, three consumers, no copy step —
and no "which Drive folder?" conversation (A3).

**Changed:** a second `ImageStore` adapter behind the existing port; local dev and tests stay on the
volume. Free egress and an S3-compatible API made it a swap, not a redesign.

**Watch after ship:** the `pub-*.r2.dev` development domain is rate-limited; objects are written
immutable-cached to stay under it, and the production fix is a custom domain — a config change
(ADR 0017).

---

### A13. No external agents in the loop — deliberately, and temporarily

**Q:** Should `Notes` classification, Shot Idea proposals, and prompt composition call a model?

**Proceeded on:** No. Classification is rule-based (ADR 0010), proposals are composed from category
+ colour + material + risk flags, prompts are templated. Nothing in the decision path is
non-deterministic.

**Why:** for a one-day build with a spend constraint, deterministic logic is testable, cheap, and
fails legibly — and every one of these is a place where a bad model output would silently degrade an
expensive generation.

**Cost:** proposals and prompts are generic where a model would be specific. This is the single
biggest quality upgrade available, and it's #1 in `DESIGN.md`'s *Next*: agents that compose a
Final *for the product*, style palettes as reusable skills, and feedback history feeding both.

---

### A14. Escalation moves the work without the Brand Owner being able to approve

**Q:**The Content Lead is the only binding actor (A2). What happens when she doesn't tap?

**Proceeded on:** After the stale threshold, the bot @-mentions the Brand Owner in the channel. the Brand Owner still
cannot approve — that would re-create the channel self-policing that broke the old process — but she
gets visibility and a reason to nudge, so the pipeline moves forward without her being *in* it.
Combined with the live batch status post, that is the Brand Owner's verbatim ask answered without asking the Content Lead.

**Watch after ship:** if escalations are frequent, the answer is a named backup approver (one config
field), not giving the Brand Owner the button.

---

### A15. Messages and images persist in place; nobody should have to open a URL

**Q:** Does the bot link to results, or render them?

**Proceeded on:** Render, in place. Drafts and published Finals appear as image blocks inside the
SKU's thread reply, with filenames hyperlinked to their stable URLs, and the message is *edited*
rather than re-posted as the request moves through its stages. the Content Lead decides from what's already on
her phone screen; the Storefront Publisher copies a link that's already in front of them.

**Changed:** every stage of `SkuThreadPost` is post-or-update; `postFinalsPublished` carries one
image block per published Final plus the hyperlinked headline.

---

## Part B — Assumptions behind what's OUT

Each of these was in an earlier draft of `DOMAIN.md`; the scope pass cut it because it
scored 1 on user-outcome contribution — it doesn't move the Content Lead's tap, the Brand Owner's answer, or the Storefront Publisher's file this quarter. Two of them (B1, B2) reverse a call marked **[decided]** during domain
modeling. I'm flagging that rather than burying it.

### B1. Palette adherence check — **CUT** (reverses a [decided] call)

**Q:** Terracotta going ochre in a warm-light render is a silent brand failure only the Content Lead's eye
catches — and she's approving on a phone. Is palette adherence an automated check, or trusted to
the model?

**Originally decided:** an automated `PaletteCheck` — sample the product region, compare to the
declared `ColorSet`, annotate the review post with "⚠ colour may be off." Non-blocking.

**Cut because:** it's non-blocking by design, so the Content Lead's decision is *identical* whether the
annotation is there or not — she looks at the image and taps. The check is real engineering
(region sampling, ΔE thresholds, tuning against actual Luma output) for an output that changes no
behaviour. It's the most *differentiated* idea in the model and the least *load-bearing*.

**Cost of cutting:** a render where the product colour drifted ships if the Content Lead's phone screen
doesn't catch it. Mitigation: the brand palette is in the prompt as an explicit constraint, and
the draft gate means she sees every direction before finals spend.

**What would bring it back:** evidence that colour drift is actually getting through — a couple of
"wait, that's not Sage" moments post-launch. Then it's worth building, and worth making *blocking*
for finals, not just an annotation.

### B2. Superseding idea revisions on re-import — **CUT** (reverses a [decided] call)

**Q:** New export, same SKU, different Shot Idea text, and the old request is already `done`. Does
the request re-open, does a second request exist, or does the old one win?

**Originally decided:** the new text mints the next idea revision and opens a *superseding*
`ShotRequest`; the prior `done` request is immutable history.

**Cut because:** it fires only in a narrow case — a re-import that *changes* idea text on an
*already-done* SKU. The drop next month is new SKUs, not re-imports of finished ones. Building the
revision-supersession machinery now is paying for a scenario that isn't in the demo and is rare in
month one.

**Cost of cutting:** a re-import with changed idea text on a known SKU raises
`NewIdeaRevisionDetected` and is **named in the import summary** — then does nothing. A human sees
"HG-002's idea changed since it was completed" and decides. `ShotRequest` identity stays *SKU +
idea revision* (that costs nothing), so the machinery can be added later without a migration.

**What would bring it back:** the first time someone actually wants a done SKU re-shot with a new
idea and is annoyed they have to ask a human.

### B3. Spend ceiling with pipeline pause — **CUT**

**Q:** One retry per rejection is bounded per request, but 40 products × drafts × retries needs a
channel-wide stop. What does the system do at the cap mid-batch — pause and ask, or halt?

**Originally assumed:** `SpendLedger` becomes an aggregate with a ceiling invariant;
`SpendCeilingReached` → `PipelinePaused` → the digest asks the Brand Owner to raise the cap or stop.

**Cut because:** the two-stage spend gate is the *real* budget control. Nothing generates finals
without the Content Lead's tap, and drafts are cheap. At 40 products the worst case is 40 + retries cheap
draft generations — a bounded, known, small number. A ceiling guards a runaway that this scale
can't produce.

**Cost of cutting:** no hard stop, **and no place the running total surfaces** — the digest that
would have shown it is also cut. Every generation attempt logs a cents estimate to the DB, so the
total is *derivable*, but nothing renders it. This is the compound cut named in `DESIGN.md`'s
scope ledger and *What breaks first* #2, and it's why the digest (with a running spend total) is
#5 in *Next*.

**What would bring it back:** the 300-product catalog. At 10× scale the draft-generation floor
alone is worth capping, and the pause-and-ask flow becomes worth its complexity.

### B4. Updated CSV export — **CUT, then reversed and shipped**

**Q:** Given status now ships via Slack, is the updated CSV still worth producing for the Storefront Publisher, who works from files?

**Originally assumed:** yes, secondary — the catalog CSV back out with a `status` column and final
image URLs.

**Cut because (at the time):**The Storefront Publisher's *only* question is "which file is final?", and the
answer is two things they already have — a deterministic filename (`hg-002-styled-01.jpg`) and a
stable URL. A CSV was judged a third status surface that has to stay consistent with the lifecycle
state — a sync liability for zero new information. (This was weighed against a then-planned digest,
which was itself cut later; F7's live batch status message is what carries in-flight status now.)

**Cost of cutting:** without the export, in-flight status lives only in the batch status message.
A CSV endpoint would have been an afternoon.

**What brought it back (Wave 7, ADR 0019):** the team asked for it, and the objection turned out
not to apply to the shape they wanted. The sync liability was the whole argument against a CSV —
and a file generated **once**, after every row in a batch is terminal, and never updated again has
no sync liability. It is an artifact, not a surface. It ships as the batch-completion CSV (A9):
original columns + `Status` + `Final Image URL`, posted to the channel root once per drop, so every
stakeholder has the whole drop in one document alongside the published URLs. Still no write-back to
The Brand Owner's sheet, still no live sync.

### B5. Non-binding tap recording — **CUT**

Covered under A2. The enforceable rule is the binding-actor check; recording other people's taps
and replying in-thread is manners, not mechanism.

---

## Part C — Operational parameters I picked with no evidence

Small numbers the problem statement doesn't specify. Each is a config value, not a hardcoded belief — easy to
change once real usage exists.

| Parameter | Picked | Reasoning | Watch |
|---|---|---|---|
| **Stale threshold (N days)** | **3 calendar days** un-tapped → `@the Brand Owner` in channel | Long enough that a busy weekend doesn't trip it; short enough that the drop doesn't rot. One escalation, not a nagging series. | If the Brand Owner gets pinged constantly, raise to 5. If drafts sit 6+ days pre-escalation, lower to 2. |
| **Status cadence** | **One live batch status message per import**, edited in place as the run progresses (F7, ADR 0019); the batch-completion CSV posts once when every row is terminal. No scheduled digest — that was cut (Part B / `DESIGN.md` scope ledger); the cross-batch, running-spend view is what's still unserved. | the Brand Owner wants to "see where things stand" — the live message answers it for the current drop without anyone asking. A standing digest is a surface to maintain; the live message is inert once the batch finishes. | If the Brand Owner asks for state *between* batches or wants the spend total, that's the digest — #5 in `DESIGN.md`'s *Next*, ~half a day. |
| **Finals generated per direction** | **2** (`FINALS_PER_DIRECTION`, shipped default) | "2–3 approved images" — generate 2 and auto-publish both; the Draft gate already captured her call, so there is nothing to discard. | If she keeps rejecting the Draft, the direction gate is underspecifying. If she wants a 3rd variation, that product returns in the next batch (A8). |
| **Draft = 1 image, low settings; finals = 2, full quality** | — | The whole cost thesis: a rejected direction costs one cheap generation, not a draft plus two full-quality finals. | Track draft→finals agreement rate; if low, the draft isn't representative enough to gate on. |
| **Image hosting** | Pipeline's own object store, public stable URLs | A3 — no Drive writes. URLs must outlive the pipeline process, so object storage, not local disk. | If URLs need auth (private product staging), add signed URLs. |
| **Per-image cost** | A configured cents constant per generation kind (`DRAFT_COST_CENTS=5`, `FINAL_COST_CENTS=11`), logged on every attempt (success *or* failure) | The Luma API doesn't hand back billing synchronously; a constant is close enough for the batch total and the unit-economics math. | Reconcile the constant against real Luma credit burn weekly; adjust. |
| **Generation input** | The one white-background photo per product, image-to-image | It's the only asset every product has. The problem statement says so. | If a `Photo` URL 404s or is flagged `sourceAssetQuality`, raise `GenerationFailed` with a clear reason rather than generating from nothing. |
| **Retry (rejection)** | Exactly one per rejection, prompt conditioned on the reject reason chip | "Wrong vibe / colour off / too staged / other" is the signal we refused to spend money guessing at — so spend the one retry *using* it. Two rejections → `parked`. | If retries rarely succeed, the reason chips aren't actionable enough — add a free-text reason. |
| **Retry (Luma transient error)** | Up to 5 retries on a 429 / 502 / 503, exponential `1s·2ⁿ` capped at 30s, +0–1s jitter, honouring `Retry-After` / `X-RateLimit-Reset`. Inside the adapter; `create` doesn't retry a *thrown* error (double-spend), `get` does. `LUMA_MAX_RETRIES=0` disables. (ADR 0016) | The first live run hit a permanent 429 stall — no delay anywhere in the 3s tick loop, so a transient throttle re-fired forever and fed itself. Luma's docs prescribe exactly this backoff. | If ticks routinely run long on backoff, lower `LUMA_MAX_RETRIES` or raise `MAX_*_PER_TICK` spacing. If 429s persist past 5 retries, the account RPM/concurrency ceiling is genuinely too low — throttle `create`s per tick. |
| **Slack surface** | One shared channel; the app posts there; the Content Lead is one configured user ID | Matches "the conversation already happens there." Multi-channel routing is scope the team doesn't have. | If the channel gets noisy, a dedicated `#shots` channel — still one channel. |

---

## The assumption underneath all of them: what this build is for

This is a foundation sized for a catalog in the low hundreds, and half its job is to **generate the
data nobody has yet.** Every approve, every reject-reason chip, every edited proposal is a labelled
example of this brand's taste, written to the DB from day one. At 300+ products that history is what
makes the system viable: it's what lets proposals and prompts get specific, and eventually what lets
the Draft phase run itself for directions the system is confident about.

One thing that must not change as it scales: **Finals stay auto-generated.** A design where a human
adjudicates each Final has a per-product human cost that multiplies by catalog size and stops being
operable well before 300. The direction is the one place human attention is spent, because it's the
one place it can't be replaced yet.

---

## The three questions I'd still ask, given ten minutes with the team

1. **the Content Lead:** When you rejected a shot in the past — "no, too staged" — did you ever want to say
   *why* in more detail, or is a four-way chip enough? (Decides whether retry needs free text.)
2. **the Brand Owner:** What's the freelance photographer's cost per usable shot, in dollars and in
   turnaround days? (That's the number the unit economics has to beat, and it's the real kill
   signal — see `SCOPE.md`.)
3. **The Storefront Publisher:** When you ship a product page, are you uploading a file or pasting a URL?
   (Decides whether B4 — the CSV export — was actually the right cut.)
