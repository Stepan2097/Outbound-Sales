// ESP 17 — the recipient's public holidays: no cold letter on a day off.
//
// Checklist (P2): «Свята країни одержувача — пропускати державні вихідні.»
//
// National public holidays of the markets we write to, computed per year:
// fixed dates, days counted from Easter (Western), and "the n-th Monday" kinds.
// Regional holidays (a German Land, a US state) are left out — a national rule
// is what a lead row's country can tell us; so are holidays a government moves
// by decree each year (Argentina's «puentes», Colombia's Monday shifts). A
// country not listed has no holidays here: the weekday window (ESP 4) still
// holds. Ukraine is not listed on purpose — under martial law public holidays
// are working days.

/** Western Easter Sunday (anonymous Gregorian algorithm), as a UTC date. */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const iso = (date) => date.toISOString().slice(0, 10);
const fixed = (year, month, day) => iso(new Date(Date.UTC(year, month - 1, day)));
const fromEaster = (year, days) => iso(new Date(easterSunday(year).getTime() + days * 86_400_000));
/** The n-th weekday (0 = Sunday … 6 = Saturday) of a month; n = -1 is the last one. */
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const offset = (weekday - first.getUTCDay() + 7) % 7;
    return iso(new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7)));
  }
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return iso(new Date(Date.UTC(year, month - 1, last.getUTCDate() - offset)));
}
/** US practice: a fixed holiday on Saturday is observed on Friday, on Sunday — on Monday. */
function observed(dateIso) {
  const date = new Date(`${dateIso}T12:00:00Z`);
  const day = date.getUTCDay();
  if (day === 6) return iso(new Date(date.getTime() - 86_400_000));
  if (day === 0) return iso(new Date(date.getTime() + 86_400_000));
  return dateIso;
}
/** UK / Canada practice: a fixed holiday on a weekend is given back on the following Monday. */
function mondayAfter(dateIso) {
  const date = new Date(`${dateIso}T12:00:00Z`);
  const day = date.getUTCDay();
  return day === 6 ? iso(new Date(date.getTime() + 2 * 86_400_000)) : day === 0 ? iso(new Date(date.getTime() + 86_400_000)) : dateIso;
}
/** Christmas and Boxing Day as the UK gives them: both days off, moved past the weekend. */
function christmasPair(year) {
  const day = new Date(Date.UTC(year, 11, 25)).getUTCDay();
  if (day === 6) return [fixed(year, 12, 27), fixed(year, 12, 28)];
  if (day === 0) return [fixed(year, 12, 26), fixed(year, 12, 27)];
  if (day === 5) return [fixed(year, 12, 25), fixed(year, 12, 28)];
  return [fixed(year, 12, 25), fixed(year, 12, 26)];
}
/** Orthodox Easter Sunday (Julian computus moved to the Gregorian calendar; good for 1900–2099). */
export function orthodoxEasterSunday(year) {
  const d = (19 * (year % 19) + 15) % 30;
  const e = (2 * (year % 4) + 4 * (year % 7) - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day + 13));
}
const fromOrthodoxEaster = (year, days) => iso(new Date(orthodoxEasterSunday(year).getTime() + days * 86_400_000));
/** Victoria Day: the Monday before 25 May. */
const victoriaDay = (year) => { const may24 = new Date(Date.UTC(year, 4, 24)); return iso(new Date(Date.UTC(year, 4, 24 - ((may24.getUTCDay() + 6) % 7)))); };
/** St Brigid's Day (Ireland, since 2023): 1 February when it is a Friday, else the first Monday of February. */
const brigid = (year) => (new Date(Date.UTC(year, 1, 1)).getUTCDay() === 5 ? fixed(year, 2, 1) : nthWeekday(year, 2, MON, 1));
const MON = 1;
const THU = 4;

const RULES = {
  PL: (y) => [fixed(y, 1, 1), fixed(y, 1, 6), fromEaster(y, 1), fixed(y, 5, 1), fixed(y, 5, 3), fromEaster(y, 49), fromEaster(y, 60), fixed(y, 8, 15), fixed(y, 11, 1), fixed(y, 11, 11), fixed(y, 12, 25), fixed(y, 12, 26), ...(y >= 2025 ? [fixed(y, 12, 24)] : [])],
  DE: (y) => [fixed(y, 1, 1), fromEaster(y, -2), fromEaster(y, 1), fixed(y, 5, 1), fromEaster(y, 39), fromEaster(y, 50), fixed(y, 10, 3), fixed(y, 12, 25), fixed(y, 12, 26)],
  AT: (y) => [fixed(y, 1, 1), fixed(y, 1, 6), fromEaster(y, 1), fixed(y, 5, 1), fromEaster(y, 39), fromEaster(y, 50), fromEaster(y, 60), fixed(y, 8, 15), fixed(y, 10, 26), fixed(y, 11, 1), fixed(y, 12, 8), fixed(y, 12, 25), fixed(y, 12, 26)],
  GB: (y) => [mondayAfter(fixed(y, 1, 1)), fromEaster(y, -2), fromEaster(y, 1), nthWeekday(y, 5, MON, 1), nthWeekday(y, 5, MON, -1), nthWeekday(y, 8, MON, -1), ...christmasPair(y)],
  IE: (y) => [mondayAfter(fixed(y, 1, 1)), brigid(y), mondayAfter(fixed(y, 3, 17)), fromEaster(y, 1), nthWeekday(y, 5, MON, 1), nthWeekday(y, 6, MON, 1), nthWeekday(y, 8, MON, 1), nthWeekday(y, 10, MON, -1), ...christmasPair(y)],
  US: (y) => [observed(fixed(y, 1, 1)), nthWeekday(y, 1, MON, 3), nthWeekday(y, 2, MON, 3), nthWeekday(y, 5, MON, -1), observed(fixed(y, 6, 19)), observed(fixed(y, 7, 4)), nthWeekday(y, 9, MON, 1), nthWeekday(y, 10, MON, 2), observed(fixed(y, 11, 11)), nthWeekday(y, 11, THU, 4), observed(fixed(y, 12, 25))],
  CA: (y) => [mondayAfter(fixed(y, 1, 1)), fromEaster(y, -2), victoriaDay(y), mondayAfter(fixed(y, 7, 1)), nthWeekday(y, 9, MON, 1), mondayAfter(fixed(y, 9, 30)), nthWeekday(y, 10, MON, 2), mondayAfter(fixed(y, 11, 11)), ...christmasPair(y)],
  FR: (y) => [fixed(y, 1, 1), fromEaster(y, 1), fixed(y, 5, 1), fixed(y, 5, 8), fromEaster(y, 39), fromEaster(y, 50), fixed(y, 7, 14), fixed(y, 8, 15), fixed(y, 11, 1), fixed(y, 11, 11), fixed(y, 12, 25)],
  ES: (y) => [fixed(y, 1, 1), fixed(y, 1, 6), fromEaster(y, -2), fixed(y, 5, 1), fixed(y, 8, 15), fixed(y, 10, 12), fixed(y, 11, 1), fixed(y, 12, 6), fixed(y, 12, 8), fixed(y, 12, 25)],
  PT: (y) => [fixed(y, 1, 1), fromEaster(y, -2), fromEaster(y, 0), fixed(y, 4, 25), fixed(y, 5, 1), fromEaster(y, 60), fixed(y, 6, 10), fixed(y, 8, 15), fixed(y, 10, 5), fixed(y, 11, 1), fixed(y, 12, 1), fixed(y, 12, 8), fixed(y, 12, 25)],
  IT: (y) => [fixed(y, 1, 1), fixed(y, 1, 6), fromEaster(y, 1), fixed(y, 4, 25), fixed(y, 5, 1), fixed(y, 6, 2), fixed(y, 8, 15), ...(y >= 2026 ? [fixed(y, 10, 4)] : []), fixed(y, 11, 1), fixed(y, 12, 8), fixed(y, 12, 25), fixed(y, 12, 26)],
  NL: (y) => [fixed(y, 1, 1), fromEaster(y, 1), new Date(Date.UTC(y, 3, 27)).getUTCDay() === 0 ? fixed(y, 4, 26) : fixed(y, 4, 27), fromEaster(y, 39), fromEaster(y, 50), fixed(y, 12, 25), fixed(y, 12, 26)],
  BE: (y) => [fixed(y, 1, 1), fromEaster(y, 1), fixed(y, 5, 1), fromEaster(y, 39), fromEaster(y, 50), fixed(y, 7, 21), fixed(y, 8, 15), fixed(y, 11, 1), fixed(y, 11, 11), fixed(y, 12, 25)],
  CZ: (y) => [fixed(y, 1, 1), fromEaster(y, -2), fromEaster(y, 1), fixed(y, 5, 1), fixed(y, 5, 8), fixed(y, 7, 5), fixed(y, 7, 6), fixed(y, 9, 28), fixed(y, 10, 28), fixed(y, 11, 17), fixed(y, 12, 24), fixed(y, 12, 25), fixed(y, 12, 26)],
  MT: (y) => [fixed(y, 1, 1), fixed(y, 2, 10), fixed(y, 3, 19), fixed(y, 3, 31), fromEaster(y, -2), fixed(y, 5, 1), fixed(y, 6, 7), fixed(y, 6, 29), fixed(y, 8, 15), fixed(y, 9, 8), fixed(y, 9, 21), fixed(y, 12, 8), fixed(y, 12, 13), fixed(y, 12, 25)],
  CY: (y) => [fixed(y, 1, 1), fixed(y, 1, 6), fromOrthodoxEaster(y, -48), fixed(y, 3, 25), fixed(y, 4, 1), fromOrthodoxEaster(y, -2), fromOrthodoxEaster(y, 1), fixed(y, 5, 1), fromOrthodoxEaster(y, 50), fixed(y, 8, 15), fixed(y, 10, 1), fixed(y, 10, 28), fixed(y, 12, 25), fixed(y, 12, 26)],
  BR: (y) => [fixed(y, 1, 1), fromEaster(y, -48), fromEaster(y, -47), fromEaster(y, -2), fixed(y, 4, 21), fixed(y, 5, 1), fromEaster(y, 60), fixed(y, 9, 7), fixed(y, 10, 12), fixed(y, 11, 2), fixed(y, 11, 15), fixed(y, 11, 20), fixed(y, 12, 25)],
  MX: (y) => [fixed(y, 1, 1), nthWeekday(y, 2, MON, 1), nthWeekday(y, 3, MON, 3), fixed(y, 5, 1), fixed(y, 9, 16), nthWeekday(y, 11, MON, 3), fixed(y, 12, 25)],
  AR: (y) => [fixed(y, 1, 1), fromEaster(y, -48), fromEaster(y, -47), fixed(y, 3, 24), fixed(y, 4, 2), fromEaster(y, -2), fixed(y, 5, 1), fixed(y, 5, 25), fixed(y, 6, 20), fixed(y, 7, 9), fixed(y, 12, 8), fixed(y, 12, 25)],
  CO: (y) => [fixed(y, 1, 1), fromEaster(y, -3), fromEaster(y, -2), fixed(y, 5, 1), fixed(y, 7, 20), fixed(y, 8, 7), fixed(y, 12, 8), fixed(y, 12, 25)],
  CL: (y) => [fixed(y, 1, 1), fromEaster(y, -2), fromEaster(y, -1), fixed(y, 5, 1), fixed(y, 5, 21), fixed(y, 7, 16), fixed(y, 8, 15), fixed(y, 9, 18), fixed(y, 9, 19), fixed(y, 11, 1), fixed(y, 12, 8), fixed(y, 12, 25)],
  PE: (y) => [fixed(y, 1, 1), fromEaster(y, -3), fromEaster(y, -2), fixed(y, 5, 1), fixed(y, 6, 29), fixed(y, 7, 28), fixed(y, 7, 29), fixed(y, 8, 30), fixed(y, 10, 8), fixed(y, 11, 1), fixed(y, 12, 8), fixed(y, 12, 25)]
};

const NAMES = {
  poland: "PL", polska: "PL", польща: "PL", germany: "DE", deutschland: "DE", німеччина: "DE", austria: "AT", österreich: "AT",
  "united kingdom": "GB", uk: "GB", gb: "GB", england: "GB", "great britain": "GB", великобританія: "GB", ireland: "IE",
  "united states": "US", usa: "US", us: "US", "united states of america": "US", сша: "US", canada: "CA", канада: "CA",
  france: "FR", франція: "FR", spain: "ES", españa: "ES", іспанія: "ES", portugal: "PT", португалія: "PT", italy: "IT", italia: "IT", італія: "IT",
  netherlands: "NL", holland: "NL", nederland: "NL", нідерланди: "NL", belgium: "BE", czechia: "CZ", "czech republic": "CZ", чехія: "CZ",
  malta: "MT", мальта: "MT", cyprus: "CY", кіпр: "CY", brazil: "BR", brasil: "BR", бразилія: "BR", mexico: "MX", méxico: "MX", мексика: "MX",
  argentina: "AR", аргентина: "AR", colombia: "CO", колумбія: "CO", chile: "CL", чилі: "CL", peru: "PE", "perú": "PE", перу: "PE"
};

export function holidayCountry(country) {
  const value = String(country ?? "").trim();
  if (/^[A-Za-z]{2}$/.test(value) && RULES[value.toUpperCase()]) return value.toUpperCase();
  return NAMES[value.toLowerCase()] || null;
}

const cache = new Map();

/** The country's national public holidays in a year, as a set of YYYY-MM-DD. */
export function holidaysOf(code, year) {
  const key = `${code}|${year}`;
  if (!cache.has(key)) cache.set(key, new Set(RULES[code] ? RULES[code](year) : []));
  return cache.get(key);
}

/** Is this local date (YYYY-MM-DD) a public holiday where the recipient is? */
export function isHoliday(country, localDate) {
  const code = holidayCountry(country);
  if (!code) return false;
  return holidaysOf(code, Number(String(localDate).slice(0, 4))).has(String(localDate).slice(0, 10));
}

export const HOLIDAY_COUNTRIES = Object.keys(RULES);
