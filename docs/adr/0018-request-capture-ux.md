# 0018 — Request capture UX: accept / edit-modal buttons, no binding-actor gate

**Status:** Accepted · implemented Wave 4 (`src/app/capture-shot-idea.ts`,
`src/domain/shot-request.ts` `confirmRequest`, `src/runtime/slack-events.ts`).

## Context

SPEC F2 needs to tell three confirm paths apart by their `ShotIdeaOrigin`:

- `slack-reply` — a person types a fresh idea in-thread.
- `proposed` — a person accepts the system's proposal exactly as posted.
- `proposed-then-edited` — a person edits the proposal before accepting it.

Nothing in the codebase said *how* "edits the proposal" is supposed to work mechanically. The
`slack-app-manifest.yaml` comment on `message.channels` (pre-dating this wave) and
`docs/libraries/slack-bolt.md` §6 both anticipated `message_changed` — Slack's edit-detection
event — as the mechanism.

## Decision

**Two buttons on the ask, one of them opening a modal:**

- "Use this" (`proposal_accept`) — confirms with the proposal text verbatim, origin `proposed`.
- "Edit before using" (`proposal_edit`) — opens a `views.open` modal, `plain_text_input` pre-filled
  with the proposal. On submit (`app.view("proposal_edit_modal", …)`), origin is `proposed` if the
  trimmed submission equals the trimmed proposal, else `proposed-then-edited`.
- Any thread reply that isn't a button tap — `app.message()`, filtered to non-subtyped, non-bot,
  actually-threaded messages in the configured channel whose `thread_ts` matches a known
  `BlankRowAsk` — is `slack-reply`, unconditionally.

One app-layer function, `captureShotIdea`, handles all three: it doesn't know or care which path
produced `{ sku, text, origin }`.

**No binding-actor gate.** `handle-decision.ts` and `handle-pick.ts` both gate on
`config.slack.ellieUserId` because DOMAIN.md's binding-actor rule is specifically about *Review* —
"only the approver's tap is binding" (DECISIONS.md A2), because a Decision spends money or ships an
image. Capture spends nothing and ships nothing; it fills in the one blank the team already can't
get anyone to write down. Gating it to one person would recreate exactly the failure the feature
exists to fix (SPEC: "the team's actual disease: ideas that live in a head or a thread"). Any
human's reply/accept/edit confirms.

## Alternatives considered

- **`message_changed` on the person's own reply** (what the pre-existing manifest comment and
  library doc anticipated): person replies once, then edits *that* message; `message_changed`
  fires with the updated text, correlated by its unchanged `ts`. Rejected — it detects a person
  editing their own free-typed reply, not editing the *proposal*. It can't distinguish "typed a
  fresh idea, then fixed a typo in it" (still `slack-reply` by the SPEC's own language) from
  "edited the system's suggested text" (`proposed-then-edited`) — both look identical: a
  `message_changed` event on a human's message. The modal sidesteps the ambiguity entirely because
  the edited text visibly *starts from* the proposal.
- **Heuristic diff against the proposed text** (any reply within some edit-distance of the
  proposal is `proposed-then-edited`, otherwise `slack-reply`): rejected — a tunable threshold with
  no natural value, and a person who happens to type something close to the proposal by coincidence
  gets miscategorized. The modal makes the distinction an explicit user action instead of a guess.
- **Binding-actor gate on capture, matching Review**: rejected per Decision above — capture has no
  spend and no publish riding on it, and the whole point of F2 is that anyone's word should be
  enough to stop an idea from living only in someone's head.

## Consequences

- First use of Slack modals (`views.open` / `app.view`) in this codebase — no new OAuth scope
  needed (modals ride on existing interactivity), but it's new surface next to the button-only
  pattern F3a/F4 use.
- `slack-app-manifest.yaml`'s `message.channels` comment is corrected; the scope list itself is
  unchanged.
- A stale `proposal_edit` tap or thread reply after the SKU is already `confirmed` is a no-op
  (`captureShotIdea` only acts on a `proposed` Request) — idempotent, no special-case handling
  needed in the runtime layer.
