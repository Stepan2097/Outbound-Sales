# Handover: the browser half of connection requests

For whoever picks up `/Users/Apple/Desktop/github/warm-up-linkedin`. The portal
half is built and answering; this is what is left, written by the person who
built the seam. `CONTACT_OUTREACH_CONTRACT.md` in the Outbound Sales repo has
the exact shapes — this is the part a contract is bad at: what will surprise
you, and why things are the way they are.

## What you are building

Two steps inside an existing run of `agent/run-account.mjs`:

1. **Send** the connection requests the portal has queued for this account.
2. **Check**, once a day, what became of the ones already sent.

Nothing else. No composing, no choosing who to write to, no deciding how many.

## What you do not touch

The portal. `warmup/**` and `server.mjs` in the Outbound Sales repo are the
other half, and they are somebody's live deployment.

**If the semaphore does not answer the way this says it does, that is a
conversation, not a patch.** Send it back through the session that handed you
this. Two people fixing one seam from both ends is how a seam stops being one.

## Where the two steps go, and why there

**Send: replaces `run-account.mjs:393-403`** — the block that currently logs
`agent.deferred` and skips connects. After the views and likes, before the
inbox. Three reasons, all of them already arguments that file makes:

- After the identity read and `portal.health('ok')`, because an invitation sent
  from a session that turns out to be a checkpoint spends a real allowance on
  nothing and writes a lie into a table that cannot be corrected.
- After the day's actions, because that file's own ordering rule says the day's
  actions are what the visit is for. An invitation is the most expensive and
  least reversible thing in the run; it should not be what a rate-limit
  interstitial costs, and a Connect fired thirty seconds into a session is the
  exact shape this whole project exists to avoid.
- Before the inbox, because displaying a conversation marks it read. If a run
  is going to be cut short, the irreversible-but-cheap work should have
  happened already.

**Check: after the inbox**, or anywhere after the send — it costs no allowance
and touches nothing the send depends on.

## Two gates will stop you before you start

- `AGENT_KINDS` in the portal's `scheduler.mjs` is `["profile_view", "like"]`
  and **stays that way**. Do not ask for `connect` to be added. Invitations
  make an account due through a different route — a count of people actually
  waiting — because a quota with nobody queued would wake every account every
  morning to send nothing.
- `run-account.mjs:140-146` exits before launching Chrome when every remaining
  quota is zero. **This has to learn about invitation work**, or an account
  whose views and likes are done will be leased, exit immediately, and report
  back having opened nothing. This is your change, in your repo.

## The four things you will trip on first

**1. `toSend: []` with `connectsLeft: 3` is not a bug.** It means nobody has
queued anybody from the lead workspace. Do not go looking for the missing
people and do not invent recipients — every request in this system is attached
to a named person and a status, which is the rule that makes the whole record
worth anything.

**2. `runnable` answers "is it worth opening the browser", not "is there
warming left".** An account past the last day of its plan answers
`runnable: true` with an empty `plan` and `reason: "Warm-up is finished —
upkeep only"`. **Exit when the plan is empty AND `upkeep.any` is false** — not
on an empty plan alone. Warming ends; watching what was already sent does not.

**3. Read the button state before clicking. Always.** This is not an
optimisation, it is the reconciliation: if a previous run clicked and died
before it could report, the card already reads Pending, and reporting
`already_pending` is how the portal learns that without being charged twice.
Skipping the read to save a moment is how an account quietly sends one more
than its day allowed.

**4. Report after LinkedIn confirms, never before.** The card has to have
changed to Pending. The portal spends the allowance on your word, and
`wl_outreach_person_once` is unique on the contact — a row written for an
invitation that never went out is permanent, across every account, and there is
no screen to undo it from.

## The outcome vocabulary is closed

`sent`, `already_pending`, `already_connected`, `no_button`, `profile_gone`,
`blocked`. Anything else is a `400` and the row does not move. Do not invent
`rate_limited` or `Sent` — an unvalidated string used to fall through to "treat
as already pending", which moved the row and spent nothing, and that is exactly
the silent overspend the validation now stops.

## `gone` is a claim about LinkedIn, not about your selector

In the daily check, `gone` moves the row to `withdrawn`, **and `withdrawn` has
no exit** — the person leaves every query that could ever surface them again,
and a reply from them later will not be counted as a reply.

So `gone` means one thing: the invitation is no longer in the sent list **and**
the person is not now a connection. An empty page because the markup changed,
a slow load, a login wall, a list that rendered zero rows — none of those are
`gone`. **When in doubt report `pending` and log it.** A person checked again
tomorrow costs nothing; a person written off does not come back.

The same caution belongs in the send step: `profile_gone` should mean a 404, a
redirect or a members-only wall, not "I could not find the button I expected".
That one is `no_button`, and it leaves the person queued for a human to look at.

## Reporting, and what to do when the report will not go

Retry twice, three seconds apart. The ordinary failure here is a dropped
socket, not a dead process, and `worker.mjs` already makes this argument for
`run.finished`: worth one retry, and worth exactly one, because a worker that
keeps a queue of unsent reports is a worker with state.

**If it still will not go, stop the send step for the whole run.** Do not open
the next person. One uncounted invitation is a day's drift; a loop of them is
the warm-up abandoned.

## Two answers that look like errors and are not

- **`overQuota: true` with `stopSending: true`.** The request you just made was
  recorded but did not fit today's allowance — probably because a seller sent
  one by hand while you were working. Nothing is wrong and nothing is lost.
  Stop sending for the day; the queue waits.
- **`moved: false` with a `reason`.** Somebody moved that row between the
  portal handing it to you and your report — usually the inbox sync recording a
  real reply. One log line. No retry.

## Send the daily check even when nothing changed

`results: []` is a valid body and writes the row that says you looked. Without
it, "nobody is accepting" and "the agent stopped looking" are the same empty
screen — and the second one is the failure that hides for weeks. This is the
same reason `inbox.synced` is written on every sync.

Report only rows the portal gave you in `toCheck`. It now checks, and anything
belonging to another account comes back in a `foreign` list rather than moving
— which is a bug report about whatever built that array, and worth noticing.

## What the portal does not check, and you must

The `outreachId` is verified to belong to this account. **Nothing verifies that
the profile you opened is the person in that row.** `toSend[].linkedin` is the
only authority on who to open, and `toSend[].note` is the text to send — a
human wrote or approved it, so do not compose your own.

A request sent to the wrong person cannot be undone.
