# Scope & Value

The value thesis and the scope cut: what job is failing, the durable change the product makes,
and which candidate features earn a place. Scores the features [`DOMAIN.md`](DOMAIN.md) implies,
before the spec is written.

Four scoping decisions are marked **[chosen]**.

---

## The value chain

**1. What job is failing today, for whom, and what do they do instead?**

The Content Lead's job is *turn a wishlist of shot ideas into approved images without becoming a full-time
image reviewer.* It fails at the point where a decision gets made. She makes the decision — "that
one," "no, too staged" — but the decision doesn't land anywhere durable. It lives in a Slack
thread, an email reply to the photographer, or nowhere. What she does instead: **2–3 times a year
she reconstructs the wishlist by hand** from the sheet, Slack scrollback, and her inbox. That
reconstruction is the workaround, and it is the disease. Sixteen requests exist, "some months old,"
and *nobody can tell you which are done.*

The Brand Owner's job — *see where things stand without asking the Content Lead* — fails for the same reason, one level
up: there is no status because there is no written-down decision to derive status from.

The Storefront Publisher's job fails at the far end of the same chain: `IMG_43xx.jpg` shipped to a live
product page and sat wrong for three weeks, because "which file is final" was a Slack question
rather than a property of the file.

**One root cause, three symptoms: the decision is never written down.**

**2. What durable change does the product make?**

The pick becomes a record instead of a message. the Content Lead taps in the tool she already has open, and
that tap is simultaneously the approval, the status, the spend authorisation, and the filename.
Afterward and permanently: nobody reconstructs a wishlist, nobody asks which file is final, and
"done" is mechanically checkable for the first time.

The change is durable because it costs the Content Lead *less* than the status quo, not more. Every previous
attempt to fix this — including the abandoned dashboard — asked her to go somewhere new to record
something she was already deciding. This one records it where she already decides it.

**3. North-star behavior at 12 months** — see below.
**4. Kill signal** — see below.

---

## User Value Moment **[chosen]**

> **A draft lands on the Content Lead's phone in Slack, she taps Approve without leaving the conversation, and
> minutes later two files exist named `hg-002-styled-01.jpg` and `hg-002-styled-02.jpg` — approved,
> stable-URL'd, and countable as done.**

The moment it pays off is not the image arriving. It's the **tap** — one thumb, no install, no
login — and the fact that the tap did four jobs at once:

| The one tap... | ...replaces |
|---|---|
| approved the direction | a Slack thread everyone 👍'd |
| authorised finals spend | "don't burn our budget on stuff she'll reject" |
| wrote the status down | the Brand Owner asking the Content Lead |
| named the file | "which `IMG_43xx.jpg` is final?" |

Everything in scope exists to make that tap possible, cheap, and consequential. Anything that
doesn't serve the tap is scaffolding, and scaffolding gets cut first.

---

## North-star behavior (12 months)

> **the Content Lead taps a decision on every draft posted to her, without being chased, and the pipeline
> sustains ~25+ requests reaching `done` per month across the 300-product catalog.**

The repeated action is *the unchased tap*. Not images generated (the machine controls that), not
requests opened (the CSV controls that) — the one action only a human can supply, taken willingly,
repeatedly, on a phone.

Two supporting reads, both derivable from data the pipeline already records:

- **Median time-to-tap under 24 hours.** Cheap to compute from `DraftPostedForReview` →
  `Decision.at`. It is the honest measure of whether this feels like two seconds of work or a chore.
- **Zero wishlist reconstructions.** If the Content Lead ever again rebuilds the list from Slack scrollback,
  the product did not replace the workaround — it added to it.

---

## Kill signal **[chosen]**

> **Median time-to-tap drifts past ~3 days for three consecutive weeks, and stale escalations become
> the normal path rather than the exception.**

This is the failure mode with the most evidence behind it. The team already killed a creative
automation tool in week one, and the incumbent process's signature pathology is the 👍 that nobody
wrote down. Dormancy is how things die here.

It is a kill signal rather than a fix-it signal because **every other metric is downstream of a
tap.** Spend, throughput, digest accuracy, published files — all of it is fiction if the approval
never comes. A pipeline nobody taps is the abandoned dashboard with extra steps, and no amount of
better prompts, cheaper drafts, or prettier digests changes that. If she stops tapping, the
correct move is to stop building, not to iterate.

**What it is NOT:** a high rejection rate. Rejections are the system working — a cheap draft
rejected for "wrong vibe" is the two-stage gate earning its keep. Rejection rate is a prompt-quality
signal, not a kill signal.

**Instrumentation this obliges us to build:** time-to-tap must be recorded per request, and stale
escalation must exist — otherwise the kill signal is unobservable. This is why *Stale escalation*
survives the cut below despite a middling differentiation score.

---

## Feature scoring

Candidates derived from `DOMAIN.md` events and invariants. Scored 1–3 on **user-outcome
contribution** (does it move the Content Lead's tap, the Brand Owner's answer, or the Storefront Publisher's file?) and on
**differentiation** (would a competent generic build have it?).

**Cut rule applied:** anything scoring **1 on user outcome is cut.** A 1 on differentiation alone
is *not* disqualifying — CSV parsing is table stakes and undifferentiated, but nothing exists
without it. Undifferentiated load-bearing work is still load-bearing.

| # | Candidate | Outcome | Diff | Verdict |
|---|---|---|---|---|
| 1 | **Draft review in Slack** — Approve / Reject + reason buttons, bound to a `ShotRequest` | 3 | 3 | **KEEP** — this *is* the value moment |
| 2 | **Two-stage spend gate** — cheap draft first; only `DraftApproved` authorises finals | 3 | 3 | **KEEP** — the direct answer to the Brand Owner's budget worry, structural not advisory |
| 3 | **Idea proposal for blank rows** — co-posted with the ask, editable | 3 | 3 | **KEEP** **[chosen]** — 24 of 40 rows are blank; the drop is mostly blank |
| 4 | **Deterministic publish** — `hg-002-styled-01.jpg` + stable URL | 3 | 2 | **KEEP** — heals the `IMG_43xx` scar; makes `done` checkable |
| 5 | **Finals & the pick** — 2–3 finals, ≥2 picks = `done`, exactly 1 = `parked` partial | 3 | 2 | **KEEP** — the team's own definition of Done, enforced |
| 6 | **Prompt composition** — Shot Idea + product facts + `ColorSet` + risk flags | 3 | 2 | **KEEP** — the judgment step; a string copy of "on a set dinner table, with food in it?" generates nothing |
| 7 | **Catalog import** — idempotent, `$48`→cents, multi-word colours, SKU gaps | 3 | 1 | **KEEP** — table stakes, but the drop is the stated first real test |
| 8 | **`Notes` → priority + generationRisk** — classified, partially trusted | 2 | 3 | **KEEP** — richest signal in the file, nearly free to use |
| 9 | **One retry per rejection** — rejection reason carried into the new prompt | 2 | 2 | **KEEP** — makes the reject button worth pressing; bounded spend |
| 10 | **Stale escalation** — un-tapped N days → @the Brand Owner | 2 | 2 | **KEEP** **[chosen]** — instruments the kill signal; without it the signal is unobservable |
| 11 | **Status digest** — counts by state, dollars, *named* stale/parked | 2 | 2 | **KEEP** — the Brand Owner's verbatim ask; a read model over data we already have |
| 12 | **Import summary posted to channel** — N with an idea, K blank, J done | 2 | 1 | **KEEP** — folds into #7 as one Slack message; first moment anyone can answer "where do we stand" |
| 13 | **Per-attempt spend in cents** | 2 | 1 | **KEEP as a field, not a feature** — see note below |
| 14 | **Palette check** — sampled colour vs `ColorSet`, non-blocking ⚠ annotation | 1 | 3 | **CUT** **[chosen]** — most differentiated idea here, but it does not change what the Content Lead does: she overrules it either way |
| 15 | **Spend ceiling + pause/post** | 1 | 2 | **CUT** **[chosen]** — the two-stage gate is the real budget control; a ceiling guards a runaway that a one-day build won't produce |
| 16 | **Updated CSV export** | 1 | 1 | **CUT** **[chosen]** — a third status surface to keep in sync; digest + stable filenames already answer the Storefront Publisher's question |
| 17 | **Superseding idea revisions** on re-import | 1 | 2 | **CUT** — fires only when a re-import changes the idea on an already-`done` SKU; correct, but no user's outcome moves this quarter |
| 18 | **Non-binding tap recording** + in-thread "noted — waiting on the Content Lead" | 1 | 1 | **CUT** — a binding-actor check is the actual rule; the polite reply is manners |

### On #13, spend recording

You cut *"Spend ledger + ceiling pause"* as a feature. I've kept **per-attempt cost in cents as a
field on `GenerationAttempt`**, and the running total in the digest. Rationale, so you can overrule
it deliberately: it's one integer written at the same moment we already write the attempt, and it's
the numerator of the **unit economics** section in [`DESIGN.md`](DESIGN.md) — "what one
approved image costs in dollars and minutes." Without it that section is a guess.

What's actually cut is the `SpendLedger` **aggregate** with a ceiling invariant, the
`SpendCeilingReached` → `PipelinePaused` events, and the pause-and-ask flow.

### Keeps, clustered for the spec (hard cap: 5)

Thirteen keeps do not survive a 5-feature cap as-is. They cluster cleanly:

| Feature | Absorbs | Serves |
|---|---|---|
| **F1 — Catalog intake** | 7, 8 (priority), 12 | The drop; queue order |
| **F2 — Request capture** | 3 | The 24 blank rows |
| **F3 — Draft review in Slack** ⭐ | 1, 2, 6, 8 (risk), 9, 10 | **The value moment** |
| **F4 — Finals & publish** | 4, 5 | Done; the `IMG_43xx` scar |
| **F5 — Status digest** | 11, 13 | the Brand Owner's question |

**F3 is the core.** If time runs out, F1 → F3 → F4 is the demoable spine; F2 and F5 are the first
things to shrink.

---

## Out of Scope

Explicit, with the reason and what it costs us.

1. **Palette adherence checking** — genuinely differentiated, but non-blocking by design, so the Content Lead's
   decision is identical with or without it. *Costs: a Terracotta-reads-as-Ochre render ships if her
   phone screen doesn't catch it.*
2. **Spend ceiling with pipeline pause** — the draft-before-finals gate already prevents the runaway
   it guards against, at 40 products. *Costs: no hard stop; at 300 products this comes back.*
3. **Updated CSV export** — a third status surface that must stay consistent with two others.
   *Costs: the Storefront Publisher reads the digest and the filenames instead of a file.* Scoped exception
   (F7): one CSV per batch status post, generated once on that batch's completion, posted into its
   own thread — not a running file kept in sync (ADR 0019).
4. **Superseding idea revisions on re-import** — an edge case that fires next month, not this week.
   *Costs: a re-import with changed idea text on a known SKU flags in the import summary and does
   nothing else. Write it down as a known gap.*
5. **Non-binding tap recording and in-thread replies** — the enforceable rule is "only the Content Lead's tap
   is binding," and that's a check, not a feature. *Costs: someone else's tap is ignored silently
   rather than acknowledged.*
6. **Multi-product / bundled scenes** (`"shoot with the mugs maybe"`) — breaks the SKU-keyed
   `ShotRequest` model outright. *Costs: `BundlingIntentFlagged` records the intent; a human acts.*
7. **Live Google Sheet sync** — the problem statement explicitly doesn't ask for it. *Costs: nothing; the sheet
   stays a handoff format.*
8. **Drive folder write access** — install-shaped commitment for a team that rejects those.
   *Costs: images live at our stable URLs, not in their Drive folder.*
9. **A dashboard, of any kind** — the documented failure mode. *Costs: nothing. This is the point.*
   Scoped exception (F7): one Slack message per CSV import, live only until that import's rows are
   all terminal, then inert — no cross-import view, no standing surface (ADR 0019).
10. **Slack slash-commands** — the Content Lead receives from a pipeline, she doesn't command a bot
    (Assumption 7). *Costs: no manual re-run trigger; the import is the only entry point.*

---

## Conflicts to reconcile before the spec

Three of these cuts **reverse a decision already recorded in `DOMAIN.md`.** Those cuts stand — but
the domain doc now disagrees with them and must be patched, or the spec will read stale input:

| `DOMAIN.md` says | Value cut says | Patch needed |
|---|---|---|
| `PaletteCheck` VO, **[decided]**, + `PaletteDeviationFlagged` event | Cut | Move to Out of Scope; drop the VO, the event, and the hotspot resolution |
| Assumption 8: `UpdatedExport` "Yes, secondary" | Cut | Reverse Assumption 8; drop the read model and `UpdatedExportProduced` |
| Assumption 5: `SpendLedger` "becomes an aggregate with an invariant" | Cut to a field | Revert to a read model; drop `SpendCeilingReached`, `PipelinePaused` |
| `ShotRequest` identity = **SKU + idea revision**, **[decided]** | Revision-minting cut | Identity can stay (it's free); the *superseding* behaviour goes. Re-import with new text flags, doesn't act |
| Assumption 2: `NonBindingTapRecorded` event | Cut | Keep the binding-actor check; drop the event |

Everything cut here belongs in `DECISIONS.md` as a written-down decision with its cost — the
README asks for opinions there, and "we considered palette checking and cut it because it doesn't
change the approver's behaviour" is an opinion.

---

## Gate

**Confirm before the spec:**

- **User Value Moment** = one tap on a phone that approves, authorises spend, writes status, and
  names the file.
- **North-star** = the unchased tap; **kill signal** = median time-to-tap > 3 days for 3 weeks.
- **5 features**, F3 (Draft review in Slack) is the core; F1 → F3 → F4 is the demoable spine.
- **10 out-of-scope items**, including two reversals of `[decided]` calls in `DOMAIN.md`.

