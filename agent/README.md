# LinkedIn agent in Outbound-Sales

All code is in this repository. The server (`warmup/`) chooses the accounts, schedule, recipients and quotas. The browser agent (`agent/`) opens the account's existing Anty profile, performs the allowed work, and reports each result. The retired Next.js application is not required.

## Linux / server Anty

Set `WARMUP_ANTY_API=http://127.0.0.1:3032` to use the Linux Anty runtime instead
of reading the Mac's database. The worker must share the runtime's Docker network
namespace; the API and CDP ports are private. Use `agent/Dockerfile` as the worker
image and Anty's `compose.linux.yml` and `docs/linux-server.md` for deployment,
profile import, backups and manual login.

The API resolves the exact cloud profile ID, refuses missing proxies and busy
profiles, then returns a private CDP endpoint. The runner uses Anty's existing
persistent context and asks Anty to flush and close it at the end. The server
continues to own all quota, lease, warning and inbox decisions.

`node agent/check-anty.mjs --profile <cloud-id> --linkedin` checks a selected
profile's proxy and login markers without likes, requests, messages or opening
the inbox. It needs `WARMUP_ANTY_API`, but does not run the production scheduler.

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

## Акаунт, що вийшов із LinkedIn

Візит, який застав акаунт розлогіненим, пише йому `health: needs_login` — і
сервер більше не роздає цей акаунт, бо відкривати його щоп'ять хвилин означає
показувати LinkedIn наш розклад. Ціна в тому, що про поломку ніхто не дізнається
і про лагодження теж.

Вартовий закриває обидва кінці:

```sh
node agent/login-watch.mjs            # крутиться, доки не спинити
node agent/login-watch.mjs --once     # один прохід, для крона або руками
```

Раз на день він відкриває кожен акаунт на паузі (тільки подивитись: без
запитів, лайків, повідомлень і без месенджера) і пише один рядок у групу з
кнопкою «Вже залогінився — продовжити прогрів». Натискання не йде на віру —
вартовий перевіряє вхід сам, і лише тоді знімає акаунт з паузи через
`health: ok`. Поки акаунт розлогінений, нагадування йде щодня.

Потрібні `TELEGRAM_BOT_TOKEN` і `TELEGRAM_LOGIN_CHAT_ID` (на сервері — файлом
600, не в коді й не в аргументах). Без них вартовий усе одно перевіряє й знімає
з паузи те, що відновилось, — просто молча. Стан (зсув оновлень Telegram і
дата останньої перевірки по акаунту) лежить у `agent/runs/login-watch.json`.

Запускати окремо від воркера: воркер — це руки розкладу, і його не має
затримувати профіль, якого ніхто не може відкрити. Рантайм у них один, тож
профіль одночасно тримає тільько хтось один — тому вартовий і відкриває лише
ті акаунти, які розклад не роздає.

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
