// «Сьогодні» і пінги в CRM (етап 1/6, таск 5f5343cb). Правила — triage/pings.mjs;
// тут — звідки береться стан діалогів (прогрів: треди, черга відправок, прийняті
// запити), як задачі CRM приводяться до нього (`reconcilePings`) і що бачить
// лідген на Головній (`todayList`, `todayItem`).
//
// Звірка йде сама кожні дві хвилини, одразу після відповіді ліда і після
// відправки з «Сьогодні». Звірка лише з'ясовує й вирівнює — нічого не надсилає.

import { anty, crm } from "../warmup/db.mjs";
import { listThreads, readThread } from "../warmup/inbox.mjs";
import { repliesOf, sameText } from "../warmup/outbox.mjs";
import { acceptedRows, firstMarks } from "../warmup/first-messages.mjs";
import { INVITE_ACCEPTED } from "../warmup/invites.mjs";
import { accountName } from "../warmup/activities.mjs";
import { acceptOpenDialogs, openDialogs, suggestOpenDialogs } from "./open-dialogs.mjs";
import {
  PING_QUEUE, REASONS, blockOf, clearSuperseded, compareItems, dayIn, desiredPing, manualDueDay, markSuperseded,
  newContactsAllowed, parseTaskMarks, planPingChanges, reasonOfKey, taskDescription, taskReason, zonedIso
} from "./pings.mjs";

const TASK_COLUMNS = "id,title,description,contact_id,owner_id,assigned_to,due_date,completed,status,task_type,queue,created_at,updated_at";
const CONTACT_COLUMNS = "id,name,position,company,owner_id,linkedin,country,lead_status";
/** Статус CRM «Не відповідає» — після останнього кроку кампанії й тиші (етап 3/6). */
export const NO_REPLY_STATUS = "no_response";
const STILL_TRYING = ["new", "in_progress"];
const CHUNK = 100;
/** Свіжий стан для списку: старіший за це — спершу звірка. */
const FRESH_MS = 60_000;
export const CRM_CONTACT_URL = (process.env.CRM_APP_URL || "https://advantage-crm.netlify.app").replace(/\/+$/, "");

// Хто веде який акаунт: { accountId: id користувача CRM }. Живе в стані робочого
// простору (server.mjs кладе сюди читання й запис); пінг діалогу акаунта — цьому
// лідгенові, без позначки — власникові контакту (рішення Марко 16.10).
let leadgenStore = { read: () => ({}), write: async () => {} };
export function setLeadgenStore(store) {
  if (store?.read && store?.write) leadgenStore = store;
}
const leadgenOf = (accountId) => (accountId && leadgenStore.read()[accountId]) || null;

// Кампанії «Прогріву» (етап 3/6): їхні кроки «мовчить» ведуть людей, яких кампанія
// дала з папки. server.mjs кладе сюди читання state.warmupCampaigns.
let campaignsReader = () => [];
export function setCampaignsReader(read) {
  if (typeof read === "function") campaignsReader = read;
}

let lastGather = null;
let lastRunAt = 0;
let running = null;
let lastStats = null;
const drafts = new Map();

const chunks = (items, size = CHUNK) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const ms = (iso) => {
  const value = Date.parse(iso || "");
  return Number.isFinite(value) ? value : 0;
};

export function pingsConfigured() {
  return crm.configured() && anty.configured();
}

/* ── стан діалогів з прогріву ───────────────────────────────────────────── */

async function acceptedTimes(outreachIds) {
  const found = new Map();
  for (const ids of chunks(outreachIds, 150)) {
    const rows = await anty.from("wl_events").select("meta,created_at").eq("type", INVITE_ACCEPTED)
      .in("meta->>outreachId", ids).order("created_at", { ascending: false }).limit(2000).rows();
    for (const row of rows) {
      const id = String(row.meta?.outreachId || "");
      if (id && !found.has(id)) found.set(id, row.created_at);
    }
  }
  return found;
}

/** Що відомо про кожен контакт: його треди, наші повідомлення в черзі, прийнятий запит. */
export async function gatherDialogs() {
  const [threads, accepted] = await Promise.all([listThreads(), acceptedRows()]);
  const accountIds = [...new Set([...threads.map((thread) => thread.accountId), ...accepted.map((row) => row.account_id)].filter(Boolean))];
  const outreachIds = accepted.map((row) => String(row.id));
  const [replyLists, acceptedAt, marks, accountRows] = await Promise.all([
    Promise.all(accountIds.map(async (id) => repliesOf(id).catch(() => []))),
    acceptedTimes(outreachIds),
    firstMarks(outreachIds),
    accountIds.length ? anty.from("wl_accounts").select("*").in("id", accountIds).rows().catch(() => []) : []
  ]);
  const accounts = new Map(accountRows.map((row) => [row.id, accountName(row)]));

  const states = new Map();
  const stateOf = (contactId) => {
    if (!states.has(contactId)) states.set(contactId, { threads: [], pending: [], accepted: null });
    return states.get(contactId);
  };
  const threadContact = new Map();
  for (const thread of threads) {
    if (!thread.crmContactId) continue;
    stateOf(thread.crmContactId).threads.push(thread);
    threadContact.set(`${thread.accountId}|${thread.threadKey}`, thread.crmContactId);
  }
  const outreachContact = new Map();
  for (const row of accepted) {
    if (!row.crm_contact_id) continue;
    const contactId = String(row.crm_contact_id);
    outreachContact.set(String(row.id), contactId);
    stateOf(contactId).accepted = {
      outreachId: String(row.id), accountId: row.account_id,
      acceptedAt: acceptedAt.get(String(row.id)) || null, dismissed: marks.dismissed.has(String(row.id)),
      name: row.person_name || "", company: row.person_company || "", position: row.person_position || ""
    };
  }
  for (const replies of replyLists) {
    for (const reply of replies) {
      if (!["waiting", "sent"].includes(reply.state)) continue;
      const contactId = reply.kind === "first" ? outreachContact.get(String(reply.outreachId)) : threadContact.get(`${reply.accountId}|${reply.threadKey}`);
      if (!contactId) continue;
      const state = stateOf(contactId);
      // Надіслане, що вже видно в треді, — це повідомлення треду, а не черга.
      if (reply.state === "sent" && state.threads.some((thread) => (thread.trailingOutBodies || []).some((body) => sameText(body, reply.body)))) continue;
      state.pending.push({ id: reply.id, accountId: reply.accountId, threadKey: reply.threadKey, queuedAt: reply.queuedAt, state: reply.state, body: reply.body });
    }
  }
  // Перепризначені після бану (етап 4/6): тред старого акаунта — лише історія.
  for (let offset = 0; ; offset += 1000) {
    const rows = await anty.from("wl_events").select("id,meta,created_at").eq("type", "invite.reassigned")
      .eq("meta->>reason", "account_blocked").order("id").limit(1000).offset(offset).rows();
    for (const row of rows) {
      const contactId = row.meta?.crmContactId ? String(row.meta.crmContactId) : null;
      if (!contactId || !states.has(contactId)) continue;
      const state = states.get(contactId);
      if (state.reassigned && state.reassigned.at > row.created_at) continue;
      state.reassigned = { from: row.meta.fromAccount || "", to: row.meta.toAccount || "", fromAccountId: row.meta.fromAccountId, toAccountId: row.meta.accountId, at: row.created_at };
    }
    if (rows.length < 1000) break;
  }
  for (const state of states.values()) {
    if (!state.reassigned) continue;
    state.threads = state.threads.map((thread) => (thread.accountId === state.reassigned.fromAccountId ? { ...thread, moved: true } : thread));
  }

  // Хто з людей прийшов з папки якої кампанії — з `invite.requested`, де це записано.
  const campaigns = new Map((campaignsReader() || []).map((campaign) => [campaign.id, campaign]));
  if (campaigns.size) {
    for (let offset = 0; ; offset += 1000) {
      const rows = await anty.from("wl_events").select("id,meta").eq("type", "invite.requested")
        .in("meta->>campaignId", [...campaigns.keys()]).order("id").limit(1000).offset(offset).rows();
      for (const row of rows) {
        const contactId = row.meta?.crmContactId ? String(row.meta.crmContactId) : null;
        const campaign = campaigns.get(String(row.meta?.campaignId || ""));
        if (!contactId || !campaign || !states.has(contactId)) continue;
        const state = states.get(contactId);
        state.campaignId = campaign.id;
        state.steps = campaign.silentSteps;
      }
      if (rows.length < 1000) break;
    }
  }
  return { states, accounts, at: new Date() };
}

/* ── задачі CRM ──────────────────────────────────────────────────────────── */

async function tasksOf(contactIds) {
  const found = new Map();
  for (const ids of chunks(contactIds)) {
    const rows = await crm.from("tasks").select(TASK_COLUMNS).eq("queue", PING_QUEUE).in("contact_id", ids).limit(5000).rows();
    for (const row of rows) found.set(row.contact_id, [...(found.get(row.contact_id) || []), row]);
  }
  return found;
}

async function contactsOf(contactIds) {
  const found = new Map();
  for (const ids of chunks(contactIds)) {
    const rows = await crm.from("contacts").select(CONTACT_COLUMNS).in("id", ids).rows();
    for (const row of rows) found.set(String(row.id), row);
  }
  return found;
}

/**
 * Кому дістається пінг контакту без власника в CRM: тому, хто веде більшість
 * діалогів (власник більшості контактів у цій звірці), а як нікого — першому
 * адміністраторові CRM. Таких контактів одиниці (12 з ~1050 на 16.10).
 */
async function fallbackOwner(contacts) {
  const counts = new Map();
  for (const contact of contacts.values()) if (contact.owner_id) counts.set(contact.owner_id, (counts.get(contact.owner_id) || 0) + 1);
  const top = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (top) return top[0];
  const admin = await crm.from("profiles").select("id").eq("role", "admin").order("email").limit(1).rows().catch(() => []);
  return admin[0]?.id || null;
}

function taskTitle(reason, contact) {
  return `${REASONS[reason]?.title || REASONS.manual.title}: ${contact?.name || "контакт"}`;
}

async function applyAction(action, { contactId, contact, owner, nowIso }) {
  if (action.op === "create") {
    const desired = action.desired;
    const assignee = leadgenOf(desired.accountId) || contact?.owner_id || owner;
    if (!assignee) throw new Error("немає кому призначити пінг");
    await crm.from("tasks").insert({
      title: taskTitle(desired.reason, contact),
      description: taskDescription(desired.reason, desired.key),
      owner_id: assignee,
      assigned_to: assignee,
      contact_id: contactId,
      due_date: zonedIso(desired.due),
      completed: false,
      status: "todo",
      task_type: "To-do",
      priority: "None",
      queue: PING_QUEUE,
      updated_at: nowIso
    }).rows();
    return "created";
  }
  if (action.op === "supersede") {
    await crm.from("tasks").update({
      completed: true, status: "done", description: markSuperseded(action.task.description), updated_at: nowIso
    }).eq("id", action.task.id).rows();
    return "superseded";
  }
  if (action.op === "reassign") {
    await crm.from("tasks").update({ assigned_to: action.to, updated_at: nowIso }).eq("id", action.task.id).rows();
    return "reassigned";
  }
  if (action.op === "reopen") {
    await crm.from("tasks").update({
      completed: false, status: "todo", description: clearSuperseded(action.task.description), updated_at: nowIso
    }).eq("id", action.task.id).rows();
    return "reopened";
  }
  return null;
}

/**
 * Привести задачі CRM до наступних кроків діалогів. Одна звірка за раз: друга,
 * що прийшла посеред першої, отримує її результат.
 */
export async function reconcilePings({ now = new Date() } = {}) {
  if (!pingsConfigured()) return { skipped: "CRM або прогрів не налаштовані" };
  if (running) return running;
  running = (async () => {
    const gathered = await gatherDialogs();
    lastGather = gathered;
    const desired = new Map();
    for (const [contactId, state] of gathered.states) {
      const next = desiredPing(contactId, state, { now });
      if (next) desired.set(contactId, next);
    }
    const ids = [...desired.keys()];
    const [tasks, contacts] = await Promise.all([tasksOf(ids), contactsOf(ids)]);
    const owner = await fallbackOwner(contacts);
    const stats = { contacts: ids.length, created: 0, superseded: 0, reopened: 0, reassigned: 0, noReply: 0, failed: 0 };
    const todayDay = dayIn(now);
    const nowIso = now.toISOString();
    for (const contactId of ids) {
      const next = desired.get(contactId);
      const actions = planPingChanges(next, tasks.get(contactId) || []);
      // Відкритий пінг акаунта, який хтось веде, — у того, хто веде: позначку
      // поставили чи змінили — пінги переходять за нею при наступній звірці.
      const leadgen = leadgenOf(next.accountId);
      if (leadgen) {
        const closing = new Set(actions.filter((action) => action.op === "supersede").map((action) => action.task.id));
        for (const task of tasks.get(contactId) || []) {
          if (!task.completed && !closing.has(task.id) && task.assigned_to !== leadgen) actions.push({ op: "reassign", task, to: leadgen });
        }
      }
      // Кампанія: кроки скінчились і тиша дотягла до дня — статус «Не відповідає».
      const state = gathered.states.get(contactId);
      const contact = contacts.get(contactId);
      if (!next.key && next.noReplyDue && state?.campaignId && next.noReplyDue <= todayDay && STILL_TRYING.includes(contact?.lead_status || "new")) {
        try {
          await crm.from("contacts").update({ lead_status: NO_REPLY_STATUS }).eq("id", contactId).rows();
          stats.noReply += 1;
        } catch (error) {
          stats.failed += 1;
          console.error(`[pings] no_response for ${contactId}: ${error.message}`);
        }
      }
      for (const action of actions) {
        try {
          const done = await applyAction(action, { contactId, contact: contacts.get(contactId), owner, nowIso });
          if (done) stats[done] += 1;
        } catch (error) {
          stats.failed += 1;
          console.error(`[pings] ${action.op} for contact ${contactId}: ${error.message}`);
        }
      }
    }
    lastRunAt = Date.now();
    lastStats = { ...stats, at: nowIso };
    if (stats.created || stats.superseded || stats.reopened || stats.reassigned || stats.noReply || stats.failed) console.log(`[pings] ${JSON.stringify(lastStats)}`);
    return lastStats;
  })().finally(() => { running = null; });
  return running;
}

export function lastReconcile() {
  return lastStats;
}

let soonTimer = null;
/** Звірка за кілька секунд — після відповіді ліда (кілька тредів за синхронізацію дають одну звірку). */
export function reconcileSoon(delayMs = 3000) {
  if (!pingsConfigured()) return;
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => void reconcilePings().catch((error) => console.error(`[pings] ${error.message}`)), delayMs);
  soonTimer.unref?.();
}

let interval = null;
export function startPingReconciler(everyMs = 120_000) {
  if (interval || !pingsConfigured() || process.env.PINGS === "off") return;
  interval = setInterval(() => void reconcilePings().catch((error) => console.error(`[pings] ${error.message}`)), everyMs);
  interval.unref?.();
  reconcileSoon(10_000);
}

async function freshGather({ force = false } = {}) {
  if (force || !lastGather || Date.now() - lastRunAt > FRESH_MS) {
    try { await reconcilePings(); } catch (error) { console.error(`[pings] ${error.message}`); }
  }
  return lastGather;
}

/* ── «Сьогодні» ─────────────────────────────────────────────────────────── */

const newestThread = (state) => [...(state?.threads || [])].filter((thread) => thread.lastMessage)
  .sort((left, right) => ms(right.lastStoredAt) - ms(left.lastStoredAt))[0] || null;

async function emailsOf(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await crm.from("profiles").select("id,email").in("id", ids).rows().catch(() => []);
  return new Map(rows.map((row) => [row.id, row.email]));
}

function itemOf(task, { contact, state, today, now, emails, accounts = new Map() }) {
  const contactId = task.contact_id ? String(task.contact_id) : null;
  const next = state ? desiredPing(contactId, state, { now }) : null;
  const thread = newestThread(state);
  const moved = Boolean(state?.reassigned) && !next && (state?.threads || []).every((item) => item.moved);
  // Перепризначений і ще не прийняв запит з нового акаунта: відповісти звідси нема
  // куди, тож пінг стоїть за датою, а не у «Відповідях».
  const reason = moved ? "manual" : taskReason(task);
  const dueDay = dayIn(task.due_date);
  const awaitingUs = next?.reason === "reply";
  return {
    pingId: task.id,
    contactId,
    name: contact?.name || state?.accepted?.name || task.title,
    position: contact?.position || state?.accepted?.position || "",
    company: contact?.company || state?.accepted?.company || "",
    reason,
    // Ручний пінг лишає назву кроку, з якого почався («Перше повідомлення: …»).
    reasonTitle: reason === "manual" && String(task.title || "").includes(":") ? task.title.split(":")[0] : REASONS[reason]?.title || REASONS.manual.title,
    title: task.title,
    dueDay,
    block: blockOf({ reason, dueDay, awaitingUs }, today),
    basisAt: next?.basisAt || null,
    accountId: next?.accountId || thread?.accountId || state?.accepted?.accountId || null,
    accountName: accounts.get(next?.accountId || thread?.accountId || state?.accepted?.accountId) || null,
    threadKey: thread?.threadKey || null,
    outreachId: state?.accepted?.outreachId || null,
    // Перше повідомлення: треду ще немає, пише сторінка прийнятого запиту.
    channel: moved ? "moved" : thread ? "thread" : state?.accepted ? "first" : "none",
    reassigned: state?.reassigned ? { from: state.reassigned.from, to: state.reassigned.to, at: state.reassigned.at } : null,
    preview: thread?.lastMessage ? { direction: thread.lastMessage.direction, body: String(thread.lastMessage.body || "").slice(0, 200), at: thread.lastMessage.at } : null,
    queued: (state?.pending || []).filter((item) => item.state === "waiting").length,
    assignee: emails.get(task.assigned_to) || null,
    crmUrl: contactId ? `${CRM_CONTACT_URL}/contacts/${contactId}` : null
  };
}

/** Відкриті пінги лідгена (адмін — усіх), розкладені по блоках «Сьогодні». */
export async function todayList({ viewerId, scope = "mine", now = new Date() }) {
  if (!pingsConfigured()) return { configured: false, blocks: { replies: [], overdue: [], today: [], first: [] }, later: [], newContactsAllowed: true };
  const gathered = await freshGather();
  let query = crm.from("tasks").select(TASK_COLUMNS).eq("queue", PING_QUEUE).eq("completed", false);
  if (scope !== "all") query = query.eq("assigned_to", viewerId);
  const open = await query.order("due_date", { ascending: true }).limit(1000).rows();
  const contactIds = [...new Set(open.map((task) => task.contact_id).filter(Boolean).map(String))];
  const [contacts, emails] = await Promise.all([contactsOf(contactIds), emailsOf(open.map((task) => task.assigned_to))]);
  const today = dayIn(now);
  const items = open.map((task) => itemOf(task, {
    contact: contacts.get(String(task.contact_id)), state: gathered?.states.get(String(task.contact_id)), today, now, emails, accounts: gathered?.accounts
  })).sort(compareItems);
  const blocks = { replies: [], overdue: [], today: [], first: [] };
  const later = [];
  for (const item of items) (blocks[item.block] || later).push(item);
  return {
    configured: true, today, scope, blocks, later,
    newContactsAllowed: newContactsAllowed(blocks),
    reconciledAt: lastStats?.at || null
  };
}

async function loadTask(pingId) {
  const [task] = await crm.from("tasks").select(TASK_COLUMNS).eq("id", pingId).limit(1).rows();
  if (!task || task.queue !== PING_QUEUE) {
    const error = new Error("Пінг не знайдено.");
    error.statusCode = 404;
    throw error;
  }
  return task;
}

function mayTouch(task, viewer) {
  return viewer.role === "admin" || task.assigned_to === viewer.id;
}

function refuse(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** Один пінг для робочого місця: людина, уся переписка, що в черзі, чернетка. */
export async function todayItem({ pingId, viewer, now = new Date() }) {
  const task = await loadTask(pingId);
  if (!mayTouch(task, viewer)) throw refuse("Це пінг іншого лідгена.", 403);
  const gathered = lastGather || await freshGather();
  const contactId = task.contact_id ? String(task.contact_id) : null;
  const state = gathered?.states.get(contactId) || null;
  const [contacts, emails] = await Promise.all([contactsOf(contactId ? [contactId] : []), emailsOf([task.assigned_to])]);
  const contact = contacts.get(contactId) || null;
  const item = itemOf(task, { contact, state, today: dayIn(now), now, emails, accounts: gathered?.accounts });
  let messages = [];
  if (item.channel === "thread" || item.channel === "moved") messages = (await readThread({ accountId: item.accountId, threadKey: item.threadKey }))?.messages || [];
  let firstDraft = null;
  if (item.channel === "first" && item.outreachId) firstDraft = (await firstMarks([item.outreachId])).drafts.get(item.outreachId) || null;
  const key = parseTaskMarks(task.description).key;
  return {
    item,
    contact,
    messages,
    pending: (state?.pending || []).map(({ id, state: status, body, queuedAt }) => ({ id, state: status, body, queuedAt })),
    acceptedAt: state?.accepted?.acceptedAt || null,
    draft: drafts.get(`${pingId}|${key}`) || (firstDraft?.text ? { text: firstDraft.text, model: firstDraft.model, kind: "first" } : null)
  };
}

/**
 * Чернетка наступного повідомлення: відповідь (лід написав) або нагадування
 * (ми написали, лід мовчить). Пише модель через `writer` з server.mjs; перше
 * повідомлення пише його власний маршрут прогріву.
 */
export async function todayDraft({ pingId, viewer, force = false, writer }) {
  const detail = await todayItem({ pingId, viewer });
  if (detail.item.channel !== "thread") throw refuse("Чернетку першого повідомлення пише «Прогрів» — відкрийте його з картки.", 409);
  const task = await loadTask(pingId);
  const cacheKey = `${pingId}|${parseTaskMarks(task.description).key}`;
  if (!force && drafts.has(cacheKey)) return drafts.get(cacheKey);
  if (!writer?.write) throw refuse("На цьому сервері немає кому писати чернетки.", 503);
  const kind = detail.messages.at(-1)?.direction === "in" ? "reply" : "follow-up";
  const written = await writer.write({ contact: detail.contact || { name: detail.item.name, company: detail.item.company, position: detail.item.position }, messages: detail.messages, kind, accountId: detail.item.accountId });
  const draft = { text: String(written?.text || ""), model: written?.model || null, kind, generatedAt: new Date().toISOString() };
  if (draft.text) drafts.set(cacheKey, draft);
  return draft;
}

/**
 * Пінг, поставлений людиною: перенести наявний або поставити новий — «+1»,
 * «+3», «+7» днів чи конкретний день; `call` — це дзвінок.
 */
export async function setManualPing({ pingId = "", contactId = "", when, call = false, viewer, now = new Date() }) {
  const dueDay = manualDueDay(when, dayIn(now));
  if (!dueDay) throw refuse("Оберіть, на коли пінг.", 400);
  const nowIso = now.toISOString();
  let task = pingId ? await loadTask(pingId) : null;
  const targetContact = String(task?.contact_id || contactId || "");
  if (!targetContact) throw refuse("Пінгу потрібен контакт.", 400);
  if (!task) {
    const [open] = await crm.from("tasks").select(TASK_COLUMNS).eq("queue", PING_QUEUE).eq("contact_id", targetContact).eq("completed", false)
      .order("created_at", { ascending: false }).limit(1).rows();
    task = open || null;
  }
  const contact = (await contactsOf([targetContact])).get(targetContact) || null;
  if (task) {
    if (!mayTouch(task, viewer)) throw refuse("Це пінг іншого лідгена.", 403);
    // Перенесений людиною — уже ручний пінг: його блок «Сьогодні» вирішує дата (завтра —
    // «На сьогодні», після — «Прострочені»), а не крок, з якого він почався. Нова
    // подія в діалозі його замінить, як будь-який ручний (planPingChanges).
    const was = parseTaskMarks(task.description).key;
    const patch = {
      due_date: zonedIso(dueDay), updated_at: nowIso,
      description: taskDescription(call ? "call" : "manual", `manual:${nowIso}`, was ? `Перенесено вручну (було: ${REASONS[reasonOfKey(was)]?.title || "пінг"})` : "Перенесено вручну")
    };
    if (call) Object.assign(patch, { task_type: "Call", title: taskTitle("call", contact) });
    await crm.from("tasks").update(patch).eq("id", task.id).rows();
    return { pingId: task.id, dueDay };
  }
  const known = lastGather?.states.get(targetContact);
  const assignee = leadgenOf(newestThread(known)?.accountId || known?.accepted?.accountId) || contact?.owner_id || viewer.id;
  const reason = call ? "call" : "manual";
  const [made] = await crm.from("tasks").insert({
    title: taskTitle(reason, contact),
    description: taskDescription(reason, `manual:${nowIso}`),
    owner_id: assignee, assigned_to: assignee, contact_id: targetContact,
    due_date: zonedIso(dueDay), completed: false, status: "todo",
    task_type: call ? "Call" : "To-do", priority: "None", queue: PING_QUEUE, updated_at: nowIso
  }).select("id").rows();
  return { pingId: made?.id || null, dueDay };
}

/* ── HTTP ────────────────────────────────────────────────────────────────── */

/**
 * /api/today — за тим самим входом, що й решта. Продавець бачить і змінює свої
 * пінги, адміністратор — усі (`scope=all`). Надсилає не цей маршрут: сторінка
 * кладе повідомлення в чергу акаунта тими самими маршрутами прогріву, що й
 * «Вхідні» та Головна, а потім просить звірку (`/api/today/refresh`).
 */
export async function handleTodayApi({ request, response, url, sendJson, readJson, viewer, writer }) {
  const path = url.pathname;
  if (path !== "/api/today" && !path.startsWith("/api/today/")) return false;
  const isAdmin = viewer?.role === "admin";
  try {
    if (request.method === "GET" && path === "/api/today") {
      const scope = isAdmin && url.searchParams.get("scope") === "all" ? "all" : "mine";
      sendJson(response, 200, { ...(await todayList({ viewerId: viewer.id, scope })), canSeeAll: isAdmin });
      return true;
    }
    if (request.method === "GET" && path === "/api/today/item") {
      sendJson(response, 200, await todayItem({ pingId: String(url.searchParams.get("pingId") || ""), viewer }));
      return true;
    }
    if (request.method === "POST" && path === "/api/today/draft") {
      const body = await readJson(request);
      sendJson(response, 200, { draft: await todayDraft({ pingId: String(body?.pingId || ""), viewer, force: Boolean(body?.force), writer }) });
      return true;
    }
    if (request.method === "POST" && path === "/api/today/ping") {
      const body = await readJson(request);
      const result = await setManualPing({ pingId: String(body?.pingId || ""), contactId: String(body?.contactId || ""), when: body?.when, call: Boolean(body?.call), viewer });
      sendJson(response, 200, result);
      return true;
    }
    // Хто веде які акаунти: читають усі, змінює адміністратор (у картці акаунта на «Прогріві»).
    if (request.method === "GET" && path === "/api/today/leadgens") {
      const people = await crm.from("profiles").select("id,email,role").order("email").rows().catch(() => []);
      sendJson(response, 200, { leadgens: leadgenStore.read(), people: people.map(({ id, email }) => ({ id, email })), canEdit: isAdmin });
      return true;
    }
    if (request.method === "POST" && path === "/api/today/leadgens") {
      if (!isAdmin) throw refuse("Хто веде акаунт, позначає адміністратор.", 403);
      const body = await readJson(request);
      const accountId = String(body?.accountId || "").trim();
      const userId = String(body?.userId || "").trim();
      if (!accountId) throw refuse("Потрібен акаунт.", 400);
      if (userId) {
        const [person] = await crm.from("profiles").select("id").eq("id", userId).limit(1).rows();
        if (!person) throw refuse("Такого користувача в CRM немає.", 400);
      }
      const next = { ...leadgenStore.read() };
      if (userId) next[accountId] = userId;
      else delete next[accountId];
      await leadgenStore.write(next);
      reconcileSoon(500);
      sendJson(response, 200, { leadgens: next });
      return true;
    }
    // Етап 2/6: відкриті діалоги з 01.08 — лише адміністратор.
    if (path.startsWith("/api/today/open-dialogs")) {
      if (!isAdmin) throw refuse("Імпорт відкритих діалогів — для адміністратора.", 403);
      if (request.method === "GET" && path === "/api/today/open-dialogs") {
        const counts = new Map();
        for (const id of Object.values(leadgenStore.read())) counts.set(id, (counts.get(id) || 0) + 1);
        const defaultAssignee = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || null;
        const people = await crm.from("profiles").select("id,email").order("email").rows().catch(() => []);
        sendJson(response, 200, { ...(await openDialogs()), people, defaultAssignee });
        return true;
      }
      if (request.method === "POST" && path === "/api/today/open-dialogs/suggest") {
        if (!writer?.classify) throw refuse("На цьому сервері немає моделі — лишаються пропозиції за правилом.", 503);
        const started = await suggestOpenDialogs({ classify: writer.classify });
        sendJson(response, 200, { job: { done: started.done, total: started.total, running: started.running, failed: started.failed } });
        return true;
      }
      if (request.method === "POST" && path === "/api/today/open-dialogs/accept") {
        const body = await readJson(request);
        const result = await acceptOpenDialogs({ items: body?.items, assignee: String(body?.assignee || "") });
        reconcileSoon(500);
        sendJson(response, 200, result);
        return true;
      }
    }
    if (request.method === "POST" && path === "/api/today/refresh") {
      sendJson(response, 200, { reconciled: await reconcilePings() });
      return true;
    }
    sendJson(response, 404, { error: "Невідомий маршрут «Сьогодні»." });
    return true;
  } catch (error) {
    const status = Number(error?.statusCode || 0) || 500;
    if (status >= 500) console.error("[today]", error);
    sendJson(response, status, { error: status >= 500 ? `Не вдалося: ${error.message}` : error.message });
    return true;
  }
}
