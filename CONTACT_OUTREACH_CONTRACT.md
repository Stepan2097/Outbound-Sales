# Contract: connection requests, acceptance, and one history per person

Phase 5. Builds on `WARMUP_CAMPAIGNS_CONTRACT.md`, `WARMUP_SCHEDULER_CONTRACT.md`
and `WARMUP_INBOX_CONTRACT.md`.

Work in two repositories: the store, the API and the lead workspace here; the
LinkedIn hands — clicking Connect, reading the sent-invitations page — in the
agent at `/Users/Apple/Desktop/github/warm-up-linkedin`.

## Why

A seller opens a person on the lead workspace, sees their LinkedIn, and has
nowhere to go. Writing to a stranger on LinkedIn means connecting first, and
connecting means an account — and the accounts are one screen away, in a
feature that only ever sent requests from a campaign queue, to people a
campaign picked, for reasons the seller never sees.

This phase joins the two halves. The person in front of the seller gets a
connection request from a chosen warmed account, the request is watched daily
until it is accepted or it is not, and everything that was ever said to that
person — the request, the LinkedIn messages both ways, the emails — is one list
under their name.

The division of labour is deliberate and it is the whole design: **the machine
does the mechanical part — sending, checking, recording — and the human writes
the words.** Nothing in this phase sends a message on its own.

## Five facts about the code that reshape the plan

Each of these was read, not assumed. They are here because three of them change
what the phases can contain.

**1. Nothing sends a connection request today.** `POST /api/warmup/leads/take`
(`warmup/api.mjs:1578`) is bookkeeping only: it re-reads the lead from the CRM,
checks the quota, writes a `wl_outreach` row as `pending`, commits the action
and logs `outreach.sent`. No browser is involved. The agent refuses the work on
purpose — `agent/run-account.mjs:393-403` logs `agent.deferred` and says
"connection request(s) left for today — sent from the leads queue, not by the
agent". So "add automatically" is new work in the agent, and the portal half is
a queue the agent drains, not a send button.

**2. A waiting invite cannot be a claim.** `releaseExpiredClaims()`
(`api.mjs:177`) **deletes** every row with `status = "queued"` older than
`CLAIM_TTL_HOURS` (default 20), workspace-wide, on any account's next Claim or
Release click. `GET /queue` and `GET /api/warmup/agent` both also hide rows
older than that cutoff. An invite queued at 10:00 today is invisible from 06:00
tomorrow and deleted by the first click after that — three hours before the
09:00 session window opens. Twenty is less than twenty-four: "waits for
tomorrow" as a `queued` row is not merely fragile, it is impossible.

**3. `connected` already means something else.** `OUTREACH_STATUSES` is
`["pending", "connected", "declined", "withdrawn"]`, and the only automatic
writer of `connected` is `markReplied` (`inbox.mjs:404-421`), which fires when
the inbox sync finds an inbound message for a `pending` row and sets
`responded_at` to that message's time. **Accepted-and-silent — the exact state
this phase must wait in — has no representation, and writing `connected` for it
would destroy the portal's only signal that somebody actually replied.**

**4. The agent will never be woken for invite work.** `AGENT_KINDS` is
`["profile_view", "like"]` (`scheduler.mjs:34`), `dueFrom` computes `remaining`
over those two kinds only and skips any account with `remaining <= 0`, and
`run-account.mjs:140-146` exits before launching Chrome when the day's plan is
done. An account with ten invites queued and its views and likes finished is
not due, is never leased, and never opens a browser. Phase 2 is not only two new
actions — it is `connect` joining the kinds that make an account due, in both
repositories.

**5. The agent cannot say who an action was for.** `POST /api/warmup/agent`
action `record` takes `{ kind, count, detail }`, where `detail` is free text
truncated to 200 characters and lands in `meta.detail`. There is no
`outreachId` and no `crmContactId` anywhere in the agent vocabulary except the
inbox's `participant`. Nothing the agent reports today could move a named
person's row out of a queue.

## The storage decisions, and what they cost

No migration can run against the Anty Supabase — no Postgres password, no
`exec_sql`. That was established in `WARMUP_INBOX_CONTRACT.md` and nothing has
changed. Three decisions follow.

### A fifth status on `wl_outreach`, called `waiting`

`wl_outreach_person_once` is UNIQUE on `crm_contact_id` alone. One person, one
row, across every account and every campaign. So the row that holds a person
while their invite waits and the row that records the sent invite must be the
same row — which rules out keeping the intent purely in events and leaving the
person unheld, because `nextCandidates` only excludes contacts that already have
a `wl_outreach` row, and an unheld person can be claimed out from under the
seller by a campaign the same afternoon.

The status column is plain text with no check constraint. `waiting` needs no
migration, and it is **immune to the claim sweep by construction**: every DELETE
in the codebase is guarded `.eq("status", CLAIM_STATUS)`, and `waiting` is not
`queued`. The risk flips from "deleted by surprise" to "never released", which
is the better risk to hold — it is one new path to write rather than five
existing ones not to break.

What it costs, and every one of these must be done or the status is a bug:

- `progressFrom` (`campaigns.mjs:255`) is a binary split — `queued` is queued,
  **everything else counts as sent**. Untouched, every waiting invite inflates
  every campaign's "approached" number.
- `GET /api/warmup/outreach` excludes only `CLAIM_STATUS`, so a waiting invite
  would appear in the list of people we have approached. It has not been.
- `WARMUP_OUTREACH_LABEL` / `WARMUP_OUTREACH_TONE` (`app/main.js:5648`) is the
  only place a status becomes Ukrainian, and it is already wrong: it carries
  `replied`, `accepted`, `skipped` and `failed`, which nothing writes, and omits
  `queued`, `declined` and `withdrawn`, which something does. Unknown statuses
  fall through as raw English on a Ukrainian screen. This phase rewrites that map
  to the real vocabulary and adds the two new values.
- Nothing releases a `waiting` row. Cancelling is a seller action
  (`POST /api/warmup/invites/cancel`), and a row nobody cancels waits until an
  account can send it. **This is the deliberate trade and it must be visible:**
  the panel shows how long a row has been waiting, and an invite older than seven
  days is shown as stale with a one-click cancel.

### `accepted`, between `pending` and `connected`

A sixth value, written only by the agent's daily check. `pending` → `accepted`
when LinkedIn shows the connection is made; `accepted` → `connected` stays with
`markReplied` when they actually write. `markReplied` currently matches only
`pending` rows and must match `accepted` too, or the first reply from an
accepted invite is never recorded.

This is what unlocks the panel's "they accepted, write to them" state, and it is
the only reason the seller ever needs to look at this screen twice.

### Invites live in `wl_events`, contained in `warmup/invites.mjs`

Everything about an invite that is not its status — who asked for it, with what
note, when the agent looked and what it saw — is an event, exactly as messages
are. Types: `invite.requested`, `invite.sent`, `invite.checked`,
`invite.cancelled`, `invite.failed`.

**Contain it.** Every read and write of these five types goes through
`warmup/invites.mjs` and nothing else touches `wl_events` for this purpose. When
a password arrives, moving to real tables is that one module and no callers.

One warning inherited from the inbox: `wl_outreach` is **not** contained the way
messages are — `anty.from("wl_outreach")` appears 17 times in `api.mjs`, 3 times
in `inbox.mjs` and once in `targeting.mjs`. The new module owns the events; the
status writes stay where they are and every one of the readers above has to be
taught the two new values by hand.

## Phase 1 — the request, from the lead workspace

### `GET /api/warmup/invites/accounts`

Which accounts can carry an invitation today, and how much room each has left.

```
{ success: true,
  accounts: [
    { id, label, login, status, health,
      connectsLeft: 3, connectQuota: 5, connectsDone: 2,
      waiting: 4,                       // rows already queued on this account
      canSend: true,
      reason: ""                        // why not, when canSend is false
    }
  ] }
```

`connectQuota` and `connectsDone` come from `checkQuota(account, run, "connect",
0)`, which answers without writing anything. An account is offered when
`status === "warming"`, `health === "ok"`, `profile_remote_id` is set and an
active run exists — the same four conditions the scheduler's candidate query
uses, so the picker cannot offer an account the scheduler will never lease.
`canSend: false` with a `reason` is a normal answer and is shown, not filtered
out: a seller who cannot see the blocked account cannot understand why their
invite is not going.

### `POST /api/warmup/invites`

```
body   { accountId, crmContactId, note }
200    { success: true, invite: { outreachId, accountId, accountLabel,
                                   crmContactId, status: "waiting",
                                   note, requestedBy, requestedAt,
                                   connectsLeft } }
409    { success: false, error: "Ця людина вже в аутрічі",
          existing: { accountLabel, status, createdAt, sentBy } }
```

In order: re-read the contact from the CRM (the snapshot must be taken now, not
taken from whatever the panel had on screen); insert `wl_outreach` with
`personSnapshot(lead)`, `sent_by: sentBy(account)`, `status: "waiting"` and the
note; write `invite.requested` with `{ outreachId, crmContactId, accountId,
requestedBy, note }`.

**The quota is not spent here.** It is spent when the agent reports a real send,
because the thing worth counting is the thing that happened. A seller can queue
an invite on an account with nothing left today; the response says
`connectsLeft: 0` and the panel says it goes tomorrow.

The 409 is a screen, not an error: `wl_outreach_person_once` fires as SQLSTATE
23505 and the handler turns it into the row that already exists, so the panel can
say which account holds this person, since when, and how it ended.

### `POST /api/warmup/invites/cancel`

`body { outreachId }`. Deletes the row when its status is `waiting`, writes
`invite.cancelled`, refuses anything else — a sent request cannot be unsent from
here, and pretending otherwise would leave the person unheld while LinkedIn still
shows a pending invitation.

### `POST /api/warmup/invites/sent-by-hand`

The bridge that makes this useful before the agent can do anything: the seller
sent the request themselves, in their own browser. Writes the row straight to
`pending`, spends the quota through `checkQuota` + `commitAction`, logs
`invite.sent` with `by: "seller"`. This is exactly what `POST /leads/take` does
today and it delegates to the same code path rather than copying it.

### The lead workspace

A section appears when the open lead has a LinkedIn URL. Account picker showing
each account's remaining connects, the invitation note prefilled from
`contacts/drafts.mjs` `linkedin.invite` and editable, one button.

Then the state, in the seller's words:
`В черзі на акаунті «Chloe» · піде завтра` → `Надіслано 21.09` →
`Прийняв(ла) 22.09 — можна писати` / `Не прийняв(ла)`.

An accepted invite shows the `linkedin.body` draft and a copy button. It does
not send it.

## Phase 2 — the agent sends, and checks every day

### `GET /api/warmup/agent` — one addition

**Built and answering.** Beside `queue`, `session`, `inbox` and `window`:

```
invites: {
  toSend:  [ { outreachId, crmContactId, name, company, position, linkedin, note } ],
  toCheck: [ { outreachId, crmContactId, name, linkedin, heldAt } ],
  lastCheckedAt: "2026-09-21T09:12:04.318Z" | null,
  connectsLeft: 3
}
```

`toSend` is already cut to `min(connectsLeft, 10)`, oldest queued first, so the
agent is not handed a request the server would refuse a moment later. `toCheck`
is every `pending` row for this account, oldest first, capped at 20 — a check
costs no allowance, and without the cap it grows into a crawl of everybody this
account ever wrote to. `note` is the text the seller wrote; send it as the
invitation note, do not compose one.

### `POST /api/warmup/agent` — `invite.sent`

**Built and answering.**

```
body { action: "invite.sent", accountId, outreachId,
       outcome: "sent" | "already_pending" | "already_connected"
              | "no_button" | "profile_gone" | "blocked" }

200  { success: true, status: "pending", moved: true,  connectsLeft: 2 }
200  { success: true, status: "waiting", moved: false, recorded: "no_button" }
200  { success: true, status: "pending", moved: false, reason: "already" | "refused" | "raced" | "gone" }
404  { success: false, error: "That invitation is gone" }
409  { success: false, error: "That invitation belongs to another account" }
409  { success: false, error: "No warm-up in progress" }
409  { success: false, error: "Daily quota reached (5)", quota: 5, done: 5 }
```

| outcome | status becomes | allowance | what it means |
|---|---|---|---|
| `sent` | `pending` | **spent** | the card read Connect, we clicked, it now reads Pending |
| `already_pending` | `pending` | not spent | it already read Pending before we clicked — last run's crash |
| `already_connected` | `accepted` | not spent | they are already in the contacts |
| `no_button` | unchanged (`waiting`) | not spent | no Connect control on the profile |
| `profile_gone` | unchanged (`waiting`) | not spent | 404, redirect, or a members-only wall |
| `blocked` | unchanged (`waiting`) | not spent | an interstitial or rate-limit page |

A `409` on quota is an ordinary answer, not a failure: **stop the send step for
the day** and leave the rest queued. A `moved: false` with a `reason` is also
ordinary — somebody else moved the row — and is worth one log line, not a retry.

### `POST /api/warmup/agent` — `invites.checked`

**Built and answering.**

```
body { action: "invites.checked", accountId,
       results: [ { outreachId, state: "accepted" | "pending" | "gone" } ] }
200  { success: true, checked: 14, accepted: 2, withdrawn: 0,
       refused: [ { outreachId, from: "connected", to: "accepted" } ] }
```

`accepted` → status `accepted`, `responded_at` untouched (nobody has said
anything yet). `gone` → `withdrawn`. `pending` changes nothing. At most 20
results are read; the rest are ignored rather than rejected.

`refused` lists moves the transition table would not make — almost always
because the inbox sync already recorded a real reply for that person inside the
same run. That is correct and expected; it is reported so that a run of them
can be noticed.

**Send this call even when nothing changed** — `results: []` is a valid body and
writes the `invite.checked` row. Without it, "nobody is accepting" and "the
agent stopped looking" are the same empty screen.

### What the portal does not check, and you must

`outreachId` is trusted to be one this account holds — the route refuses one
belonging to another account with a 409 — but nothing checks that the profile
you clicked is the person in the row. **The link in `toSend[].linkedin` is the
only authority on who to open.** A request sent to the wrong person cannot be
undone: `wl_outreach_person_once` is unique on the contact, so the row now says
this account approached somebody it did not.

`toSend` can be empty while `connectsLeft` is positive, and that is not an
error — it means nobody is queued. Do not fall back to inventing recipients;
that is the rule `run-account.mjs` has followed from the beginning and it is
why every request in this system is attached to a person and a status.

### The second, cheaper road to the same answer

If the inbox sync stores an inbound message from somebody whose row is `pending`
or `accepted`, they have obviously accepted. `markReplied` already does the
`connected` half; it gains the `pending → accepted → connected` path so the
acceptance is recorded even when the invitations page is unreadable. **When the
agent's selectors rot, the history does not stop.**

### For the session working in `warm-up-linkedin`

The send step **replaces** `run-account.mjs:393-403` — after the views and likes,
before the inbox. After, because an invitation is the most expensive and least
reversible thing in the run and should not be what a rate-limit interstitial
costs, and because a Connect fired thirty seconds into a session is the shape
this whole folder exists to avoid. Before the inbox, because displaying a
conversation marks it read and that is the destructive step.

**Read the top card before clicking, always, and report what it said even when
it is not what was asked for.** That is the reconciliation, not an optimisation.

Report after LinkedIn confirms, never before. Retry the report twice, three
seconds apart — the ordinary failure here is a dropped socket, not a dead
process — and if it still will not go, **stop the send step for the whole run**
rather than opening the next person.

**Correction to this contract, made while building it.** It said `connect` must
join `AGENT_KINDS`. It must not. `dueFrom` computes `remaining` from quota
alone, so adding the kind there makes every account due every morning for as
long as it has allowance, and the browser opens to send nothing. What is now
built instead: `dueFrom` takes an `invitesWaiting` count per account and adds
`min(waiting, connectLeft)` to `remaining`, pushing `connect` into `kinds` only
when somebody is actually queued. The evidence for waking an account is a
person waiting, not an unspent allowance.

The early-exit gate at `run-account.mjs:140-146` still has to count invite work,
or an account whose views and likes are done exits before opening Chrome. That
half is in the agent repository.

### What this costs, and it is a real cost

The count moves when the agent says an invitation went out, and it says so only
after the card reads Pending. Between the click and the report there is a window
— a dropped socket, a sleeping Mac, a killed process — in which the invitation
exists and the day counter does not know it. **So an account can send one more
request than its day allowed, on a day the agent died mid-invitation, and the
portal does not find out until the next run.** It is bounded at one per crash, it
stops the run when it happens, and it is corrected the next time the agent opens
that profile and reads Pending where it expected Connect.

Spending the allowance before the click never exceeds the day's quota and was
refused anyway: a reservation is only useful attached to a person, and
`wl_outreach_person_once` makes a row written for an invitation that never went
out permanent across every account.

## Phase 3 — one history per person

### `GET /api/warmup/history?crmContactId=`

One list, newest first: the invitation and what became of it, LinkedIn messages
both ways, emails both ways once Phase 4 lands.

```
{ success: true,
  contact: { crmContactId, name, company },
  outreach: describeOutreach(row) | null,
  entries: [ { kind: "invite" | "message" | "email",
               direction: "out" | "in" | null,
               at, accountLabel, body, meta } ] }
```

Two problems this has to solve, and both are named rather than hidden:

**History is keyed by thread today, not by person.** Nothing writes
`crm_contact_id` into a message event's meta; the person is recomputed on every
read by matching a name or a profile slug against `wl_outreach`. A person who
renames their LinkedIn profile drops out of their own history. From this phase
on, `storeThread` writes `meta.crmContactId` when it matched an outreach row, so
history by person becomes a filter rather than a reconstruction — for everything
stored after the change. **Older messages keep the old, fragile matching, and
that is a gap this phase does not backfill.**

**`created_at` on a sent row is the claim time, not the send time.** Nothing
rewrites it when a claim becomes a send, which `campaigns.mjs:248` relies on
elsewhere. A history ordered by it places the invitation hours early. The
timeline uses the `invite.sent` event's timestamp and falls back to `created_at`
only when there is no event — which is every row written before this phase.

### `POST /api/warmup/history/message` — "записати як надіслане"

The seller wrote the first message by hand in LinkedIn and records it here. This
reverses a decision `WARMUP_INBOX_CONTRACT.md:296` made deliberately —
"Replying from the portal … should not ride in on the back of a read" — and the
reversal is narrow: **the portal still does not send anything.** It records that
a human did.

The duplicate is the real problem. Suppression in `inbox.mjs` keys on exactly
one thing — `meta->>externalId`, matched by a read before the write — and a
hand-written message has no LinkedIn id at all. When the sync later reads that
same conversation, the message is stored a second time and the history lies
about what happened.

**Adopt on sight.** The hand-recorded message is written as `message.out` with
`meta.provisional: true`, a portal-minted `externalId`, and
`meta.fingerprint = sha1` of the body normalised to single spaces and lower
case. On the next `storeThread` for that account, each fresh outbound message is
fingerprinted the same way and, when it matches a provisional row, that row is
**updated in place** with the real external id, the real thread key and the real
timestamp instead of a second row being inserted.

What it costs: the normalisation is a judgement about what "the same message"
means that a unique constraint would have made for us — an edited message is a
new one and both survive. It is a second read-before-write with the race the
module already admits about the first, and it is the first UPDATE this codebase
performs on `wl_events`, so the service-role grant has to allow it. **Verify the
UPDATE works against the live table before building the rest of Phase 3** — if it
does not, the fallback is to suppress at render time and carry two rows forever.

## Phase 4 — email

**Stop here and show the provider choice before writing any of it.** SMTP is out:
`package.json` has no `dependencies`, `node_modules` does not exist, and the
Dockerfile runs no install. Mail goes over HTTP through `fetch`, the way
OpenRouter, Apify and FullEnrich already do.

Two candidates, and they differ in more than convenience:

- **Gmail API on the team's Google Workspace.** The letter leaves the seller's
  real address at `@advantage-agency.co`, replies land in the mailbox they
  already read, and the same API reads them back, so inbound is solved by the
  same integration. Cost: OAuth with a refresh token per seller, and a domain
  Google can suspend for the whole team at once.
- **Resend or Postmark on a separate domain.** One API key, delivery webhooks,
  an inbound webhook. Cost: a second sending identity to warm up, and replies
  arrive at an address nobody reads by hand.

Whichever is chosen: keys in the existing encrypted vault, one `email.out` event
per letter with `{ crmContactId, from, to, subject, body, messageId, status,
error }`, and **`email.in` from day one or the contract says plainly that email
history is one-directional.** A history with only our own letters in it is the
half that makes the other half misleading.

One schema problem to solve before any of this: `wl_events.account_id` is a
LinkedIn account, and an email has none. Either emails carry a null account and
every reader learns to expect it, or they live somewhere else entirely. Decide it
in the Phase 4 contract, not in the code.

## Shared code this touches, and must not break

- `progressFrom`, `GET /api/warmup/outreach`, `GET /queue`, `GET /agent` — all
  learn `waiting` and `accepted`.
- `markReplied` — matches `accepted` as well as `pending`.
- `WARMUP_OUTREACH_LABEL` / `WARMUP_OUTREACH_TONE` — rewritten to the real six
  values.
- `AGENT_KINDS` — gains `connect`.
- `POST /leads/take` — its claim lookup is `.eq("crm_contact_id").eq("status",
  CLAIM_STATUS)` with **no account filter**, and the patch it applies sets
  `account_id`. Sending from account B silently re-points a claim account A
  holds, with no event recording it. Harmless while only campaigns claimed;
  reachable the day the panel offers an account picker. **Fix it in Phase 1** —
  scope the lookup, or refuse with the holder's name.

## Not in this phase

Sending the first message from the portal. The seller writes it in LinkedIn and
records it here. Automating that is a different risk with its own quota
treatment, and it is the one thing in this design that is a person's judgement
rather than a machine's patience.

Backfilling `crmContactId` onto messages stored before this phase, and
retro-dating invitations sent before it.

Rate-limiting how many people one seller can queue in a day. The account quota
bounds what goes out; nothing bounds what piles up behind it.
