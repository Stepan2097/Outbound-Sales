#!/usr/bin/env node
/**
 * The hands. The head is on the server.
 *
 *   node agent/worker.mjs --portal https://outbound-sales.169-58-60-245.sslip.io
 *
 * Ask what to do, take the account, do it, say what happened, sleep for as long
 * as we are told. That is the whole program, and it is deliberately dull: this
 * is the one process on this Mac that is meant to stay up for weeks, and every
 * clever thing in it would be a clever thing to debug at 09:00 on a Tuesday
 * when nobody's profile opened.
 *
 * Asking and taking are two calls, and that is not an accident of the API: the
 * question used to grant the lease along with the answer, so a single curl —
 * or a health check, or a client that timed out on a reply the server had
 * already sent — quietly parked a live account for twenty-five minutes. The
 * poll is free now. The `POST /agent/lease` is where a claim is made, and it is
 * made only when this is about to open a browser.
 *
 * It carries no window, no order, no gap and no idea which account is next.
 * Every one of those used to live here — half in `run-today.mjs` and half in a
 * clock inside the Next.js portal — and both halves are gone. They are now one
 * number in one response. If the server says sleep for fifteen minutes, this
 * sleeps for fifteen minutes; if it says an account that this machine has never
 * heard of is due, this opens it. The only judgement left here is how to open a
 * browser, and that is `run-account.mjs`, which is unchanged and is invoked as
 * a child exactly as a person would invoke it.
 *
 * Two rules it does not break:
 *
 * 1. A failed poll is a warning and a retry, never an exit. The network being
 *    down for an hour is a quiet hour, not the end of the warm-up. Nothing
 *    short of a signal stops this loop.
 * 2. A repeated reason is logged once, when it changes. "outside 09:00–13:00"
 *    printed every five minutes from 13:00 to 09:00 is 190 lines that hide the
 *    one line that matters.
 *
 * Testing it does not involve LinkedIn: `worker.test.mjs` points it at
 * `fake-scheduler.mjs` and at a stub that exits 0 or 1 without opening
 * anything. Opening a real warming profile outside its window is exactly the
 * signal this whole folder exists to avoid.
 */
import { DEFAULT_PORTAL } from './lib/env.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Portal } from './lib/portal.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

// ── arguments ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const PORTAL = arg('portal', DEFAULT_PORTAL);
const ONCE = argv.includes('--once');
/**
 * The script to run for an account. A seam for the tests and nothing else:
 * they point it at a stub that exits 0 or 1, which is the only way to prove
 * what this does with a failed run without opening a real profile.
 */
const RUN_ACCOUNT = arg('run-account', path.join(here, 'run-account.mjs'));

// ── how long to sleep, and the bounds we will not go outside ───────────────
/**
 * The server's numbers, and a guard rail under them.
 *
 * The backend documents `retryAfterSeconds` as an integer in [1, 1500] and
 * `nextInSeconds` as 120–420. We obey whatever arrives inside those bounds
 * without an opinion — that is the point of the phase. Outside them we clamp
 * *and say so*, because a 0 would turn this into a denial-of-service against
 * our own server and a NaN into the same thing faster, and because a number out
 * of range is a bug on the other side that nobody will ever find if this file
 * absorbs it quietly.
 */
const SLEEP_FLOOR_S = 1;
const SLEEP_CEIL_S = 3600;
const SLEEP_FALLBACK_S = 300;

/**
 * When we cannot reach the server at all, we pick the gap ourselves — there is
 * no answer to obey. It doubles up to five minutes so that an hour of no
 * network is a handful of attempts rather than 240 of them.
 *
 * `--offline-first` is a seam for the tests, which cannot wait fifteen seconds
 * per failure to prove that two failures in a row are survived. Nothing else
 * has a reason to set it.
 */
const OFFLINE_FIRST_S = Number(arg('offline-first', 15)) || 15;
const OFFLINE_MAX_S = 300;

/** `run.finished` is worth one retry, not a queue. See `report()`. */
const REPORT_ATTEMPTS = 2;
const REPORT_GAP_MS = 3_000;

// ── the log ────────────────────────────────────────────────────────────────
/**
 * With the date, unlike `run-account.mjs`.
 *
 * That script logs a time of day because its whole life is one morning. This
 * one's log is a single file that a LaunchAgent appends to for months, and a
 * bare "07:14:22" in it answers no question anybody actually asks of it.
 */
const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);

/**
 * Say it once, and again only when it changes.
 *
 * The reason the server gives is a stable sentence by agreement — no
 * timestamps, no countdowns, no jitter interpolated into it — so it can be
 * compared as a whole string. When it finally does change, the previous one
 * gets a single line saying how long it held, which is the thing you want
 * when you come back to the log: not 190 copies of "outside 09:00–13:00" but
 * one line and "held for 20 год 4 хв".
 */
let lastKey = null;
let repeats = 0;
let firstSeen = 0;
function say(key, line) {
  if (key !== null && key === lastKey) { repeats += 1; return; }
  if (lastKey !== null && repeats > 0) {
    log(`   ↑ те саме ще ${repeats} раз(ів), разом ${human(Date.now() - firstSeen)}`);
  }
  lastKey = key;
  repeats = 0;
  firstSeen = Date.now();
  log(line);
}
/** Anything that is worth a line every single time it happens. */
function shout(line) { say(null, line); }

function human(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} год ${m % 60} хв` : `${m} хв`;
}

// ── the token ──────────────────────────────────────────────────────────────
/**
 * `WARMUP_AGENT_TOKEN`, from the shell or from `.env.local`.
 *
 * It used to reach the agent for free: the scheduler lived inside the Next.js
 * process, which loads `.env.local` itself, and spawned the agent as a child.
 * Nothing loads it now. The LaunchAgent starts a login shell, which has the
 * user's profile and not this repo's env file, so without this the worker sends
 * no token, Outbound Sales answers 401 to every poll for weeks, and the only
 * symptom is a log line nobody is reading because nothing appears to be wrong.
 *
 * Read here rather than by a dependency, and never printed: the presence of the
 * token is the interesting fact, its value never is.
 */
function loadToken() {
  if (process.env.WARMUP_AGENT_TOKEN?.trim()) return 'середовища';
  for (const file of ['.env.local', '.env']) {
    const full = path.join(repo, file);
    if (!fs.existsSync(full)) continue;
    const hit = fs.readFileSync(full, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => !l.startsWith('#') && l.startsWith('WARMUP_AGENT_TOKEN='));
    if (!hit) continue;
    const value = hit.slice('WARMUP_AGENT_TOKEN='.length).trim().replace(/^['"]|['"]$/g, '');
    if (!value) continue;
    process.env.WARMUP_AGENT_TOKEN = value;
    return file;
  }
  return null;
}

// ── sleeping, interruptibly ────────────────────────────────────────────────
let stopping = false;
let wake = null;
let child = null;

/**
 * Sleep, unless somebody asks us to stop.
 *
 * A plain `setTimeout` would make `launchctl unload` — or Ctrl-C — wait up to
 * fifteen minutes for a process that has nothing to do, and launchd stops
 * waiting long before that and sends SIGKILL. Waking the sleep means the worker
 * ends on its own terms, and, more to the point, that a run in progress gets to
 * finish its report.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) process.exit(1);   // a second one means they mean it
    stopping = true;
    log(`отримав ${signal} — зупиняюсь${child ? ' після поточного запуску' : ''}`);
    // The child gets the signal too: `run-account.mjs` closes the session and
    // the browser in its own `finally`, and killing it from outside without
    // letting it do that leaves an open session on the account's screen.
    child?.kill(signal);
    wake?.();
  });
}

/**
 * A stray rejection must not be what ends a process that is meant to run for
 * weeks. Everything below has its own catch; this is the net under the net.
 */
process.on('unhandledRejection', (error) => {
  shout(`⚠️ непередбачена помилка: ${error?.message ?? error}`);
});

// ── numbers from the server ────────────────────────────────────────────────
function seconds(value, { field, min = SLEEP_FLOOR_S, max = SLEEP_CEIL_S }) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    say(`bad:${field}:missing`, `⚠️ сервер не прислав ${field} — сплю ${SLEEP_FALLBACK_S} с`);
    return SLEEP_FALLBACK_S;
  }
  if (n < min || n > max) {
    // Deduped like any other repeated reason, and kept loud: this is a bug on
    // the server side and the log is the only place it can surface.
    say(`bad:${field}:${n}`, `⚠️ ${field}=${n} поза межами [${min}, ${max}] — це помилка сервера, обрізаю`);
    return Math.min(Math.max(n, min), max);
  }
  return n;
}

// ── running one account ────────────────────────────────────────────────────
/**
 * `run-account.mjs`, unchanged, as a child process.
 *
 * Not imported: it is a script with a `process.exit()` in its `finally` and a
 * browser attached to it, and a crash inside it has to cost one account rather
 * than the worker. `stdio: 'inherit'` on purpose — its log and this one are the
 * same log, in the order things happened, which is what you want at the point
 * where you are asking why yesterday's session did nothing.
 *
 * The exit code is the whole verdict: 0 is a finished visit (including the
 * honest "nothing to do today"), anything else is a failure and becomes a
 * cool-off on the server.
 */
function runAccount(accountId, leaseId) {
  return new Promise((resolve) => {
    const args = [RUN_ACCOUNT, '--account', accountId, '--portal', PORTAL, ...(leaseId ? ['--lease-id', leaseId] : [])];
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; child = null; resolve(result); } };
    try {
      child = spawn(process.execPath, args, { cwd: repo, stdio: 'inherit' });
    } catch (error) {
      // spawn can throw synchronously — a missing interpreter, a file that is
      // not there. It still counts as a run that did not happen, and it still
      // has to be reported, which is why this resolves rather than throws.
      return done({ code: -1, note: `не вдалося запустити run-account: ${error.message}` });
    }
    child.on('error', (error) => done({ code: -1, note: `не вдалося запустити run-account: ${error.message}` }));
    child.on('close', (code, signal) => done({
      code: code ?? -1,
      note: signal ? `run-account зупинено сигналом ${signal}` : null,
    }));
  });
}

/**
 * Tell the server the run is over. This is not optional.
 *
 * It releases the lease and, on a failure, starts the 45-minute cool-off that
 * keeps a broken account from being handed back every four minutes. A report
 * that never arrives costs a cool-off that never gets written — so it is worth
 * one retry on a 5xx or a dropped connection, and worth exactly one, because a
 * worker that keeps a queue of unsent reports is a worker with state, and state
 * is the thing this process is supposed not to have. The server expires the
 * lease on its own clock either way.
 *
 * An expired or unknown lease is *accepted* by the server, by agreement, and
 * answers `released: false`. That is information, not a failure: a run may
 * legitimately outlive the 25-minute lease, and the report is worth more than
 * the bookkeeping. It is not retried and not logged as an error.
 */
async function report(portal, { accountId, label, leaseId, ok, note }) {
  for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt += 1) {
    try {
      const res = await portal.runFinished({ accountId, leaseId, ok, note });
      if (res.success) {
        if (res.released === false) {
          log('   (сервер уже зняв лізу — звіт однаково зараховано)');
        }
        return seconds(res.nextInSeconds, { field: 'nextInSeconds' });
      }
      // A 404 for an account the server does not know and a 400 for a body it
      // could not read are answers: they do not get better by being sent again.
      // A 5xx is the server having a bad minute, and that one is worth the one
      // retry, because the cool-off it would have written is the part worth
      // saving.
      const what = res.error ?? `HTTP ${res.status}`;
      const worthRetrying = !res.status || res.status >= 500;
      if (worthRetrying && attempt < REPORT_ATTEMPTS) {
        shout(`⚠️ сервер не прийняв звіт про ${label}: ${what} — ще одна спроба`);
        await sleep(REPORT_GAP_MS);
        if (stopping) return SLEEP_FALLBACK_S;
        continue;
      }
      shout(`⚠️ сервер не прийняв звіт про ${label}: ${what}${worthRetrying ? ' — здаюсь, кулдаун не записано' : ''}`);
      return SLEEP_FALLBACK_S;
    } catch (error) {
      const more = attempt < REPORT_ATTEMPTS;
      shout(`⚠️ не зміг звітувати про ${label}: ${error.message}${more ? ' — ще одна спроба' : ' — здаюсь, кулдаун не записано'}`);
      if (!more) return SLEEP_FALLBACK_S;
      await sleep(REPORT_GAP_MS);
      if (stopping) return SLEEP_FALLBACK_S;
    }
  }
  return SLEEP_FALLBACK_S;
}

// ── the loop ───────────────────────────────────────────────────────────────
const tokenFrom = loadToken();
log(`воркер прогріву — портал ${PORTAL}`);
log(`розклад належить серверу: вікно, черга, паузи й кулдаун вирішує він, тут лише руки`);
if (tokenFrom) log(`токен: із ${tokenFrom}`);
else log('⚠️ WARMUP_AGENT_TOKEN не задано — сервер відповідатиме 401 на кожен запит');
if (RUN_ACCOUNT !== path.join(here, 'run-account.mjs')) log(`⚠️ підмінений run-account: ${RUN_ACCOUNT}`);

/**
 * The dialect is pinned, not discovered.
 *
 * Only Outbound Sales has a scheduler, so there is nothing to discover — and
 * discovery would be actively harmful here: it decides by asking, and a portal
 * that is merely unreachable at the moment the worker starts must not be
 * mistaken for the other one for the rest of the month.
 */
const portal = new Portal(PORTAL, { prefix: '/api/warmup/agent' });

let offline = OFFLINE_FIRST_S;

do {
  let answer = null;
  try {
    answer = await portal.due();
  } catch (error) {
    // Connection refused, DNS, a TLS handshake, a socket that died mid-answer.
    // None of these is a reason to stop; the Mac has been asleep before and the
    // warm-up survived it. Back off so an hour offline is not an hour of
    // requests, and say it once.
    say(`offline:${error.message}`, `⚠️ сервер недоступний: ${error.message} — повторю через ${offline} с`);
    await sleep(offline * 1000);
    offline = Math.min(offline * 2, OFFLINE_MAX_S);
    continue;
  }

  if (!answer.success) {
    // The server answered, and said no: 401 for a missing token, 500 for
    // something broken inside it. Same treatment — a warning, a backoff and
    // another attempt — because every one of these is something a person fixes
    // on the other side while this keeps asking.
    const what = answer.error ?? `HTTP ${answer.status}`;
    say(`refused:${what}`, `⚠️ сервер відмовив: ${what} — повторю через ${offline} с`);
    await sleep(offline * 1000);
    offline = Math.min(offline * 2, OFFLINE_MAX_S);
    continue;
  }
  offline = OFFLINE_FIRST_S;

  const wait = seconds(answer.retryAfterSeconds, { field: 'retryAfterSeconds', max: 1500 });

  if (!answer.next) {
    // The reason is the server's sentence, printed as it came. The window is in
    // the answer too and is not consulted: knowing the hours is not the same as
    // deciding by them, and only one of those still lives here.
    const reason = answer.reason ?? 'сервер не сказав чому';
    say(reason, `⏸ ${reason} — наступне питання через ${wait} с`);
    if (ONCE) break;
    await sleep(wait * 1000);
    continue;
  }

  const next = answer.next;
  const label = next.label ?? next.accountId;

  /**
   * Take the account before opening anything.
   *
   * Asking and taking are two acts now, and the gap between them is real: the
   * answer to `/due` is advice, so another worker — or the same one after a
   * restart — can be told about the same account, and exactly one of them may
   * have it. Losing that race is normal and costs nothing but another poll.
   *
   * A server that still hands the lease out with the advice is honoured as it
   * is: if `leaseId` came back on `next`, it has already been taken and asking
   * again would take a second one.
   */
  let leaseId = next.leaseId ?? null;
  let mandate = next;
  if (!leaseId) {
    let taken = null;
    try {
      taken = await portal.lease(next.accountId);
    } catch (error) {
      say(`lease-offline:${error.message}`, `⚠️ не зміг узяти ${label}: ${error.message} — повторю через ${offline} с`);
      await sleep(offline * 1000);
      offline = Math.min(offline * 2, OFFLINE_MAX_S);
      continue;
    }
    if (!taken.success) {
      const reason = taken.reason ?? taken.error ?? `HTTP ${taken.status}`;
      // 404 is the one answer that means the question itself was wrong: the
      // server advised an account it does not have. Nothing here can fix that
      // and the next poll may well say it again, so it is said loudly every
      // time rather than folded into the quiet states — it is a bug on the
      // other side, and a bug that repeats is worth repeating.
      if (taken.status === 404) {
        shout(`⚠️ сервер порадив ${label}, якого сам не знає: ${reason}`);
      } else {
        // 409 is ordinary: somebody got there first, or the account stopped
        // owing work in the seconds since we asked — a cool-off started, a
        // quota ran out, the window closed. `/due` only advises, so losing
        // this race is expected and costs one more poll.
        const after = seconds(taken.retryAfterSeconds ?? answer.retryAfterSeconds,
          { field: 'retryAfterSeconds', max: 1500 });
        say(`lease:${reason}`, `⏸ ${label} не дістався: ${reason} — наступне питання через ${after} с`);
        if (ONCE) break;
        await sleep(after * 1000);
        continue;
      }
      if (ONCE) break;
      await sleep(wait * 1000);
      continue;
    }
    /**
     * What came back with the lease outranks what came back with the advice.
     *
     * The server re-checks the window, the quota and the cool-off when it
     * grants, so `lease` is a statement about now, while `next` is a statement
     * about whenever we last asked — which may have been a long run ago. They
     * agree almost always, and the almost is the whole reason to prefer one.
     */
    mandate = { ...next, ...(taken.lease ?? {}) };
    leaseId = mandate.leaseId ?? null;
    if (!leaseId) {
      // Granted without saying what was granted. Run anyway — the account is
      // ours and the work is the point — but the report will go up without a
      // lease id, and it has to be visible that that is why.
      shout(`⚠️ сервер віддав ${label} без leaseId — звітую без нього`);
    }
  }

  shout(`▶ ${mandate.label ?? label}: день ${mandate.day}, лишилось ${mandate.remaining} (${(mandate.kinds ?? []).join(', ') || 'без переліку'})`);

  let outcome = { code: -1, note: 'запуск не завершився' };
  let sleepAfter = SLEEP_FALLBACK_S;
  try {
    outcome = await runAccount(next.accountId, leaseId);
  } catch (error) {
    // Belt and braces: `runAccount` resolves rather than throws, but a run that
    // somehow threw is precisely the case where the report must still go out.
    outcome = { code: -1, note: `запуск впав: ${error.message}` };
  } finally {
    const ok = outcome.code === 0;
    shout(`${ok ? '✅' : '❌'} ${label}: run-account завершився з кодом ${outcome.code}${outcome.note ? ` — ${outcome.note}` : ''}`);
    sleepAfter = await report(portal, {
      accountId: next.accountId,
      label,
      leaseId,
      ok,
      note: outcome.note ?? (ok ? 'ok' : `run-account exit ${outcome.code}`),
    });
  }

  if (ONCE) break;
  if (stopping) break;
  log(`   пауза ${sleepAfter} с перед наступним питанням`);
  await sleep(sleepAfter * 1000);
} while (!stopping);

log('воркер зупинено');
process.exit(0);
