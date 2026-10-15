// ESP 4 — how many, how often and when: limits, intervals and the window.
//
// Checklist (P0):
// - «Ліміт на сендера — сумарно по всіх кампаніях: ціль 35 на день, але
//   фактичний ліміт = етап рампи (5 → 10 → 15 → 20 → 25 → 30 → 35).»
// - «Ліміт на домен — сума сендерів домену ≤ ~105 на день.»
// - «Вікно відправки — Пн–Пт, 08:00–17:00 за часовим поясом одержувача.
//   Вихідні пропускаються.»
// - «Випадкові інтервали — 12–40 хв між листами одного сендера, без пачок на
//   початку години.»
// - «Без доганяння — пропущені листи не відправляються купою наступного дня,
//   а розподіляються в межах звичайного ліміту.»
//
// `sendDecision` is the one question the sequence (ESP 5) asks before every
// letter: may this sender write to this person now — and if not, why, and
// from when. It reads the day's sends from the ESP journal (ESP 9), so every
// campaign counts against the same sender and the same domain.
//
// There is no backlog anywhere in here: a day's limit is the day's limit,
// whatever was not sent yesterday. A queue of a hundred letters on Monday
// morning still goes out five, ten, fifteen at a time.

import { createHash } from "node:crypto";

import { isHoliday } from "./holidays.mjs";

export const RAMP_LIMITS = [5, 10, 15, 20, 25, 30, 35];
export const SENDER_DAILY_CAP = 35;
export const DOMAIN_DAILY_LIMIT = 105;
/**
 * Mail providers' own domains: twenty-six @gmail.com mailboxes are twenty-six
 * people's reputations, not one domain's — Gmail judges each one alone — so
 * the domain's daily limit is for our own domains only (13.10).
 */
export const PUBLIC_MAIL_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com", "gmx.com", "zoho.com", "ukr.net"]);
export const WINDOW = { startHour: 8, endHour: 17 };
export const GAP_MINUTES = { min: 12, max: 40 };
// The day a limit counts in: ours. The window is the recipient's.
export const COUNTING_ZONE = "Europe/Kyiv";

/**
 * Where a country's working day happens. A country with several zones lists
 * the ones its business runs in; a letter goes only while it is 08–17 in all
 * of them — so a US lead is written to when it is working hours on both
 * coasts, never at 07:00 in California.
 */
const COUNTRY_ZONES = {
  "united states": ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"],
  canada: ["America/Toronto", "America/Winnipeg", "America/Edmonton", "America/Vancouver"],
  mexico: ["America/Mexico_City", "America/Tijuana"],
  brazil: ["America/Sao_Paulo", "America/Manaus"],
  argentina: ["America/Argentina/Buenos_Aires"], chile: ["America/Santiago"], colombia: ["America/Bogota"],
  peru: ["America/Lima"], ecuador: ["America/Guayaquil"], uruguay: ["America/Montevideo"], paraguay: ["America/Asuncion"],
  bolivia: ["America/La_Paz"], venezuela: ["America/Caracas"], "costa rica": ["America/Costa_Rica"], panama: ["America/Panama"],
  guatemala: ["America/Guatemala"], "dominican republic": ["America/Santo_Domingo"], "puerto rico": ["America/Puerto_Rico"],
  "united kingdom": ["Europe/London"], ireland: ["Europe/Dublin"], portugal: ["Europe/Lisbon"], spain: ["Europe/Madrid"],
  france: ["Europe/Paris"], belgium: ["Europe/Brussels"], netherlands: ["Europe/Amsterdam"], luxembourg: ["Europe/Luxembourg"],
  germany: ["Europe/Berlin"], austria: ["Europe/Vienna"], switzerland: ["Europe/Zurich"], italy: ["Europe/Rome"], malta: ["Europe/Malta"],
  denmark: ["Europe/Copenhagen"], norway: ["Europe/Oslo"], sweden: ["Europe/Stockholm"], finland: ["Europe/Helsinki"], iceland: ["Atlantic/Reykjavik"],
  poland: ["Europe/Warsaw"], czechia: ["Europe/Prague"], slovakia: ["Europe/Bratislava"], hungary: ["Europe/Budapest"],
  slovenia: ["Europe/Ljubljana"], croatia: ["Europe/Zagreb"], serbia: ["Europe/Belgrade"], "bosnia and herzegovina": ["Europe/Sarajevo"],
  montenegro: ["Europe/Podgorica"], "north macedonia": ["Europe/Skopje"], albania: ["Europe/Tirane"], kosovo: ["Europe/Belgrade"],
  romania: ["Europe/Bucharest"], bulgaria: ["Europe/Sofia"], greece: ["Europe/Athens"], cyprus: ["Asia/Nicosia"], turkey: ["Europe/Istanbul"],
  ukraine: ["Europe/Kyiv"], moldova: ["Europe/Chisinau"], estonia: ["Europe/Tallinn"], latvia: ["Europe/Riga"], lithuania: ["Europe/Vilnius"],
  georgia: ["Asia/Tbilisi"], armenia: ["Asia/Yerevan"], azerbaijan: ["Asia/Baku"], kazakhstan: ["Asia/Almaty"], uzbekistan: ["Asia/Tashkent"],
  russia: ["Europe/Moscow"], belarus: ["Europe/Minsk"], israel: ["Asia/Jerusalem"], "united arab emirates": ["Asia/Dubai"], "saudi arabia": ["Asia/Riyadh"],
  qatar: ["Asia/Qatar"], bahrain: ["Asia/Bahrain"], kuwait: ["Asia/Kuwait"], oman: ["Asia/Muscat"], jordan: ["Asia/Amman"], lebanon: ["Asia/Beirut"],
  egypt: ["Africa/Cairo"], morocco: ["Africa/Casablanca"], tunisia: ["Africa/Tunis"], nigeria: ["Africa/Lagos"], ghana: ["Africa/Accra"],
  kenya: ["Africa/Nairobi"], "south africa": ["Africa/Johannesburg"], india: ["Asia/Kolkata"], pakistan: ["Asia/Karachi"], bangladesh: ["Asia/Dhaka"],
  "sri lanka": ["Asia/Colombo"], nepal: ["Asia/Kathmandu"], singapore: ["Asia/Singapore"], malaysia: ["Asia/Kuala_Lumpur"], thailand: ["Asia/Bangkok"],
  vietnam: ["Asia/Ho_Chi_Minh"], philippines: ["Asia/Manila"], indonesia: ["Asia/Jakarta", "Asia/Makassar"], "hong kong": ["Asia/Hong_Kong"],
  taiwan: ["Asia/Taipei"], china: ["Asia/Shanghai"], japan: ["Asia/Tokyo"], "south korea": ["Asia/Seoul"], australia: ["Australia/Sydney", "Australia/Adelaide", "Australia/Perth"],
  "new zealand": ["Pacific/Auckland"], gibraltar: ["Europe/Gibraltar"], "isle of man": ["Europe/Isle_of_Man"], curacao: ["America/Curacao"]
};

// What CRMs actually write in the country field, mapped to the names above.
const COUNTRY_ALIASES = {
  us: "united states", usa: "united states", "u.s.": "united states", "u.s.a.": "united states", "united states of america": "united states", сша: "united states",
  uk: "united kingdom", gb: "united kingdom", "great britain": "united kingdom", england: "united kingdom", scotland: "united kingdom", wales: "united kingdom", великобританія: "united kingdom",
  uae: "united arab emirates", emirates: "united arab emirates", оае: "united arab emirates", "czech republic": "czechia", чехія: "czechia",
  "korea, republic of": "south korea", korea: "south korea", "russian federation": "russia", росія: "russia", türkiye: "turkey", турція: "turkey",
  україна: "ukraine", польща: "poland", німеччина: "germany", іспанія: "spain", франція: "france", італія: "italy", бразилія: "brazil", мексика: "mexico",
  канада: "canada", ізраїль: "israel", кіпр: "cyprus", мальта: "malta", португалія: "portugal", нідерланди: "netherlands", естонія: "estonia",
  латвія: "latvia", литва: "lithuania", грузія: "georgia", казахстан: "kazakhstan", аргентина: "argentina", колумбія: "colombia", чилі: "chile", перу: "peru",
  "viet nam": "vietnam", holland: "netherlands", deutschland: "germany", españa: "spain", brasil: "brazil", méxico: "mexico", "perú": "peru"
};

export function zonesFor({ timezone = "", country = "" } = {}) {
  const zone = String(timezone || "").trim();
  if (zone && isZone(zone)) return [zone];
  const key = String(country || "").trim().toLowerCase();
  return COUNTRY_ZONES[COUNTRY_ALIASES[key] || key] || [];
}

function isZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Weekday (1 = Monday … 7 = Sunday), hour and minute of an instant in a zone, and its date. */
export function localTime(instant, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  return { weekday, hour: Number(parts.hour), minute: Number(parts.minute), date: `${parts.year}-${parts.month}-${parts.day}` };
}

/**
 * Is it a working moment — Monday to Friday, 08:00–17:00, not a public
 * holiday of the recipient's country (ESP 17) — in every one of these zones?
 */
export function inWindow(instant, zones, country = "", window = WINDOW) {
  return zones.length > 0 && zones.every((zone) => {
    const time = localTime(instant, zone);
    return time.weekday <= 5 && time.hour >= window.startHour && time.hour < window.endHour && !isHoliday(country, time.date);
  });
}

/**
 * The next working moment for these zones, minute by minute in 15-minute
 * steps (two weeks at most — Christmas, a holiday and a weekend fit): when to
 * come back, not a promise of a send.
 */
export function nextWindowOpen(instant, zones, country = "", window = WINDOW) {
  if (!zones.length) return null;
  const start = Math.ceil(instant.getTime() / (15 * 60_000)) * 15 * 60_000;
  for (let at = start; at < start + 15 * 24 * 3600_000; at += 15 * 60_000) {
    if (inWindow(new Date(at), zones, country, window)) return new Date(at);
  }
  return null;
}

/** A number in [min, max] fixed by `seed`: the same question gets the same answer on every tick. */
export function seeded(seed, min, max) {
  const value = createHash("sha256").update(String(seed)).digest().readUInt32BE(0);
  return min + (value % (max - min + 1));
}

/**
 * The cold letters a sender may send today: its ramp stage, but never below the
 * workspace's floor — `ESP_COLD_LIMIT_FLOOR` (owner 15.10: «постав у всіх 0 / 20»).
 * The ramp still climbs above the floor (25, 30, 35) on clean weeks.
 */
export function senderDailyLimit(sender, env = process.env) {
  const stage = Number(sender?.rampStage);
  const ramp = RAMP_LIMITS.includes(stage) ? stage : RAMP_LIMITS[0];
  const floor = Math.min(Math.max(0, Number(env.ESP_COLD_LIMIT_FLOOR) || 0), SENDER_DAILY_CAP);
  return Math.min(Math.max(ramp, floor), SENDER_DAILY_CAP);
}

/**
 * The day's sends per sender and per domain, from the ESP journal. A letter
 * counts from the moment it is attempted (`message.sending`, or the mailbox
 * warm-up's `warmup.sending`) unless it failed — an attempt still in flight is a letter, or two ticks at once would
 * both see room for one more.
 */
export function sendLedger(entries, { now = new Date(), zone = COUNTING_ZONE } = {}) {
  const today = localTime(now, zone).date;
  // Cold letters and warm-up letters are counted apart (owner 14.10: a mailbox
  // that only warmed today has not used its cold limit). `today` is both, for
  // the gaps between letters; `cold` is what the ramp's limit is about.
  const failed = new Set(entries.filter((entry) => entry.type === "message.failed" || entry.type === "warmup.failed").map((entry) => entry.data?.sendingSeq));
  const senders = new Map();
  const domains = new Map();
  for (const entry of entries) {
    if ((entry.type !== "message.sending" && entry.type !== "warmup.sending") || failed.has(entry.seq)) continue;
    const from = String(entry.data?.from || "").toLowerCase();
    if (!from) continue;
    const at = new Date(entry.at);
    const row = senders.get(from) || { today: 0, cold: 0, warmup: 0, lastAt: null };
    if (!row.lastAt || at > row.lastAt) row.lastAt = at;
    if (localTime(at, zone).date === today) {
      row.today += 1;
      const cold = entry.type === "message.sending";
      if (cold) row.cold += 1; else row.warmup += 1;
      // The domain's day is cold mail too.
      if (cold) {
        const domain = from.split("@")[1];
        domains.set(domain, (domains.get(domain) || 0) + 1);
      }
    }
    senders.set(from, row);
  }
  return { today, senders, domains };
}

/**
 * May `sender` write to `recipient` at `now`?
 *
 * `{ ok: true }` or `{ ok: false, reason, message, retryAt }`. `retryAt` is
 * when asking again makes sense (null when only a person can change the
 * answer). Limits are checked before the clock: a sender that is done for the
 * day is told so, not told to wait twelve minutes.
 */
export function sendDecision({ sender, recipient = {}, ledger, now = new Date(), domainLimit = DOMAIN_DAILY_LIMIT, window = WINDOW, purpose = "cold" }) {
  const email = String(sender?.email || "").toLowerCase();
  const domain = email.split("@")[1] || "";
  const mine = ledger.senders.get(email) || { today: 0, cold: 0, warmup: 0, lastAt: null };
  const warmup = purpose === "warmup";
  // Cold mail answers to the ramp's limit; the warm-up to its own plan (checked
  // by the warm-up), with the sender's cap as a ceiling.
  const limit = warmup ? SENDER_DAILY_CAP : senderDailyLimit(sender);
  const used = warmup ? (mine.warmup ?? mine.today) : (mine.cold ?? mine.today);
  const tomorrow = () => nextCountingDay(now);

  if (used >= limit) {
    return refuse("sender_daily_limit", warmup
      ? `${email} сьогодні вже надіслав ${used} листів прогріву — більше не можна.`
      : `${email} сьогодні вже надіслав ${used} з ${limit} холодних листів (етап рампи).`, tomorrow());
  }
  const domainToday = warmup ? 0 : ledger.domains.get(domain) || 0;
  if (domainToday >= domainLimit && !PUBLIC_MAIL_DOMAINS.has(domain)) {
    return refuse("domain_daily_limit", `Домен ${domain} сьогодні вже надіслав ${domainToday} з ${domainLimit}.`, tomorrow());
  }

  const zones = zonesFor(recipient);
  if (!zones.length) {
    return refuse("unknown_timezone", "Невідомо, котра в одержувача година: у ліда немає ні часового поясу, ні знайомої країни.", null);
  }
  const country = recipient.country || "";
  if (!inWindow(now, zones, country, window)) {
    const local = localTime(now, zones[0]);
    const holiday = local.weekday <= 5 && zones.some((zone) => isHoliday(country, localTime(now, zone).date));
    const reason = local.weekday > 5 ? "weekend" : holiday ? "holiday" : "outside_window";
    const message = { weekend: "У одержувача вихідний.", holiday: `У одержувача державне свято (${country}, ${local.date}).`, outside_window: `У одержувача зараз не ${String(window.startHour).padStart(2, "0")}:00–${window.endHour}:00.` }[reason];
    return refuse(reason, message, nextWindowOpen(now, zones, country, window));
  }

  // Not straight at the window's opening, and never on the hour: the first
  // letter of a sender's day waits a few minutes picked for that sender and
  // day; every letter after it waits 12–40 minutes picked for that gap.
  if (!mine.lastAt || localTime(mine.lastAt, COUNTING_ZONE).date !== ledger.today) {
    const opened = windowOpenedAt(now, zones, window);
    const offset = seeded(`${email}|${ledger.today}|first`, 3, GAP_MINUTES.max);
    const from = new Date(opened.getTime() + offset * 60_000);
    if (now < from) return refuse("too_soon", "Перший лист дня — не одразу на відкритті вікна.", from);
  } else {
    const gap = seeded(`${email}|${mine.lastAt.toISOString()}`, GAP_MINUTES.min, GAP_MINUTES.max);
    const from = new Date(mine.lastAt.getTime() + gap * 60_000);
    if (now < from) return refuse("too_soon", `Між листами одного сендера — ${gap} хв.`, from);
  }
  return { ok: true, limit, sentToday: used, domainToday };
}

function refuse(reason, message, retryAt) {
  return { ok: false, reason, message, retryAt: retryAt ? retryAt.toISOString() : null };
}

/**
 * When today's window opened for these zones: the latest of their 08:00s.
 * Called only inside the window, so each zone's local hour is 08 or later.
 */
function windowOpenedAt(now, zones, window = WINDOW) {
  return new Date(Math.max(...zones.map((zone) => {
    const local = localTime(now, zone);
    return now.getTime() - ((local.hour - window.startHour) * 60 + local.minute) * 60_000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds();
  })));
}

/** Midnight of the next day where the limits count. */
function nextCountingDay(now) {
  const today = localTime(now, COUNTING_ZONE).date;
  let at = now.getTime() + 60_000;
  while (localTime(new Date(at), COUNTING_ZONE).date === today) at += 15 * 60_000;
  // Back to the first minute of that day.
  while (localTime(new Date(at - 60_000), COUNTING_ZONE).date !== today) at -= 60_000;
  return new Date(at);
}
