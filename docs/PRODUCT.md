# Product

## One-liner

A Slack-native pipeline that turns a home-goods brand's spreadsheet **Shot Ideas** into
AI-generated styled product photos, approved by one person from their phone, with the answer to
"where do things stand?" posted back into the same channel.

This document is the problem framing the rest of `docs/` builds on: who feels the pain, where
the work happens today, and the reference catalog the build and its tests run against.

## Users

| Who | Job they're trying to do | What they will not tolerate |
|---|---|---|
| **the Content Lead** — runs product content "along with half of everything else" | Turn a wishlist of shot ideas into approved images without becoming a full-time image reviewer | Installing anything new; logging into a dashboard. Her words: *"it has to work from my phone, and I don't want to install anything new."* |
| **the Brand Owner** — founder | See where the shot pipeline stands **without asking the Content Lead**; land the 40-product drop next month with styled shots | Burning budget on images the Content Lead will reject |
| **The Storefront Publisher** | Ship the *right* file to the product page | Guessing which `IMG_43xx.jpg` is final — they already shipped the wrong one and it sat live for three weeks |

The load-bearing user is **the Content Lead**. She is the only approver ("her pick is the decision;
there's no other approval step") and she is the documented adoption risk — the team already
abandoned a creative-automation tool with a beautiful dashboard after week one.

## Surfaces observed

There is no existing product UI to extract from. The observed surfaces are the team's current
toolkit, which is the entire design constraint:

- **Google Sheet** — one shared spreadsheet, one row per product. The system of record. 16 rows
  currently carry a Shot Idea. No status column exists.
- **Slack** — where requests get 👍'd and forgotten, where the Content Lead forwards favorites for opinions,
  and where the decision sometimes lives.
- **Gmail** — where candidate shots arrive from the freelance photographer, as attachments or
  download links or `final_v2_REAL_final.zip`.
- **Google Drive** — a shared folder of winners, keeping whatever filename the camera gave them.
- **The product page** — uploaded from Drive roughly weekly, "usually after asking in Slack which
  files are actually final."

**Rejected surface (evidence, not speculation):** a creative-automation tool with a beautiful
dashboard. Trialed last quarter. Nobody logged in after week one.

## Domain vocabulary (verbatim from the problem statement and the export)

| Term | Meaning as this team uses it |
|---|---|
| **Shot Idea** | A spreadsheet column. Free-text, human-vague: *"morning kitchen counter, steam, warm light"*, *"holiday mantel with evergreen"*, *"on a set dinner table, with food in it?"* |
| **Request** | One Shot Idea for one SKU. Sixteen exist today, "some months old." |
| **Done** | **2–3 approved images matching the shot idea**, in the drive folder, on the product page. |
| **Candidate shots** | What comes back for review, before a pick. |
| **The pick** | the Content Lead's choice. It *is* the approval — there is no second step. |
| **Wishlist** | What the Content Lead reconstructs 2–3× a year from sheet + Slack scrollback + inbox. |
| **The drop** | 40 products landing next month. The stated first real test. |
| **Export** | The CSV the Brand Owner sent: *"this is where we are as of today."* New ones will keep coming. |
| **White-background photo** | The one photo every product already has. The generation input. |
| **Notes** | An unstructured column carrying five different jobs (see quirks). |

## Data handoff — observed quirks

`data/catalog.csv`, 40 rows, "a sample of the full 300."

- **16 rows have a Shot Idea**, 24 are blank. Matches the problem statement's "sixteen in the sheet right now."
- **Gaps in the SKU sequence** (HG-007, -015, -023, -031, -039 absent). It's a filtered export, not
  a clean range — don't assume contiguity when the drop arrives.
- **No status column.** This is mechanically why "nobody can tell you today which of the sixteen
  requests are done."
- **`Notes` is a junk drawer doing five distinct jobs**, and it is the richest signal in the file:
  - priority — `"El: bestseller, do this one first"`, `"top seller, gets reordered constantly"`
  - generation risk — `"El: smoke glass photographs badly, careful"`, `"came out too shiny in last shoot"`
  - source-asset quality — `"photo slightly underexposed?"`
  - lifecycle — `"discontinued after spring?"`
  - bundling intent — `"shoot with the mugs maybe"`, `"bathroom set w/ the towels?"`
- **Shot Ideas are underspecified by design.** One is literally a question. Turning them into
  generation prompts is a judgment step, not a string copy.
- **`Price` is a string with a `$`**; multi-word `Color / Finish` values (`"Cream Terracotta Sage"`)
  encode multiple colors in one field.
- **Tight repeating brand palette** across every category — Terracotta, Sage, Ochre, Dusty Blue,
  Clay Pink, Charcoal, Cream, Forest, Amber, Smoke. Brand consistency is checkable, not vibes.

## Decisions taken (asked and answered)

1. **Approval lives in Slack.** A Slack app posts candidates to a channel with Approve / Reject
   buttons. Slack is already on the Content Lead's phone — nothing new installed, no login, no dashboard.
   The decision lands in the same place the conversation already happens, and this time it gets
   written down.
2. **Two-stage spend: cheap draft → finals.** One low-cost draft per Shot Idea goes to the Content Lead first.
   Only after she picks a direction does the system spend on the 2–3 full-quality finals that
   satisfy "done." A rejection costs a fraction of a full run — this is the direct answer to
   *"don't burn our budget on stuff she'll reject."*
3. **Status is a Slack message, not a dashboard or a CSV.**The Brand Owner gets the pipeline state posted as
   a Slack digest — how many requests are done, in review, failed, and what's been spent. She sees
   where things stand without asking the Content Lead, and without opening a tool the team already proved they
   won't return to.

## Known constraints

- **the Content Lead's phone, zero installs.** Non-negotiable, stated verbatim. Any flow requiring a desktop
  or an account creation is dead on arrival.
- **A dashboard is a known failure mode here.** Not a hypothesis — an observed outcome.
- **Cost per image is real** and the Brand Owner raised it unprompted. Spend has to be visible and bounded.
- **New CSV exports keep coming.** The 40-product drop lands next month; ingesting a fresh export
  (same columns, new SKUs, new photo URLs) must be a working, demonstrable entry point.
- **Must be deployed and demoed live**, not on localhost.
- **~1 working day.** There is deliberately more here than fits.
- Toolkit is Google Docs/Sheets, Slack, Gmail. Nothing else is installed.
- Generation via the Luma API (key in gitignored `.env.local`); credits are finite.
- No live sheet sync is required — an updated export at the end is acceptable.

## Open questions

Kept verbatim as the record of what I'd have asked. Each carries **→ Resolved:** where it landed —
in `DOMAIN.md` / `DECISIONS.md`, and whether the later scope pass cut it.

1. **What is the unit of approval?** The whole shot idea (one tap approves the concept), or each
   image individually? "Done = 2–3 approved images" implies per-image, but 16 requests × 3 images
   is 48 taps and the Content Lead has half of everything else to do.
   **→ Resolved:** both, in sequence — one tap approves the draft *direction*, then one tap per
   final to keep. ≈3–4 taps per request. `DraftApproved` is the only finals-spend authoriser.
   *Assumption A1.*
2. **What happens on reject?** Auto-retry with a varied prompt, retry only when the Content Lead asks, or drop
   the request back to a queue? Auto-retry spends money on a signal we haven't interpreted yet.
   **→ Resolved:** exactly one retry per rejection, prompt conditioned on the reject-reason chip
   (wrong vibe / colour off / too staged / other). Two rejections → `parked`. *Assumption C, table.*
3. **Where do approved files land, and named what?** The wrong-`IMG_43xx.jpg` incident is a real
   scar. Deterministic SKU-based filenames are the obvious fix — but does the pipeline own the
   Drive folder, or just hand back stable URLs?
   **→ Resolved:** deterministic name (`hg-002-styled-01.jpg`) + stable URL from the pipeline's own
   store. No Drive writes. *Assumption A3.*
4. **Does the `Notes` column feed generation?** `"smoke glass photographs badly"` and `"needs to
   look premium"` are free expert guidance sitting in an unstructured field. Parsing it is upside;
   trusting it blindly is risk.
   **→ Resolved:** classified into 5 intents; only `priority` (queue order) and `generationRisk`
   (prompt caution) act; `lifecycle` + `bundling` flag for a human, never auto-act. *Assumption A4.*
5. **What about the 24 rows with no Shot Idea?** The drop will be mostly blank rows. Does the system
   propose a shot idea from category + color + material, or stay strictly request-driven?
   **→ Resolved:** propose, co-posted with the ask ("reply with one, or use this: …"). No timer.
   An edited or replied idea wins. *Assumption A5.*
6. **Who triggers a run?** A Slack command from the Content Lead, an upload, or a scheduled batch? This decides
   whether the product is a bot she talks to or a pipeline she receives from.
   **→ Resolved:** she receives from a pipeline. The CSV import is the only entry point; the Content Lead only
   taps buttons and reads the digest. No slash-command surface. *Assumption A6.*
7. **Is the updated CSV export still worth producing** as a secondary artifact, given status now
   ships via Slack — for the Storefront Publisher, who works from files?
   **→ Resolved: CUT by the value pass.** The digest + deterministic filenames + stable URLs
   already answer "which file is final?" A third status surface is a sync liability. *Assumption B4.*
8. **Does the brand palette get enforced** as a generation check (product color must survive the
   scene), or is that trusted to the model?
   **→ Resolved: CUT by the value pass** (was decided as an automated non-blocking check). It
   changed no decision — the Content Lead taps on the image regardless. Trusted to the model, the palette in
   the prompt, and her eye on the draft. *Assumption B1.*

---

*Next in the chain: [`DISCOVERY.md`](DISCOVERY.md) → [`DOMAIN.md`](DOMAIN.md) →
[`SCOPE.md`](SCOPE.md) → [`DECISIONS.md`](DECISIONS.md).*
