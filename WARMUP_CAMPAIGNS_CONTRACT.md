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
account that is paused, restricted or unhealthy simply contributes nothing.

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
| the warm-up is over | `The warm-up is finished — day 15 of 14` |
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

## Out of scope for this phase

Message text — what is actually written to each person — is Phase 3, together
with `wl_threads` / `wl_messages`. A campaign stores `productId` and nothing
else about wording; the screens may show the product's name but must not imply
a message has been drafted.
