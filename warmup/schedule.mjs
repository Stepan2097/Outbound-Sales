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

export function windowLabel() {
  const pad = (hour) => String(hour).padStart(2, "0");
  return `${pad(SESSION_WINDOW.startHour)}:00–${pad(SESSION_WINDOW.endHour)}:00`;
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
  const outstanding = options.outstanding !== false;
  const now = options.now || new Date();
  const todaySlot = sessionTimeOn(accountId, now);

  // `notBefore` is the scheduler's own hold on the account — the rest between
  // two sessions of one morning, or the cool-off after a failed one. Without it
  // an account the scheduler will not hand out for an hour read "time has
  // come", which is the one answer that sends an operator looking for a fault.
  const notBefore = Number(options.notBefore) || 0;
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

  // Nothing left today, so the next session is tomorrow's — even when today's
  // planned time has not arrived yet. An account that finished at 09:04 was
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
