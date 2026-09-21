# Design

**Backdrop** — a Slack-native pipeline that turns a brand's spreadsheet Shot Ideas into approved,
published styled photos, with every dollar of generation spend gated by one tap on the approver's
phone.

> **Status — shipped.** All six features (F1–F4, F7) are built, tested (`npm test` → 445 passing,
> 42 files), and deploy-ready (Docker + Railway). The design chain —
> `PRODUCT.md` → `DISCOVERY.md` → `DOMAIN.md` → `SCOPE.md` → `DECISIONS.md` → `SPEC.md` → build —
> is complete. Two figures below stay marked `[POST-BUILD]` rather than guessed — measured
> generation latency and the per-generation cost constant reconciled against real credit burn —
> because both need production run-data this pre-production build hasn't accumulated; the dollar
> cost is given as a sensitivity range instead.

This document covers what was built and why: the load-bearing decisions, the tradeoffs each one
makes, the scope ledger, the unit economics, and what breaks first.

### Starting the workflow in Slack

1. **Open the one channel the bot runs in.** Every status message, ask, draft, and published final
   for every batch lands there — there is no other surface and no slash command. The bot runs in
   **exactly one channel**, fixed at deploy time by `SLACK_CHANNEL_ID`. `file_shared` and
   block-action events from any other channel it is invited to are dropped
   ([slack-events.ts](../src/runtime/slack-events.ts) —
   `if (event.channel_id !== config.slack.channelId) return`), and the one Slack gateway only ever
   posts to that channel. Retargeting means changing the variable and redeploying; it cannot serve
   two channels at once.
2. **Kick off a batch:** drag a catalog CSV into that channel — `test/fixtures/catalog.sample.csv` is a sample, or any
   same-column export (SKU, name, colour, price, photo URL, Shot Idea, Notes). Ingest fires on
   Slack's `file_shared` event; nothing else is needed. Within seconds one **batch status message**
   posts to the channel root — one line per SKU with its state — and stays live, editing itself in
   place as the run progresses.
3. **Answer the blank rows:** every SKU with no Shot Idea gets a reply threaded under that message —
   *"no shot idea yet"* with **Accept proposal** and **Edit** buttons (Edit opens a modal). Plain-text
   replies are intentionally ignored (ADR 0019) — one shared thread can't tell which SKU a loose
   reply is about, so blank-row capture is buttons-only.
4. **Approve the draft:** each SKU generates one cheap Draft, posted as an image block in its thread
   with **Approve** / **Reject** (Reject asks for a one-tap reason chip — wrong vibe / colour off /
   too staged). **`OPEN_APPROVAL` defaults to `true`, so any member's tap counts** — approve
   and reject the drafts yourself; your own Slack id is recorded as the actor. Setting the flag to
   `false` restores the shipped design where only the configured approver (`APPROVER_SLACK_USER_ID`) is
   binding — decision 3 below.
5. **Done takes care of itself:** Approve authorises exactly the 2 Finals, which auto-generate,
   auto-publish under deterministic names (`hg-002-styled-01.jpg`) at stable URLs, and post back
   into the same thread. ≥2 published Finals flips the SKU to `done`. When every row is terminal,
   the completion CSV (`Status` + `Final Image URL` columns added) is posted to the channel root.

Everything for one import lives under its one status message — forty products arrive as one thread,
not forty notifications.

---

## What I'm building, and why

The problem statement describes three broken jobs. They are one root cause with three symptoms:

| Who | Job failing | Symptom |
|---|---|---|
| **the Content Lead** | Turn a wishlist into approved images without becoming a full-time reviewer | Reconstructs the wishlist by hand 2–3× a year |
| **the Brand Owner** | See where things stand without asking the Content Lead | No status exists to see |
| **Storefront Publisher** | Ship the *right* file | Shipped the wrong `IMG_43xx.jpg`; live for three weeks |

**The decision is never written down.**The Content Lead *does* decide — "that one," "no, too staged" — but the
decision lands in a Slack thread or an email reply, so it isn't status, isn't a spend
authorisation, and isn't a filename.

So the product is not an image generator. It's a **decision recorder that happens to generate
images**. The whole design collapses to one moment:

> A draft lands on the Content Lead's phone in Slack. She taps Approve without leaving the conversation.
> Minutes later two files exist named `hg-002-styled-01.jpg` and `hg-002-styled-02.jpg` — approved,
> stable-URL'd, and countable as done.

That one tap does four jobs at once: approves the direction, authorises finals spend, writes the
status down, and names the file. Everything in scope exists to make that tap possible, cheap, and
consequential. Anything that doesn't serve the tap is scaffolding, and scaffolding got cut first.

**Why Slack and not a UI of our own:** this is the one decision the problem statement already made for me, with
evidence rather than preference. They trialed a creative-automation tool with a beautiful dashboard;
nobody logged in after week one. the Content Lead's constraint is verbatim: *"it has to work from my phone, and
I don't want to install anything new."* Any design that asks her to go somewhere new to record
something she is already deciding loses to the status quo — because the status quo costs her
nothing. Slack buttons are the only surface where the tool is *cheaper* than the current process.

**Five specified features** (`SPEC.md`, 19 Given/When/Then scenarios) plus **F7**, a scoped
exception added after the spec gate at the team's request (ADR 0019):

| # | Feature | Serves |
|---|---|---|
| F1 | Catalog intake — idempotent, `$48`→cents, multi-word ColorSet, SKU gaps, Notes priority, import summary | The drop |
| F2 | Request capture — Shot Idea found / asked / proposed / edited / confirmed | The 24 blank rows |
| **F3a** | **Draft generation & review loop** ⭐ | **The value moment** |
| F3b | Retry & stale escalation | The reject button; the kill signal |
| F4 | Finals & publish — 2 finals auto-publish = Done, deterministic filename + stable URL | *Done*; the `IMG_43xx` scar |
| F7 | Batch status post & threaded review — one live message per import, all review in its thread, completion CSV | the Brand Owner's "where do things stand"; a clutter-free channel |

Demoable spine: **F1 → F3a → F4**, all of it inside F7's one message and thread.

---

## Key decisions and tradeoffs

Eleven decisions did most of the work. Full reasoning, plus what I'd watch after ship, in
`DECISIONS.md`; the engineering choices underneath them are in `docs/adr/`.

### 1. Two-stage spend gate: one cheap draft, then finals

One low-cost draft goes to the Content Lead first. Only `DraftApproved` authorises the 2 full-quality finals.
This is structural, not advisory — it is an invariant on the aggregate, and `SPEC.md` asserts it
from both sides (a rejection writes no finals-spend entry; a Request with no `DraftApproved`
generates no finals).

This is the direct answer to *"don't burn our budget on stuff she'll reject."* A rejected direction
costs one cheap draft instead of a draft plus two full-quality finals.

> **Trades away: wall-clock latency.** The draft gate sits on the critical path — nothing publishes
> until the Content Lead taps, and a rejection adds a second wait for the retry draft. The gate that saves
> dollars is the gate that sets time-to-published. I think that's the right trade for a team whose
> founder raised cost unprompted — but it is a real cost, and it's the first thing I'd revisit if
> drafts get approved at a very high rate (then the draft gate is theatre and should collapse to
> auto-publish-on-direction).

### 2. The unit of approval is the *direction* — and only the direction

The Content Lead taps once, on the cheap Draft. Every Final that generates successfully is auto-approved and
auto-published (ADR 0020). **A second gate on the Finals was designed, built as a Keep/pick UI, and
then deliberately retired.**

Why it was deferred: a Finals gate is a second round of manual work for the one person who has
"half of everything else to do", and it buys very little. the Content Lead has already made the binding call —
*this direction is worth spending on* — and that judgment is exactly what the Finals are generated
from. Making her come back and adjudicate 2 more images per SKU turns a glance into a chore, which
is how the last tool died. One tap keeps the UX calm while keeping her in control of the only
decision that costs money.

It rests on an assumption I'm naming rather than hiding: **the Content Lead rejects the directions that
aren't right.** The integrity of what gets published is entirely carried by the Draft gate. If she
approves loosely, wrong Finals ship.

`done` requires **≥2 auto-published images**. Exactly one completed Final is `parked` as *partially
done*, never `done` — the team's own definition of Done, mechanically enforced for the first time.

> **Trades away: no in-place veto on a Final.** A Final that comes out wrong can't be killed on the
> spot; the product returns in the next batch (decision 7). The lever for quality is the Draft gate
> and the prompt, not a second review. If Finals start coming back wrong at a rate that annoys her,
> that is the evidence that brings a Finals gate back — see *Next*.

### 3. Only the Content Lead's tap is binding

The buttons sit in a shared channel. A configured Slack user ID is the single binding actor; anyone
else's tap does nothing. *"Her pick is the decision; there's no other approval step"* is verbatim,
and channel self-policing is how the current process already fails — the 👍 nobody wrote down was
the whole channel "deciding."

> **Trades away: a bus factor of one.**The Content Lead on vacation halts the pipeline. Escalation @-mentions
> the Brand Owner, but the Brand Owner can't tap. See *What breaks first*.

> **Demo override.** What is described above is the shipped design, but it ships behind
> `OPEN_APPROVAL`, which **defaults to `true`** so a deployed instance is open — any channel
> member can tap and their own Slack id is recorded as the actor on the Decision. Set the flag to
> `false` and this section is exactly the behaviour. It's a single config boolean (`src/config.ts`,
> `slack.openApproval`); the domain functions (`approveDraft` / `rejectDraft`) keep their
> `NonBindingActor` guard, and the use-case just passes the tapper as the binding actor when the
> flag is on. Nothing else in the pipeline changes, and an empty actor id is never binding either
> way. Shipping it open is a deliberate demo choice — I'd flip the default before this served a real
> team, because *"her pick is the decision"* is load-bearing (see the integrity note in decision 2).

### 4. Blank rows get a proposed Shot Idea, co-posted with the ask

24 of 40 rows are blank, and the drop will be mostly blank. Strictly request-driven means the drop
stalls on rows nobody writes up — today's failure, automated. The bot posts the ask and a proposal
as **one message**: *"no shot idea yet. Reply with one, or use this: …"*

No timer to tune. The proposal is text, so rejecting it costs nothing, and a better idea in the
reply wins.

### 5. `Notes` feeds generation — but only two of its five jobs

`Notes` is a junk drawer doing five jobs and is simultaneously the richest signal in the file.
`"smoke glass photographs badly, careful"` is expert guidance worth thousands; `"plant not included
lol"` is not — and those are different substrings, which is why blanket trust and blanket ignore are
both wrong.

Classified into five intents. Only `priority` (queue order) and `generationRisk` (prompt caution)
act. `sourceAssetQuality` warns. `lifecycleConcern` and `bundlingIntent` flag for a human and
**never auto-act**.

### 6. Deterministic filenames + stable URLs; no Drive writes

Every published image gets `hg-002-styled-01.jpg` and a stable URL from our own store. The pipeline
never writes to the team's Drive.

Drive write access is an OAuth scope, a consent screen, and a "which folder?" conversation —
install-shaped, for a team whose one hard constraint is *don't install anything new*. And the scar
isn't caused by *where* the file lives; it's caused by the filename not answering "is this final?"
A deterministic name fixes that wherever the file sits.

### 7. Rejected and failed products come back in the *next* batch, not in place

There is no regenerate-here button. A Request that ends `parked` (Draft rejected twice, or exactly
one Final landed) or `failed` (generation errored) is handed back by simply being re-listed in the
next CSV drop — `ingestCatalog` re-opens it as a fresh idea revision (ADR 0020).

Why: it keeps one queue, one artifact of record (the CSV), and one mental model — *what's in the
sheet is what's being worked on.* No per-request retry state machine, no "is this the old run or
the new one?" ambiguity in the thread, and the filename sequence restarts cleanly.

> **Trades away: turnaround on the products that most deserve it.** A `Notes`-flagged bestseller
> that fails is treated exactly like a low-priority napkin — it waits for the next drop. That's a
> real cost and I took it deliberately: the alternative is a partially-approved catalog trickling
> onto the website. Only what cleared the gate gets published; everything else waits and is
> re-run as a batch, or re-listed on its own if someone is in a hurry.

### 8. Slack, and *only* threads inside Slack

Slack isn't just "where they are" — it's the only surface that requires **no new install and no new
account**, which is the Content Lead's one hard constraint, and it's portable: the same workflow drops into
any workspace with a bot token, no per-user onboarding.

Inside Slack, the discipline that makes it survivable is that **all work happens in a thread.** The
channel root carries only the import summary, one live batch status message per drop, the
completion CSV, and the Brand Owner's stale escalations. Every ask, proposal, Draft, approve/reject, and
published Final is edited in place into that SKU's single living thread reply (ADR 0019). Forty
products land as *one* message, not forty. The channel stays readable; the work stays findable.

The completion CSV is deliberate redundancy: images are already published at stable URLs, but the
CSV gives every stakeholder the whole drop — SKU, status, final URL — in one document they can open
in the tool they already use.

### 9. Cloudflare R2 for published images, chosen for the Storefront Publisher

Published images live in an R2 bucket at stable public URLs (ADR 0017), not on the app's disk and
not in Drive.

The deciding reason is not storage economics — it's that **R2 is a place the web designer can serve
the site from directly.** The same URL that Slack unfurls into the thread is a URL a product page
can point at, and the same object is reachable from any future MCP tool or UI without going through
this service. One artifact, three consumers, no copy step and no "which folder?" conversation.
(Free egress and an S3-compatible API made the swap a single adapter behind the existing
`ImageStore` port.)

### 10. The Brand Owner can't approve, but the pipeline never waits on her either

A Draft left un-tapped past the stale threshold @-mentions the Brand Owner in the channel. She has no binding
button — that would re-create the channel self-policing that broke the old process — but she gets
the one thing she asked for: *seeing where things stand without asking the Content Lead*, and a reason to go
nudge. The batch status post carries the rest, live, without anyone asking anyone.

Related, and deliberate: **messages and images persist in place.** The Draft, the published Finals,
their filenames and their links are all rendered as image blocks inside the thread, edited in
place, not linked out. Nobody should have to open a URL to do their job — the Content Lead decides from what's
on her phone screen, and the Storefront Publisher copies a link that's already in front of them.

### 11. No external agents in the pipeline — for now

Everything the system "decides" is deterministic code: `Notes` classification is rule-based (ADR
0010), Shot Idea proposals are composed from category + colour + material + risk flags, and prompt
composition is a template. No LLM sits in the loop.

That was the right call for a one-day build with a spend constraint — it's testable, cheap,
debuggable, and it fails legibly. It is also the most obvious upgrade path: shot ideas that read
the brand's actual voice, prompts that adapt to the product category, and Finals composed *for the
product* rather than from one template are all agent-shaped work. See *Next*.

---

## The road not taken

**Batch contact-sheet review.** One Slack message per import carrying a grid of every draft in the
batch, with the Content Lead approving in bulk — tap the three she likes, everything else auto-parks.

This was the strongest alternative and I came close to building it, because **it is the design that
best fits the actual scale event.** The drop is 40 products landing at once. My design posts up to
40 individual review messages into one channel; the contact sheet posts *one*. It turns the Content Lead's job
from "answer 40 notifications over a week" into "spend four minutes once." Measured against the
kill signal — median time-to-tap — it very plausibly wins.

**Why I didn't build it:**

1. **It destroys the rejection reason.** Bulk review gives you "not these" with no *why*. The reason
   chip (wrong vibe / colour off / too staged) is the signal I explicitly refused to spend money
   guessing at — it's what makes the one retry worth spending, and it's the only prompt-quality
   feedback the system ever gets. A contact sheet converts a rich rejection into silence.
2. **It's a dashboard wearing a Slack costume.** A grid you scan, in bulk, on a schedule, is the
   review-session ergonomics of the tool they abandoned. The thing that makes the single-draft post
   work is that it arrives *as a message, in the conversation, one decision deep* — it costs a
   glance, not a session. Batching re-introduces the "sit down and do the images" chore that the
   current process already fails at.
3. **It optimises for a load I can't see yet.** Bulk review is the right answer *if* per-request
   review proves too noisy. I'd rather ship the high-signal version, measure time-to-tap, and add
   batching as a mode when the evidence exists — than ship the low-signal version and never learn
   why drafts get rejected.

**It is the first thing I'd build at 10× catalog** — see *Unit economics*, where human attention,
not money, becomes the binding constraint. The honest summary is that I optimised for signal quality
at 40 products and knowingly took on a channel-flood risk that batching would have solved.

*Runner-up: email-native approval* (reply to approve — zero install, matches the existing
photographer workflow). Rejected because parsing reply intent is fragile and the decision still
arrives as prose, not structure. Slack buttons are unambiguous by construction.

---

## Scope ledger

### In — and why

| Feature | Reasoning |
|---|---|
| **Draft review in Slack** (F3a) | This *is* the value moment. If it isn't three taps on a phone, the product dies in week one like the last tool. |
| **Two-stage spend gate** (F3a/F4) | the Brand Owner's budget worry, answered structurally rather than with a policy note. |
| **Idea proposal for blank rows** (F2) | 24 of 40 rows are blank; the drop is mostly blank. Without this the drop stalls. |
| **Finals auto-publish → Done** (F4) | The team's own definition of Done, mechanically checkable for the first time. |
| **Deterministic publish** (F4) | Heals the `IMG_43xx` scar. The filename answers "is this final?" without a Slack question. |
| **Prompt composition** (F3a) | The judgment step. A string copy of *"on a set dinner table, with food in it?"* generates nothing usable. |
| **Catalog import, idempotent** (F1) | Undifferentiated and load-bearing. The drop is the stated first real test, and new exports keep coming. |
| **`Notes` → priority + risk** (F1/F3a) | Richest signal in the file, nearly free to use once classified. |
| **One retry per rejection** (F3b) | Makes the reject button worth pressing, at bounded spend. |
| **Stale escalation** (F3b) | Instruments the kill signal. Without it, "she stopped tapping" is unobservable. |
| **Batch status post + threaded review** (F7, ADR 0019) | Forty products arrive as one live message, not forty notifications. Directly answers the Brand Owner, and keeps the channel clean. |
| **Batch completion CSV** (F7, ADR 0019) | One document with every row's status and final URL, in the tool the team already uses. Posted once per batch, not kept in sync. |

### Out — and what it costs

Full 10-item list in `SCOPE.md`; per-cut reasoning in `DECISIONS.md`. The cut rule was **anything
scoring 1 on user-outcome contribution** — does it move the Content Lead's tap, the Brand Owner's answer, or the Storefront Publisher's file? A low differentiation score was *not* disqualifying: CSV parsing is table stakes and
nothing exists without it.

| Cut | Reason | Cost |
|---|---|---|
| **Status digest** ⚠️ | Cut late, to hold the 5-feature cap when the review loop was split into F3a/F3b. It is a read model over data the other features already record. **Partly superseded:** F7's live batch status post now answers "where does this drop stand" — the *spend* total and the cross-batch view are still unserved. | **See below.** |
| **A second approval gate on Finals** | Retired after being built (ADR 0020). A second manual round for the one person with no time, buying only what the Draft gate already decided. | A wrong Final can't be vetoed in place; it returns in the next batch. Integrity rests on the Content Lead rejecting loose directions. |
| **External agents / LLM in the loop** | Rule-based classification and templated prompts are testable, cheap, and legible for a one-day build. | Proposals and prompts are generic where a model would be specific. #1 quality upgrade — see *Next*. |
| **Palette adherence check** | The most *differentiated* idea in the model and the least *load-bearing*: non-blocking by design, so the Content Lead's decision is identical with or without the annotation. | A Terracotta-reads-as-Ochre render ships if her phone screen misses it. Palette is still an explicit prompt constraint. |
| **Superseding idea revisions** | Fires only when a re-import changes idea text on an already-`done` SKU. The drop is new SKUs, not re-imports of finished ones. | A human reads "HG-002's idea changed since it was completed" in the import summary and decides manually. |
| **Spend ceiling + pause** | The two-stage gate is the real budget control. At 40 products the worst case is a bounded, small number of cheap drafts. | No hard stop if generation loops. |
| ~~**Updated CSV export**~~ **— reversed, shipped** | Cut as "a third status surface to keep in sync"; brought back as a **one-shot** artifact per batch (ADR 0019), which has no sync liability because it is generated once, after every row is terminal. | None. The sync risk the cut was protecting against doesn't exist for a write-once file. |
| **Non-binding tap recording** | The enforceable rule is the binding-actor check; the in-thread "noted — waiting on the Content Lead" is manners. | Someone else's tap is silently inert rather than acknowledged. |
| **Multi-product / bundled scenes** | Breaks the SKU-keyed model outright. | `BundlingIntentFlagged` records the intent; a human acts. |
| **Live Google Sheet sync** | The problem statement explicitly doesn't ask for it. | None. |
| **Drive folder write access** | Install-shaped commitment for a team that rejects those. | Images live at our stable URLs. |
| **A dashboard, of any kind** | The documented failure mode. *Exception:* F7's batch status post — one message, alive only until that import finishes, then inert. No standing surface, no login. | None. This is the point. |
| **Regenerate-in-place / retry buttons on a Final** | One queue, one artifact of record; re-listing in the next drop keeps the model simple (decision 7). | A high-priority product that fails waits for the next batch rather than jumping the queue. |

> ### ⚠️ Naming the cost of cutting the digest
>
> This is the weakest point in the scope, and it is better named here than left to be discovered.
>
> **the Brand Owner is one of three users, and her verbatim ask — *"I'd want to see where things stand without
> having to ask the Content Lead"* — is now entirely unserved by the in-scope features.** Status exists as
> data (every Request has a state, every attempt logs cents), but nothing surfaces it. The import
> summary is the only status message that ships.
>
> Worse, it compounds with an earlier cut: I cut the spend ceiling *on the grounds that* the running
> total would always be visible in the digest. Cutting both means there is no ceiling **and** no
> place the spend total surfaces. Those two cuts were individually defensible and are jointly a
> hole.
>
> It stays cut for this build because the digest is a read model over data F1–F4 already write —
> genuinely additive, not a refactor — and because with the review loop split, something had to give
> to hold the cap. **It is #1 in "what's next" and it is roughly a half-day.**

### Next — in order

1. **Agents that compose the Final *for the product*** — the biggest quality lever left. Today the
   prompt is a template; an agent that reads category, material, colour, and the risk flags (and,
   later, the brand's own approved shots) produces Finals that look made for *that* product rather
   than for a shot idea. Same for Shot Idea proposals on blank rows.
2. **Style palettes / templates as reusable skills** — a named house style ("sunlit oak, soft
   morning shadows") that generation takes hints from, so the drop looks like one campaign instead
   of forty independent renders. Also enables **regenerate with a different style** as an explicit
   action.
3. **Record the feedback we already collect** — every reject reason chip, every edited proposal, and
   every approve is a labelled example sitting in the DB. Feeding that history back is what makes
   proposals and Finals better over time; it's also what would eventually let the system *auto-run
   the Draft phase* for directions it has high confidence in.
4. **Select-and-add-to-batch** — a way to re-look at parked/failed products and pull chosen ones
   into the next batch (or run one on its own) instead of waiting for a full re-list. Removes the
   cost named in decision 7.
5. **Status digest** — counts by state, **running spend total**, named stale/parked Requests across
   batches. F7 covers the current drop; this covers the quarter and restores spend visibility.
   Half a day.
6. **A named backup approver** — one config field. Removes the bus-factor-of-one without
   reintroducing channel self-policing.
7. **Batch contact-sheet review as a mode** — once time-to-tap data exists. See *The road not taken*.
8. **Spend ceiling + pause** — at ~300 products, not before.
9. **Palette check, blocking on finals** — only if colour drift is observed getting through.

---

## Unit economics

### What one approved image costs in dollars

Cost per *published* image, not per generation — a rejected direction and a parked Request are both
real costs that no published image ever carries alone.

Per 100 Requests, with a first-draft approval rate `a`, a retry-approval rate `r`, and
**2 Finals auto-generated and auto-published per approved direction** (ADR 0020 — no pick step):

| Path | Share | Drafts | Finals | Published |
|---|---|---|---|---|
| Approve on first draft | 60 | 60 | 120 | ~120 |
| Reject → retry → approve | 25 | 50 | 50 | ~50 |
| Rejected twice → `parked` | 15 | 30 | 0 | 0 |
| **Total** | **100** | **140** | **170** | **~170** |

**≈ 0.82 drafts + 1.0 finals per published image.** (Generation-failure attrition, ~5–10% on the
Finals leg, is what separates the two `~` columns from an exact 2× at scale; a Request that lands
only one Final is `parked`, not `done`.)

The 60/25/15 split is an assumption to be replaced with measurement — it is the single number most
worth instrumenting, and `SPEC.md` records every attempt and every Decision, so it's derivable from
day one. `[POST-BUILD]` reconcile the per-generation constant against real Luma credit burn; the
API doesn't return billing synchronously, so the pipeline logs a configured cents constant per
generation kind on **every** attempt, success or failure.

Sensitivity, so the shape is visible without pretending to know the rate:

| Assumed draft / final cost | Cost per published image |
|---|---|
| $0.02 / $0.08 | **≈ $0.10** |
| **$0.05 / $0.11** (shipped `DRAFT_COST_CENTS` / `FINAL_COST_CENTS`) | **≈ $0.15** |
| $0.05 / $0.20 | **≈ $0.24** |
| $0.10 / $0.40 | **≈ $0.48** |

At any of these, the whole 40-product drop lands for roughly the price of lunch. **Dollars are not
the constraint** — which is precisely why cutting the spend ceiling was defensible, and why the
draft gate earns its keep on *taste* (not spending on directions she'd reject) more than on
arithmetic.

The comparison number I don't have is the freelance photographer's cost per usable shot — it's one
of the three questions I'd ask given ten minutes with the team (`DECISIONS.md`). Turnaround,
though, we beat without ambiguity: **weeks → same day.**

### What one approved image costs in minutes

Three different clocks, and only one of them matters:

| Clock | Per approved image | Notes |
|---|---|---|
| **Machine time** | `[POST-BUILD]` — measured generation latency | Not the bottleneck at any plausible value. |
| **the Content Lead's attention** | **~10–30 seconds** | 1 tap on the happy path (approve the Draft); a blank row adds the proposal accept, a rejection adds the reason chip + one retry tap. Amortised over ≥2 published images. This is the number the product exists to protect. |
| **Wall-clock** | **Dominated by time-to-tap** | One human gate; a rejection adds a second wait for the retry. Target median <24h to tap; the stale threshold (3 days) is the hard ceiling before escalation. |

The honest read: **wall-clock is 99% waiting for a human, and that's the design working.** Machine
minutes are noise. The north-star metric is median time-to-tap, and the kill signal is that metric
drifting past ~3 days for three consecutive weeks.

### What changes at 10× (300 products)

Dollars scale linearly and stay small. **the Content Lead's attention does not scale at all** — and that
inversion is the whole story:

- **The binding constraint flips from money to human attention.** 300 products × ~2 taps each (one
  on the happy path, more with blank rows and rejections) ≈ **600+ taps, all on one person**. At the
  north-star throughput of ~25 Requests reaching `done` per month, the full catalog is **~12 months
  of tapping.** No amount of cheaper generation moves that number.
- **Per-request review stops being viable; batching becomes necessary.** This is where *the road not
  taken* comes back — and it comes back as a requirement, not an option.
- **The digest stops being optional.** At 40 products you can hold the state in your head; at 300 you
  cannot. It becomes the primary interface for everyone who isn't the Content Lead.
- **The spend ceiling returns.** 10× the draft-generation floor is worth capping, and the
  pause-and-ask flow becomes worth its complexity.
- **Priority ordering becomes load-bearing.** At 40 products, queue order is a nicety; at 300 it
  decides which two-thirds of the catalog never gets shot this year. `Notes`-derived priority (F1)
  is the cheap version; it will need a real ranking input from the Brand Owner.
- **One channel gets noisy.** A dedicated `#shots` channel, and review posts drip-fed by priority
  rather than fired on import. F7's one-message-per-batch already absorbs most of this; what's left
  is pacing the *thread* activity.

> **The scaling thesis, stated plainly.** What ships today is a foundation sized for catalogs in the
> low hundreds, and its job is as much to *generate the data we don't have* as to produce images:
> every approve, every reject reason, every edited proposal is a labelled example. At 300+ products
> that history is what makes the system viable — it's what lets proposals and prompts get
> specific, and eventually what lets the Draft phase run itself for high-confidence directions.
>
> **Finals must stay auto-generated.** That is not a convenience decision, it's the scaling
> constraint: any design where a human adjudicates each Final has a per-product human cost that
> multiplies by catalog size, and at 300 products it stops being operable. The one place human
> attention is spent — the direction — is the one place it can't be replaced yet.

---

## What breaks first under pressure

Ranked by what I actually expect to happen, soonest first.

**1. The drop lands and floods the channel.** 40 products import at once; up to 40 review posts hit
one Slack channel in minutes. the Content Lead opens Slack to forty notifications and does the rational thing —
nothing. This is the failure mode the whole product is designed to prevent, arriving through the
back door, and it is my design's single largest exposure. *Mitigation shipped:* `Notes`-derived
priority ordering means the bestsellers post first. *Mitigation not shipped:* rate-limiting the
posts and drip-feeding by priority — this is a small change and it is what I'd do the moment I saw
the first import backing up. Batch contact-sheet review is the structural fix.

**2. Spend has nowhere to surface.** With both the ceiling and the digest out, a generation loop or
a runaway retry spends until a human happens to notice. The data is recorded per attempt — the
observability is not. This is the compound cut named in the scope ledger, and it's why the digest is
next.

**3. The Content Lead goes on vacation.** One binding actor means the pipeline halts entirely. Stale escalation
@-mentions the Brand Owner, which tells her the pipeline is stuck but gives her no way to unstick it — she
can't tap. A named backup approver is one config field, and it's #2 in what's next.

**4. The `Notes` classifier gets one wrong.** A joke read as `generationRisk` poisons a prompt;
`"discontinued after spring?"` read as guidance produces a strange image. Tuning is deliberately
biased toward false negatives — when unsure, flag for a human rather than feed the prompt — but the
first genuinely weird generation will trace back to this.

**5. A `Photo` URL 404s at import scale.** Every generation is image-to-image from the one
white-background photo. A dead link, or one flagged `sourceAssetQuality`, must raise
`GenerationFailed` with a legible reason rather than silently generating from nothing. Surfaced, not
swallowed — but at 300 rows this stops being an exception and becomes a category.

---

## How this was built

Backdrop was built with AI coding tools (Claude Code as the primary driver), in discrete feature
waves. Each wave was closed by a code / test / documentation audit synthesised in
[`AUDIT-LOG.md`](AUDIT-LOG.md), which records what each review caught and what was accepted or
pushed back on. Building in audited waves kept written state — the domain docs, the ADRs, the spec
— load-bearing rather than optional, so any session could pick the thread back up without
re-deriving context.

---

## Where the reasoning lives

| File | What it holds |
|---|---|
| `PRODUCT.md` | Product context, the three user archetypes, where the work happens today, data quirks |
| `DISCOVERY.md` | 27-event domain timeline, aggregates, 10 hotspots, bounded contexts |
| `DOMAIN.md` | Bounded context, ubiquitous language, entities, invariants, core vs. supporting |
| `SCOPE.md` | User Value Moment, north-star, kill signal, 18 features scored and cut |
| `DECISIONS.md` | Every open question, the call taken, what it changed, what to watch |
| `SPEC.md` | 5 features, 19 Given/When/Then scenarios, out of scope |
| `docs/adr/` | 21 engineering decision records — Socket Mode, hexagonal ports, SQLite, R2 image hosting (0017), threaded batch status (0019), Finals auto-publish (0020), queue throttling (0021) |
| `docs/libraries/` | version-pinned grounding docs the adapters were written against |
| `AUDIT-LOG.md` | per-wave code / test / docs audit synthesis (what the reviews caught, what was accepted or pushed back on) |
| `README.md` | how to run it, deploy it, and set the Slack app up |
