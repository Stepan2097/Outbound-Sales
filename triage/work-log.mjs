// Робота по днях (власник 12.10): «сторінку де я бачитиму по днях… список
// контактів яким я написав… підсвічуватися якщо зявляються нові
// повідомлення… хто писав привязується до того з якого він акаунту зайшов на
// платформу, ми збираємо максимум статистики щоб аналізувати роботу
// працівників».
//
// One line per thing a person did, in a JSON-lines file beside the workspace
// state (`work-log.jsonl`): who (the platform login, never the LinkedIn account
// or the mailbox — those are written next to it), what, to whom, through what,
// when. Only appended. The day page and its numbers are read from it; the
// answers (a LinkedIn message in, a letter back) are looked up where they live
// — the Anty events and the ESP journal — so nothing here can go stale.
//
// Actions:
//   viewed   — the card was opened on Головна (once a day per person and contact);
//   skipped  — «Пропустити»;          invalid  — «Не валідний»;
//   enriched — «Збагатити» (with what went into the base);
//   drafted  — texts generated;       invited  — a LinkedIn request queued;
//   wrote    — a first message / a letter sent (channel linkedin | email);
//   replied  — our answer in a conversation already going (Вхідні, Unibox).

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { addWorkingDays, currentPingSteps } from "./pings.mjs";

export const WORK_ACTIONS = ["viewed", "skipped", "invalid", "enriched", "drafted", "invited", "wrote", "replied"];
/** The actions that mean somebody was written to — what the day's list is made of. */
export const OUTREACH_ACTIONS = new Set(["invited", "wrote", "replied"]);
export const WORK_TIME_ZONE = "Europe/Kyiv";

let logPath = null;
let rows = null;
let tail = Promise.resolve();

/** Point the log at a file: the server once at start, tests between cases. */
export function useWorkLog(path) {
  logPath = path;
  rows = null;
  tail = Promise.resolve();
}

async function load() {
  if (rows) return rows;
  let text = "";
  try { text = await readFile(logPath, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a line torn by a crash is skipped, not repaired */ }
  }
  return rows;
}

const lower = (value) => String(value ?? "").trim().toLowerCase();
const clean = (value, max = 300) => (value == null || value === "" ? null : String(value).slice(0, max));

/**
 * Write one thing a person did. `profile` is the signed-in user
 * (request.auth.profile). Never throws — a log that cannot be written costs the
 * work nothing — and resolves when the line is on disk.
 */
export function logWork(profile, entry, { now = new Date() } = {}) {
  if (!logPath || !WORK_ACTIONS.includes(entry?.action)) return Promise.resolve(null);
  const row = {
    at: now.toISOString(),
    user: lower(profile?.email) || "невідомий",
    userName: clean(profile?.name, 120),
    action: entry.action,
    channel: entry.channel === "email" || entry.channel === "linkedin" ? entry.channel : null,
    contactId: clean(entry.contactId, 80),
    email: lower(entry.email) || null,
    name: clean(entry.name, 160),
    accountId: clean(entry.accountId, 80),
    accountName: clean(entry.accountName, 120),
    mailbox: lower(entry.mailbox) || null,
    detail: clean(entry.detail, 500),
    // Звідки дія (19.10): "triage" — конвеєр нових контактів; за цим рахується денна
    // норма нових контактів лідгена (triage/today.mjs → newContactsGate).
    source: entry.source === "triage" ? "triage" : null
  };
  tail = tail.then(async () => {
    await load();
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(row)}\n`);
    rows.push(row);
    return row;
  }).catch((error) => { console.warn(`[work-log] ${error.message}`); return null; });
  return tail;
}

export async function workEntries() {
  await tail;
  return load();
}

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: WORK_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
/** The Kyiv calendar day of a moment, as YYYY-MM-DD. */
export const dayOf = (at) => dayFormat.format(new Date(at));

/** The key one person is grouped by: the base's id, or the address when only a letter knows them. */
export const contactKeyOf = (row) => (row.contactId ? `id:${row.contactId}` : row.email ? `email:${row.email}` : null);

function emptyCounts() {
  return { viewed: 0, skipped: 0, invalid: 0, enriched: 0, drafted: 0, invited: 0, wroteLinkedin: 0, wroteEmail: 0, replied: 0, contacts: 0 };
}

/**
 * One day of work: who did how much, and the people written to — each with
 * what was done to them that day, by whom and through what. `user` is a login
 * email or "all". The answers are the caller's (they live elsewhere).
 */
export function dayActivity(entries, { date, user = "all" }) {
  const mine = (row) => user === "all" || row.user === user;
  const today = entries.filter((row) => dayOf(row.at) === date && mine(row));
  const byUser = new Map();
  const counted = (row) => {
    if (!byUser.has(row.user)) byUser.set(row.user, { user: row.user, name: row.userName, counts: emptyCounts(), viewedKeys: new Set(), contactKeys: new Set() });
    const person = byUser.get(row.user);
    if (row.userName) person.name = row.userName;
    return person;
  };
  const contacts = new Map();
  for (const row of today) {
    const person = counted(row);
    const key = contactKeyOf(row);
    if (row.action === "viewed") { if (key && !person.viewedKeys.has(key)) { person.viewedKeys.add(key); person.counts.viewed += 1; } continue; }
    if (row.action === "wrote") person.counts[row.channel === "email" ? "wroteEmail" : "wroteLinkedin"] += 1;
    else if (row.action in person.counts) person.counts[row.action] += 1;
    if (!OUTREACH_ACTIONS.has(row.action) || !key) continue;
    person.contactKeys.add(key);
    if (!contacts.has(key)) contacts.set(key, { key, contactId: row.contactId, emails: [], name: row.name, actions: [], firstAt: row.at, lastAt: row.at, users: [] });
    const contact = contacts.get(key);
    if (row.email && !contact.emails.includes(row.email)) contact.emails.push(row.email);
    if (!contact.name && row.name) contact.name = row.name;
    if (!contact.users.includes(row.user)) contact.users.push(row.user);
    contact.lastAt = row.at > contact.lastAt ? row.at : contact.lastAt;
    contact.firstAt = row.at < contact.firstAt ? row.at : contact.firstAt;
    contact.actions.push({ at: row.at, action: row.action, channel: row.channel, user: row.user, userName: row.userName, accountId: row.accountId, accountName: row.accountName, mailbox: row.mailbox });
  }
  const users = [...byUser.values()].map((person) => ({ user: person.user, name: person.name, counts: { ...person.counts, contacts: person.contactKeys.size } }))
    .sort((left, right) => right.counts.contacts - left.counts.contacts || right.counts.viewed - left.counts.viewed);
  const total = emptyCounts();
  for (const person of users) for (const key of Object.keys(total)) total[key] += person.counts[key];
  return { date, users, total, contacts: [...contacts.values()].sort((left, right) => right.lastAt.localeCompare(left.lastAt)) };
}

/**
 * The day strip above the list: the chosen day in the middle (власник 14.10:
 * «день має бути по центру»), `around` days either side. Days after `today`
 * come back marked `future` — nothing was done on them yet.
 */
export function daysAround(entries, { user = "all", date, today, around = 7 }) {
  const shift = (days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  return recentDays(entries, { user, until: shift(around), days: around * 2 + 1 })
    .map((day) => ({ ...day, future: day.date > today }));
}

/** How many people were written to on each of the last `days` days. */
export function recentDays(entries, { user = "all", until, days = 14 }) {
  const counts = new Map();
  for (const row of entries) {
    if (!OUTREACH_ACTIONS.has(row.action) || (user !== "all" && row.user !== user)) continue;
    const day = dayOf(row.at);
    if (!counts.has(day)) counts.set(day, new Set());
    counts.get(day).add(contactKeyOf(row));
  }
  const list = [];
  const end = new Date(`${until}T12:00:00Z`);
  for (let back = 0; back < days; back += 1) {
    const day = new Date(end.getTime() - back * 86400000).toISOString().slice(0, 10);
    list.push({ date: day, contacts: counts.get(day)?.size || 0 });
  }
  return list;
}

/** Every login that ever did anything — whom the administrator can pick. */
export function workUsers(entries) {
  const users = new Map();
  for (const row of entries) users.set(row.user, row.userName || users.get(row.user) || "");
  return [...users.entries()].map(([user, name]) => ({ user, name })).sort((left, right) => left.user.localeCompare(right.user));
}

/** One person's whole record here, oldest first — the dialog page's «хто що робив». */
export function contactWork(entries, { contactId, emails = [] }) {
  const addresses = new Set(emails.map(lower).filter(Boolean));
  return entries.filter((row) => (contactId && row.contactId === contactId) || (row.email && addresses.has(row.email)))
    .sort((left, right) => left.at.localeCompare(right.at));
}

/**
 * Заплановані (власник 14.10): «коли я написав людині і вона не відповіла — через
 * день їй знову написати; що не встигли — перенести на наступний день».
 *
 * From the LinkedIn conversations the agent reads (`deriveThreads`): a thread
 * whose last message is ours, sent before `today`, is due the day after it was
 * sent; one not written to by then stays on the list, older first, with how
 * many days it has waited. After `limit` messages of ours in a row with no
 * answer the person leaves the list, and so does a thread silent for longer
 * than `maxDays` — a plan that grows forever is a plan nobody reads.
 */
// П'ять наших повідомлень поспіль без відповіді — і людина зникає з «Запланованих» (власник 20.10; було 3).
// Скільки саме — кроки нагадувань із «Сьогодні» плюс перше повідомлення (`currentPingSteps`).
export const FOLLOW_UP_LIMIT = 5;
export const FOLLOW_UP_MAX_DAYS = 14;
// LinkedIn's link label sometimes comes through as the name: «Переглянути профіль Luke».
const PROFILE_LABEL = /^(переглянути профіль|view profile( of)?|view|открыть профиль|посмотреть профиль)\s+/i;

/**
 * Коли писати знову — за кроками нагадувань (власник 20.10: перший через 2
 * робочі дні, другий через 3, третій через 5, четвертий через 7; редагуються на
 * «Сьогодні»), а не «наступного дня».
 */
export function followUpsDue(threads, { today, accounts = new Map(), skipAccounts = new Set(), steps = currentPingSteps(), limit = steps.length + 1, maxDays = FOLLOW_UP_MAX_DAYS } = {}) {
  const dayNumber = (date) => Math.round(Date.parse(`${date}T12:00:00Z`) / 86400000);
  const now = dayNumber(today);
  const due = [];
  for (const thread of threads) {
    const last = thread.lastMessage;
    if (!last || last.direction !== "out" || !last.at || !Number.isFinite(Date.parse(last.at))) continue;
    if (!thread.trailingOut || thread.trailingOut >= limit) continue;
    // A blocked account cannot write anyone; its people are not today's work.
    if (skipAccounts.has(thread.accountId)) continue;
    const sentDay = dayOf(last.at);
    const dueDay = addWorkingDays(sentDay, steps[Math.min(thread.trailingOut, steps.length) - 1] ?? 1);
    const waited = now - dayNumber(dueDay) + 1;
    if (waited < 1 || waited > maxDays) continue;
    due.push({
      key: thread.crmContactId ? `id:${thread.crmContactId}` : `thread:${thread.accountId}:${thread.threadKey}`,
      contactId: thread.crmContactId || null,
      accountId: thread.accountId,
      accountName: accounts.get(thread.accountId) || null,
      threadKey: thread.threadKey,
      name: String(thread.participant?.name || "").replace(PROFILE_LABEL, "").trim() || "без імені",
      headline: thread.participant?.headline || null,
      lastAt: last.at,
      lastText: String(last.body || "").slice(0, 240),
      sentInRow: thread.trailingOut,
      dueDay,
      // Due on its step's day; every day past that it was carried over.
      carriedDays: waited - 1
    });
  }
  // One row a person: the same contact in two threads (a re-sent first message,
  // a second account) is one follow-up — the newest thread's.
  const newest = new Map();
  for (const item of due) {
    const person = item.contactId ? `id:${item.contactId}` : `${item.accountId}:${item.name.toLowerCase()}`;
    if (!newest.has(person) || item.lastAt > newest.get(person).lastAt) newest.set(person, item);
  }
  return [...newest.values()].sort((left, right) => right.carriedDays - left.carriedDays || left.lastAt.localeCompare(right.lastAt));
}

/**
 * What was really written in LinkedIn (власник 15.10: «логіка сторінки по днях
 * слабо пропрацьована»): the log above holds only what was done through this
 * platform's buttons, so a message typed in LinkedIn itself — or one the agent
 * sent days after it was queued — never reached the day. These are the
 * messages the agent read back from the accounts' inboxes (`message.out`),
 * counted on the day they were sent.
 *
 * A message is credited to whoever queued it here (a `wrote`/`replied` line for
 * that person in the three days before), otherwise to «з LinkedIn-акаунта» —
 * typed in LinkedIn by hand or sent by the agent on its own, which the inbox
 * cannot tell apart.
 * Only the team view («Уся команда») shows them: nobody's own day is filled
 * with work they did not do through their login.
 */
export const LINKEDIN_DIRECT = "linkedin";

export function linkedinSends(events, { accounts = new Map(), entries = [] } = {}) {
  const queuedBy = new Map();
  for (const row of entries) {
    if (row.channel !== "linkedin" || !["wrote", "replied"].includes(row.action) || !row.contactId) continue;
    (queuedBy.get(row.contactId) || queuedBy.set(row.contactId, []).get(row.contactId)).push(row);
  }
  const sends = [];
  for (const event of events) {
    const meta = event.meta || {};
    if (!meta.threadKey) continue;
    const at = meta.sentAtIso && Number.isFinite(Date.parse(meta.sentAt)) ? meta.sentAt : event.created_at;
    const contactId = meta.crmContactId ? String(meta.crmContactId) : null;
    const queued = contactId
      ? (queuedBy.get(contactId) || []).filter((row) => row.at <= at && Date.parse(at) - Date.parse(row.at) < 3 * 86400000).at(-1)
      : null;
    sends.push({
      at,
      key: contactId ? `id:${contactId}` : `thread:${event.account_id}:${meta.threadKey}`,
      contactId,
      name: String(meta.participant?.name || "").replace(/^(переглянути профіль|view profile( of)?)\s+/i, "").trim() || null,
      accountId: event.account_id,
      accountName: accounts.get(event.account_id) || null,
      user: queued?.user || LINKEDIN_DIRECT,
      userName: queued?.userName || "з LinkedIn-акаунта"
    });
  }
  return sends;
}

/** The day's people, with the LinkedIn sends nobody logged merged in — the team view. */
export function withLinkedinSends(activity, sends, { date }) {
  const contacts = new Map(activity.contacts.map((item) => [item.key, item]));
  let added = 0;
  for (const send of sends) {
    if (dayOf(send.at) !== date) continue;
    const action = { at: send.at, action: "wrote", channel: "linkedin", user: send.user, userName: send.userName, accountId: send.accountId, accountName: send.accountName, mailbox: null, fromInbox: true };
    const known = contacts.get(send.key);
    if (known) {
      // Already on the day through a button: only a send at another moment is added.
      if (!known.actions.some((row) => row.channel === "linkedin" && Math.abs(Date.parse(row.at) - Date.parse(send.at)) < 6 * 3600000)) known.actions.push(action);
      continue;
    }
    contacts.set(send.key, { key: send.key, contactId: send.contactId, emails: [], name: send.name, actions: [action], firstAt: send.at, lastAt: send.at, users: [send.user] });
    added += 1;
  }
  const list = [...contacts.values()].sort((left, right) => right.lastAt.localeCompare(left.lastAt));
  return { ...activity, contacts: list, total: { ...activity.total, contacts: list.length, wroteLinkedin: activity.total.wroteLinkedin + added } };
}

/** The day strip in the team view: people written to per day, from the log and from LinkedIn. */
export function addSendsToDays(days, sends, entries) {
  const byDay = new Map();
  for (const row of entries) {
    if (!OUTREACH_ACTIONS.has(row.action)) continue;
    const day = dayOf(row.at);
    (byDay.get(day) || byDay.set(day, new Set()).get(day)).add(contactKeyOf(row));
  }
  for (const send of sends) {
    const day = dayOf(send.at);
    (byDay.get(day) || byDay.set(day, new Set()).get(day)).add(send.key);
  }
  return days.map((day) => ({ ...day, contacts: day.future ? 0 : byDay.get(day.date)?.size || 0 }));
}
