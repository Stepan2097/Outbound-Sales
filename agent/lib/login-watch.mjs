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
 * - **There is no button that reports back.** There was one, for a day: an
 *   inline callback button, which needs `getUpdates` on the bot. That polling
 *   is exclusive and acknowledges every update up to its offset, so it
 *   swallowed the owner's own replies to a different chat on the same bot.
 *   Telegram offers no way to read only part of a bot's updates — the rest are
 *   dropped, not queued. So the group message carries a **link** button (which
 *   reports nothing to anybody) and the half-hourly check is what resumes the
 *   warm-up: log in, and within thirty minutes the account is back by itself.
 *   A one-tap button can come back the day this has a bot of its own.
 * - **A recovered account is announced out of turn.** The once-a-day limit is
 *   about nagging, and "it works again" is not nagging.
 * - **Health is written through the portal**, like the agent writes it, so the
 *   dashboard, the log and the schedule all see one story.
 * - **A silent watch is still useful.** With no bot token configured it keeps
 *   checking and un-pausing recovered accounts; it just cannot say so.
 */

/** How often a parked account is looked at. */
export const RECHECK_MS = 30 * 60 * 1000;

/** The health values that mean "a person has to go and do something". */
export const NEEDS_PERSON = ['needs_login', 'captcha'];

export function emptyState() {
  return { lastCheck: {}, lastTold: {} };
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
  return state;
}

function parkedAmong(accounts) {
  return accounts.filter((account) => NEEDS_PERSON.includes(account.health) && account.profileRemoteId);
}

async function restore({ portal, telegram, account, who = null, log = () => {} }) {
  portal.accountId = account.id;
  const note = who
    ? `Вхід підтверджено після кнопки в групі (${who}).`
    : 'Вхід підтверджено щоденною перевіркою.';
  const answer = await portal.health('ok', note);
  if (!answer?.success) throw new Error(`Портал не прийняв health: ${answer?.error || 'без пояснення'}`);
  log(`${account.label}: вхід відновлено — знято з паузи`);
  if (telegram.configured) await telegram.send(`${account.label}: вхід відновлено, прогрів продовжено.`);
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
        + `Відкрий профіль в Anty і залогінься. Тиснути нічого не треба: перевіряю кожні 30 хвилин `
        + `і сам продовжу прогрів, коли побачу вхід.`,
        portalUrl ? { text: 'Відкрити Outbound', url: portalUrl } : null
      );
      announced += 1;
    }
    state.lastTold[account.id] = today;
  }
  return { parked: parked.length, checked, restored, announced };
}
