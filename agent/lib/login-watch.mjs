/**
 * The watch over accounts that need a person.
 *
 * An account whose session died is marked `needs_login` by the visit that found
 * it, and from that moment the server stops handing it out — which is right,
 * because handing it out every five minutes only teaches LinkedIn our
 * schedule. The cost is that nobody learns when it is fixed, and nobody is
 * told it is broken: the warm-up for that login simply stops, quietly, for as
 * long as nobody opens the dashboard.
 *
 * This closes both ends. A parked account is looked at every half hour —
 * opened, read, closed, nothing else — and the group is told once a day, in
 * one line, while it stays signed out.
 *
 * The decisions, said out loud:
 *
 * - **The button is a link, never a callback.** A Telegram callback needs
 *   `getUpdates` on the bot; that reading is exclusive and acknowledges every
 *   update up to its offset, so for half a day it swallowed the owner's own
 *   replies to another chat on the same bot. A link button tells Telegram
 *   nothing, so one bot carries both. The link is signed and single-use, the
 *   portal issues it (`warmup/login-check.mjs`), and opening it records an ask
 *   that this watch collects within the minute — so "I have logged in" still
 *   works in one tap, it just travels through our own server instead of
 *   through the bot.
 * - **The half-hourly check stands behind the link.** Somebody who logs in and
 *   taps nothing is noticed anyway, within thirty minutes.
 * - **A recovered account is announced out of turn.** The once-a-day limit is
 *   about nagging, and "it works again" is not nagging.
 * - **Health is written through the portal**, like the agent writes it, so the
 *   dashboard, the log and the schedule all see one story.
 * - **A silent watch is still useful.** With no bot token configured it keeps
 *   checking and un-pausing recovered accounts; it just cannot say so.
 */

/** How often a parked account is looked at. */
export const RECHECK_MS = 30 * 60 * 1000;

export const BUTTON_TEXT = 'Вже залогінився — продовжити прогрів';

/** The health values that mean "a person has to go and do something". */
export const NEEDS_PERSON = ['needs_login', 'captcha'];

export function emptyState() {
  return { lastCheck: {}, lastTold: {}, asked: {} };
}

/**
 * The saved state, believed only where it makes sense.
 *
 * `lastCheck` is a moment (ms), `lastTold` a day. A file written by the older
 * version carried a day in `lastCheck` and a Telegram offset beside it; both
 * are dropped rather than converted — a day cannot be read as a moment, and an
 * offset belongs to polling this no longer does. The account is simply looked
 * at once more, which costs one page view.
 */
export function normalizeState(input) {
  const state = emptyState();
  if (!input || typeof input !== 'object') return state;
  for (const [id, at] of Object.entries(input.lastCheck ?? {})) {
    if (Number.isFinite(at) && at > 0) state.lastCheck[id] = Number(at);
  }
  for (const [id, day] of Object.entries(input.lastTold ?? {})) {
    if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) state.lastTold[id] = day;
  }
  for (const [nonce, at] of Object.entries(input.asked ?? {})) {
    if (Number.isFinite(at) && at > 0) state.asked[nonce] = Number(at);
  }
  return state;
}

function parkedAmong(accounts) {
  return accounts.filter((account) => NEEDS_PERSON.includes(account.health) && account.profileRemoteId);
}

async function restore({ portal, telegram, account, asked = false, log = () => {} }) {
  portal.accountId = account.id;
  const note = asked
    ? 'Вхід підтверджено за посиланням із групи.'
    : 'Вхід підтверджено щоденною перевіркою.';
  const answer = await portal.health('ok', note);
  if (!answer?.success) throw new Error(`Портал не прийняв health: ${answer?.error || 'без пояснення'}`);
  log(`${account.label}: вхід відновлено — знято з паузи`);
  if (telegram.configured) await telegram.send(`${account.label}: вхід відновлено, прогрів продовжено.`);
}


/**
 * The asks somebody made by opening the link in the group, answered one at a
 * time.
 *
 * Each one is answered whatever it finds — the page is refreshing while this
 * runs, and a request left unanswered turns into "перевірка затягнулась" on
 * somebody's phone. A probe that throws is reported as "no login seen" with
 * its reason rather than left silent: the person tapped, they get a verdict.
 */
export async function answerAsks({ portal, telegram, probe, state, nowMs = Date.now(), log = () => {} }) {
  let asks;
  try {
    asks = await portal.loginChecks();
  } catch (error) {
    log(`не зміг прочитати запити з групи: ${error.message}`);
    return { asks: 0, restored: 0, skipped: 0 };
  }
  if (!asks.length) return { asks: 0, restored: 0, skipped: 0 };

  const accounts = await portal.accounts();
  let restored = 0;
  let skipped = 0;
  let answered = 0;
  for (const ask of asks) {
    /**
     * One look per ask per half hour, and this is why.
     *
     * 08.10.2026: the verdict could not be written (a crash in the portal's
     * route), so the ask stayed open, and every minute this opened the profile
     * again and sent the group another «входу ще не видно». The owner got three
     * of them for one tap of a button he had not even pressed. An ask that
     * cannot be closed must go quiet, not louder — and a profile opened every
     * minute is the very pattern this whole folder avoids.
     */
    if (nowMs - Number(state?.asked?.[ask.nonce] ?? 0) < RECHECK_MS) {
      skipped += 1;
      continue;
    }
    const account = accounts.find((item) => item.id === ask.accountId);
    if (!account) {
      portal.accountId = ask.accountId;
      await portal.loginRecheck(ask.nonce, false, 'акаунта вже немає в прогріві').catch(() => {});
      if (state?.asked) state.asked[ask.nonce] = nowMs;
      continue;
    }
    let result;
    try {
      result = await probe(account);
    } catch (error) {
      result = { signedIn: false, reason: `не вдалося відкрити профіль: ${error.message}` };
    }
    if (state?.asked) state.asked[ask.nonce] = nowMs;
    answered += 1;

    if (result.signedIn) {
      // Health first: an account that recovered must come back even if the ask
      // cannot be closed afterwards.
      await restore({ portal, telegram, account, asked: true, log });
      restored += 1;
      portal.accountId = account.id;
      await portal.loginRecheck(ask.nonce, true, result.reason || '').catch((error) => {
        log(`${account.label}: вердикт не записався — ${error.message}`);
      });
      continue;
    }

    // Verdict before the message, and no message without it: the page is what
    // the person is looking at, and an unwritten verdict means this will be
    // asked again. Saying "no login yet" on every retry is how one tap became
    // three notifications.
    portal.accountId = account.id;
    let written = false;
    try {
      const answer = await portal.loginRecheck(ask.nonce, false, result.reason || '');
      written = answer?.success === true;
    } catch (error) {
      log(`${account.label}: вердикт не записався — ${error.message}`);
    }
    log(`${account.label}: за посиланням із групи входу не видно (${result.reason})`);
    if (written && telegram.configured) {
      await telegram.send(`${account.label}: входу ще не видно (${result.reason}). Перевір, що залогінився саме в цьому профілі.`);
    }
  }

  // The nonces are a short memory, not a ledger: anything older than a day is
  // past its ask's own lifetime.
  if (state?.asked) {
    for (const [nonce, at] of Object.entries(state.asked)) {
      if (nowMs - Number(at) > 24 * 60 * 60_000) delete state.asked[nonce];
    }
  }
  return { asks: answered, restored, skipped };
}

/**
 * The look at every parked account whose turn has come, and the one line a day
 * about each that is still out.
 */
export async function checkParked({
  portal, telegram, probe, state, today, nowMs = Date.now(), portalUrl = null, log = () => {}
}) {
  const parked = parkedAmong(await portal.accounts());
  let checked = 0;
  let restored = 0;
  let announced = 0;
  for (const account of parked) {
    if (nowMs - Number(state.lastCheck[account.id] ?? 0) < RECHECK_MS) continue;
    let result;
    try {
      result = await probe(account);
    } catch (error) {
      log(`${account.label}: перевірка не вдалася — ${error.message}`);
      continue;
    }
    // Written only after a look that finished: a crashed check must not buy
    // the account half an hour of silence.
    state.lastCheck[account.id] = nowMs;
    checked += 1;
    if (result.signedIn) {
      await restore({ portal, telegram, account, log });
      delete state.lastCheck[account.id];
      delete state.lastTold[account.id];
      restored += 1;
      continue;
    }
    log(`${account.label}: досі розлогінений (${result.reason})`);
    if (state.lastTold[account.id] === today) continue;
    if (telegram.configured) {
      await telegram.send(
        `⚠️ ${account.label}: акаунт вийшов із LinkedIn — прогрів по ньому стоїть.\n`
        + `Відкрий профіль в Anty, залогінься — і натисни кнопку нижче, щоб я перевірив одразу.\n`
        + `Можна й не тиснути: перевіряю кожні 30 хвилин і сам продовжу прогрів, коли побачу вхід.`,
        account.loginCheckPath ? { text: BUTTON_TEXT, url: `${portalUrl}${account.loginCheckPath}` } : null
      );
      announced += 1;
    }
    state.lastTold[account.id] = today;
  }
  return { parked: parked.length, checked, restored, announced };
}
