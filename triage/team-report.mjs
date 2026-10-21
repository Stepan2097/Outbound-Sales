// «Звіт команди» (Марко 21.10, таск 3bc6830a): хто що зробив і з яким результатом за
// день чи тиждень. Головна — «зараз» (до роботи, прострочені); тут — підсумок періоду
// й порівняння з таким самим періодом раніше. Нічого з «зараз» тут не повторюється.
//
// Звідки числа (на проді 21.10 журнал кнопок — 6 написань за тиждень, а з
// LinkedIn-акаунтів іде ~50 повідомлень на день):
//   написали   — LinkedIn: розмови з нашим повідомленням за період (події агента
//                message.out), зараховані лідгену, що веде акаунт (Налаштування →
//                акаунти); пошта: листи ESP (message.sent) — кнопкою чи розсилкою;
//   відповіли  — розмови з повідомленням людини за період; відповіді на листи;
//   кваліфіковані — мітка AI «Кваліфікована» у Вхідних, остання відповідь — у періоді;
//   дзвінки    — історія статусів CRM: «Дзвінок» поставлено в періоді (хто поставив);
//   швидкість  — від повідомлення людини (першого поспіль) до нашої відповіді в тій
//                самій розмові; «повільно» — понад 24 год, або досі без відповіді.
//                Час відповіді людини — коли його прочитав агент, тож містить його паузу.
//
// Чиста функція: збір фактів — у server.mjs (/api/work/report).

import { dayOf } from "./work-log.mjs";

export const REPORT_PERIODS = ["day", "week"];
const DAY_MS = 86400000;
const SLOW_MS = 24 * 3600000;
/** Відправки з акаунта, якого не призначено жодному лідгену. */
export const NO_LEADGEN = "linkedin";
/** Розсилки ESP, яких ніхто не надсилав кнопкою. */
export const ESP_BULK = "esp";

const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * Період звіту: день — він сам і той самий день тиждень тому (понеділок з понеділком);
 * тиждень — з понеділка по неділю і попередній тиждень.
 */
export function reportRange({ period = "day", date }) {
  if (period === "week") {
    const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 — понеділок
    const from = shift(date, -weekday);
    const to = shift(from, 6);
    return { period, from, to, prevFrom: shift(from, -7), prevTo: shift(to, -7) };
  }
  return { period: "day", from: date, to: date, prevFrom: shift(date, -7), prevTo: shift(date, -7) };
}

/** Межі, які треба прочитати: попередній період, кілька днів до нього (стан розмов) і до сьогодні. */
export function readWindow(range, now = new Date()) {
  return { since: new Date(Date.parse(`${range.prevFrom}T00:00:00Z`) - 4 * DAY_MS).toISOString(), until: now.toISOString() };
}

/** Коли повідомлення справді надіслано: точний час LinkedIn, якщо він є, інакше — коли його побачив агент. */
export function eventAt(event) {
  const meta = event.meta || {};
  return meta.sentAtIso && Number.isFinite(Date.parse(meta.sentAt)) ? meta.sentAt : event.created_at;
}

function emptyRow(key, name) {
  return { key, name, written: 0, writtenLinkedin: 0, writtenEmail: 0, replied: 0, qualified: 0, calls: 0, answers: [], slow: 0 };
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Один період. `facts`:
 *   events   — LinkedIn: [{ type: "message.in"|"message.out", account_id, created_at, meta: { threadKey, sentAt, sentAtIso } }]
 *   leadgens — { accountId: profileId };   people — Map profileId → email
 *   names    — Map email → ім'я (з журналу роботи)
 *   labels   — мітки Вхідних: { "accountId|threadKey": { label, basis: "N|lastInAt" } }
 *   calls    — [{ changed_at, changed_by }] — «Дзвінок» в історії статусів CRM
 *   journal  — журнал ESP: [{ type, at, contact, data }]
 *   entries  — журнал роботи: хто надіслав лист кнопкою (wrote · email)
 */
export function periodReport(facts, { from, to, now = new Date(), only = "" }) {
  const inside = (at) => { const day = dayOf(at); return day >= from && day <= to; };
  const rows = new Map();
  const nameOf = (key) => facts.names?.get(key) || (key === NO_LEADGEN ? "Акаунт без лідгена" : key === ESP_BULK ? "Розсилки пошти" : key || "без автора");
  const row = (key) => rows.get(key) || rows.set(key, emptyRow(key, nameOf(key))).get(key);
  const leadgenOf = (accountId) => facts.people?.get(facts.leadgens?.[accountId]) || NO_LEADGEN;

  // LinkedIn: розмова за розмовою, у порядку часу.
  const threads = new Map();
  for (const event of facts.events || []) {
    const threadKey = event.meta?.threadKey;
    if (!threadKey || !["message.in", "message.out"].includes(event.type)) continue;
    const key = `${event.account_id}|${threadKey}`;
    (threads.get(key) || threads.set(key, []).get(key)).push({ in: event.type === "message.in", at: eventAt(event), accountId: event.account_id });
  }
  for (const list of threads.values()) {
    list.sort((left, right) => String(left.at).localeCompare(String(right.at)));
    const who = leadgenOf(list[0].accountId);
    let wrote = false;
    let answered = false;
    let burst = null; // перше повідомлення людини, на яке ми ще не відповіли
    for (const message of list) {
      if (message.in) {
        if (inside(message.at)) answered = true;
        if (!burst) burst = message.at;
        continue;
      }
      if (inside(message.at)) wrote = true;
      // Менше хвилини — це не відповідь, а одне читання агента (імпорт розмов 16.10 так і записався).
      if (burst && inside(burst) && Date.parse(message.at) - Date.parse(burst) >= 60000) {
        const waited = Date.parse(message.at) - Date.parse(burst);
        row(who).answers.push(waited);
        if (waited > SLOW_MS) row(who).slow += 1;
      }
      burst = null;
    }
    if (burst && inside(burst) && now.getTime() - Date.parse(burst) > SLOW_MS) row(who).slow += 1;
    if (wrote) { row(who).written += 1; row(who).writtenLinkedin += 1; }
    if (answered) row(who).replied += 1;
  }
  // Смуга днів тижня: скільком людям писали в LinkedIn кожного дня.
  const days = [];
  for (let day = from; day <= to; day = shift(day, 1)) days.push({ date: day, written: 0 });
  for (const list of threads.values()) {
    if (only && leadgenOf(list[0].accountId) !== only) continue;
    for (const day of new Set(list.filter((message) => !message.in && inside(message.at)).map((message) => dayOf(message.at)))) {
      const slot = days.find((item) => item.date === day);
      if (slot) slot.written += 1;
    }
  }

  // Кваліфіковані: мітка Вхідних, остання відповідь людини — в періоді.
  for (const [key, value] of Object.entries(facts.labels || {})) {
    if (value?.label !== "qualified") continue;
    const lastIn = String(value.basis || "").split("|")[1];
    if (!lastIn || !inside(lastIn)) continue;
    row(leadgenOf(key.split("|")[0])).qualified += 1;
  }

  // Дзвінки: хто поставив «Дзвінок» у CRM.
  for (const call of facts.calls || []) {
    if (!inside(call.changed_at)) continue;
    row(facts.people?.get(call.changed_by) || "").calls += 1;
  }

  // Пошта: лист кнопкою — того, хто надіслав (журнал роботи), решта — розсилки ESP.
  const senders = new Map();
  for (const entry of facts.entries || []) {
    if (entry.action === "wrote" && entry.channel === "email" && entry.email) (senders.get(entry.email) || senders.set(entry.email, []).get(entry.email)).push(entry);
  }
  const senderOf = (contact, at) => (senders.get(contact) || []).filter((entry) => Math.abs(Date.parse(entry.at) - Date.parse(at)) < DAY_MS).at(-1)?.user || ESP_BULK;
  const lastSender = new Map();
  const mailed = new Map();
  const mailAnswered = new Map();
  for (const entry of [...(facts.journal || [])].sort((left, right) => String(left.at).localeCompare(String(right.at)))) {
    if (!entry.contact) continue;
    if (entry.type === "message.sent") {
      const who = senderOf(entry.contact, entry.at);
      lastSender.set(entry.contact, who);
      if (inside(entry.at)) (mailed.get(who) || mailed.set(who, new Set()).get(who)).add(entry.contact);
    } else if (entry.type === "message.replied" && inside(entry.at)) {
      const who = lastSender.get(entry.contact) || ESP_BULK;
      (mailAnswered.get(who) || mailAnswered.set(who, new Set()).get(who)).add(entry.contact);
    }
  }
  for (const [who, contacts] of mailed) { row(who).written += contacts.size; row(who).writtenEmail += contacts.size; }
  for (const [who, contacts] of mailAnswered) row(who).replied += contacts.size;

  const finish = (item) => {
    const { answers, ...rest } = item;
    return { ...rest, rate: rest.written ? Math.round((rest.replied / rest.written) * 100) : null, answeredCount: answers.length, responseMedianMinutes: answers.length ? Math.round(median(answers) / 60000) : null };
  };
  const list = [...rows.values()].map(finish)
    .filter((item) => item.written || item.replied || item.qualified || item.calls || item.slow)
    .sort((left, right) => right.written - left.written || right.replied - left.replied);
  const total = emptyRow("all", "Уся команда");
  const allAnswers = [];
  for (const item of rows.values()) {
    for (const field of ["written", "writtenLinkedin", "writtenEmail", "replied", "qualified", "calls", "slow"]) total[field] += item[field];
    allAnswers.push(...item.answers);
  }
  total.answers = allAnswers;
  return { from, to, rows: list, total: finish(total), days };
}

/**
 * Звіт: період і такий самий період раніше. `only` — логін продавця: він бачить лише свій рядок.
 */
export function teamReport(facts, { period, date, now = new Date(), only = "" }) {
  let range = reportRange({ period, date });
  // Тиждень ще йде (сьогодні середа) — порівнюємо з тими самими днями минулого: пн–ср з пн–ср,
  // а не з повним тижнем, бо інакше кожен вівторок виглядав би провалом.
  const today = dayOf(now);
  if (range.from <= today && range.to > today) {
    const done = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${range.from}T12:00:00Z`)) / DAY_MS);
    range = { ...range, prevTo: shift(range.prevFrom, done), partial: true };
  }
  const current = periodReport(facts, { from: range.from, to: range.to, now, only });
  const previous = periodReport(facts, { from: range.prevFrom, to: range.prevTo, now, only });
  const narrow = (report) => {
    if (!only) return report;
    const mine = report.rows.filter((item) => item.key === only);
    const { answers, ...empty } = emptyRow(only, only);
    return { ...report, rows: mine, total: mine[0] || { ...empty, rate: null, answeredCount: 0, responseMedianMinutes: null } };
  };
  const shown = narrow(current);
  const before = narrow(previous);
  const prevByKey = new Map(before.rows.map((item) => [item.key, item]));
  return {
    ...range,
    total: shown.total,
    previous: before.total,
    rows: shown.rows.map((item) => ({ ...item, previous: prevByKey.get(item.key) || null })),
    days: shown.days
  };
}
