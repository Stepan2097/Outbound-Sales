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
 * This closes both ends. Once a day each parked account is looked at — opened,
 * read, closed, nothing else — and the group is told in one line. While it
 * stays signed out it is told again the next day, because a single message at
 * 11:00 on a Tuesday is a message nobody acts on. Under the line sits one
 * button: press it after logging in by hand and the account is checked right
 * then, and the warm-up carries on without waiting for tomorrow.
 *
 * The decisions, said out loud:
 *
 * - **The button never trusts the press.** It checks. "I logged in" from a
 *   person who logged into the wrong profile would otherwise put a dead
 *   session back into rotation, and the next visit would walk an account into
 *   a login wall, which is exactly the thing LinkedIn counts.
 * - **One message a day per account, and one on recovery.** A reminder every
 *   hour is a muted group.
 * - **Health is written through the portal**, like the agent writes it, so the
 *   dashboard, the log and the schedule all see one story.
 * - **A silent watch is still useful.** With no bot token configured it keeps
 *   checking and un-pausing recovered accounts; it just cannot say so.
 */
export const ASK_PREFIX = 'warmup:login:';
export const BUTTON_TEXT = 'Вже залогінився — продовжити прогрів';

/** The health values that mean "a person has to go and do something". */
export const NEEDS_PERSON = ['needs_login', 'captcha'];

export function emptyState() {
  return { offset: 0, lastCheck: {} };
}

export function normalizeState(input) {
  const state = emptyState();
  if (!input || typeof input !== 'object') return state;
  state.offset = Number.isSafeInteger(input.offset) && input.offset > 0 ? input.offset : 0;
  if (input.lastCheck && typeof input.lastCheck === 'object') {
    for (const [id, day] of Object.entries(input.lastCheck)) {
      if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) state.lastCheck[id] = day;
    }
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
 * The presses since the last look. Each one is answered — the grey toast on
 * the button — whether or not it changed anything, because a button that says
 * nothing back gets pressed again.
 */
export async function handlePresses({ portal, telegram, probe, state, log = () => {} }) {
  if (!telegram.configured) return { presses: 0, restored: 0 };
  const { offset, presses } = await telegram.callbacks(state.offset ?? 0);
  state.offset = offset;
  let restored = 0;
  for (const press of presses) {
    if (!press.data.startsWith(ASK_PREFIX)) continue;
    const accountId = press.data.slice(ASK_PREFIX.length);
    const account = (await portal.accounts()).find((item) => item.id === accountId);
    if (!account) {
      await telegram.answer(press.id, 'Цього акаунта вже немає в списку прогріву.');
      continue;
    }
    let result;
    try {
      result = await probe(account);
    } catch (error) {
      await telegram.answer(press.id, `Не вдалося перевірити: ${error.message}`);
      continue;
    }
    if (result.signedIn) {
      await restore({ portal, telegram, account, who: press.from, log });
      await telegram.answer(press.id, 'Вхід бачу — прогрів продовжено.');
      state.lastCheck[account.id] = null;
      delete state.lastCheck[account.id];
      restored += 1;
    } else {
      await telegram.answer(press.id, 'Входу ще не видно. Перевір, що залогінився саме в цьому профілі.');
      await telegram.send(`${account.label}: входу ще не видно (${result.reason}).`);
    }
  }
  return { presses: presses.length, restored };
}

/**
 * Today's look at every parked account: at most one per account per day,
 * whatever it finds.
 */
export async function checkParked({ portal, telegram, probe, state, today, log = () => {} }) {
  const parked = parkedAmong(await portal.accounts());
  let checked = 0;
  let restored = 0;
  let announced = 0;
  for (const account of parked) {
    if (state.lastCheck[account.id] === today) continue;
    let result;
    try {
      result = await probe(account);
    } catch (error) {
      log(`${account.label}: перевірка не вдалася — ${error.message}`);
      continue;
    }
    // Written only after a look that finished: a crashed check must not buy
    // the account a day of silence.
    state.lastCheck[account.id] = today;
    checked += 1;
    if (result.signedIn) {
      await restore({ portal, telegram, account, log });
      delete state.lastCheck[account.id];
      restored += 1;
      continue;
    }
    log(`${account.label}: досі розлогінений (${result.reason})`);
    if (telegram.configured) {
      await telegram.send(
        `⚠️ ${account.label}: акаунт вийшов із LinkedIn — прогрів по ньому стоїть.\n`
        + `Відкрий профіль в Anty, залогінься, і натисни кнопку нижче.`,
        { text: BUTTON_TEXT, data: `${ASK_PREFIX}${account.id}` }
      );
      announced += 1;
    }
  }
  return { parked: parked.length, checked, restored, announced };
}
