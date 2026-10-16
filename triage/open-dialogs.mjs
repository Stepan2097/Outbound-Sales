// Відкриті діалоги з 01.08 отримують пінги (етап 2/6, таск 2814f681, 16.10.2026).
//
// Етап 1 веде діалоги останніх 14 днів. Давніші живі розмови — ~190 людей, які
// відповіли з 01.08 і досі не закриті в CRM, — тут: для кожного AI з переписки
// визначає наступний крок (відповісти / нагадати / дзвінок) і пріоритет, дати
// розкладаються по робочих днях із межею на день, адміністратор переглядає,
// править і приймає пачкою. Пінги стають задачами CRM, як в етапі 1.
//
// «Відкритий діалог» (заміряно 16.10): лід відповів після 01.08 — вхідний дотик
// (direction=incoming або наш рядок «LinkedIn · Відповідь на акаунт…»: до 16.10
// відповіді писались як outgoing) чи статус перейшов у responded / qualification
// / booked_call — і статус зараз один із відкритих. Контакт, у якого вже є
// відкритий пінг Outbound, не кандидат — повторний імпорт не дублює.

import { crm } from "../warmup/db.mjs";
import { PING_QUEUE, addWorkingDays, dayIn, taskDescription, zonedIso } from "./pings.mjs";

export const SINCE = "2026-08-01T00:00:00Z";
export const OPEN_STATUSES = ["in_progress", "responded", "qualification", "booked_call"];
const ADVANCED = ["responded", "qualification", "booked_call"];
export const PER_DAY = 20;
const REPLY_PREFIX = "LinkedIn · Відповідь на акаунт";
const CHUNK = 100;

const chunks = (items, size = CHUNK) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

/** Їхній дотик: позначений вхідним або наш рядок відповіді (до виправлення 16.10 — outgoing). */
export function isTheirs(activity) {
  return activity.direction === "incoming" || String(activity.content || "").startsWith(REPLY_PREFIX);
}

/**
 * Кандидати з самих рядків CRM — чиста функція: активності з 01.08, зміни статусу,
 * контакти й відкриті пінги Outbound. Повертає людей зі стрічкою дотиків, найсвіжіші першими.
 */
export function pickOpenDialogs({ activities, statusChanges, contacts, openPingContacts }) {
  const byContact = new Map();
  for (const activity of activities) {
    if (!activity.contact_id) continue;
    byContact.set(activity.contact_id, [...(byContact.get(activity.contact_id) || []), activity]);
  }
  const advanced = new Set(statusChanges.filter((row) => ADVANCED.includes(row.new_status)).map((row) => row.contact_id));
  const out = [];
  for (const contact of contacts) {
    if (!OPEN_STATUSES.includes(contact.lead_status) || openPingContacts.has(contact.id)) continue;
    const touches = (byContact.get(contact.id) || []).sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
    const theirs = touches.filter(isTheirs);
    if (!theirs.length && !advanced.has(contact.id)) continue;
    const ours = touches.filter((touch) => !isTheirs(touch));
    const last = touches.at(-1) || null;
    out.push({
      contactId: contact.id,
      name: contact.name || "",
      company: contact.company || "",
      position: contact.position || "",
      status: contact.lead_status,
      ownerId: contact.owner_id || null,
      lastTheirsAt: theirs.at(-1)?.created_at || null,
      lastOursAt: ours.at(-1)?.created_at || null,
      lastAt: last?.created_at || null,
      lastBy: last ? (isTheirs(last) ? "them" : "us") : null,
      timeline: touches.slice(-8).map((touch) => ({ at: touch.created_at, by: isTheirs(touch) ? "them" : "us", type: touch.type, text: String(touch.content || "").slice(0, 600) }))
    });
  }
  return out.sort((left, right) => String(right.lastAt || "").localeCompare(String(left.lastAt || "")));
}

/**
 * Наступний крок без моделі — і запасний, коли модель мовчить: останнє слово за
 * лідом — відповісти; дзвінок у статусі — дзвінок; інакше — нагадати.
 */
export function ruleVerdict(candidate) {
  if (candidate.status === "booked_call") return { reason: "call", priority: "high", why: "У CRM статус «дзвінок призначено» — підтвердити дзвінок." };
  if (candidate.lastBy === "them") return { reason: "reply", priority: "high", why: "Останнє повідомлення — від ліда, відповіді немає." };
  if (candidate.status === "qualification") return { reason: "silent", priority: "high", why: "Лід на кваліфікації, ми написали останніми — нагадати." };
  return { reason: "silent", priority: "normal", why: "Ми написали останніми — нагадати." };
}

const PRIORITY = { high: 0, normal: 1, low: 2 };

/**
 * Дати пінгів: найважливіші — раніше, не більше `perDay` на робочий день, починаючи
 * з сьогодні (а у вихідний — з понеділка). 190 пінгів одного дня — це жоден.
 */
export function spreadDates(items, { today, perDay = PER_DAY }) {
  const sorted = [...items].sort((left, right) =>
    (PRIORITY[left.priority] ?? 1) - (PRIORITY[right.priority] ?? 1)
    || (left.reason === "reply" ? 0 : 1) - (right.reason === "reply" ? 0 : 1)
    || String(right.lastAt || "").localeCompare(String(left.lastAt || "")));
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  let day = weekday === 0 || weekday === 6 ? addWorkingDays(today, 1) : today;
  let used = 0;
  return sorted.map((item) => {
    if (used >= perDay) {
      day = addWorkingDays(day, 1);
      used = 0;
    }
    used += 1;
    return { ...item, due: day };
  });
}

const TITLES = { reply: "Відповісти", silent: "Нагадати", call: "Дзвінок" };

/* ── I/O ─────────────────────────────────────────────────────────────────── */

async function crmCandidates() {
  const activities = await crm.from("activities").select("contact_id,created_at,direction,content,type")
    .gte("created_at", SINCE).order("created_at", { ascending: true }).limit(20000).rows();
  const statusChanges = await crm.from("contact_status_history").select("contact_id,new_status,changed_at")
    .gte("changed_at", SINCE).in("new_status", ADVANCED).limit(20000).rows();
  const ids = [...new Set([...activities.map((row) => row.contact_id), ...statusChanges.map((row) => row.contact_id)].filter(Boolean))];
  const contacts = [];
  const openPingContacts = new Set();
  for (const part of chunks(ids)) {
    contacts.push(...await crm.from("contacts").select("id,name,company,position,lead_status,owner_id").in("id", part).in("lead_status", OPEN_STATUSES).rows());
  }
  const openIds = contacts.map((contact) => contact.id);
  for (const part of chunks(openIds)) {
    const tasks = await crm.from("tasks").select("contact_id").eq("queue", PING_QUEUE).eq("completed", false).in("contact_id", part).rows();
    for (const task of tasks) openPingContacts.add(task.contact_id);
  }
  return pickOpenDialogs({ activities, statusChanges, contacts, openPingContacts });
}

// Що сказала модель про кожного (у пам'яті процесу: після рестарту — спитати знову).
const verdicts = new Map();
let job = null;

/** Кандидати з пропозиціями: дата, крок, пріоритет, чому, і хто їх визначив (модель чи правило). */
export async function openDialogs({ today = dayIn(new Date()) } = {}) {
  const candidates = await crmCandidates();
  const withVerdict = candidates.map((candidate) => {
    const verdict = verdicts.get(`${candidate.contactId}|${candidate.lastAt}`);
    return { ...candidate, ...(verdict || ruleVerdict(candidate)), by: verdict?.by || "rule" };
  });
  return {
    items: spreadDates(withVerdict, { today }),
    perDay: PER_DAY,
    job: job ? { done: job.done, total: job.total, running: job.running, failed: job.failed } : null
  };
}

/** Спитати модель про всіх, кого ще не питали. У фоні, по кілька разом; сторінка бачить хід. */
export async function suggestOpenDialogs({ classify }) {
  if (job?.running) return job;
  const candidates = await crmCandidates();
  const todo = candidates.filter((candidate) => !verdicts.has(`${candidate.contactId}|${candidate.lastAt}`));
  job = { done: 0, total: todo.length, running: true, failed: 0 };
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const candidate = queue.shift();
      try {
        const answer = await classify(candidate);
        if (answer && TITLES[answer.reason]) {
          verdicts.set(`${candidate.contactId}|${candidate.lastAt}`, {
            reason: answer.reason, priority: PRIORITY[answer.priority] !== undefined ? answer.priority : "normal",
            why: String(answer.why || "").slice(0, 300), by: "ai"
          });
        } else job.failed += 1;
      } catch (error) {
        job.failed += 1;
        console.warn(`[open-dialogs] ${candidate.contactId}: ${error.message}`);
      }
      job.done += 1;
    }
  };
  void Promise.all([worker(), worker(), worker(), worker()]).finally(() => { job.running = false; });
  return job;
}

/**
 * Прийняти пачку: на кожного — задача CRM у черзі Outbound на `assignee`. Хто вже
 * має відкритий пінг (прийнятий раніше чи поставлений етапом 1) — пропускається.
 */
export async function acceptOpenDialogs({ items, assignee, now = new Date() }) {
  if (!assignee) throw Object.assign(new Error("Оберіть, кому пінги."), { statusCode: 400 });
  const clean = (Array.isArray(items) ? items : []).filter((item) => item?.contactId && TITLES[item.reason] && /^\d{4}-\d{2}-\d{2}$/.test(item.due));
  const ids = [...new Set(clean.map((item) => String(item.contactId)))];
  const taken = new Set();
  for (const part of chunks(ids)) {
    const tasks = await crm.from("tasks").select("contact_id").eq("queue", PING_QUEUE).eq("completed", false).in("contact_id", part).rows();
    for (const task of tasks) taken.add(task.contact_id);
  }
  const names = new Map();
  for (const part of chunks(ids)) {
    for (const contact of await crm.from("contacts").select("id,name").in("id", part).rows()) names.set(contact.id, contact.name);
  }
  const nowIso = now.toISOString();
  let created = 0;
  let skipped = 0;
  const seen = new Set();
  for (const item of clean) {
    const contactId = String(item.contactId);
    if (taken.has(contactId) || seen.has(contactId)) {
      skipped += 1;
      continue;
    }
    seen.add(contactId);
    await crm.from("tasks").insert({
      title: `${TITLES[item.reason]}: ${names.get(contactId) || "контакт"}`,
      description: taskDescription(item.reason === "call" ? "call" : item.reason, `import:${item.reason}:${contactId}`, item.why ? `Імпорт відкритих діалогів з 01.08: ${String(item.why).slice(0, 300)}` : "Імпорт відкритих діалогів з 01.08"),
      owner_id: assignee, assigned_to: assignee, contact_id: contactId,
      due_date: zonedIso(item.due), completed: false, status: "todo",
      task_type: item.reason === "call" ? "Call" : "To-do", priority: item.priority === "high" ? "High" : "None",
      queue: PING_QUEUE, updated_at: nowIso
    }).rows();
    created += 1;
  }
  return { created, skipped };
}
