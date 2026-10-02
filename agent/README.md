# LinkedIn agent in Outbound-Sales

All code is in this repository. The server (`warmup/`) chooses the accounts, schedule, recipients and quotas. The local Mac agent (`agent/`) opens the account's existing Anty profile, performs the allowed work, and reports each result. The retired Next.js application is not required.

## Install on the Mac with Anty

Use Node.js 22.13 or later and installed Google Chrome. Install the agent's dependency from the project root:

```sh
npm ci --prefix agent
```

Configure the root `.env` (or environment):

```dotenv
WARMUP_PORTAL=https://your-outbound-sales-server.example
WARMUP_AGENT_TOKEN=the-same-token-as-on-the-server
```

The worker and manual runner load the root `.env.local` and `.env`; shell values take precedence. Never copy the archived `.env.local`: it belongs to the previous application. Optional `WARMUP_CHROME_PATH` and `WARMUP_ANTY_DIR` override the installed Chrome executable and Anty data directory.

Start the worker from the project root:

```sh
npm run agent
```

One scheduled visit, or one specified account using the same server lease:

```sh
npm run agent:once
node agent/run-today.mjs --account "Account label or ID"
```

The account must be due inside the server's session window. A manual launch also takes a lease and reports `run.finished`. The worker passes its lease to the child runner; it does not acquire a second one. An open Anty profile is refused; a profile must already have its local copy on this Mac and a configured proxy.

## Behaviour

- Warm-up quotas remain in the server's strategy. Connection requests have an additional hard limit of **60 per account across seven UTC dates, including today**, across all runs. Stopping or restarting warm-up does not clear it. Previous accepted day counters and uncounted out-of-allowance sends are included. Records from before Outbound-Sales knew about the account cannot be reconstructed from this archive.
- The daily quota still applies. With 58 requests recorded in the window, the server queues at most two more. At 60, inbox reads and checks can still run; new sends wait for older dates to expire.
- `GET /agent` runs after the lease; it fills the campaign queue. The agent sends only `invites.toSend`, with the supplied note or a bare request. It handles Connect in the profile header or its More menu. It never uses suggested people's Connect buttons.
- Before each recipient, `invite.prepare` checks the current allowance, ownership, health and pause. Every confirmed send is reported as `invite.sent`. Reports get one retry; persistent failure stops the visit. `overQuota` or `stopSending` stops sending. A warning or pause stops the whole visit.
- Explicit LinkedIn invitation limits, restrictions, identity checks and checkpoints call `warning` and stop the visit. The server controls the two-day pause. No CAPTCHA is solved by the agent.
- Existing Pending or first-degree profiles are reconciled instead of receiving another request. The daily check reports `accepted` when the profile shows a first-degree relationship. An uncertain missing request remains `pending`; the agent does not infer withdrawal from a missing selector.
- Inbox reading follows `inbox.due`; a second session on the same day does not reread it. Both message directions and the entire visible thread are posted oldest first. LinkedIn message URNs are preferred. Fallback IDs use the text, direction, true ISO time when available, and occurrence; aging labels never form the ID. Non-ISO times remain labels, rather than invented dates. With no URN or absolute time, identical messages whose visible history changes can still be ambiguous; the server also reconciles repeated content.

## Keep the worker running

Generate a LaunchAgent with paths for the current checkout and Node executable:

```sh
node agent/launchagent.mjs
```

This writes `agent/runs/com.advantage.outbound-sales-agent.plist`; it does not install or start the service. On the operating Mac, copy that file to `~/Library/LaunchAgents/` and load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.advantage.outbound-sales-agent.plist`. The worker runs in the desktop session because Chrome needs a window. Stop any retired warm-up worker before enabling this one. Logs and screenshots stay in ignored `agent/runs/`.

## Verify without a LinkedIn account

```sh
npm test
npm run check
npm run test:agent
```

The worker uses a fake scheduler and a stub runner. Browser tests intercept every LinkedIn URL and use synthetic local pages, without profiles or sessions. The two optional backend compatibility probes use `WARMUP_REAL_PORTAL` and `WARMUP_REAL_TOKEN`; they skip if that backend is absent. Never aim a fixture send or `run.finished` at a real account.

These checks prove queue, quota, reporting and browser logic against fixtures. Selectors still need a supervised run on a test account with Anty before production activation.
