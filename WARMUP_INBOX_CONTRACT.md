> The local agent is implemented in this repository under `agent/`. See `agent/README.md` for the current installation and runtime.

# Contract: the inbox — threads, replies, and what they mean

Phase 3. Builds on `WARMUP_CAMPAIGNS_CONTRACT.md` and `WARMUP_TARGETING_CONTRACT.md`.

Three pieces of work in two repositories: the store and API here, the screens
here, and the LinkedIn reader in the agent at
`agent/`.

## Why

Everything built so far is outbound. A campaign picks people, a claim holds one,
a send records that a request went out — and then the trail stops. When somebody
writes back, nothing sees it. The account's own operator finds out by opening
LinkedIn, and nobody else ever finds out at all.

This phase closes that. It also delivers the two things still missing from the
original ask: a notification that somebody wrote to one of the accounts, and a
history per contact that says from which account, when, what was written and
what came back.

## The storage decision, and its cost

Threads and messages want their own tables. They cannot have them: there is no
Postgres password for the Anty database and no `exec_sql` RPC, so no migration
can run. Both were verified, not assumed.

So they live in `wl_events`, which already has `account_id`, `type`, `message`,
a `meta` jsonb and a timestamp. A message is an event of type `message.in` or
`message.out`, with `meta` carrying the thread key, the participant, the
direction, the external id and the body.

**This is a compromise and it should be written down as one.** What it costs:

- No unique index on the external id, so duplicate suppression is a read before
  a write rather than a constraint. Tolerable because one agent syncs one
  account at a time; not tolerable forever.
- No index on the thread key, so listing threads reads events and groups them in
  memory. Fine at a few thousand, wrong at a hundred thousand.
- The audit log and the message log share a table, so a reader of either has to
  filter. `GET /api/warmup/events` and the dashboard feed now exclude
  `message.in`, `message.out` and `inbox.read` — a message row carries somebody's
  private reply in `meta`, and eight of them would push a whole day of history
  off a panel that shows eight. `inbox.synced` stays visible on purpose: a run
  of zeros is the signal that the agent's selectors have rotted.

**Contain it.** Every read and write of a message or a thread goes through
`warmup/inbox.mjs` and nothing else touches `wl_events` for this purpose. When a
password arrives, moving to real tables is that one module and no callers.

## The agent's way in

The agent runs on somebody's Mac beside Anty, so it has no workspace session and
cannot get one. It authenticates with a shared token, exactly as the FullEnrich
webhook already does in `server.mjs`: the route is matched before the session
gate, the token is compared with `secretsMatch`, and a missing or wrong token is
a 401.

- Env: `WARMUP_AGENT_TOKEN`. Unset means the agent routes are closed, not open.
- Header: `X-Agent-Token`. Never a query parameter — those land in access logs.
- Scope: only `/api/warmup/agent` and `/api/warmup/agent/*`. Everything else
  stays behind the session, including the whole inbox read API. A token that can
  post a message must not be able to read the workspace.
- One route was added under that prefix while building: `GET
  /api/warmup/agent/accounts`, returning `{ id, label, login, profileRemoteId,
  status, health }` per account and nothing else. The agent knows a profile by
  its name and has to resolve it to an id before it can ask for anything, and
  `/api/warmup/accounts` is correctly closed to it. Deliberately thin: no
  proxies, no secrets, nothing from the CRM.

## Backend — owns `warmup/**`, `server.mjs`, `tests/**`, this file

### `POST /api/warmup/agent` — two new actions

**`inbox.thread`** — one conversation as the agent found it.

```ts
{ action: "inbox.thread",
  accountId: string,
  threadKey: string,        // LinkedIn's own conversation id, stable per account
  participant: { name: string, slug: string | null, headline: string | null },
  messages: [{ externalId: string,   // LinkedIn's message id, or a hash of time+body
               direction: "in" | "out",
               body: string,
               sentAt: string }] }   // oldest first, as the thread shows them
```

Upserts: a message whose `externalId` is already stored for this account is
skipped, not duplicated — and so is one that came back under a new id (see
"Once each, and retried" below). Returns `{ success, stored, skipped, repeated,
invalid, undated, threadKey, matchedOutreachId, crmContactId, matchedBy,
statusMoved, crm, crmWritten }`, where `repeated` is the part of `skipped` that
arrived under a new id, `matchedBy` is `"outreach"`, `"linkedin"` or `null` (see
"Once a day, onto the contact" below), `crm` is `"written"`, `"failed"` or
`"skipped"`, and `crmWritten` is how many CRM lines this call wrote.

A body is stored to 4 000 characters, marker included. Longer is truncated with
a marker rather than rejected — a long message is still worth having.

**Every field above is optional except `accountId` and `threadKey`.** That is
the agent contract and it is deliberate, because the agent is reading a DOM it
does not control:

- `participant.slug` and `participant.headline` missing or null are normal — a
  group thread has no `/in/` link.
- `participant.name` is never rejected, and neither is the placeholder LinkedIn
  prints in place of one. A restricted or out-of-network profile renders
  "LinkedIn Member"; deleted accounts render a variant. Those, and a missing
  name, all fold into the single sentinel `"Unknown"`, which the matcher then
  refuses from **both** sides — an unnameable participant matches nothing, and a
  CRM row whose own `person_name` is a placeholder is matched by nobody.
  Without that fold, ten threads called "LinkedIn Member" are ten different
  people all matching one outreach row: one status moved wrongly and a CRM
  activity per person filed against a stranger. The agent sends what LinkedIn
  printed, verbatim; it must not invent a placeholder of its own.
- `messages: []` is accepted, not refused. A conversation the agent opened and
  could not read is a fact worth reporting; a 400 would fail the run over it.
  `messages` present but not an array is a 400.
- `externalId` missing is derived here as `sha1(threadKey|direction|sentAt|first
  200 chars of body)` over the values **as sent**, so re-posting the same
  payload derives the same id and the suppression still suppresses.
- `sentAt` unparseable — and LinkedIn renders "2h" far more often than a
  datetime — is not a rejection. The time we received it is stored instead,
  with `sentAtGiven: false` and the original in `sentAtRaw`, and the message is
  counted in `undated`. Day resolution (`...T00:00:00.000Z`) is taken as given.
  A time that parses but cannot be a reading — before LinkedIn existed, or more
  than a day after the server received it — counts as unparseable: `Date.parse`
  reads the label `"Sep 20"` as the year 2001.
- A message with no body, or a direction that is neither `in` nor `out`, is
  counted in `invalid` and dropped. One unreadable message never costs the
  nineteen around it.
- `externalId` is any text up to 200 characters. A LinkedIn URN such as
  `urn:li:msg_message:(urn:li:fsd_profile:ACoAA…,2-MTY5…)` is fine: every value
  the portal puts into a PostgREST `in.(…)` list is quoted when it holds a
  comma, a bracket, a quote or a backslash (`listValue` in `warmup/rest.mjs`).
  Sent bare, such an id was cut at its comma, matched nothing, and every re-read
  stored and copied the thread again.
- **Order.** `messages` are expected oldest first, top to bottom as the thread
  shows them, and the order posted is taken as the truth. Only ISO-8601
  datetimes can overrule it — a `sentAt` that starts `YYYY-MM-DDTHH:MM` and
  is a plausible reading of a clock: a payload whose ISO times run backwards
  more often than forwards is read as newest first and turned round, and when
  every message has one they are sorted by it. A label never turns a thread —
  not a time of day (`"3:00 PM"` then `"10:00 AM"` is as often yesterday
  afternoon and this morning as the wrong way round), not a day
  (`"Yesterday"`, `"Mon"`, `"Sep 20"`, `"3d"`), and not a date with a year in
  it (`"Sep 20, 2025"`, `"12/9/2025"` — 12 September in a day-first locale,
  9 December to the parser), even when it is stored as a real time
  (`sentAtGiven: true`). Each stored message keeps its place as
  `meta.position`, because the messages of one store share one timestamp, and
  whether its time is an ISO one as `meta.sentAtIso` — what the thread screen
  orders by (`GET /inbox/thread`, below).
- An attachment-only message — a file, a sticker, a voice note — arrives with
  the body `[attachment]`. Carried, never dropped: an inbound file **is** a
  reply, and dropping it would mean the reply detection missed the very thing
  this phase exists to catch. It stores, marks the thread unread, matches, moves
  the status and reaches the CRM like any other inbound message.
- **A row with neither text nor media is not a message.** It is a card — a
  profile picture, a notice LinkedIn put in the thread — and the agent does not
  send it (a conversation made only of such rows is not sent at all). It used to
  arrive as `[no text]`, under the name of its own avatar's description
  («Переглянути профіль Sinan»), and filled the inbox with «conversations» that
  nobody wrote and unread replies nobody sent. The portal now also refuses the
  body `[no text]` at the door (`inbox.thread` answers `cards: N`; not counted as
  `invalid`), and the ones already stored are left out when read: they make no
  thread, no unread, no preview, no participant, no CRM line and no history
  entry. An avatar's description is not a name either — the agent strips
  «Переглянути профіль» / "View profile of" from names.
- A group thread is named by its whole visible row, e.g.
  `"Anna Bauer, Tomás Ruiz"`, and carries no slug. It therefore matches nobody,
  which is the right outcome: filing a group chat under whichever avatar loaded
  first would move one member's outreach row on a message that was never about
  them. Verified against a pending row for a named member — the row stays
  `pending`, and that member writing alone still matches.
- Names are stored with runs of whitespace collapsed to single spaces. The
  agent reads a DOM, so a name split across two elements arrives carrying the
  newline and indentation between them; without collapsing, a ragged
  `"LinkedIn\n   Member"` would skip the placeholder fold above and go back into
  the matcher as an exact-name candidate. Bodies are never collapsed — newlines
  are the message there.

Bodies are stored exactly as the agent found them — no stripping, no escaping.
The screens escape before the DOM, and a mangled body loses the original for
good.

**`inbox.done`** — the sync finished, so the portal can tell "no new messages"
from "the agent never looked".

```ts
{ action: "inbox.done", accountId, threadsSeen: number }
```

Writes an `inbox.synced` event carrying the count and the time. Written even
when `threadsSeen` is 0, which is the point of it. Then retries whatever an
earlier sync could not copy to the CRM, and answers `{ success, threadsSeen,
syncedAt, crmRetried: { owed, written, failed } }`.

`GET /api/warmup/agent?accountId=` answers with `inbox: { lastSyncedAt,
maxThreads, due }` so the agent learns where to stop reading from the portal rather
than from a file beside itself — a Mac that gets replaced or a portal that gets
re-pointed would otherwise re-read a year of history. `due` says whether to read
at all this session (below).

### What an inbound message does beyond being stored

*Superseded in part by "Once a day, onto the contact" below: every new message,
in both directions, is now copied to the CRM, not only the newest inbound one.*

Three things, in this order, each skipped silently when it does not apply:

1. **Match it to an outreach row.** By `participant.slug` against
   `wl_outreach.person_linkedin`, then by exact name among that account's rows.
   No match is normal — people write to an account without having been
   approached by it.
2. **Move the outreach status.** A matched row still `pending` becomes
   `connected`, with `responded_at` set. Already `connected` stays. This is the
   reply detection the seller would otherwise do by hand.
3. **Write it to the CRM.** An `activities` row with `type: "linkedin"`,
   `contact_id` from the matched outreach row's `crm_contact_id`, and a
   `content` naming the account it arrived on. The CRM is where the sales team
   already works; a reply that only exists in this portal is a reply half the
   company cannot see.

The CRM write is best-effort: a CRM that is down must not lose the message. Log
the failure and keep going.

### `GET /api/warmup/inbox`

Threads across every account, unread first, then newest.

```ts
{ success: true,
  unread: number,
  // Top level as well as per thread: the one case this value decides — an
  // empty inbox — is the case with no thread to carry it.
  sync: { accountsTotal: number, accountsSynced: number, lastSyncedAt: string | null },
  threads: [{ threadKey, accountId, accountLabel, accountIdentity: string | null,
              participant: { name, slug, headline, memberProfile: boolean },
              lastMessage: { direction, body, sentAt },
              messageCount: number, unread: boolean,
              crmContactId: string | null, outreachStatus: string | null,
              lastSyncedAt: string | null }] }
```

`?accountId=` narrows to one account. `?unread=1` to unread only.

### `GET /api/warmup/inbox/thread?threadKey=&accountId=`

One conversation, oldest first — the shape the thread screen renders.

```ts
{ success: true, thread: {...as above}, messages: [{ direction, body, sentAt, externalId }] }
```

**Oldest first** is the order the CRM writes the lines in (*The order lines go
in*, below): when each message was stored, then its place in that store
(`meta.position`). A message's own time reorders only messages that both
carry an ISO one (`meta.sentAtIso`): those are sorted by it among the places
the stored order gives them, so an older message a later read found further
up goes where it was sent, and every other message keeps its place. A label
never moves anything — `"12/9/2025"` then `"3/10/2025"`, posted in that
order, reads back in that order, not as December before March. Rows stored
before `meta.sentAtIso` was written carry none and keep the order they were
stored in (inside one store, their times). The inbox list's `lastMessage` is
the last message in this same order, so the preview is the message the
thread ends on.

### `POST /api/warmup/inbox/read`

Body `{ threadKey, accountId }`. Marks it read by writing an `inbox.read` event
and returns `{ success, readAt, unread }`, where `unread` is the new global
count so the screen that just changed the badge does not have to ask again.
Marking an already-read thread is a harmless no-op.

Unread is derived as **an inbound message we STORED after the last read mark**,
not one DATED after it. The difference is the ordinary case: somebody writes at
10:00, you open the thread at 11:00, the agent syncs at 12:00 and stores the
10:00 message. By `sentAt` it is already read and you never see it; by when we
stored it, it is new to you — which it is.

Derived rather than stored because there is no column to store it in, and it has
a property worth having anyway: a new reply to a thread you have read makes it
unread again, with no extra write.

### `GET /api/warmup/config` — one addition

`unreadReplies: number`, so the nav badge does not need a second request. It is
`null` — not absent, not 0 — when the database could not be reached: "nobody
wrote" and "we could not tell" have to be tellable apart, or a badge that
quietly vanishes during an outage reads as an empty inbox.

## Frontend — owns `app/index.html`, `app/main.js`, `app/styles.css`

### The badge

A count on the Warm-up nav item when `unreadReplies > 0`. This is the whole
notification for now: the workspace's `notifications` setting has channels for
email and Slack, but none of them are wired to anything, and a badge that is
true beats a channel that silently does nothing.

### Inbox panel

Above Campaigns, because a reply outranks a plan. Each thread: who wrote, which
account it arrived on — by the account's real identity, not its profile label —
the first line of the last message, when, and an unread mark. Clicking opens the
thread.

An empty inbox says which it is: nothing has arrived, or no account has synced
yet. `lastSyncedAt` is what tells them apart, and the difference matters because
one of them means the agent is not running.

### Thread view

The conversation oldest first, inbound and outbound visually distinct. Above it:
the person, their LinkedIn link, the account that holds the thread, and the
outreach status when there is one. Opening a thread marks it read.

### What must not regress

The campaigns panel and its forecast keep their place and their weight. The
inbox goes above them without shrinking them.

## Agent — owns `agent/**`

A new step at the end of a run, after the quota work, before the session closes
— **only when `GET /agent` answers `inbox.due: true`** (once a day; see below).

- Open `https://www.linkedin.com/messaging/`, let it settle the way
  `settle()` already does for the feed — poll for something conclusive rather
  than sleeping a fixed time.
- Read the conversation list. For each conversation touched since the account's
  last sync, open it and read the messages.
- Post each conversation with `inbox.thread`, then `inbox.done`.
- Cap it: at most 20 conversations a run, and stop at the first one older than
  the last sync. Reading the whole history every day is both slow and a pattern.

**Class names are hashes and will change.** Read what LinkedIn cannot obfuscate:
the conversation list is links to `/messaging/thread/`, a message's author is
distinguishable by whether its avatar link points at the account's own slug.
Where a selector is unavoidable, fail soft — report zero threads and log why,
never crash the run.

**A sync that reads zero threads on an inbox that is not empty is a silent
failure and the most likely one.** Log `threadsSeen` every run so it is visible;
a run of zeros is the signal that the selectors have rotted.

### Pointing at this portal

The agent currently talks to `http://127.0.0.1:3100` with no authentication.
It gains `--portal <url>` (already present) plus `WARMUP_AGENT_TOKEN`, sent as
`X-Agent-Token`. The Mac portal ignores the header, so one build works against
both while the transition lasts.

## Replying from the portal

Reading a conversation is safe; sending is a different risk, and it was kept out
of the read for exactly that reason. It is here now — as a request, not an action.
The portal owns no browser. A reply written on the thread screen is **queued**
and the account **sends it in its own next session**, after its daily inbox read.
That is the design and not a gap to close later: opening a warming account's
browser the moment somebody presses a button is an unscheduled session, which is
the one signal this folder exists to avoid.

### The queue

A reply is a `wl_events` row `outbox.queued` (`meta.threadKey`, `meta.body`,
`meta.participantName`), never rewritten; what becomes of it is a second row that
points back with `meta.replyId` — `outbox.sent`, `outbox.failed` (with
`meta.reason`) or `outbox.cancelled` — and the newest decides. A reply nobody got
to in 72 hours reads as `expired` and is never sent. `outbox.queued` is hidden
from the audit log (it is somebody's private words); the others are not.

Refused when written (`POST /api/warmup/inbox/reply`, `{accountId, threadKey, text}`):

- the thread or the account does not exist (404);
- **nobody has written to the account in that thread** — that is a first message,
  which has its own allowance and its own place in «Прогрів» (409);
- **the account would not be opened**: excluded, no warm-up in progress, paused,
  or health not ok (409, with the reason in words) — a reply the agent can never
  send is refused now rather than found out three days later;
- empty, or over 2000 characters (400);
- more than 5 already waiting on the account, or `INBOX_REPLIES_PER_DAY`
  (default 10) sent and waiting together today (429).

The same words in the same thread while one is still waiting are that one
(`duplicate: true`), so a double click or a re-sent request queues once.
`POST /api/warmup/inbox/reply/cancel` `{accountId, replyId}` takes a waiting reply
back, or puts away one that did not go; a sent one is refused (409).

`GET /api/warmup/inbox/thread` carries `outbox` (waiting, failed and expired ones,
and sent ones until their message turns up among the stored messages, so a send
whose conversation re-read failed does not vanish for a day) and `reply`
`{canWrite, reason, limit, goesOutAt, goesOutToday, goesOutSoon, window, sentToday,
perDay}`. `goesOutAt` is the account's planned session time (`nextSession`), and
`goesOutSoon` is true when that moment has passed but today's session is still owed.
`GET /api/warmup/inbox` carries `sync.byAccount` (each account's own last read) and
`sync.window`.

### What the agent does

`GET /agent` carries `outbox: {toSend: [{id, threadKey, text, name}], waiting,
sentToday, perDay}` — the oldest waiting, at most 3 a session and never past the
day's limit, and **empty** where the account would not be opened (paused, no run,
excluded, unhealthy). After the inbox read, in the same visit:

1. `outbox.prepare {replyId}` before **each** one — `{allowed, reason, stopAll,
   reply: {id, threadKey, text}}`. The plan was cut earlier and a person may have
   taken the reply back since; the text comes only with a yes, and `stopAll`
   (a warning, a pause) ends the visit.
2. Open `/messaging/thread/<key>/`. If the conversation already ends with our own
   message in the same words, do not type: report `outbox.failed`.
3. Find **exactly one** composer (two on the page is not guessed at), put the
   cursor in it (checked), type in runs of whole characters with human pauses
   (Shift+Enter for a line break), and check the field holds exactly what was
   written and the send button is live. Anything else: clear the field and
   report `outbox.failed` with the reason. No draft is left in a real messenger.
4. Press the button; **sent means seen** — the message must be on the page one
   more time than before. The field emptying is not enough. If it never appears:
   `outbox.failed` «невідомо, чи пішло — не надсилайте вдруге».
5. `outbox.sent {replyId}` — retried, and the visit stops if it cannot be made, because a
   reply that went out and is not recorded would be handed out again tomorrow.
   Then the conversation is re-read and posted through `inbox.thread`, so the
   message the portal shows is LinkedIn's own and not a copy of what was typed.

`outbox.failed` is final: the agent never retries by itself, since whether a
message went is the one thing it can fail to know. The person sees the reason and
can write again.

## Once a day, onto the contact

What the seller asked for: read each account's messages once a day and write
into the contact's information what we wrote to them and what they answered.

### When the inbox is read

`GET /api/warmup/agent` carries `inbox.due`. It is `true` when the account has
no `inbox.synced` today, on every day it has a plan — days 1–14 and working
mode alike — and `false` while a warning's pause holds (then `maxThreads` is 0
as well). It turns `false` the moment `inbox.done` is written. The same rule is
`upkeep.inbox`, and the scheduler wakes an account for it: an account whose
views, likes and requests are done but whose inbox is unread today is handed
out with `remaining: 0` and `upkeep.inbox: true`.

One bound on that wake, in memory like the cool-off: a session that was handed
the account with the read owing and reports `run.finished` with `ok: true`
spends the day's wake for it. If that session did not read the inbox (an older
agent build, broken selectors), the account is not handed out again *for the
inbox alone* that day; `inbox.due` still says `true` if it is opened for
anything else.

Out of plan — only a strategy snapshot with no working mode, which no current
strategy produces — the old evidence rule stays: an open conversation, and
unread today.

### What reaches the CRM

Every message stored for the first time — `message.out` and `message.in` —
whose thread is tied to a CRM contact becomes one `activities` row
`{ contact_id, type: "linkedin", content }`, one insert per line so the CRM's
own timestamps keep the conversation's order. The line names the direction,
the account, and the message's real time in UTC:

```
LinkedIn · Ми написали з акаунта chloe@example.com · 2026-09-20 09:00 UTC
Дякую, що прийняли запит!
LinkedIn · Відповідь на акаунт chloe@example.com · 2026-09-20 11:30 UTC
Привіт! Розкажіть більше.
```

A time LinkedIn only gave as a label (`"2h"`) is written as that label plus
when it was read.

**The order lines go in** is the order their rows were stored, and inside one
store the message's place in the thread (`meta.position`, above) — not the
message's own time, which for a label is only when it was read. Before a
thread's new lines, the same call writes what that contact is still owed on
this account: lines an earlier copy failed on, and the thread's messages
stored while nobody knew who it was with. So after an outage the older lines
land before the new reply, not after it. A connection request that went out (`invite.sent` with the
row now `pending`, a seller's `sent-by-hand`, or `POST /leads/take`) becomes one
line too, with the note it actually carried when that is known (`Записка: …` or
`Без записки.`); a request sent by hand says nothing about a note, because
nobody here saw it.

**Tied to a contact** means: the account's own `wl_outreach` row, matched as
before (slug, then exact name); failing that, the CRM contact whose `linkedin`
column is the same `/in/` profile slug (exact slug, not a prefix; never by
name; never a company page). The CRM is asked first for links that end where
the slug ends (bare, `/…`, `?…`), and only if none of those is the person for
any link that starts with it — a short slug can start more contacts than one
page of candidates holds. A thread matched only this second way moves no
outreach status. Either way `meta.crmContactId` is written on the stored
messages, so the person's history finds them on every account.

- **The name is never enough against two profiles.** A name match is refused
  when the participant's slug and the row's slug are both known member
  profiles and differ — a namesake writing in is somebody else. Only an `/in/`
  link, or a bare slug as the agent sends it, is a known member profile, on
  either side. The participant's link is cut to its slug when the thread
  arrives, so its shape is kept beside it as `participant.memberProfile`:
  `https://www.linkedin.com/pub/jane-doe/1a/2b/3c` is stored as the slug
  `"3c"` with `memberProfile: false`, and rules nothing out. A
  member-id slug (`/in/ACoAA…`, `/in/ACwAA…`, how messaging links a profile)
  is not a vanity slug and rules nothing out; nor does a company, school or
  showcase page, a `/pub/…` link, or a link of any other shape (a Sales
  Navigator lead, say), whether in the CRM's LinkedIn column or as the
  participant's link — none of them says who the person is not. A participant
  stored before `memberProfile` existed has only its slug, and counts as it
  did then.
- **The account's approaches are read whole**, page by page: one request is cut
  at 1 000 rows, which working mode reaches in a few months, and a reply from
  anybody past the cut matched nothing. The inbox list reads them the same way.
- **One person held twice** in the CRM goes to the contact an approach of any
  account names (`wl_outreach.crm_contact_id`), else the one in a running
  campaign's folder, else the oldest.
- **The slug goes into `ilike` literal**: `%`, `_` and `\` are escaped and `*`
  becomes `_` (`likeLiteral`). A percent-encoded Cyrillic slug is nothing but
  `%` signs, and unescaped each was a wildcard: pages of lookalike links pushed
  the real contact off the 50-candidate page. The folder walk's profile check
  builds its patterns the same way (`slugLikeForms` in `warmup/db.mjs`).

### Once each, and retried

The CRM has no confirmed `external_id` or `occurred_at` column
(`CRM_API_CONTRACT.md`, "Add or confirm"), and inserting a column the table does
not have fails the row. So nothing beyond `contact_id`, `type`, `content` is
sent; the time is in the text; and the idempotency key is kept on our side: the
`wl_events` row the line was made from — a stored message, which the
suppression below stores exactly once, or the event that recorded the
request.

A message is stored once on two counts. By `externalId`, as before; and, when
its id is new, by content (`splitRepeats`): it is a repeat of a row already
stored in the same thread when it went the same way with the same body and the
two times cannot tell them apart — equal, or at least one of them a label
(`sentAtGiven: false`, or a stored time that cannot be a clock reading: rows
stored before the plausibility check hold `"Sep 20"` as the year 2001). One
stored row answers for one arriving message, and a row whose own id the check
by id found has answered already, so two identical
messages that are both in what the agent read stay two. This catches the id an
agent hashes over a time label that has aged since yesterday. What it cannot
tell apart it keeps once: an agent posting only the newest messages, with no
times, and a word-for-word repeat among them. `repeated` in the answer counts
these; a count every morning means the agent's ids are not stable.

- A line that landed is recorded in a `crm.copied` event (`meta.eventIds`),
  hidden from the account log like the messages themselves.
- A line that did not — the insert failed, or the CRM could not be asked who the
  person is — is recorded in `inbox.crm_failed` (`meta.owed: [{ eventId, since
  }]`, no message text: this row is shown in the account's log). Visible at
  `warn`.
- `inbox.done` makes every owed line again from its stored row, for up to
  `CRM_RETRY_DAYS` (7) from its first failure. A line is never written twice
  unless the CRM accepted an insert and then failed to answer, or the
  `crm.copied` marker could not be written after it (logged on the server with
  the row ids).
- Copies for one account run one at a time (in memory; the server is one
  process): an `inbox.done` sent again while the first is still retrying waits,
  then finds nothing owed. Each line is also looked up among the `crm.copied`
  markers right before its insert, so a line copied since it was read as owed
  is passed over.
- **A thread matched late is copied whole, once.** Messages stored with no
  contact carry `meta.awaitsContact: true`. When a later read ties the thread
  to a contact, those stored since the thread was last tied to anybody are
  copied with the new ones, in order — the markers keep it to once. Rows
  owed to another contact are left to that copy.
- **The person's history** (`GET /history`, the Контакти card) finds such a
  message by the marker that names the contact (`crm.copied` or
  `inbox.crm_failed` with `meta.contactId`), since the row itself keeps its
  null key. It shows as `matchedBy: "contact_id"`.
- Messages stored before this change are not backfilled: the old code wrote the
  newest inbound reply of each sync without a key, and copying those threads
  again would duplicate them. Their rows carry no `awaitsContact`, so a late
  match does not pick them up either.

### What the agent must do

- Read the inbox when, and only when, `inbox.due` is `true`, in the same
  session, then post `inbox.done` (even with `threadsSeen: 0`). A session
  opened with `remaining: 0` and `upkeep.inbox: true` exists for this read.
- Send **both directions**: our own messages as `direction: "out"`. They are
  half of what the CRM now shows.
- Make `externalId` **stable across days**: LinkedIn's message URN when the DOM
  carries one, or a hash that does not include the relative time label. A label
  that changes from `"10:42"` to `"Sep 25"` produces a new id. The portal now
  catches most of those by content (above) and says so in `repeated`, but it
  can only guess where a stable id would know.
- Post **the whole visible thread**, not only what is new since the last sync:
  the repeat check tells a word-for-word second "ok" from yesterday's first one
  by seeing both. Post it **oldest first**, top to bottom as the thread shows
  it. A newest-first payload is recognised by its ISO times and turned round;
  one with only labels — dates with a year included — is taken exactly as
  posted.
- Send a real time (`sentAt` as an ISO datetime, e.g. from the message's
  `<time datetime>`) where the DOM has one. A label is stored as a label and
  the CRM line says "у LinkedIn «10:42», прочитано …" instead of the time.
- Nothing else: the request line, the matching and the retries are all here.

**Until the agent is updated.** The deployed build ignores `inbox.due` and
reads the inbox at the end of every session, as the old contract said. With
working mode and the folder feed an account can have two sessions a day, so it
is read twice. Nothing is done about that on the server: `maxThreads` stays 20
while `due` is false, and the second read costs only the visit — the ids, the
repeat check and the `crm.copied` markers keep every message stored once and
copied once. The updated agent must gate the read on `due` itself, not on
`maxThreads`, and stop reading once `inbox.done` is posted for the day.
