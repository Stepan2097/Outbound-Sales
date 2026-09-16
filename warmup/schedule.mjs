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
 */
export const SESSION_WINDOW = { startHour: 9, endHour: 13 };

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
