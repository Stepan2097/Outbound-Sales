# Contract: the inbox — threads, replies, and what they mean

Phase 3. Builds on `WARMUP_CAMPAIGNS_CONTRACT.md` and `WARMUP_TARGETING_CONTRACT.md`.

Three pieces of work in two repositories: the store and API here, the screens
here, and the LinkedIn reader in the agent at
`/Users/Apple/Desktop/github/warm-up-linkedin`.

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
               sentAt: string }] }
```

Upserts: a message whose `externalId` is already stored for this account is
skipped, not duplicated. Returns `{ success, stored, skipped, invalid, undated,
threadKey, matchedOutreachId, statusMoved, crm }`, where `crm` is `"written"`,
`"failed"` or `"skipped"`.

A body is stored to 4 000 characters, marker included. Longer is truncated with
a marker rather than rejected — a long message is still worth having.

**Every field above is optional except `accountId` and `threadKey`.** That is
the agent contract and it is deliberate, because the agent is reading a DOM it
does not control:

- `participant.slug` and `participant.headline` missing or null are normal — a
  group thread has no `/in/` link. A missing `name` becomes `"Unknown"`, which
  is then excluded from name matching so an unreadable thread is not filed
  against a real stranger who happens to be called that.
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
- A message with no body, or a direction that is neither `in` nor `out`, is
  counted in `invalid` and dropped. One unreadable message never costs the
  nineteen around it.

Bodies are stored exactly as the agent found them — no stripping, no escaping.
The screens escape before the DOM, and a mangled body loses the original for
good.

**`inbox.done`** — the sync finished, so the portal can tell "no new messages"
from "the agent never looked".

```ts
{ action: "inbox.done", accountId, threadsSeen: number }
```

Writes an `inbox.synced` event carrying the count and the time. Written even
when `threadsSeen` is 0, which is the point of it.

`GET /api/warmup/agent?accountId=` answers with `inbox: { lastSyncedAt,
maxThreads }` so the agent learns where to stop reading from the portal rather
than from a file beside itself — a Mac that gets replaced or a portal that gets
re-pointed would otherwise re-read a year of history.

### What an inbound message does beyond being stored

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
              participant: { name, slug, headline },
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

## Agent — owns `/Users/Apple/Desktop/github/warm-up-linkedin/agent/**`

A new step at the end of a run, after the quota work, before the session closes.

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

## Not in this phase

Replying from the portal. Reading a conversation is safe; sending is a different
risk, needs its own quota treatment, and should not ride in on the back of a
read. The thread screen shows a reply box only when there is something behind it.
