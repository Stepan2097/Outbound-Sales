# Contract: warm-up targeting — folders, filters, forecast, identity

Shared by the backend and frontend work on Phase 1. Do not change a shape here
without updating this file first and telling the other side.

## Why

Two things are hard-wired that should not be.

The lead queue is pinned to one CRM folder through `WARMUP_CRM_LEADS_FOLDER_ID`,
so the twenty-six folders in the CRM are twenty-five folders nobody can reach.
And an account's real LinkedIn identity — who the browser is actually signed in
as — is discovered by the agent on every run and then thrown into `health_note`
as free text, so "from which account" cannot be answered properly anywhere.

Neither needs a schema change. Targeting is workspace configuration and belongs
in the workspace state this app already persists. Identity is already written to
`wl_events.meta` by the agent on every sign-in; it needs reading, not storing.

## Capacity is the point, not a detail

At peak the standard strategy allows 5–6 connection requests per account per
day. Four accounts warming is a ceiling near 22 a day, and it does not move
because a folder is larger. The largest folder holds 22,088 contacts — roughly
a thousand days at that rate.

So the folder picker must never present a folder as a thing you "run". Every
screen that offers a folder also states what will actually be reached, and the
forecast below is a required part of the response, not an extra.

## Backend

### `GET /api/warmup/folders`

Lists CRM folders with counts, biggest first. Archived folders are excluded
unless `?archived=1`.

Read `contact_folders` (`id, name, color, owner_id, is_archived`) and
`folder_stats` (`folder_id, contact_count`) from the CRM client, join in memory.
A folder with no stats row counts 0 rather than being dropped.

```ts
{ success: true, folders: [{ id, name, color, contactCount, isArchived }] }
```

Live: 26 folders, of which 2 are archived — and those two are the largest, so
the default list starts at 19 501 rather than 22 088.

### `GET /api/warmup/targeting`

The saved selection. Returns the default when nothing has been saved: the folder
from `WARMUP_CRM_LEADS_FOLDER_ID` if set, otherwise `null`.

```ts
{ success: true,
  targeting: {
    folderId: string | null,
    folderName: string | null,
    filters: { country: string, position: string, leadStatus: string, ownerId: string },
    accountIds: string[],
    updatedAt: string | null
  },
  forecast: Forecast | null,
  forecastError: string | null }
```

`filters` fields are always present as strings; empty string means "no filter".
`leadStatus` defaults to `"new"`. `ownerId` defaults to
`WARMUP_CRM_LEADS_OWNER_ID` when set, and is a filter now rather than a
requirement — the CRM client must stop refusing to work without it.

Once a selection has been saved it stands exactly as saved: a lead status
cleared on purpose means every status, not a quiet return to `"new"`.

`folderName` is asked of the CRM on every read, because folders get renamed;
the name stored with the selection is what answers when the CRM does not.

`forecastError` is how a CRM that is not answering degrades. The request still
succeeds and `targeting` is still the saved selection — only `forecast` is null,
with a sentence beside it. A panel must not lose the selection it exists to show
because a count could not be taken.

### `POST /api/warmup/targeting`

Body: `{ folderId, filters?, accountIds? }`. Validates that the folder exists and
that every account id is a real `wl_accounts` row. Persists to workspace state
and writes a `wl_events` row of type `targeting.changed`.

Returns the same shape as `GET`, with a freshly computed forecast.

Each field left out of the body keeps what was saved, so ticking an account in
the profiles table can post `{ accountIds }` alone. A `folderId` that is present
but empty is a 400 — the folder is the one part of this with no default left.
An unknown folder is a 404, an unknown account a 400 naming it.

### Where it is kept

`state.warmupTargeting` in `server.mjs`, saved by `writePersistentWorkspaceState()`
alongside everything else the workspace remembers. The warm-up never reaches for
it directly: `server.mjs` hands `handleWarmupApi` a `{ read, write }` pair, so
nothing under `warmup/` knows where the file is.

### `Forecast`

```ts
{ matching: number,          // contacts in the folder passing the filters
  alreadyApproached: number, // of those, already in wl_outreach (any status)
  remaining: number,
  perDayNow: number,         // today's connect quota summed over the chosen accounts
  perDayAtPeak: number,      // each chosen account's highest connect quota, summed
  daysToFinish: number | null,   // null when perDayAtPeak is 0
  reachedThisMonth: number,      // perDayAtPeak * 30, capped at remaining
  accountsChosen: number }
```

`perDayNow` reads each account's active run and its strategy snapshot through
the existing quota helpers — never a second copy of that arithmetic. An account
that is paused, unhealthy or not warming contributes 0 to `perDayNow` and still
contributes its peak to `perDayAtPeak`, so the screen can show the difference
between "today" and "when everything is warm".

An account's peak is drawn day by day through the same `dailyQuota` helper and
the highest figure kept, so it is a number that account actually reaches rather
than the top corner of a range it may never be dealt. An account with no run
yet has frozen no snapshot, so its peak comes from the strategy it is assigned,
or the house default.

`perDayNow` is 0 for a fresh set of accounts and stays 0 until day 4 — the
standard strategy forbids requests for the first three days. That gap is the
point of showing both numbers, not a fault.

### Filters, exactly

`country` matches case-insensitively and whole; `position` matches
case-insensitively and anywhere inside; `leadStatus` and `ownerId` are exact.
Every empty box narrows nothing.

A value is sent to PostgREST unquoted. The documented double-quoting for values
carrying a reserved character is wrong against the build behind Supabase, which
passes the quotes down to Postgres: `country=eq."United States"` matches nobody
and a quoted uuid comes back as a type error. URL encoding does the whole job.

### `GET /api/warmup/leads` — changed

Stops reading the folder from the environment. Uses the saved targeting, with
the same already-approached exclusion it does today. Returns `queueTotal` (the
count matching folder + filters) alongside the leads, and `targeting` so the
panel can say which folder it is drawing from.

When nothing is targeted yet, answer `409` with
`"Pick a folder before pulling leads"` rather than an empty list — an empty
queue and an unconfigured one are different answers. The body carries
`needsTargeting: true` beside `error`, so the panel can tell the prompt from a
real failure without matching on the sentence.

### Account identity — added to existing shapes

`describeAccount()` and each row of `GET /api/warmup/profiles` gain:

```ts
identity: { name: string | null, slug: string | null, seenAt: string } | null
```

Read from the newest `wl_events` row per account with `type = 'agent.login'`,
taking `meta.who` and `meta.slug`. One query for the whole list — no per-account
round trip, the same rule the rest of that endpoint already follows.

`meta.slug` is not written by the current agent build (it computes the slug and
sends only `who`). Treat it as optional and render on the name alone until the
agent is updated; do not fail when it is absent. Live: four of five accounts
carry an identity, and `slug` is null on every one of them.

## Frontend

Owns `app/index.html`, `app/main.js`, `app/styles.css`. All of this lives in the
existing Warm-up view; no new tab.

### Targeting panel — new, above Profiles

- Folder `<select>`, biggest first, each option showing the contact count.
- Four filter inputs: country, position contains, lead status, owner.
- The chosen accounts are the ones ticked in the Profiles table (see below).
- A **Save targeting** button posting to `POST /api/warmup/targeting`.

### The forecast line — required

Directly under the picker, in plain words, from the `Forecast`:

> 12 038 у папці · 486 уже опрацьовано · **22 на день** · ~160 за місяць · повний обхід ~547 днів

When `remaining` is far larger than `reachedThisMonth`, the line carries a
warning tone and an explicit hint to narrow the filters. That is the whole point
of the panel: a folder of 22,000 must not read as a folder you can run.

### Profiles table — two changes

- A checkbox column selecting which accounts work the targeting. Ticking one
  posts the new `accountIds` and refreshes the forecast.
- Under the profile name, show `identity.name` when present — the person the
  browser is actually signed in as, which is not the same string as the profile
  label.

### Leads panel

Unchanged in behaviour, but its header now names the folder it is drawing from,
and the "pick a folder first" 409 renders as a prompt rather than an error.

## File ownership

- **Backend agent**: `warmup/**`, `server.mjs`, `WARMUP_TARGETING_CONTRACT.md`,
  `tests/**`.
- **Frontend agent**: `app/index.html`, `app/main.js`, `app/styles.css`.

Neither edits the other's files. A change that needs the other side is a message
to the other agent, not an edit.

## Also in this phase

`linkedinAccounts` and `activeLinkedinAccountId` on the workspace user profile
are a second, unrelated notion of "LinkedIn account" that predates the warm-up
and points at nothing. The real account is the Anty profile behind
`wl_accounts`. Both sides remove their half; the backend also drops the three
`/api/account/linkedin*` routes.

Done on the backend: the routes, `normalizeLinkedinIdentity`, both profile
fields, and the `linkedinAccount` that rode along on the actor context into
research jobs and CRM activity notes.
