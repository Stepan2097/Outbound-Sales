// Порівняння LinkedIn-кампаній (етап 6/6 плану кампаній і пінгів, таск 011c66da, 16.10.2026).
//
// Кампанії порівнюються за кваліфікованими відповідями на 100 написаних, дзвінки —
// як підтвердження (лідген-стратегія 10.2026, §5). Люди кампанії — ті, кого вона
// взяла з папки (`invite.requested` з її id). Для кожного:
//   написали  — у треді є наше повідомлення;
//   прийняли  — запит у друзі прийнято (accepted / connected) або вже є розмова;
//   відповіли — у треді є їхнє повідомлення;
//   кваліфікована — відповідь із міткою «кваліфікована»;
//   дзвінок   — статус CRM «Дзвінок» або угода в CRM.
// Мітку відповіді ставить AI з тексту відповіді; лідген змінює її одним кліком, і
// його мітку AI вже не переписує. Нова відповідь людини — привід AI подивитись
// знову (якщо мітку ставив AI). Мітки — у стані робочого простору (server.mjs).

import { anty, crm } from "../warmup/db.mjs";
import { campaignsByContact, leadCampaigns } from "./lead-campaigns.mjs";
import { listThreads, readThread } from "../warmup/inbox.mjs";

export const LABELS = [
  ["qualified", "Кваліфікована"],
  ["not_icp", "Не ICP"],
  ["refusal", "Відмова"],
  ["traffic_only", "Тільки трафік"],
  ["other", "Інше"]
];
const LABEL_KEYS = new Set(LABELS.map(([key]) => key));
const CHUNK = 100;
const chunks = (items, size = CHUNK) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

let labelStore = { read: () => ({}), write: async () => {} };
export function setReportStores({ labels }) {
  if (labels?.read && labels?.write) labelStore = labels;
}

export function isLabel(value) {
  return LABEL_KEYS.has(value);
}

/**
 * Звіт з уже зібраних фактів — чиста функція.
 * `people`: [{ contactId, campaignId, outCount, inCount, outreachStatus, leadStatus, hasDeal, label }]
 */
export function buildReport(campaigns, people) {
  return campaigns.map((campaign) => {
    const mine = people.filter((person) => person.campaignId === campaign.id);
    const written = mine.filter((person) => person.outCount > 0);
    const replied = mine.filter((person) => person.inCount > 0);
    const accepted = mine.filter((person) => ["accepted", "connected"].includes(person.outreachStatus) || person.outCount > 0 || person.inCount > 0);
    const qualified = replied.filter((person) => person.label === "qualified");
    const calls = mine.filter((person) => person.leadStatus === "booked_call" || person.hasDeal);
    const byLabel = Object.fromEntries(LABELS.map(([key]) => [key, replied.filter((person) => person.label === key).length]));
    return {
      id: campaign.id,
      name: campaign.name,
      state: campaign.state,
      people: mine.length,
      written: written.length,
      accepted: accepted.length,
      replied: replied.length,
      qualified: qualified.length,
      qualifiedPer100: written.length ? Math.round((qualified.length / written.length) * 1000) / 10 : null,
      calls: calls.length,
      unlabeled: replied.filter((person) => !person.label).length,
      byLabel
    };
  });
}

/* ── збір фактів ─────────────────────────────────────────────────────────── */

/** Усі, кого ми торкнулися в LinkedIn: рядок запиту в друзі або розмова. */
async function touchedContacts(threads) {
  const ids = new Set(threads.map((thread) => thread.crmContactId).filter(Boolean).map(String));
  for (let offset = 0; ; offset += 1000) {
    const rows = await anty.from("wl_outreach").select("id,crm_contact_id").order("id").limit(1000).offset(offset).rows();
    for (const row of rows) if (row.crm_contact_id) ids.add(String(row.crm_contact_id));
    if (rows.length < 1000) break;
  }
  return [...ids];
}

/**
 * Люди кампаній лідгенів (WorkSpace, «варіант А», 16.10): ті, кого ми торкнулися в
 * LinkedIn і хто лежить у папці кампанії. Автозапити прогріву тут ні до чого.
 */
export async function gatherPeople() {
  const campaigns = leadCampaigns();
  const threads = await listThreads();
  const byCampaign = campaigns.length ? await campaignsByContact(await touchedContacts(threads)) : new Map();
  const byContact = new Map([...byCampaign].map(([contactId, campaign]) => [contactId, { campaignId: campaign.id }]));
  const ids = [...byContact.keys()];
  const threadsOf = new Map();
  for (const thread of threads) {
    if (!thread.crmContactId || !byContact.has(thread.crmContactId)) continue;
    threadsOf.set(thread.crmContactId, [...(threadsOf.get(thread.crmContactId) || []), thread]);
  }
  const outreach = new Map();
  const crmContacts = new Map();
  const deals = new Set();
  for (const part of chunks(ids)) {
    for (const row of await anty.from("wl_outreach").select("crm_contact_id,status").in("crm_contact_id", part).rows()) outreach.set(String(row.crm_contact_id), row.status);
    for (const row of await crm.from("contacts").select("id,name,company,position,lead_status").in("id", part).rows()) crmContacts.set(String(row.id), row);
    for (const row of await crm.from("deal_contacts").select("contact_id").in("contact_id", part).rows()) deals.add(String(row.contact_id));
  }
  const labels = labelStore.read() || {};
  const people = ids.map((contactId) => {
    const own = threadsOf.get(contactId) || [];
    const contact = crmContacts.get(contactId) || {};
    const lastIn = own.map((thread) => thread.lastInboundStoredAt).filter(Boolean).sort().at(-1) || null;
    return {
      contactId,
      campaignId: byContact.get(contactId).campaignId,
      name: contact.name || "",
      company: contact.company || "",
      position: contact.position || "",
      outCount: own.reduce((sum, thread) => sum + (thread.outCount || 0), 0),
      inCount: own.reduce((sum, thread) => sum + (thread.inCount || 0), 0),
      lastInboundAt: lastIn,
      threads: own.map((thread) => ({ accountId: thread.accountId, threadKey: thread.threadKey })),
      outreachStatus: outreach.get(contactId) || null,
      leadStatus: contact.lead_status || null,
      hasDeal: deals.has(contactId),
      label: labels[contactId]?.label || null,
      labelBy: labels[contactId]?.by || null,
      labelBasis: labels[contactId]?.basis || null
    };
  });
  return { campaigns, people };
}

export async function campaignReport() {
  const { campaigns, people } = await gatherPeople();
  return { campaigns: buildReport(campaigns, people), labels: LABELS, job: job ? { ...job } : null };
}

/** Відповіді людей кампанії — для міток. Найсвіжіші зверху. */
export async function campaignReplies(campaignId) {
  const { people } = await gatherPeople();
  const replied = people.filter((person) => person.campaignId === campaignId && person.inCount > 0)
    .sort((left, right) => String(right.lastInboundAt || "").localeCompare(String(left.lastInboundAt || "")));
  const out = [];
  for (const person of replied) {
    const thread = person.threads[0];
    const messages = thread ? (await readThread(thread).catch(() => null))?.messages || [] : [];
    const lastIn = [...messages].reverse().find((message) => message.direction === "in");
    out.push({
      contactId: person.contactId, name: person.name, company: person.company, position: person.position,
      reply: String(lastIn?.body || "").slice(0, 400), replyAt: lastIn?.sentAt || person.lastInboundAt,
      label: person.label, labelBy: person.labelBy, leadStatus: person.leadStatus
    });
  }
  return out;
}

/** Мітка людини: її рішення AI вже не переписує. */
export async function setLabel({ contactId, label, by = "human", basis = null }) {
  if (!isLabel(label)) throw Object.assign(new Error("Невідома мітка."), { statusCode: 400 });
  const next = { ...(labelStore.read() || {}) };
  next[String(contactId)] = { label, by, basis, at: new Date().toISOString() };
  await labelStore.write(next);
  return next[String(contactId)];
}

/* ── AI-мітки ────────────────────────────────────────────────────────────── */

let job = null;

/** Хто чекає мітки AI: відповів, мітки немає, або її ставив AI до нової відповіді. */
export function needsAiLabel(person) {
  if (person.inCount <= 0) return false;
  if (!person.label) return true;
  return person.labelBy === "ai" && person.labelBasis !== person.lastInboundAt;
}

export async function labelReplies({ classify }) {
  if (job?.running) return job;
  const { people } = await gatherPeople();
  const todo = people.filter(needsAiLabel);
  job = { done: 0, total: todo.length, running: true, failed: 0 };
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const person = queue.shift();
      try {
        const thread = person.threads[0];
        const messages = thread ? (await readThread(thread))?.messages || [] : [];
        const answer = await classify({ person, messages });
        if (answer && isLabel(answer.label)) await setLabel({ contactId: person.contactId, label: answer.label, by: "ai", basis: person.lastInboundAt });
        else job.failed += 1;
      } catch (error) {
        job.failed += 1;
        console.warn(`[campaign-report] ${person.contactId}: ${error.message}`);
      }
      job.done += 1;
    }
  };
  void Promise.all([worker(), worker(), worker()]).finally(() => { job.running = false; });
  return job;
}

let labeler = null;
/**
 * Фонова розмітка: кожні 10 хвилин AI дивиться нові відповіді людей кампаній.
 * Без обох баз в оточенні (тести, локальний запуск) або з REPLY_LABELS=off — не стартує.
 */
export function startReplyLabeler({ classify, everyMs = 600_000 }) {
  if (labeler || !crm.configured() || !anty.configured() || process.env.REPLY_LABELS === "off") return;
  const run = () => void labelReplies({ classify }).catch((error) => console.error(`[campaign-report] ${error.message}`));
  labeler = setInterval(run, everyMs);
  labeler.unref?.();
  setTimeout(run, 60_000).unref?.();
}

/* ── HTTP ────────────────────────────────────────────────────────────────── */

export async function handleCampaignReportApi({ request, response, url, sendJson, readJson, classify }) {
  const path = url.pathname;
  if (path !== "/api/campaign-report" && !path.startsWith("/api/campaign-report/")) return false;
  try {
    if (request.method === "GET" && path === "/api/campaign-report") {
      sendJson(response, 200, await campaignReport());
      return true;
    }
    if (request.method === "GET" && path === "/api/campaign-report/replies") {
      sendJson(response, 200, { replies: await campaignReplies(String(url.searchParams.get("campaignId") || "")), labels: LABELS });
      return true;
    }
    if (request.method === "POST" && path === "/api/campaign-report/label") {
      const body = await readJson(request);
      sendJson(response, 200, { label: await setLabel({ contactId: String(body?.contactId || ""), label: body?.label }) });
      return true;
    }
    if (request.method === "POST" && path === "/api/campaign-report/ai") {
      if (!classify) throw Object.assign(new Error("На цьому сервері немає моделі."), { statusCode: 503 });
      const started = await labelReplies({ classify });
      sendJson(response, 200, { job: { ...started } });
      return true;
    }
    sendJson(response, 404, { error: "Невідомий маршрут звіту кампаній." });
    return true;
  } catch (error) {
    const status = Number(error?.statusCode || 0) || 500;
    if (status >= 500) console.error("[campaign-report]", error);
    sendJson(response, status, { error: error.message });
    return true;
  }
}
