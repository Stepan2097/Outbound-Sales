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

1. The account is `warming`, `health = ok`, and has an Anty profile.
2. Its run is live, not paused, and inside the plan.
3. Today's quota still has something left in it for a kind the agent can do —
   `profile_view` and `like`. Connection requests come from a campaign's queue
   and are counted separately.
4. It is not in cool-off and not leased to somebody else.

Oldest run first: an account waiting since day one goes before one enabled five
minutes ago.

### `GET /api/warmup/agent/due`

Token-scoped, like the rest of `/agent/*`. The worker's only question.

```ts
{ success: true,
  window: { startHour, endHour, label, open },
  next: null | { accountId, label, profileRemoteId, day, remaining, kinds: string[],
                 leaseId: string, leaseExpiresAt: string },
  reason: string | null,
  retryAfterSeconds: number }
```

**`retryAfterSeconds` is the whole point.** It is how the server paces the Mac,
and the worker obeys it without having an opinion:

| Situation | `retryAfterSeconds` |
|---|---|
| Outside the window | seconds until it opens, capped at 900 |
| Inside, nothing due | 300–540, jittered |
| Inside, an account handed out | the gap after it finishes — see below |
| Another worker holds a lease | seconds until that lease expires |

`reason` is a sentence for the log when `next` is null — "outside 09:00–13:00",
"nothing owes work today", "Chloe Stewart is already running".

A lease is granted for `LEASE_MINUTES` (default 25) and lives in memory. A
worker that dies mid-run costs one lease period, which is shorter than the gap
between accounts anyway. In memory rather than in the database because a lease
is about right now, and a restarted server that has forgotten one is a server
that correctly believes nobody is running.

### `POST /api/warmup/agent` — one new action

```ts
{ action: "run.finished", accountId, leaseId, ok: boolean, note?: string }
```

Releases the lease, writes a `scheduler.finished` event, and on `ok: false`
puts the account in cool-off for `COOL_OFF_MINUTES` (default 45) — the same
backstop the old scheduler had, for the failures health does not capture: Anty
holding the profile open, a proxy that is down, a browser that would not start.

The answer carries the gap: `{ success, nextInSeconds }`, drawn 120–420 seconds
and jittered, because two sessions a minute apart from one machine is the shape
of a tool.

A `run.finished` with an unknown or expired lease is accepted, not refused — the
run happened either way and the report is worth more than the bookkeeping.

### What does not change

Quota, claiming, the inbox and every existing agent action stay exactly as they
are. This adds a way to be told when to start; it changes nothing about what
may then happen.

## Agent — owns `/Users/Apple/Desktop/github/warm-up-linkedin/agent/**`

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

Six things, found building it.

**`reason` cannot carry a number.** The worker logs a reason once and stays
quiet until it changes, which is the only thing standing between a five-minute
poll and a log nobody reads. A countdown inside the sentence — "in cool-off for
another 31 min" — makes every poll a new reason and produces exactly the spam
the rule exists to prevent. `reason` is now fixed text plus, at most, an account
label; everything that moves is in `retryAfterSeconds`.

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
