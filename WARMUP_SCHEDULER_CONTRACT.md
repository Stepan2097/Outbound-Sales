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
5. Anty does not already have its profile open. The lease covers the workers
   that ask; this covers the ones that do not — an old portal still running, or
   a person who opened the profile by hand. Both have to go through Anty to get
   a browser, so Anty is where they are visible.

Oldest run first: an account waiting since day one goes before one enabled five
minutes ago.

### `GET /api/warmup/agent/due`

Token-scoped, like the rest of `/agent/*`. The worker's question — and only the
question. It grants nothing, so `leaseId` and `leaseExpiresAt` come back null
and probing it costs nothing at all. Taking the account is the POST below, and
the two must never be merged back together: see *What this got wrong*.

```ts
{ success: true,
  window: { startHour, endHour, label, open },
  next: null | { accountId, label, profileRemoteId, day, remaining, kinds: string[],
                 leaseId: null, leaseExpiresAt: null },
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
cool-off", "Chloe Stewart already has its profile open", "that account does
not owe work right now", "outside 09:00–13:00".
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
