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
    detail: clean(entry.detail, 500)
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

/** How many people were written to on each of the last `days` days — the day strip above the list. */
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
