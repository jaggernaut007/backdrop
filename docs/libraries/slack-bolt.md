# Grounding: `@slack/bolt` (Socket Mode)

**Version pinned: `@slack/bolt@5.1.0`** — verified against `registry.npmjs.org`, `docs.slack.dev`,
and `slackapi/bolt-js` on 2026-09-06. This file is the reference `src/adapters/bolt-slack-gateway.ts`
and `src/runtime/slack-events.ts` are written against — code from memory is not trusted.

---

## 1. Version & runtime

| Fact | Value |
|---|---|
| `dist-tags.latest` | **`5.1.0`** (~2026-09-02; v5.0.0 was 2026-07-15) |
| `engines.node` | **`>=20`** (no upper bound → Node 26 satisfies it) |
| Key deps | `@slack/web-api@^8.1.1`, `@slack/socket-mode@^3.0.1`, `@slack/oauth@^4.0.0`, `express@^5.0.0` |

Bolt 5 / node-slack-sdk 8 dropped `axios` for native `fetch` and ship no native addons → no known
Node 26 incompatibility. The project CI matrix tests LTS lines (20/22/24), so Node 26 is ahead of
the tested path.

**This project's choice:** the container runs **Node 22** (`node:22-bookworm`) — a Bolt-tested LTS
line — while local dev / `vitest` run on Node 26. Nothing in the runtime path depends on the
difference; Node 22 is picked over Node 24 only because `node:22-bookworm` is the well-worn base
and 24 buys nothing here. See ADR 0011.

v5 breaking changes: min Node 20, `axios`→`fetch`, "Workflow Steps from Apps" removed, `express`
peer → v5. v5.1.0 added a configurable `bodyLimit` (default 4 MB) on the HTTP receiver —
irrelevant in pure Socket Mode.

Sources: <https://registry.npmjs.org/@slack/bolt/latest> · <https://github.com/slackapi/bolt-js/blob/main/package.json> · <https://docs.slack.dev/changelog/2026/07/15/bolt-js-release/>

---

## 2. Socket Mode setup

```ts
import { App } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,     // xoxb-...  (bot token — carries feature scopes)
  appToken: process.env.SLACK_APP_TOKEN,  // xapp-...  (app-level token, scope: connections:write)
  socketMode: true,
  // signingSecret: NOT required in Socket Mode — omit it
});

await app.start(); // opens the WebSocket; binds no port in Socket Mode
```

- **Bot token** `xoxb-…` → `token`. From *Settings → Install App → Bot User OAuth Token*.
- **App-level token** `xapp-…` → `appToken`. From *Settings → Basic Information → App-Level Tokens*.
  Must have **`connections:write`**. Only authorizes opening the socket; not used for Web API calls.
- **Signing secret: not required** in pure Socket Mode (no inbound HTTP, no Request URL). Only
  needed if you also run an HTTP receiver (e.g. OAuth install).
- Also toggle *Settings → Socket Mode → Enable* and list events under *Event Subscriptions* (the
  subscription list still applies; only the transport changes).

Sources: <https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/> · <https://docs.slack.dev/apis/events-api/using-socket-mode/>

---

## 3. Block Kit — interactive messages

### 3a. Approve / Reject buttons

```ts
await client.chat.postMessage({
  channel: channelId,
  text: 'Draft ready for review',          // fallback text — always include
  blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: '*HG-002* — approve this direction?' } },
    {
      type: 'actions',
      block_id: 'draft_actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary',
          action_id: 'draft_approve', value: requestId },
        { type: 'button', text: { type: 'plain_text', text: 'Reject' }, style: 'danger',
          action_id: 'draft_reject', value: requestId },
      ],
    },
  ],
});
```

Limits: `value` ≤ 2000 chars, `action_id` ≤ 255, button `text` ≤ 75, ≤ 25 elements per `actions`
block, ≤ 50 blocks per message.

### 3b. Reject-reason chips — use a second row of buttons (chip feel)

```ts
{
  type: 'actions',
  block_id: 'reject_reason',
  elements: [
    { type: 'button', text: { type: 'plain_text', text: 'Wrong vibe' }, action_id: 'reason_wrong_vibe', value: requestId },
    { type: 'button', text: { type: 'plain_text', text: 'Color off' },  action_id: 'reason_color_off',  value: requestId },
    { type: 'button', text: { type: 'plain_text', text: 'Too staged' }, action_id: 'reason_too_staged', value: requestId },
    { type: 'button', text: { type: 'plain_text', text: 'Other' },      action_id: 'reason_other',      value: requestId },
  ],
}
```

(A `static_select` also works — fires with `action.selected_option.value` — but requires opening a
menu. Buttons are click-and-forget.)

### 3c. Image block

```ts
{ type: 'image', image_url: 'https://public/img/hg-002-styled-01.jpg',
  alt_text: 'Styled draft for HG-002', title: { type: 'plain_text', text: 'Draft' } }
```

Image URL must be publicly reachable (png/jpg/jpeg/gif). For a Slack-hosted file use
`slack_file: { url: <url_private> }` instead of `image_url`.

### 3d. One message, N images, each with its own Keep button

```ts
await client.chat.postMessage({
  channel: channelId,
  text: '3 finals ready',
  blocks: finals.flatMap((f, i) => [
    { type: 'image', image_url: f.url, alt_text: `Final ${i + 1}`,
      title: { type: 'plain_text', text: `Final ${i + 1}` } },
    { type: 'actions', block_id: `keep_${f.id}`,
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Keep' }, style: 'primary',
        action_id: 'final_keep', value: f.id }] },
  ]).concat([
    { type: 'actions', block_id: 'finish_picking',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Finish picking' },
        action_id: 'finals_finish', value: requestId }] },
  ]),
});
```

All three Keep buttons share `action_id: 'final_keep'` and disambiguate via `action.value`
(the final's id). `app.action('final_keep', …)` handles all three.

Sources: <https://docs.slack.dev/reference/block-kit/block-elements/button-element/> · <https://docs.slack.dev/reference/block-kit/blocks/image-block/> · <https://docs.slack.dev/reference/block-kit/blocks/actions-block/>

---

## 4. Handling `action` events

```ts
app.action('draft_approve', async ({ ack, body, action, client, respond }) => {
  await ack();                          // MUST be first — 3-second deadline

  const tappingUserId = body.user.id;  // Slack user id of whoever clicked, e.g. "U0123ABCD"
  const requestId = (action as any).value;
  const channelId = body.channel.id;
  const messageTs = body.container.message_ts ?? body.message.ts;

  // ... binding-actor check happens in the app layer (tappingUserId === ELLIE_SLACK_USER_ID) ...

  await client.chat.update({            // edit the original message after the tap
    channel: channelId, ts: messageTs,
    text: `Approved by <@${tappingUserId}>`,
    blocks: [ /* replace buttons with a status line */ ],
  });
});
```

- **Tapping user id: `body.user.id`** (not `action`). Also `body.user.username`, `body.user.team_id`.
- **Ack within 3 s** — `await ack()` first, no args for block actions, then do slow work.
- **Edit the message:** `respond({ replace_original: true, ... })` uses the `response_url` (valid
  ~30 min, ≤ 5 uses, no channel `chat:write` needed); `client.chat.update({ channel, ts, ... })` is
  a direct Web API edit (needs `chat:write`, works indefinitely). `respond({ delete_original: true })`
  removes it.
- Register by exact `action_id`, RegExp, or `{ action_id, block_id }`.

Sources: <https://docs.slack.dev/tools/bolt-js/concepts/actions/> · <https://docs.slack.dev/tools/bolt-js/concepts/acknowledge/>

---

## 5. `file_shared` event + downloading bytes

**Subscription: `file_shared`. Scope: `files:read`.** The event carries only ids — no URL:

```json
{ "type": "file_shared", "channel_id": "C…", "file_id": "F…", "user_id": "U…", "event_ts": "…" }
```

```ts
app.event('file_shared', async ({ event, client }) => {
  const { file } = await client.files.info({ file: event.file_id });
  const res = await fetch(file.url_private_download, {
    headers: { Authorization: `Bearer ${client.token}` },   // client.token === xoxb bot token
  });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) throw new Error('got a login page — bad auth on url_private_download');
  const bytes = Buffer.from(await res.arrayBuffer());
});
```

**Gotcha:** `url_private[_download]` returns **HTTP 200 with an HTML login page** if the
`Authorization` header is missing/wrong — check content-type / magic bytes, not just status.
`file_shared` only fires for conversations the bot is a member of. Alternative: handle
`message.channels` with `subtype: 'file_share'` — its payload already includes `files: [...]` with
`url_private_download`, saving the `files.info` call.

Sources: <https://docs.slack.dev/reference/events/file_shared> · <https://docs.slack.dev/reference/methods/files.info>

---

## 6. Threaded replies + detecting edits

```ts
// Plain human messages (no subtype). Subscribe to message.channels + channels:history.
app.message(async ({ message }) => {
  if ((message as any).subtype !== undefined || (message as any).bot_id) return;
  const m = message as any;
  const isThreadedReply = Boolean(m.thread_ts) && m.thread_ts !== m.ts;
  // m.thread_ts -> parent ts (the ask), m.ts -> this reply, m.user, m.text
});

// Edits: app.message() skips subtyped events → use app.event('message', …)
app.event('message', async ({ event }) => {
  const e = event as any;
  if (e.subtype === 'message_changed') {
    const updated = e.message;          // new state: .text .ts .user .edited{user,ts} .blocks
    const previous = e.previous_message;
    // updated.ts === the ORIGINAL message ts → correlate to the proposal you posted/saw
  }
});
```

- Parent message: no `thread_ts`. Reply: `thread_ts` = parent's `ts`; guard `thread_ts !== ts`.
- `message_changed` is a wrapper (`hidden: true`); real content is nested `message` +
  `previous_message`; the edited message **keeps its original `ts`**. No separate subscription for
  edits — they arrive on `message.channels`.

Sources: <https://docs.slack.dev/reference/events/message> · <https://docs.slack.dev/reference/events/message/message_changed>

---

## 6a. Modals: `views.open` + `app.view` (F2 proposal edit)

Opening a modal from a button tap needs the tap's `trigger_id` (valid ~3 s, single use — call
`views.open` immediately after `ack()`, don't await slow work first):

```ts
app.action('proposal_edit', async ({ ack, body, client }) => {
  await ack();
  const triggerId = (body as any).trigger_id;
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'proposal_edit_modal',   // routes the submission below
      private_metadata: sku,                // small opaque string carried through to submit
      title: { type: 'plain_text', text: 'Edit Shot Idea' },
      submit: { type: 'plain_text', text: 'Confirm' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'shot_idea_block',
          label: { type: 'plain_text', text: 'Shot Idea' },
          element: {
            type: 'plain_text_input',
            action_id: 'shot_idea_input',
            multiline: true,
            initial_value: proposedText,
          },
        },
      ],
    },
  });
});

app.view('proposal_edit_modal', async ({ ack, view }) => {
  await ack();                                     // no args closes the modal
  const sku = view.private_metadata;
  const submitted =
    view.state.values['shot_idea_block']['shot_idea_input'].value ?? '';
  // ... use sku + submitted ...
});
```

- **No new OAuth scope**: modals ride on the `interactivity` config already required for buttons —
  only a valid `trigger_id` from a prior interaction is needed.
- **Submitted values live at `view.state.values[block_id][action_id].value`**, one entry per
  `input` block — not on `view.private_metadata` (that's for state you set on `views.open`, not
  what the user typed).
- `ack()` with no arguments accepts the submission and closes the modal; `ack({ response_action:
  'errors', errors: { block_id: 'message' } })` re-opens it with an inline validation error instead.
- Correlate the submission back to what opened it via `private_metadata` (a plain string — JSON it
  yourself if more than one field is needed) or `callback_id` if one modal shape covers everything.

Sources: <https://docs.slack.dev/surfaces/modals/> · <https://docs.slack.dev/reference/methods/views.open> · <https://docs.slack.dev/reference/methods/views.update>

---

## 7. @-mentioning a user

Put `<@USER_ID>` directly in message `text` or any `mrkdwn` block — angle brackets, `@`, the **user
id** (not display name). `<@U0123ABCD> the draft for HG-041 has been waiting 3 days`. Do not wrap it
in `plain_text` — mentions only resolve in `mrkdwn`/message `text`.

Source: <https://docs.slack.dev/messaging/formatting-message-text/>

---

## 8. Gotchas — Socket Mode in a long-running container

- **Routine disconnects are normal.** Slack cycles the socket every few hours (sends `warning` →
  `refresh_requested`/`disconnect`). `@slack/socket-mode` auto-reconnects (new connection opened
  before the old closes). The process must stay up and not treat a close as fatal.
- **Reconnect can wedge on abrupt network loss** (bolt-js #1906, node-slack-sdk #1243). Mitigate:
  run under a supervisor that restarts on crash (`restartPolicyType: ON_FAILURE`), add
  `app.error(async (err) => { … })` + `process.on('unhandledRejection'|'uncaughtException')` logging.
- **Multi-instance:** each app-level token allows ≤ 10 concurrent connections; every payload goes
  to **exactly one** connection at random. So 2+ replicas ⇒ make handlers **idempotent** (dedupe on
  `event_id` / message `ts`); you cannot broadcast an event to all replicas. → single replica for
  this build (also forced by the Railway volume).
- **Graceful shutdown:** `await app.stop()` on `SIGTERM`/`SIGINT`, drain in-flight handlers.
- **`ack()` 3 s deadline applies over the socket too.**
- **Web API calls are independent of the socket** — plain HTTPS with the bot token, normal rate
  limits, `WebClient` retries with backoff by default.
- If the socket refuses to open: `xapp-` token missing `connections:write`, or Socket Mode not
  toggled on.

Sources: <https://docs.slack.dev/apis/events-api/using-socket-mode/> · <https://github.com/slackapi/bolt-js/issues/1906> · <https://github.com/slackapi/node-slack-sdk/issues/1243>
