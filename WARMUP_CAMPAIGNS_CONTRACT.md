# Contract: campaigns — folder × accounts × product, and claiming

Phase 2. Supersedes the targeting shapes in `WARMUP_TARGETING_CONTRACT.md`;
that file stays as the record of how folders, filters, the forecast and identity
work, and everything it says about those still holds.

## What changes, and why it replaces rather than extends

Targeting is one folder, one set of filters, one set of accounts. A campaign is
the same thing with a name, a product and a state. Keeping both would leave two
places that answer "which folder is this account working" — which is exactly the
duplication just removed with `linkedinAccounts`, and it would be worse here
because the two would disagree the first time somebody edited one.

So `state.warmupTargeting` becomes `state.warmupCampaigns`, a list. A saved
targeting migrates on first read into a single campaign named after its folder,
`state: "running"`, keeping its filters and accounts. The old key is left in
place untouched — migration reads it, never writes it — so a rollback loses
nothing.

## The rule that governs everything here

**A campaign proposes; the warm-up disposes.** A campaign never has a pace of
its own. It says who is next; whether anything may be sent today is answered by
`checkQuota` exactly as it is for an action recorded by hand. There is no path
in this feature that writes a day counter without going through it.

This is what makes a campaign safe to point at a folder of twenty thousand
people: it cannot make an account do more than its warm-up day allows, and an
account that is paused after a warning or unhealthy simply contributes nothing.
The pause ends by itself: the day after `paused_until` the account contributes
again, `restricted` on its row or not.

## Claiming

A claim is a `wl_outreach` row with `status: "queued"` — no new table, and the
existing `wl_outreach_person_once` unique index does the work it was built for:
one person, one approach, across every account and every campaign. Verified
against the live database: `status` is plain text with no check constraint, so
`queued` needs no migration.

**Claiming does not spend quota.** Quota is spent when something is sent. A
claim is an allocation, and its cap is today's remaining quota so that nothing
is allocated that could not be sent.

**A claim expires.** A `queued` row older than `CLAIM_TTL_HOURS` (default 20)
is released — deleted, returning the person to the pool. Twenty hours is longer
than any session and shorter than a day, so a crash costs one day at most and
never burns a contact permanently. Release runs at the start of every claim and
on `POST /api/warmup/campaigns/release`.

**One account, several campaigns.** Campaigns carry an `order` — a position in
the list, changed by moving a campaign to it (see `PATCH` below); an account's
remaining quota is offered to them in that order, and the first campaign with
work takes it. Round-robin was rejected: a seller who puts a campaign first
means it, and splitting three ways produces three campaigns that all crawl.

**A position is not a rank.** `order` is a place in the whole list, drafts and
paused campaigns included — they hold a position and can be moved. The number
that decides anything is the rank among `running` campaigns, which is what the
quota is offered along. The two disagree the moment a draft sits between two
running campaigns, so only one of them belongs on screen: show the claim rank,
and say plainly that a campaign which is not running is not in the line. Showing
both numbers in one slot is unreadable, and showing the position alone tells a
seller their draft is first in a queue it is not in.

## Backend

Owns `warmup/**`, `server.mjs`, `tests/**`, and both contract files.

### `Campaign`

```ts
{ id: string,
  name: string,
  folderId: string,
  folderName: string | null,
  filters: { country, position, leadStatus, ownerId },   // as Phase 1
  accountIds: string[],
  productId: string | null,        // from the workspace's own products
  fromDay: number,                 // 1–365, default 7: the day the folder starts feeding (see below)
  state: "draft" | "running" | "paused" | "done",
  order: number,
  createdAt: string,
  updatedAt: string }
```

### `GET /api/warmup/campaigns`

Every campaign, in `order`, each with its forecast and progress.

```ts
{ success: true, campaigns: [{ ...Campaign, forecast: Forecast | null,
                               forecastError: string | null,
                               progress: Progress }] }
```

### `Progress`

```ts
{ queued: number,     // wl_outreach rows for this campaign, status queued
  sent: number,       // status pending or beyond
  replied: number,    // status connected
  claimedToday: number,
  sentToday: number }
```

`sentToday` is **not** counted from these rows. A row claimed yesterday and sent
this morning still carries yesterday's `created_at`, and there is no column to
record the send in without a migration — so it comes from `wl_day_actions`, the
same counter the quota is checked against, summed over the campaign's accounts.
It is the one number here that cannot drift from what was actually sent.

Counted from `wl_outreach` filtered to the campaign's accounts. A row carries no
campaign id — it cannot, without a migration — so a campaign's rows are its
accounts' rows for contacts inside its folder. Where two campaigns share an
account and a folder this over-counts, and that is accepted rather than papered
over: the alternative is a schema change, and the honest fix is to say so in the
response with `progressApproximate: true` when a campaign's accounts appear in
another campaign on the same folder.

It is also true when the CRM could not say which contacts are in the folder at
all: the list still answers, counting every row of the campaign's accounts, with
the caveat set. A panel that loses its campaigns because a count failed is worse
than a number with a note beside it.

Verified live: it fires exactly as specified. Two campaigns on the same folder
with the same account both come back `true`; the same accounts on a different
folder and the same folder with different accounts both come back `false`.

### `POST /api/warmup/campaigns`

Create. Body `{ name, folderId, filters?, accountIds?, productId? }`. Same
validation as Phase 1 targeting: folder must exist, accounts must be real. A new
campaign starts `draft` and last in `order`. `productId` is checked against the
workspace's own products — the ones `GET /api/state` returns as
`products: [{ id, name }]` — and an unknown one is a 400 naming it; `null` is
always allowed and means "not chosen".

Answers `201` with the single campaign, enriched exactly as a row of the list:

```ts
{ success: true, campaign: { ...Campaign, forecast, forecastError, progress,
                             progressApproximate } }
```

The single campaign rather than the whole list, so the panel can splice it in
without a second round trip.

### `PATCH /api/warmup/campaigns`

Body `{ id, ...fields }`. Every field optional; what is absent keeps its value.
`state` moves between the four values; moving to `running` writes a
`campaign.started` event, to `paused` a `campaign.paused`. Answers `200` with
the same single enriched `campaign` as `POST`.

**`order` is a move, not a number.** `PATCH { id, order: N }` places that
campaign at position `N` and renumbers its siblings around it, so the list is
always a dense `0..n-1` with nothing sharing a place. Past either end is that
end. `order` stays optional: a PATCH without it moves nothing.

Set-the-number was tried and is wrong. Writing one campaign's `order` and
leaving its siblings alone leaves two campaigns claiming the same position, and
the tie-break by age then quietly keeps the older one in front — so "put this
one first" did not put it first, and an account's whole quota stayed captured by
whichever campaign was created earliest. The tie-break by age remains as the
fallback for any stored state that somehow still has duplicates; it is no longer
something a normal write can produce.

Every write renumbers, so a delete closes its gap too — otherwise the positions
left behind (0, 2) would make "move to position 1" mean two different things.

This is the reorder control the claiming rule depends on: an account's quota
goes to the first campaign in order, and "a seller who puts a campaign first
means it" is only true if putting it first is something a seller can do.

A single-campaign response cannot carry a field computed **across** campaigns.
`progressApproximate` and the effective order are both relational: editing one
campaign can change another's, and only `GET /api/warmup/campaigns` sees all of
them. Use the returned campaign for instant feedback and reload the list after
a write.

### `DELETE /api/warmup/campaigns?id=`

Removes the campaign and releases every `queued` row belonging to its accounts,
for contacts in its folder. Rows already sent stay — they are history, and
history is not the campaign's to delete. Answers `{ success: true, released }`.

Where the CRM cannot say which contacts are in the folder, only the accounts no
other campaign works are released: another campaign's allocation is not this
one's to throw away.

### `POST /api/warmup/campaigns/claim`

The heart of it. Body `{ accountId, limit? }`.

1. Release expired claims across the board.
2. Refuse unless the account is warming and healthy — 409 naming the reason.
3. Ask `checkQuota(account, run, "connect", 1)` what today allows; compute
   `remaining = quota - done`. Zero means a 200 with an empty list and a reason,
   not an error: "day 2 of 14, connection requests start on day 4" is the
   expected answer for most accounts this week.
4. Walk this account's campaigns in `order`, `state: "running"` only. For each,
   take candidates from its folder+filters, excluding anyone already in
   `wl_outreach`, and insert `queued` rows until `remaining` is used up.
5. A `23505` on insert means another account claimed that person a moment ago —
   skip them and continue, never fail the batch.

```ts
{ success: true,
  claimed: [{ outreachId, accountId, crmContactId, name, company, position,
              linkedin, campaignId, campaignName, claimedAt }],
  remainingQuota: number, reason: string | null, released: number }
```

`released` is how many expired claims step 1 let go — the queue shrinking under
somebody's feet is worth a word. It is news rather than state: it belongs to the
claim that happened to do the releasing, and it is deliberately absent from
`GET /api/warmup/queue`, which answers what is held now.

`remainingQuota` is `quota - sent today`, and claiming does not change it. It
answers "how many more may go out today", which is a different question from
"how many are queued".

**The cap is `quota - sent - already queued`.** What is already claimed counts
against the day even though it has spent nothing: without that, clicking Claim
twice allocates twelve people to an account that can send six. A second claim on
a full queue is therefore a 200 with an empty list and the "already claimed"
reason below — the ordinary answer, not a failure.

### The reasons, exactly

`reason` is non-null only on a 200, and it is the string the panel renders where
the list would have been. A 409 carries `error` and no `reason`.

| when | `reason` |
| --- | --- |
| quota has not opened | `Day 2 of 14 — connection requests start on day 4` |
| no requests planned at all | `Day 2 of 14 — no connection requests are planned for today` |
| today's allowance is spent | `Day 11 of 14 — today's 5 connection requests are already spent` |
| enough is already claimed | `5 already claimed and today allows 5 — work through the queue first` |
| working mode, today's allowance is spent | `Working mode, day 17 — today's 12 connection requests are already spent` |
| the warm-up is over (only a snapshot with nothing after its last phase) | `The warm-up is finished — day 15 of 14` |
| no campaign points here | `No running campaign works this account` |
| the folder is exhausted | `Nothing left in "Media buyers" that has not been approached` |

The 409s, which are refusals rather than answers: `Excluded from warm-up`,
`Account health: Needs login`, `No warm-up in progress`, `Paused until <date>`.

### `POST /api/warmup/campaigns/release`

Body `{ accountId? }`. Releases expired claims, or every claim for one account
when asked. Returns `{ success, released: number }`.

A claim expires after `CLAIM_TTL_HOURS` (default 20). A value that is not a
positive number falls back to 20 rather than meaning "release on sight".

### `GET /api/warmup/queue?accountId=`

What is claimed to an account right now, oldest first — the list a person or the
agent works through. Same row shape as `claimed` above.

```ts
{ success: true, accountId, queue: [...], reason: string | null }
```

Always a 200 short of an unknown account. An account that is paused, unhealthy
or three days from its first request still has a queue worth showing, and "why
is it empty" is the question the panel is really asking — so `reason` carries
the same sentences as `claim`, including the 409 wordings, and is null whenever
the queue has rows. An empty queue with nothing else wrong reads
`Nothing is claimed to this account right now`.

Expired claims are hidden here rather than deleted: a read that quietly rewrites
the database is a read nobody can reason about. The next claim releases them.

### `POST /api/warmup/leads/take` — changed

Still the one place a request is recorded. Now it also closes a claim: when a
`queued` row exists for that contact it is **updated** to `pending` rather than
inserted, so the claim and the send are one row and the unique index is never
fought. A contact with no claim still works — that is the manual path, and it
inserts as it does today.

The quota check stays exactly where it is: before any write, refusing without a
trace, as Phase 1 documented. The update is guarded on the status it was read
with, so two screens sending the same claim leave one send and one honest 409.

`GET /api/warmup/outreach` stops returning `queued` rows. That list means "who
we approached", and a claim is an allocation nobody has sent yet; `GET
/api/warmup/queue` is where those live.

### `GET /api/warmup/leads` — changed again

It drew from the one saved targeting. It now draws from a campaign: `?campaignId=`
names one, and without it the first `running` campaign in order — the same one
`claim` would serve. With no campaign to draw from it is still a 409, now
`Create a campaign before pulling leads`, carrying `needsCampaign: true` and
`needsTargeting: true` so a panel that has not moved yet still tells the prompt
from a real failure. The response gains `campaign`, and keeps `targeting` as the
same folder-and-filters shape Phase 1 documented.

### `GET|POST /api/warmup/targeting` — gone

Both routes are removed and `state.warmupTargeting` is read only by the
migration. There is one place that answers "which folder is this account
working", and it is the campaign list.

### `GET /api/warmup/agent` — one addition

The agent's plan gains `queue: [...]` — what is claimed to this account now, in
the same row shape as `claimed` — so a run does not need a second call to find
its work. It sits beside `account`, so an account that is not runnable still
reports what it is holding. Expired claims are left out: they belong to the pool
again whether or not anything has deleted them yet.

## Where it is kept

`state.warmupCampaigns` in `server.mjs`, a list, saved by
`writePersistentWorkspaceState()` like everything else the workspace remembers.
`server.mjs` hands `handleWarmupApi` a `{ read, write, readTargeting, products }`
store, so nothing under `warmup/` knows where the file is.

`readTargeting` is Phase 1's key and is never written. The migration runs on the
first read and writes the migrated list straight through, so from that moment
the list is the only answer — and a rollback to Phase 1 finds its targeting
exactly as it was saved.

## What this was checked against

Live, on the real databases, on 16 September 2026:

- **The migration.** A saved Phase 1 targeting on "media buyers" came back as
  one `running` campaign, 4 670 matching contacts, `perDayNow` 0 and
  `perDayAtPeak` 12 over two accounts — 390 days to finish. `warmupTargeting`
  was byte-for-byte unchanged afterwards.
- **Day 1–3 is the normal state.** All four warming accounts are on day 1 or 2,
  and today's connect quota is 0 for every one of them. `claim` and `queue` both
  answer 200 with `Day 2 of 14 — connection requests start on day 4`.
- **Claiming does not spend quota.** On a probe account on day 12 with a quota
  of 5: claims of 2, 2 and 1 filled the queue while `remainingQuota` stayed 5,
  and the next claim answered `5 already claimed and today allows 5`.
- **A send closes the claim.** `leads/take` on a claimed contact left the *same*
  row, `queued` → `pending`, exactly one row for that contact, and moved the day
  counter to 1 of 6. A second take answered 409.
- **The index is real.** A second row for a person who already has one is
  refused with `23505`, carried through with its code — which is what the claim
  loop skips on.
- **The TTL works.** A claim stamped 30 hours ago was released by
  `POST /campaigns/release` with no body.

## Frontend

Owns `app/index.html`, `app/main.js`, `app/styles.css`.

The Targeting panel becomes the **Campaigns** panel in the same place. What was
one form is now a list plus a form; the forecast sentence, the today-vs-peak
line and the red/amber states from Phase 1 are kept exactly as they are, shown
per campaign.

### Campaigns list

Each row: name, folder, how many accounts, product, state pill, and the one
number that matters — `sent` of `remaining`, with the forecast sentence beneath
the selected one. Controls per row: start / pause, edit, delete.

`progressApproximate` renders as a quiet note next to the number, not a warning
badge: it is a caveat about counting, not a problem with the campaign.

### The queue

**The queue is per account, not per campaign.** `claim` and `queue` both take an
`accountId`, and a claimed row carries no campaign of its own — it is attributed
by folder after the fact. So an account working two campaigns shows one merged
list under both of them, and a **Claim now** click under campaign A can
legitimately claim for campaign B, because the quota belongs to the account and
the first campaign in order takes it.

That is the design, not a gap: say so on screen rather than implying a
per-campaign queue that does not exist. Name the campaign beside any row that
came from a different one, and count the list by accounts ("4 held by 2
accounts"), not by campaign.

Under the selected campaign, per account: what is claimed to it right now, with
the person's name, position, company and a link to their LinkedIn profile, and a
**Sent a request** button that calls `leads/take`. Empty is the normal state for
an account whose quota has not opened yet — say which day requests start, the
way the Phase 1 panel already does, rather than showing an empty box.

A **Claim now** button per account calls `campaigns/claim`. When it returns an
empty list with a reason, show the reason where the list would be. The same
`reason` comes back on `GET /api/warmup/queue`, so an empty queue never needs a
sentence the frontend invented.

The product `<select>` is filled from `GET /api/state` → `products: [{ id, name }]`,
and `selectedProductId` is a reasonable default for a new campaign.

### What must not regress

The forecast is still the centre of the panel. A campaign on a folder of twenty
thousand still has to read as twenty thousand — moving from one form to a list
must not shrink that sentence into a number in a table cell.

One trap in the `Forecast` shape: `remaining: 0` has two causes that need
opposite advice. Everyone matched has been approached, or nothing matched at
all. Branch on `matching === 0` first — a filter that matches nobody must read
as "nothing in this folder passes these filters", never as "everyone has already
been approached", which is flatly false and sends the seller looking for work
that was never there.

## A running campaign sends: the folder feeds its accounts

Added after working mode, the pause and the note rule. Before this a campaign
only proposed: its people reached the agent one at a time, through a seller
queueing each of them from the lead workspace, and "Закріпити зараз" made
claims that only a human could send. A running campaign on "ліди з linkedin2"
looked alive — forecast, rank, "#1 у черзі" — and the agent sent nobody from it.

**The rule.** For every account ticked on a `running` campaign, from the
campaign's `fromDay` on — working mode included — the server tops that
account's `waiting` invitations up from the campaign's folder to **today's
remaining connection allowance** (`quota - sent today`), with nobody clicking.
No folder is hardcoded: the operator picks it in the campaign form as before.

- **`fromDay`, default 7.** Days 4–6 allow one or two requests and they are for
  the account's own team and verified contacts, which a seller still queues by
  hand from the lead workspace. A campaign that *is* the team folder can say 4.
  Stored on the campaign (`Campaign.fromDay`, integer 1–365); `POST` and
  `PATCH /campaigns` accept it, absent means 7 on create and "keep" on edit,
  anything else is a 400 `«З якого дня» — ціле число від 1 до 365`. A campaign
  saved before this reads as 7.
- **The same path as a seller's invitation.** Each top-up is `requestInvite`: a
  `waiting` row plus an `invite.requested` event, now with
  `meta.source: "campaign"`, `campaignId`, `campaignName` and `note: null`. So the
  person's history shows it, cancel and move work on it, and the phase's note
  rule applies (there is no note to apply it to). One `campaign.fed` event per
  top-up says how many and why (`meta.fedToday` is the day's running total).
- **Only from the campaign's day, sent as well as added.** A folder's waiting
  row is handed to the agent only while the account's day is at or past the
  `fromDay` of the campaign that fed it (a deleted campaign reads as 7), and the
  scheduler and the top-up count it only then (`sendableToday`). Without it, a
  run stopped and started again sent the folder's leftovers on its days 4–6.
- **Picked by hand first.** The room is `left - waiting - live claims`
  (`folderRoom`): what a seller queued, and claims somebody took to send
  themselves, come off before the folder adds anybody. `invitesToSend` then
  hands the agent the hand-picked waiting rows ahead of the folder's, each
  oldest first — so a person picked after the folder already filled the day
  still goes first, and the stranger they displace waits for tomorrow.
- **Who is skipped.** Anybody with a `wl_outreach` row in any status on any
  account (approached, claimed, waiting, connected — held by another account
  included), and anybody whose `linkedin` is not a profile link: `queueQuery`
  now requires `linkedin ilike *linkedin.com/in/*`, so that also narrows the
  forecast's `matching` and the manual claim. Competitors are the folder's
  business: curate the folder, or cancel the person's invitation from their
  card — see the next point.
- **Anybody the folder let go.** A `campaign.skipped` event marks a person the
  folder must not offer again: written when a seller cancels a folder-fed
  invitation (`reason: "cancelled"`) and when the agent reports a held outcome
  about the person on one (`reason: "held"`, and the row is deleted — see
  *Held outcomes* below; a `no_note` from an out-of-date agent writes none).
  It carries the contact id and the profile slug, and the walk steps over both.
  It binds the folder only: a seller can still queue the person by hand.
- **One profile, one person.** The CRM holds some people twice — two contact
  ids, one LinkedIn profile — and the unique index only knows the id. So the
  people about to be offered are also checked by normalized `/in/` slug
  (`linkedinSlug`): against every `wl_outreach.person_linkedin` (asked as an
  `or=(person_linkedin.ilike.*/in/<slug>*,…)` prefix and compared exactly),
  against the skip markers, and against each other within the walk. The same
  member no longer gets a request from two of our logins.
- **When.** When the agent asks for its work (`GET /agent`, before `invites`
  is built), which it does straight after taking the account. Not on
  `POST /agent/lease` any more: that answers at once and only counts, like the
  poll — see `WARMUP_SCHEDULER_CONTRACT.md`. Idempotent — the room is counted
  from what is held now, so asking again adds nobody — and one fill per
  account at a time, so two questions arriving together fill it once.
  `GET /agent/due` stays free of side effects: it only *counts* what the folder
  could offer (see `WARMUP_SCHEDULER_CONTRACT.md`, *A campaign's folder is
  work*), so an account with folder room and views already done is still woken.
- **Never more than a day.** A top-up never goes past today's allowance, so
  nothing piles up: whatever did not go today counts against tomorrow's room.
- **Twice the day's quota a day, at most.** However the room frees up, the
  folder adds at most `2 × today's connect quota` people to one account per day
  (`FOLDER_DAILY_FACTOR`), counted from today's `invite.requested` events with
  `meta.source: "campaign"` on that account. `folderRoom` and the scheduler's
  `folderWork` apply the same cap, so an account at it is not woken for its
  folder. This is what bounds an agent that fails every profile (selector rot,
  stale links): two days' worth of the folder, not the folder.
- **Nothing while it cannot send.** A paused, unhealthy, excluded or not-yet-
  allowed account (days 1–3), a campaign that is not `running`, or an account
  not ticked on it gets nothing.

**The walk scales now.** `nextCandidates` moved to `warmup/feed.mjs`. It read
five pages from the front of the folder and stopped, so once about two hundred
people had been approached it answered "nothing left" with thousands still
there. It now pages on the server (`offset`, with `id` breaking `created_at`
ties — a folder imported in one statement shares one timestamp), grows the page
as it goes, and remembers per folder query where the approached head ended
today, so the next walk starts there. The hint is only a starting point: every
person offered is still checked against `wl_outreach`. It resets each day, which
is how people added to the folder or released back to it are found.

**The manual button keeps working**, from the same walk (`takeFromCampaigns`).
Its capacity now counts the account's `waiting` invitations as well as its
claims, so a claim on a day the folder already filled answers
`N already claimed and today allows N — work through the queue first` rather
than allocating people the day can never send.

**`GET /api/warmup/queue?accountId=&campaignId=`** gains two fields, so the
panel can show the account is fed:

```ts
waiting: [ { outreachId, accountId, crmContactId, name, company, position, linkedin,
             claimedAt, fromFolder: boolean, campaignName: string | null,
             parked: boolean } ],
autoFeed: null | {
  campaignId, campaignName, fromDay, day: number | null, working: boolean,
  running: boolean, ticked: boolean, blocked: string | null,
  on: boolean,            // this campaign fills this account by itself today
  ahead: [ { id, name } ],// running campaigns ranked above it that feed this account today
  connectsLeft: number
}
```

`ahead` exists because the top-up fills the room first campaign first: while a
campaign above has people, the folder of the one on screen never moves even
though it is `on`. The panel then says the account is filled by «…» first and
that this folder is taken from only when theirs runs out, instead of «працює».
It holds only campaigns that take today — running, ticking this account, with
a `fromDay` the account has reached — and is `[]` when `on` is false. A server
from before it sends no `ahead`, which the panel reads as nobody ahead.

`campaignId` picks the campaign `autoFeed` is about (the panel's selected one);
without it, the account's first running campaign. The panel shows the line only
when `autoFeed.campaignId` is the campaign on screen, drops an answer that
arrives after the selection moved, and reloads the queues when «Редагувати»
selects another campaign — the queue cache is keyed by account alone, and two
campaigns can tick the same account. The panel says whether the
folder is feeding, from which day it will, and lists what waits for the agent
with "з папки" / "вручну" beside each person. The campaign form has a
"Автопідбір із папки з дня" field. A running campaign's row says "сам бере з
N-го дня"; a draft or paused one "братиме з N-го дня, коли працюватиме"; a
finished one nothing. The running campaign's note says the feed starts on each
ticked account's own warm-up day N — not on the campaign's first day — and
after the campaigns above it in the list that tick the same account.

**Held outcomes.** A request the browser could not send (`no_button`,
`profile_gone`, `no_note`, `blocked`) is handled by who picked the person:

- **Folder-fed:** the row is deleted, and the folder fills the place today
  within the daily cap. Left waiting, such a row was retried every morning
  ahead of the day's new people and held a slot of the account's allowance for
  as long as nobody looked. After `no_button`, `profile_gone` or `blocked`,
  `campaign.skipped` is written first and the folder never offers the person
  again — `blocked` deliberately: the page may have been about the account,
  but a second pause of the account costs more than one lead. After a
  `no_note` on a request handed over bare (always the case for a folder row
  unless somebody set a note on it), the agent is out of date, not the person:
  no marker, and the person is back in the pool to be fed again later. The
  same for any held report that comes while the account is already paused —
  an agent that went on after an earlier block page: about the account, no
  marker. A retry of the `blocked` that started the pause is not one of those:
  it is skipped like the first report would have been.
- **Hand-picked:** the row stays `waiting` for the seller, and rests until
  tomorrow — `invitesToSend` leaves it out and neither the scheduler nor the
  top-up counts it. Before, one broken profile link kept its account due all
  morning, re-opened every few minutes to fail on the same profile. A
  `blocked` parks it at once: not handed out — not even alone in the queue
  after the pause — not counted, and shown as «Потребує уваги» until a person
  moves it to another account or cancels it and queues the person again. A
  `blocked` that comes while the account is already paused parks nobody.

See *A held report while the pause holds* in `CONTACT_OUTREACH_CONTRACT.md`.

A held report the agent sends again (it retries what it got no answer to) is
answered as the first was and changes nothing, except to finish letting a
folder's row go when the first report failed part-way through that — see *A
held report sent again* in `CONTACT_OUTREACH_CONTRACT.md`.

`GET /queue`'s `waiting[]` rows carry `parked` for the panel, and the lead
card's invite carries it too; both are read the way the hand-off reads it
(`waitingFacts`).

## Out of scope for this phase

Message text — what is actually written to each person — is Phase 3, together
with `wl_threads` / `wl_messages`. A campaign stores `productId` and nothing
else about wording; the screens may show the product's name but must not imply
a message has been drafted.
