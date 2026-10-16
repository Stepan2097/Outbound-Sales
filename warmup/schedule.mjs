/**
 * When today's session happens.
 *
 * A day has a time, derived the same way the quotas are: seeded on the account
 * and the date, so it does not move when the page is refreshed and two accounts
 * do not fire at the same minute.
 */

/**
 * The hours a session may happen in. A profile active at 04:00 is a signal in
 * itself, so every planned time is drawn from inside this window and the agent
 * refuses to start outside it — a schedule nothing enforces is a suggestion.
 *
 * `endHour` is the first hour a session may no longer start: 9–13 means the
 * last slot is 12:55.
 *
 * Nine to one unless the deployment says otherwise. It is a constant in the
 * sense that matters — nothing moves it at runtime, and the agent cannot talk
 * its way past it — but the hours themselves belong to the operator's day, and
 * on 08.10.2026 showing the owner a live run meant editing this file and
 * deploying twice. A window that can only be changed by a release is not
 * safer, it is only harder to use honestly. Values that are not two whole
 * hours with the start before the end are ignored rather than obeyed: a typo
 * in an environment variable must not open the night.
 */
function windowHour(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const hour = Number(raw);
  return Number.isInteger(hour) && hour >= 0 && hour <= 24 ? hour : fallback;
}

function configuredWindow() {
  const startHour = windowHour("WARMUP_SESSION_START_HOUR", 9);
  const endHour = windowHour("WARMUP_SESSION_END_HOUR", 13);
  return startHour < endHour ? { startHour, endHour } : { startHour: 9, endHour: 13 };
}

export const SESSION_WINDOW = configuredWindow();

/** Local time, because the window is the operator's day. */
export function insideWindow(date = new Date()) {
  const hour = date.getHours();
  return hour >= SESSION_WINDOW.startHour && hour < SESSION_WINDOW.endHour;
}

/**
 * The window in the team's own clock (Kyiv, 16.10.2026), whatever zone the
 * server runs in: the server keeps Warsaw time, an hour behind, and a page that
 * said «07:00–19:00» for what is eight to eight in Kyiv would be read wrong.
 * WARMUP_LABEL_ZONE moves it; the window itself is still the server's hours.
 */
function labelShiftHours(date = new Date()) {
  const zone = process.env.WARMUP_LABEL_ZONE || "Europe/Kyiv";
  try {
    const there = new Date(date.toLocaleString("en-US", { timeZone: zone }));
    const here = new Date(date.toLocaleString("en-US"));
    return Math.round((there.getTime() - here.getTime()) / 3_600_000);
  } catch { return 0; }
}

export function windowLabel() {
  const pad = (hour) => String(((hour % 24) + 24) % 24).padStart(2, "0");
  const shift = labelShiftHours();
  return `${pad(SESSION_WINDOW.startHour + shift)}:00–${pad(SESSION_WINDOW.endHour + shift)}:00`;
}

// ── Чергування у вхідних (власник 16.10: «тримати відкритим акаунт з 8 до 8
// з якимось перервами 2-4 рандомно, і сповіщення будуть одразу приходити») ──
//
// Inside the window an account looks into its inbox every 12–20 minutes, as
// somebody with LinkedIn open in a tab would, with 2–4 breaks a day of 25–60
// minutes each, placed at random between the first and the last hour. Drawn
// from the account and the date, so a restart does not move them.
export function dutyBreaks(accountId, date = new Date()) {
  const key = `${accountId}:${localDateKey(date)}`;
  const count = 2 + (seedHash(`${key}:breaks`) % 3);
  const firstMinute = (SESSION_WINDOW.startHour + 1) * 60;
  const span = Math.max(60, (SESSION_WINDOW.endHour - SESSION_WINDOW.startHour - 2) * 60);
  const breaks = [];
  for (let index = 0; index < count; index += 1) {
    const start = firstMinute + (seedHash(`${key}:break:${index}:at`) % span);
    const length = 25 + (seedHash(`${key}:break:${index}:len`) % 36);
    const from = new Date(date); from.setHours(0, start, 0, 0);
    breaks.push({ from: from.getTime(), to: from.getTime() + length * 60_000 });
  }
  return breaks.sort((left, right) => left.from - right.from);
}

export function onDutyBreak(accountId, date = new Date()) {
  const at = date.getTime();
  return dutyBreaks(accountId, date).find((pause) => at >= pause.from && at < pause.to) ?? null;
}

/** Minutes between two looks into the inbox, 12–20, drawn from the account and the last look. */
export function dutyGapMinutes(accountId, lastMs) {
  return 12 + (seedHash(`${accountId}:${Math.floor(lastMs / 60_000)}:gap`) % 9);
}

function seedHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * The planned session time for one account on one day. Minutes are drawn in
 * 5-minute steps: a plan that says 14:23 pretends to a precision nobody is
 * going to hit by hand.
 */
export function sessionTimeOn(accountId, date) {
  const slots = (SESSION_WINDOW.endHour - SESSION_WINDOW.startHour) * 12;
  const slot = seedHash(`${accountId}:${localDateKey(date)}:session`) % slots;
  const planned = new Date(date);
  planned.setHours(SESSION_WINDOW.startHour, 0, 0, 0);
  planned.setMinutes(slot * 5);
  return planned;
}

/**
 * The session an account is due next.
 *
 * `outstanding` is whether today's quota still has actions left in it. While it
 * does, the answer is today — at the planned time if it is ahead, right now if
 * it is not. Only a finished day points at tomorrow: answering "tomorrow" while
 * today's actions sit untouched tells an operator to go home with the work
 * still there.
 */
export function nextSession(accountId, options = {}) {
  const now = options.now || new Date();
  const todaySlot = sessionTimeOn(accountId, now);

  // `notBefore` is the scheduler's own hold on the account — the rest between
  // two sessions of one morning, or the cool-off after a failed one. Without it
  // an account the scheduler will not hand out for an hour read "time has
  // come", which is the one answer that sends an operator looking for a fault.
  const notBefore = Number(options.notBefore) || 0;

  // What is left of today stops being owed when the window closes: no session
  // starts after it (`insideWindow`), and tomorrow's quota does not carry
  // today's over. On 08.10.2026 at 19:50 an account with one request left read
  // «час настав» — the one answer that says something is late and should be
  // looked into, at an hour when nothing could happen until 09:00. The same
  // goes for a hold that ends after the window: the morning is over for it.
  const windowEnd = new Date(now);
  windowEnd.setHours(SESSION_WINDOW.endHour, 0, 0, 0);
  const todayIsOver = now.getTime() >= windowEnd.getTime() || notBefore >= windowEnd.getTime();
  const outstanding = options.outstanding !== false && !todayIsOver;
  if (outstanding && notBefore > now.getTime() && notBefore > todaySlot.getTime()) {
    const held = new Date(notBefore);
    return {
      at: held.toISOString(),
      today: localDateKey(held) === localDateKey(now),
      overdue: false,
      inMinutes: Math.round((notBefore - now.getTime()) / 60000)
    };
  }

  if (outstanding) {
    if (todaySlot.getTime() > now.getTime()) {
      return {
        at: todaySlot.toISOString(),
        today: true,
        overdue: false,
        inMinutes: Math.round((todaySlot.getTime() - now.getTime()) / 60000)
      };
    }
    return { at: now.toISOString(), today: true, overdue: true, inMinutes: 0 };
  }

  // Nothing left today, or no window left to do it in, so the next session is
  // tomorrow's — even when today's planned time has not arrived yet. An account that finished at 09:04 was
  // otherwise told its next session was at 09:35 today, which would do nothing.
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowSlot = sessionTimeOn(accountId, tomorrow);
  return {
    at: tomorrowSlot.toISOString(),
    today: false,
    overdue: false,
    inMinutes: Math.round((tomorrowSlot.getTime() - now.getTime()) / 60000)
  };
}
