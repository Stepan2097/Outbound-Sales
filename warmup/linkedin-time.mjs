// Коли повідомлення прийшло в LinkedIn (власник 16.10: «хіба це повідомлення
// прийшло 4 год назад, став там дату коли це повідомлення приходить в
// лінкедин»).
//
// The agent sends LinkedIn's own label whenever the page gives no datetime,
// and the page almost never does: the first message of a day carries the day
// separator («28 вер.», «вівторок», «Сьогодні», «Sep 1»), the ones after it
// only a clock («14:31»). Stored as is, beside the moment the agent read it.
// The screen showed that moment — «4 год тому» for a welcome note from
// September.
//
// This reads the labels back into a day, and a time where the clock gives one,
// against the moment each was read, walking a thread in order so a clock
// lands on the day its separator named. It is for showing only: `sentAt`
// stays what it was, because the reply check and the thread order rely on it.

export const LINKEDIN_ZONE = "Europe/Kyiv";

const DAY_MS = 86_400_000;

const MONTHS = [
  ["січ", 0], ["лют", 1], ["бер", 2], ["квіт", 3], ["трав", 4], ["черв", 5],
  ["лип", 6], ["серп", 7], ["вер", 8], ["жовт", 9], ["лист", 10], ["груд", 11],
  ["jan", 0], ["feb", 1], ["mar", 2], ["apr", 3], ["may", 4], ["jun", 5],
  ["jul", 6], ["aug", 7], ["sep", 8], ["oct", 9], ["nov", 10], ["dec", 11],
  ["ene", 0], ["abr", 3], ["ago", 7], ["dic", 11]
];

const WEEKDAYS = [
  [/^(неділя|нд|sunday|sun|domingo|dom)$/, 0],
  [/^(понеділок|пн|monday|mon|lunes|lun)$/, 1],
  [/^(вівторок|вт|tuesday|tue|tues|martes)$/, 2],
  [/^(середа|ср|wednesday|wed|miércoles|miercoles|mié|mie)$/, 3],
  [/^(четвер|чт|thursday|thu|thur|thurs|jueves|jue)$/, 4],
  [/^(п[ʼ'’]?ятниця|пт|friday|fri|viernes|vie)$/, 5],
  [/^(субота|сб|saturday|sat|sábado|sabado|sáb|sab)$/, 6]
];

const UNITS = {
  m: 60_000, min: 60_000, mins: 60_000, хв: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, год: 3_600_000,
  d: DAY_MS, д: DAY_MS, дн: DAY_MS, days: DAY_MS, day: DAY_MS,
  w: 7 * DAY_MS, wk: 7 * DAY_MS, тиж: 7 * DAY_MS
};

const pad = (value) => String(value).padStart(2, "0");

const zoneFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: LINKEDIN_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short"
});

function zoneParts(ms) {
  const parts = Object.fromEntries(zoneFormat.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday)
  };
}

/** The Kyiv calendar day of a moment, as `YYYY-MM-DD`. */
export function zoneDay(ms) {
  const parts = zoneParts(ms);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function shiftDay(day, days) {
  const [year, month, date] = day.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1, date + days, 12));
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/** A Kyiv wall-clock time on a day, as a moment. */
function zoneMoment(day, hour, minute) {
  const [year, month, date] = day.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  let guess = wall;
  for (let step = 0; step < 2; step += 1) {
    const seen = zoneParts(guess);
    guess += wall - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
  }
  return guess;
}

function monthOf(word) {
  const lower = word.toLowerCase().replace(/\.$/, "");
  return MONTHS.find(([prefix]) => lower.startsWith(prefix))?.[1] ?? null;
}

function datedDay(year, month, date, readMs, yearGiven) {
  if (month === null || date < 1 || date > 31) return null;
  const today = zoneDay(readMs);
  let day = `${year}-${pad(month + 1)}-${pad(date)}`;
  // Without a year LinkedIn means the most recent one.
  if (!yearGiven && day > today) day = `${year - 1}-${pad(month + 1)}-${pad(date)}`;
  return day;
}

/**
 * One label read against the moment it was read: `{ day }`, `{ at }` (a moment),
 * `{ clock: [hour, minute] }` (a time on a day the label does not name), or null.
 */
export function readLinkedinLabel(label, readMs) {
  const text = String(label ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!text || !Number.isFinite(readMs)) return null;
  const today = zoneDay(readMs);

  if (/^(сьогодні|today|hoy)$/.test(text)) return { day: today };
  if (/^(вчора|yesterday|ayer)$/.test(text)) return { day: shiftDay(today, -1) };

  const weekday = WEEKDAYS.find(([pattern]) => pattern.test(text.replace(/\.$/, "")))?.[1];
  if (weekday !== undefined) {
    // A weekday is one of the last few days, never today.
    const back = (zoneParts(readMs).weekday - weekday + 7) % 7 || 7;
    return { day: shiftDay(today, -back) };
  }

  const relative = text.match(/^(\d+)\s*([a-zа-яіїєґ]+)\.?(?:\s+(?:ago|тому))?$/);
  if (relative && UNITS[relative[2]]) {
    const at = readMs - Number(relative[1]) * UNITS[relative[2]];
    return UNITS[relative[2]] >= DAY_MS ? { day: zoneDay(at) } : { at };
  }

  const year = Number(today.slice(0, 4));
  // «28 вер.», «1 вересня 2025 р.», «12 Sep», «1 sept»
  const dayFirst = text.match(/^(\d{1,2})\s+(?:de\s+)?([a-zа-яіїєґ]{3,12})\.?(?:,?\s*(\d{4}))?(?:\s*р\.?)?$/);
  if (dayFirst) return wrap(datedDay(dayFirst[3] ? Number(dayFirst[3]) : year, monthOf(dayFirst[2]), Number(dayFirst[1]), readMs, Boolean(dayFirst[3])));
  // «Sep 1», «Sep 1, 2025»
  const monthFirst = text.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?$/);
  if (monthFirst) return wrap(datedDay(monthFirst[3] ? Number(monthFirst[3]) : year, monthOf(monthFirst[1]), Number(monthFirst[2]), readMs, Boolean(monthFirst[3])));

  // «14:31», «10:32 AM», «4:05 p. m.»
  const clock = text.match(/^(\d{1,2}):(\d{2})\s*([ap])?\.?\s*(?:m\.?)?$/);
  if (clock) {
    let hour = Number(clock[1]);
    if (clock[3]) hour = (hour % 12) + (clock[3] === "p" ? 12 : 0);
    if (hour > 23 || Number(clock[2]) > 59) return null;
    return { clock: [hour, Number(clock[2])] };
  }
  return null;
}

function wrap(day) {
  return day ? { day } : null;
}

/**
 * A thread's messages, oldest first, each with `linkedinAt` (when LinkedIn says
 * it was sent, to the minute) or only `linkedinDay` (the day), or neither when
 * nothing on the page said. A clock belongs to the day named last before it;
 * a message with no label at all to the day of the one before it.
 */
export function withLinkedinTimes(messages) {
  let day = null;
  return messages.map((message) => {
    const readMs = Date.parse(message.storedAt || "");
    if (message.sentAtGiven) {
      const at = Date.parse(message.sentAt || "");
      if (Number.isFinite(at)) {
        day = zoneDay(at);
        return { ...message, linkedinAt: new Date(at).toISOString(), linkedinDay: day };
      }
    }
    const read = readLinkedinLabel(message.sentAtRaw, readMs);
    if (read?.day) {
      day = read.day;
      return { ...message, linkedinAt: null, linkedinDay: day };
    }
    if (read?.at) {
      day = zoneDay(read.at);
      return { ...message, linkedinAt: new Date(read.at).toISOString(), linkedinDay: day };
    }
    if (read?.clock) {
      let base = day ?? (Number.isFinite(readMs) ? zoneDay(readMs) : null);
      if (!base) return { ...message, linkedinAt: null, linkedinDay: null };
      let at = zoneMoment(base, read.clock[0], read.clock[1]);
      // A clock later than the moment it was read, with no day before it, was yesterday's.
      if (day === null && at > readMs + 5 * 60_000) {
        base = shiftDay(base, -1);
        at = zoneMoment(base, read.clock[0], read.clock[1]);
      }
      day = base;
      return { ...message, linkedinAt: new Date(at).toISOString(), linkedinDay: day };
    }
    return { ...message, linkedinAt: null, linkedinDay: day };
  });
}
