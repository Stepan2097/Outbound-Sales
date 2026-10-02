> The local agent is implemented in this repository under `agent/`. See `agent/README.md` for the current installation and runtime.

# Contract: the server decides when, the Mac only does it

Phase 4. Builds on the three contracts before it.

## Why

The warm-up is launched from the Mac today, in two places. A clock inside the
Next.js portal process ticks every few minutes, works out who owes work, and
spawns the agent. A second runner, `run-today.mjs`, asks the portal who is
warming and then paces the accounts itself with its own two-to-seven minute gap.
So the schedule lives in two files on one laptop, and the portal process that
holds half of it is also the thing that has to stay alive for any of it to
happen.

That is one laptop away from nothing running at all, and it very nearly was
this morning.

Everything about *deciding* moves to the server. What cannot move is the doing:
Anty, the browser profiles and their sessions are on the Mac, and no amount of
API design changes that. So the Mac keeps the hands and loses the head.

This is the rule the agent already follows for quotas — the portal decides what
may happen, the agent decides how — extended from the quota to the clock.

## What the server owns after this

- The session window, and whether we are inside it.
- Which account is due, and in what order.
- That only one account runs at a time.
- The gap between accounts.
- The cool-off after a failure.
- The lease, so two workers cannot take the same account.

## What the Mac owns after this

Opening the browser and performing the actions. Nothing else. After this change
the Mac no longer runs a portal at all — the Next.js app and its LaunchAgent
stop being part of how the warm-up runs, and the only long-lived process is a
worker that asks the server what to do.

## Backend — owns `warmup/**`, `server.mjs`, `tests/**`, this file

### The scheduler

A tick inside the Outbound Sales process, started at boot, disabled by
`WARMUP_SCHEDULER_DISABLED=1`. It keeps no work of its own: it decides, and a
worker asks. There is no `spawn` anywhere in this — the thing it used to launch
is on another machine.

Due, in the order the old scheduler used:

1. The account is `warming` — or `restricted`, which is what a warning leaves
   behind — with `health = ok` and an Anty profile.
2. Its run is live (`running`, or `paused` with `paused_until` behind it), the
   pause does not hold today, and it is inside the plan. Past the last phase is
   working mode, which is inside the plan — see *After day 14: working mode*.
   A pause holding today takes the account out entirely, upkeep included — see
   *After a warning: the pause*.
3. Today's quota still has something left in it for a kind the agent can do —
   `profile_view` and `like`. Connection requests come from a campaign's queue
   and are counted separately. Or upkeep is owed: invitations to check, or
   today's inbox read — see *The inbox, once a day*.
4. It is not in cool-off, not leased to somebody else, and not resting: its
   last session that finished (`run.finished` with `ok: true`) ended at least
   `WARMUP_SAME_DAY_GAP_MINUTES` (60) ago — see *The second session of a
   morning*.
5. Anty does not already have its profile open. The lease covers the workers
   that ask; this covers the ones that do not — an old portal still running, or
   a person who opened the profile by hand. Both have to go through Anty to get
   a browser, so Anty is where they are visible.

Accounts that have not had a session today first, then plan work before
upkeep, then oldest run first: an account waiting since day one goes before one
enabled five minutes ago, but not before an account that has had nothing yet
this morning.

### `GET /api/warmup/agent/due`

Token-scoped, like the rest of `/agent/*`. The worker's question — and only the
question. It grants nothing, so `leaseId` and `leaseExpiresAt` come back null
and probing it costs nothing at all. Taking the account is the POST below, and
the two must never be merged back together: see *What this got wrong*.

```ts
{ success: true,
  window: { startHour, endHour, label, open },
  next: null | { accountId, label, profileRemoteId, day, mode: "warmup" | "working",
                 remaining, kinds: string[], leaseId: null, leaseExpiresAt: null },
  reason: string | null,
  retryAfterSeconds: number }
```

### `POST /api/warmup/agent/lease`

`{ accountId }`, the account the GET just named. 200 takes it:

```ts
{ success: true,
  lease: { accountId, label, profileRemoteId, day, remaining, kinds: string[],
           leaseId: string, leaseExpiresAt: string } }
```

`lease` is field-identical to `next`, with the two nulls filled in, and it is
the authoritative one: the window, the quota and the lease are all re-checked
here, because an answer a worker sat on for ten minutes is a claim about three
things that may all have moved.

409 refuses it, and a refusal is an ordinary state rather than an error — the
loser of a race polls again:

```ts
{ success: false, error: string, reason: string, retryAfterSeconds: number }
```

`error` and `reason` are the same sentence, in the stable wording the worker
deduplicates on: "Chloe Stewart is already running", "Chloe Stewart is in
cool-off", "Chloe Stewart is resting between sessions", "Chloe Stewart already
has its profile open", "that account does not owe work right now", "outside
09:00–13:00".
404 is an account id that does not exist, and is the only answer a worker should
treat as final.

**`retryAfterSeconds` is the whole point.** It is how the server paces the Mac,
and the worker obeys it without having an opinion:

| Situation | `retryAfterSeconds` |
|---|---|
| Outside the window | seconds until it opens, capped at 900 |
| Inside, nothing due | 300–540, jittered |
| Inside, an account named | 120–420 — what to do if it does not take it |
| Another worker holds a lease | seconds until that lease expires, capped at 900 |

Every one of them is a whole number between 1 and 900, and the cap is enforced
in the arithmetic rather than promised in prose.

`reason` is a sentence for the log when `next` is null — "outside 09:00–13:00",
"nothing owes work today", "Chloe Stewart is already running".

A lease is granted for `LEASE_MINUTES` (default 25) and lives in memory. A
worker that dies mid-run costs one lease period and nothing more: the account
is available again the moment the lease runs out, with no same-morning rest,
because that rest starts only from a `run.finished` with `ok: true`. In memory
rather than in the database because a lease is about right now, and a
restarted server that has forgotten one is a server that correctly believes
nobody is running.

**One grant at a time, for real.** `leaseAccount` asks "is anybody running"
before its reads and again after them, with no `await` between that second
check and the grant. The reads take a dozen round trips and a folder walk, and
two workers taking two different accounts in that time used to both be
granted — two profiles opened at once. Now exactly one is, and the other gets
the ordinary 409 naming the winner.

**The lease answers at once.** It writes nothing for a campaign's folder any
more: `GET /agent`, which the agent asks straight after the lease, does the
same idempotent top-up, and doing it here too only delayed the one reply whose
loss strands a lease — a worker that times out on it never learns the
`leaseId` the server already granted.

### `POST /api/warmup/agent` — one new action

```ts
{ action: "run.finished", accountId, leaseId, ok: boolean, note?: string }
```

Releases the lease, writes a `scheduler.finished` event, and on `ok: false`
puts the account in cool-off for `COOL_OFF_MINUTES` (default 45) — the same
backstop the old scheduler had, for the failures health does not capture: Anty
holding the profile open, a proxy that is down, a browser that would not start.
The cool-off is the whole wait after a failure: no same-morning rest is added
to it, and the event's message ("not handed out again for N min") and
`meta.coolOffMinutes` state it. On `ok: true` there is no cool-off; the account
rests `WARMUP_SAME_DAY_GAP_MINUTES` from the report before it is handed out
again (see *The second session of a morning*). A report that comes after its
lease ran out still counts from when it came.

The answer carries the gap: `{ success, nextInSeconds }`, drawn 120–420 seconds
and jittered, because two sessions a minute apart from one machine is the shape
of a tool.

A `run.finished` with an unknown or expired lease is accepted, not refused — the
run happened either way and the report is worth more than the bookkeeping.

### What does not change

Quota, claiming, the inbox and every existing agent action stay exactly as they
are. This adds a way to be told when to start; it changes nothing about what
may then happen.

## Agent — owns `agent/**`

### `agent/worker.mjs` — new, and the only thing that runs continuously

```
node agent/worker.mjs --portal https://outbound-sales.169-58-60-245.sslip.io
```

A loop, and deliberately a dull one:

1. `GET /agent/due`.
2. No account → log the reason once when it changes, sleep `retryAfterSeconds`,
   repeat. The same reason repeated every five minutes is noise nobody reads.
3. An account → run the existing `run-account.mjs` against it, unchanged.
4. `run.finished` with the outcome, then sleep `nextInSeconds`.

It carries no window, no order, no gap and no idea which account is next. Every
one of those is a question it asks. If the server says sleep for fifteen
minutes, it sleeps for fifteen minutes.

Survives the network being down: a failed poll is a warning and a retry, never
an exit. The worker is meant to run for weeks.

### `ops/` — the LaunchAgent changes what it starts

It currently runs `npm start`, which is the Next.js portal, because the
scheduler lived inside it. It now runs the worker. The portal is no longer part
of how the warm-up runs and does not need to be up.

### `run-today.mjs` and `run-account.mjs`

`run-account.mjs` is unchanged — it already takes an account and a portal and
does one visit.

`run-today.mjs` loses its pacing: no window check of its own, no gap of its own,
no list of its own. It becomes what it should have been — a manual "run this one
now" for a person who wants to catch an account up, and it says plainly that the
schedule is the server's.

## Not in this phase

Running the browser on the server. That needs the Anty cloud container out of
its Phase 1 detection experiment and the agent moved onto the GUI launch path,
and it is a larger piece of work than everything in these four contracts put
together. This phase makes the Mac replaceable rather than removing it: any
machine with Anty and this worker becomes the hands, and the server does not
care which one.

## What this got wrong

Eight things, found building it.

**A lease only binds the things that ask for one.** The old portal's scheduler
is a process, not a file, and taking the machinery out of `scheduler.ts` does
not reach a `next-server` that has been running since yesterday with the old
build in memory. It launched four sessions this morning — 07:05, 07:14, 07:29
and 07:39 UTC — and the last of them was on the account this server spent the
morning offering to a worker, which is why that account reads as owing three
profile views twenty minutes after a browser was on it. Two decision-makers,
one profile directory, and nothing in either of them can see the other.

So "is it leased" is not the same question as "is it running", and the second
one has an answer: Anty. Anything that opens one of these profiles has to go
through it, so `anty_browser_profiles.status = running` now takes an account out
of the due list however much it owes, and both `/due` and `/lease` say
"<Label> already has its profile open". That closes the window on a second
launcher and on a person who opened a profile by hand; it does not close the
one where another scheduler is making decisions, because nothing in a database
can. **The old portal has to be stopped, and that is an operational step, not a
code change.**

**A GET granted a lease, and that was the serious one.** Written as one call,
`/agent/due` answered the question by taking the account — so the first curl
anybody ran against it parked a real warming account for twenty-five minutes,
in the middle of the 09:00–13:00 window, and said nothing anywhere. A health
check on that URL, a monitor, an `--once` sanity run, a client-side timeout on a
request the server had already answered, or a browser tab left open would each
have cost a session, and the only symptom is a quiet morning — the exact failure
this phase exists to stop. The worker found it with its first exploratory
request and I reproduced it immediately.

It is now split: the GET answers and takes nothing, `POST /agent/lease` takes
it. **Do not merge them back together for convenience.** The two calls are one
round trip apart and the second one re-checks everything anyway; what the split
buys is that the safe operation is the one that looks safe, which is the only
form of this that survives contact with a person holding curl. The race the
split creates — two workers both told the same account is next — is honest and
cheap: one POST wins, the loser gets a 409 naming the holder and a number to
sleep on, and nobody runs the same profile twice from two machines.

**`reason` cannot carry a number, and neither can the bound.** The worker logs a
reason once and stays quiet until it changes, which is the only thing standing
between a five-minute poll and a log nobody reads. A countdown inside the
sentence — "in cool-off for another 31 min" — makes every poll a new reason and
produces exactly the spam the rule exists to prevent. `reason` is now fixed text
plus, at most, an account label; everything that moves is in
`retryAfterSeconds`. And that number is clamped rather than trusted to stay
inside its range: the wait on a lease came back at 1498 against a stated ceiling
of 1500, which is one second of clock drift from breaking a bound somebody else
is clamping against, and `LEASE_MINUTES` is a variable a deployment can raise.

**Cool-off needed a sentence of its own.** The table has four cases and none of
them fits an account that owes work and may not have it: "nothing owes work
today" would be a lie, and the operator reading the log would go looking for a
quota bug. It reads `Chloe Stewart is in cool-off`, and an account with nothing
left today is deliberately not reported that way — "in cool-off" has to mean
work is waiting, or it reads as a stuck account.

**`WARMUP_SCHEDULER_DISABLED=1` has to reach `/agent/due`, not just the tick.**
Written as a tick switch, it would have stopped a clock that no longer starts
anything while the route kept handing out real accounts to any worker that
asked. The deployment that is not meant to drive anything is the one with a
worker pointed at it by mistake. It is a fifth reason —
`the scheduler is switched off on this deployment` — and it answers 900.

**The gap when an account is handed out is a fallback, not the pacing.** "The
gap after it finishes" cannot be known at the moment it is handed out; the
number that paces the Mac is `nextInSeconds` in the `run.finished` answer. The
`retryAfterSeconds` that rides along with an account is what a worker comes back
on if it dies between being handed the account and saying what happened, and it
is drawn from the same 120–420 so that death costs one gap rather than a morning.

**`nextInSeconds` after a failure is the gap, not the cool-off.** The contract
sets both numbers and never says which one comes back. It is the gap: the
cool-off is about that account, not about the Mac. Returning 45 minutes there
would park four healthy accounts behind one broken one.

**The tick had nothing left to do, so it was given the thing nobody else is
awake for.** With `spawn` gone, the worker's poll moves all the work and a clock
inside the server decides nothing. What survives is bookkeeping: a lease whose
worker died is swept and written down as `scheduler.lease_expired`, because
"handed out and never reported back" is the line somebody needs when they ask
why a morning was quiet, and without it a dead worker leaves no trace at all.

**Not fixed here, and it will bite on the first deploy: the window moved
timezone when the decision did.** `insideWindow()` reads the local clock, and
the local clock used to be the operator's Mac. On the server it is the
container's, and the image sets no `TZ`, so Alpine is UTC: 09:00–13:00 becomes
11:00–15:00 for an operator in CEST, and the Mac sits idle through the morning
it was meant to work. The fix is one line — `ENV TZ=Europe/Kyiv` in the
Dockerfile, or the zone the operator actually keeps — but it is a decision about
whose day the window means, not a bug in the scheduler, and the Dockerfile is
not this phase's file.

## After day 14: working mode

Added after this phase shipped. Day 15 used to be the end: no quota for
anything, `plan: []`, "upkeep only", and an account warmed for two weeks and
then never used. Now the plan does not end, it settles.

**The numbers.** Past the last phase every run is in working mode:
`profile_view` 10–12, `like` 2–3, `connect` 10–15 a day, each drawn per account
and day like every other figure (`DEFAULT_STRATEGY.workingMode` in
`warmup/strategy.mjs`). Notes follow the day 11–14 rule — `connectionNote`
`{ maxWords: 3, allowLinks: false }` — and the portal enforces it when it builds
`invites.toSend`: a note that breaks it is handed over as `""`, with
`noteDropped` saying why, and the request goes bare (*Notes follow the phase*
in `CONTACT_OUTREACH_CONTRACT.md`).
`post_comment` and `follow` stay forbidden.

**The ceiling.** `CONNECT_HARD_MAX = 20` requests a day, in any phase and in
working mode. `validateStrategy` refuses a `connect` range above it, and
`dailyQuota` clamps to it, so a snapshot saved before the ceiling cannot send the
twenty-first either: every quota check refuses it as `Daily quota reached (20)`.

**Runs already under way get it without a restart.** A snapshot without a
`workingMode` block — every run started before this, and the default row in
`wl_strategies`, which has no column for one — falls back to the one in code.
New runs freeze it into `strategy_snapshot` at start like the phases.

**Nothing marks a run finished.** `wl_runs.state` stays `running`, so working-mode
accounts stay in `candidates()` and are due by the same rules as any warming day.
A run is finished only if its snapshot has no phases at all.

**Two sessions a day, on purpose.** A run hands the agent at most
`MAX_INVITES_PER_RUN` (10) invitations and working mode allows up to 15. The
scheduler counts what was actually sent today, not sessions, so an account that
sent ten is due again — `kinds: ["profile_view", "connect"]`: the two views the
first session left for it, and `invites` = the rest of today's allowance — once
it has rested and every account that has not had a session today has had its
turn (see *The second session of a morning*).

**What changed on the wire.**

- `/agent/due` `next` and `/agent/lease` `lease` carry `mode: "warmup" | "working"`.
  `day` keeps counting past 14.
- `GET /agent?accountId` past the last phase answers like any warming day —
  `runnable: true`, a `plan` with quota/done/remaining/heldBack, `rules`,
  `connectionNote`, `phase: "Working mode"` — plus `mode: "working"`.
  `"Warm-up is finished — upkeep only"` now only comes back for a snapshot with
  no phases.
- The scheduler's `scheduler.started` event says `working mode, day N`.
- `deriveStatus` has a new value, `working` ("Робочий режим" on screen), and
  `/dashboard` `totals` a new count, `working`.

**What the agent must do.** Treat `mode: "working"` as an ordinary plan day — no
special case is needed if it already reads `plan` and `invites.toSend`. Do not
exit on day 15. Expect to be handed the same account twice in one morning when
it has more than ten requests to send — at least an hour apart — and send only
what `toSend` holds. Do the views the `plan` row gives as `remaining`, not
`quota − done`: `heldBack` on that row is how many of the day's views are kept
for the second session (below).

## The second session of a morning

Added after the review of working mode. Two rules in `dueFrom`, both in memory
next to the lease and the cool-off, and one in the plan both it and
`GET /agent` read:

- **First sessions first.** `ready` is sorted by "worked today" before anything
  else — handed out earlier this morning, or any of today's counters above
  zero, which survives a restart. Working mode's leftover requests belong to
  the oldest runs, so by age alone they took the morning's sessions from newer
  accounts whose day counts by the calendar whether they got a session or not.
- **An hour's rest.** The same account is not handed out again until
  `WARMUP_SAME_DAY_GAP_MINUTES` (default 60, read like the other `WARMUP_*`
  minute settings) after its last session finished: the `run.finished` with
  `ok: true` that gave the lease back, counted from when the report came, even
  after the lease ran out. A second session two to seven minutes after the
  first was a second visit from an account LinkedIn had just watched leave.
  While it rests it is `held` and, when it is the only thing owing work,
  `reason` is "<label> is resting between sessions". A restart forgets the
  rest (one early second session at most), not the order.
  Only a finished session rests. After `ok: false` the cool-off
  (`COOL_OFF_MINUTES`, 45) is the whole wait, as the `scheduler.finished` line
  says; a lease that runs out with no report costs the lease and nothing more.
- **Two views wait for it.** The rest alone did not change how the second
  session opened: the first had spent every view and like, so the agent went
  straight to Connect — the shape `AGENT_INVITES_HANDOFF.md` warns against. So
  the first session is handed all but two of the day's views, and every
  session after it starts with the two. 2 views are kept back
  (`VIEWS_HELD_BACK`) while all of these hold: today's `profile_view` quota
  is 4 or more; today's views done are fewer than that quota − 2; today's
  `connect` quota (the day's figure, not what is left of it) is more than
  `MAX_INVITES_PER_RUN`; and the account has more than one run's worth of
  requests the hand-off can send today — its waiting rows the hand-off would
  give out (`sendableToday`), up to today's connects left, plus what its
  folders may still add today (`folderWork`), the same figure `/agent/due`
  calls `invites` — more than `MAX_INVITES_PER_RUN`. With one run's worth or
  fewer, one session sends them all, and nothing is kept back that would wake
  the account again just for two views: fifteen people waiting on a day of
  fourteen requests, five of them already sent by hand, is nine to send — one
  session, every view in it. `GET /agent`'s `profile_view` row then reads `heldBack: 2`
  and `remaining` = max(0, quota − 2 − done) (every `plan` row carries
  `heldBack`, 0 on the other kinds), and `dueFrom` counts the same, so an
  account is never woken for views the plan would not hand out. Once the
  first session has done its views, `heldBack` is 0 however many requests it
  sent, and the next session — after a finished first session, or after one
  that failed part-way and waited out its cool-off — is handed the two views
  first, then the rest of the requests (`kinds: ["profile_view",
  "connect"]`). Both callers ask one function over the same rows
  (`viewsHeldBack`, and `viewsHeldBackFor` for one account in
  `warmup/scheduler.mjs`: `heldCounts`, the bounded `folderFeeds`,
  `folderAddedToday`, today's counters), so they cannot disagree and a
  restart changes nothing. `GET /agent` asks after its folder top-up, which
  turns the folder's share into waiting rows and leaves the sum as it was.
  The day's totals never pass the quotas.
- **The record answer counts them too.** `POST /agent {action: "record"}`
  answers `{ success, done, quota, remaining, heldBack }`. For
  `profile_view`, `heldBack` is decided by the same function over the same
  rows, on the views done before the one being recorded — what `GET /agent`
  would have said just before it — and `remaining` = max(0, quota − heldBack −
  done), so the first session's last view answers `remaining: 0`, not the
  two kept for the next session. `heldBack` is 0 on the other kinds, whose
  `remaining` is quota − done as before. A view is never refused for the
  two kept back: `checkQuota` accepts every view up to the day's quota.
  `heldBack` is read after `checkQuota` and before the view is counted
  (`commitAction`), so a read that fails there answers an error with nothing
  counted, and the agent's retry counts the view once.
  One edge is left: the people are counted when the first session starts,
  so when more than a run's worth waited then and the first session left
  nobody behind — a seller cancelled the rest, or the browser could not reach
  them — the two views are a session of their own.

**What the agent must do:** nothing new. Keep the order it already has —
views, likes, invitations — and do the views `plan` gives as `remaining`;
the second session then begins with its two views. The rest is enforced by
what the server hands out.

**Today's counters are summed.** `dueFrom` and `GET /agent`'s `plan` (and the
account screen) add up every `wl_day_actions` row for a run, day and kind, the
way `checkQuota` refuses by. Read last-row-wins, a duplicate row — two writers
that both found none — showed connects the quota had already spent, and the
account was woken all morning to be handed nothing. The poll reads the rows by
live run id, so a run stopped this morning does not count toward its
replacement.

## After a warning: the pause

Added after working mode. A LinkedIn warning or restriction stops **all**
actions for the strategy's `pauseDays` (2): the rest of the day it came in on
and the two whole dates after it. `paused_until` is the last of them.

**Three ways in, one pause.** The operator's "Прилетіло попередження" button
(`POST /control {action:"warning"}`), the agent reporting one
(`POST /agent {action:"warning"}`, below), and an invitation the agent reports
as `blocked` all go through `pauseForWarning` in `warmup/store.mjs`. A second
report while a pause holds only adds the dates it pushes the end past — on the
same day, none — so a block page on every invitation of one morning is one
pause, not five. `health` reports (`captcha`, `needs_login`, `blocked` health)
keep their old meaning and start no pause: they need a person, a warning needs
nobody.

**Nothing is handed out while it holds.** `dueFrom` skips the account before
it looks at quota or upkeep, so `/agent/due` never names it and `/agent/lease`
refuses it. `GET /agent` answers `runnable: false`, `reason: "Paused until
<date>"`, `pausedUntil`, an empty `plan`, and every list empty rather than
missing: `invites.toSend: []`, `invites.toCheck: []`, `connectsLeft: 0`,
`queue: []`, `upkeep.any: false`, `inbox.maxThreads: 0`.

**It ends by itself.** Nobody has to press anything. The day after
`paused_until` every reader treats the run as running (`pausedOn` in
`warmup/strategy.mjs` asks the date, never the row's `state`), `candidates()`
reads `restricted` accounts and `paused` runs as well as `warming` and
`running`, and the account is due by the ordinary rules. The first
`/agent/lease` after that writes it down — run back to `running`,
`paused_until` cleared, `paused_days` set (below), account back to `warming`,
one `run.resumed` event with `meta.auto: true` — as a write conditional on the
row still reading what it was computed from (`paused`, the same
`paused_until` and `paused_days`), so whichever caller gets there first writes
it, the rest find nothing to do, and a warning that landed in between is not
overwritten. A Resume press and any action recorded on the run
(`commitAction`) settle it the same way. `/agent/due` still writes nothing.

**Days nobody took the account on count as paused.** While the row still reads
`paused` after `paused_until`, the dates from the day after `paused_until` up
to yesterday are added to `paused_days` by every reader (`pausedDaysOn`,
`dayOfRun`): the poll, the lease, `GET /agent`, `checkQuota`, the screens and
`deriveStatus`. Settling the pause writes exactly that number, so the day does
not move when the row changes, whichever route writes it. On the first morning
after a pause the stall is none. This is what brings back the accounts the old
code left stalled for good (a warning wrote `paused`/`restricted` and nothing
ever resumed them): they come back on the day after their warning day, not
weeks on in working mode with a full folder top-up. A warning on such a run
starts from the stalled figure too.

**The paused days are counted once.** They are added to `paused_days` when the
warning is written, never when the pause ends, so the end needs no write for the
day to be right. A warning on day 8 comes back on day 9: the warning day was
worked, the two whole dates were not. On screen the day stands still at 8
through the pause (`runDay`), rather than dropping to 6 the moment the button is
pressed.

**Resume is for ending it early.** It gives back the paused dates not yet
reached (`resumeCredit`): the next morning, both; on the last paused date, one;
after the pause has already run out, none — it writes the stall into
`paused_days` like the lease would and the day stays where the screen showed
it. So an early resume no longer puts the account behind where it stopped, and
a late one no longer counts the idle days after the pause as progress. The
button is shown only while the pause holds.

### `POST /api/warmup/agent` — `warning`

```ts
{ action: "warning", accountId, note?: string }
→ 200 { success: true, paused: true, pausedUntil: "YYYY-MM-DD", stopSending: true }
→ 409 { success: false, error: "No warm-up in progress" }
```

Writes a `run.warning` event at `warn` with `meta.source: "agent"` and the note.
Every `run.warning` also carries `meta.extended`: `false` on the one that
started the pause, `true` on one that came while it held. One from a block
page (`meta.source: "invite.blocked"`) names the report it came from
(`meta.outreachId`, `meta.leaseId`) — see *A held report while the pause
holds* in `CONTACT_OUTREACH_CONTRACT.md`.

**What the agent must do.** When LinkedIn shows a warning, a restriction
notice or a "too many invitations" page, report `warning` once and stop
everything in the run: no more views, likes, invitations, invitation checks or
inbox reading. Close the session and report `run.finished`. Do not report it as
`health` — health is for a person to fix, and it does not pause the day count.
A Connect that lands on a block page is reported as `invite.sent` with
`outcome: "blocked"`; the answer now carries `paused: true`, `pausedUntil`,
`stopSending: true` and `overQuota: true` (what an agent built before this
stops on), and it means the same: stop the whole run. A held report that
comes after that, while the pause holds, parks and skips nobody — see *A held
report while the pause holds* in `CONTACT_OUTREACH_CONTRACT.md`. Expect nothing
to be handed out until the day after `pausedUntil`, then carry on as normal —
the account comes back by itself.

## A campaign's folder is work

Added with the folder feed (*A running campaign sends* in
`WARMUP_CAMPAIGNS_CONTRACT.md`). An account ticked on a running campaign, on or
after the campaign's `fromDay`, is due for `connect` when its folder still has
people for it — not only when somebody queued one by hand.

**The poll and the lease count, `GET /agent` writes.** `candidates()` asks `folderFeeds`
(`warmup/feed.mjs`) what each running campaign's folder could still offer —
read-only, capped at 20, and only for campaigns with an account on or past
their day. `dueFrom` adds `folderWork` to the waiting invitations:
`invites = min(waiting, connectLeft) + min(available, connectLeft − waiting −
live claims, 2 × connectQuota − added by the folder today)`. That is the same
sum the top-up fills by (`folderRoom`, daily cap included — `folderAddedToday`
counts today's folder `invite.requested` events per account), so an account
woken for its folder is never handed an empty list, and an account the folder
has already fed twice its quota today is not woken for the folder again.
`available` counts people, not contacts: the walk steps over a second contact
for a profile already approached and anybody the folder let go
(`campaign.skipped`), the same way the top-up does. `/agent/due` still
writes nothing — no row, no event; the one thing the walk keeps is an
in-memory note of where the folder's approached head ends, which only decides
where the next read starts. `/agent/lease` writes nothing for the folder
either; `GET /agent`, which the agent asks straight after taking the account,
tops it up before `invites` is built, so the people are `waiting` rows in
`invites.toSend` when it reads them.

**The folder check cannot hang the poll.** `folderFeeds` is the one read in
`candidates()` that goes to the CRM, and `fetch` has no timeout. It is raced
against `WARMUP_FOLDER_CHECK_SECONDS` (default 5): on a timeout the folders
count as empty for that poll (views, likes, waiting rows and upkeep are still
counted) and the next poll asks again. A folder that fails on its own counts as
empty as before. Either way the console says so once per outage, not on every
poll.

`decideNext` and `leaseAccount` take the campaigns as `{ campaigns }`; the
routes pass the workspace's list, read without the migration's write-through.
Called without them — the existing tests — nothing about the folder is counted.

**Working mode needs the second session.** A working-mode account is topped up
to its 10–15; a run carries 10, and the account is due again for the rest
exactly as with hand-picked invitations, with `invites` = what is still waiting.

**`waiting` counts only what the hand-off would give out today** — one rule,
`sendableToday` in `warmup/invites.mjs`, for `invites` here, the top-up's room
and `invites.toSend`:

- **A held invitation rests until tomorrow.** A `waiting` row the agent already
  tried today and reported with a held outcome (`invite.failed` today, since the
  row was last moved) is left out. Before, one broken link kept an account due
  all morning — handed out, failed, handed out again every few minutes,
  spending nothing, so the allowance that would have ended it never ran out.
  (Only a seller's row can be in this state: a folder's row with a held outcome
  is let go instead.)
- **A parked invitation is nobody's work.** One `blocked` outcome on a row
  since it was last moved parks it until a person moves it to another account
  or cancels it and queues the person again — even when it is the only row the
  account has waiting, which used to open the next session after the pause and
  cost a second one. Not a `blocked` reported while the account was already
  paused (`meta.duringPause` on its `invite.failed`): that page was about the
  account.

Both are read from the rows' own events (`waitingFacts`) without ever reading
a row's whole history: today's `invite.failed` and `invite.reassigned` for
resting; the `invite.failed` events with `outcome: "blocked"` (those without
`meta.duringPause`), then the moves of just the rows that have one, for
parking. Each read is newest first and
paged 500 at a time until a page comes back short, because Supabase answers at
most 1000 rows and drops the rest silently — a seller's row that fails once a
day for months must not push today's failure off the end of the answer.
- **A folder's row waits for its campaign's `fromDay`.** `candidates()` passes
  each account's day (read off `nowMs`, like `dueFrom`) and the campaigns'
  `fromDay`s, so a run started again does not wake for the folder's leftovers
  on days 4–6.

**What the agent must do:** nothing new on the wire — `kinds`, `invites` and
`toSend` keep their shapes. `invites` on `/agent/due` and `/agent/lease` now
includes people the folder will add when the agent asks `GET /agent`, so the
worker must go on to `GET /agent` after the lease, as it already does — that
question is what writes them down.

## The inbox, once a day

Added with the inbox-to-contact work (*Once a day, onto the contact* in
`WARMUP_INBOX_CONTRACT.md`).

**`upkeep.inbox` is now true on every plan day the inbox has not been read.**
It used to be forced false inside the plan, on the reasoning that the day's
views open the browser anyway; that left the read to whatever sessions the
account happened to get — several a morning, or none — while the CRM copy now
depends on it happening once a day. The rule, in `upkeepFor`, used by both the
scheduler and `GET /agent`:

- inside the plan (days 1–14 and working mode): no `inbox.synced` today;
- out of plan (a snapshot with no working mode): as before — an open
  conversation, and no `inbox.synced` today;
- while a pause holds: nothing, as for all upkeep.

An account whose day is otherwise done is therefore due with `remaining: 0`,
`kinds: []`, `upkeep.inbox: true`, sorted after accounts with plan work. On an
ordinary day it costs no extra session: the read rides on the first one.

**One wake a day for it.** `leaseAccount` remembers on the lease whether the
read was owing; `finishRun` with `ok: true` on that lease marks the account's
chance at today's read as spent (in memory, keyed by the UTC date, cleared by a
restart like the cool-off). After that the inbox alone no longer makes the
account due today, though `upkeep.inbox` and `GET /agent`'s `inbox.due` still
say it is owed. Without this, an agent that never posts `inbox.done` would be
handed the same account every few minutes until the window closed. A session
that fails (`ok: false`) does not spend it; the cool-off paces the retry.

**What the agent must do:** when `GET /agent` answers `inbox.due: true`, read
the inbox in that session and post `inbox.done` before `run.finished`.
