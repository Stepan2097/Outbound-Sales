// Кампанії лідгенів (WorkSpace, таск f78ffd9a, 16.10.2026; модель — «варіант А» Марка).
//
// Кампанія — стратегія аутріч: одна або кілька папок CRM, продукт зі «Смислів»,
// сценарій (сигнал, гіпотеза, ціль, флоу, розгалуження), кроки нагадувань і привід
// хвилі. Людина в кампанії, якщо вона в одній із її папок; у кількох — перша жива
// кампанія за порядком. З прогрівом (автозапити в друзі, активність, імпорт
// діалогів — warmup/*) кампанія не пов'язана: прогрів лише додає людей у друзі.

import { randomUUID } from "node:crypto";
import { crm } from "../warmup/db.mjs";
import { cleanPlan } from "../warmup/scenarios.mjs";
import { DEFAULT_SILENT_STEPS, MAX_SILENT_STEPS } from "../warmup/campaigns.mjs";

export const LEAD_CAMPAIGN_STATES = ["active", "paused"];
const CHUNK = 100;
const chunks = (items, size = CHUNK) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const text = (value, limit = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

let store = { read: () => [], write: async () => {} };
export function setLeadCampaignStore(next) {
  if (next?.read && next?.write) store = next;
}

// «Пропустити» кампанію (Марко 22.10, таск a0c0820f): { contactId: до коли ISO }. Поки пропуск
// діє, відповісти можна без кампанії; минув — картка знову просить обрати, створити чи пропустити.
export const CAMPAIGN_SKIP_DAYS = 3;
let skipStore = { read: () => ({}), write: async () => {} };
export function setCampaignSkipStore(next) {
  if (next?.read && next?.write) skipStore = next;
}

/**
 * До коли пропущено вибір кампанії для контакта, або null. Минулий пропуск теж повертається:
 * картка за ним каже «це нагадування» — пропускали, час обрати, створити чи пропустити знову.
 */
export function campaignSkippedUntil(contactId) {
  return skipStore.read()[String(contactId || "")] || null;
}

/** Пропустити на 3 дні; старі пропуски, що вже минули, прибираються. */
export async function skipCampaign({ contactId, now = new Date() }) {
  const id = String(contactId || "").trim();
  if (!id) throw refuse("Потрібен контакт.");
  const until = new Date(now.getTime() + CAMPAIGN_SKIP_DAYS * 86400000).toISOString();
  const kept = Object.fromEntries(Object.entries(skipStore.read()).filter(([, value]) => Date.parse(value) > now.getTime()));
  await skipStore.write({ ...kept, [id]: until });
  return { contactId: id, until };
}

function isSteps(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_SILENT_STEPS && value.every((days) => Number.isInteger(days) && days >= 1 && days <= 30);
}

export function normalizeLeadCampaign(raw, index = 0) {
  const now = new Date().toISOString();
  const folderIds = [...new Set((Array.isArray(raw?.folderIds) ? raw.folderIds : []).map((id) => text(id, 60)).filter(Boolean))];
  return {
    id: text(raw?.id, 60) || randomUUID(),
    name: text(raw?.name, 120) || "Кампанія без назви",
    folderIds,
    folderNames: Object.fromEntries(Object.entries(raw?.folderNames || {}).filter(([id]) => folderIds.includes(id)).map(([id, name]) => [id, text(name, 200)])),
    productId: text(raw?.productId, 80) || null,
    approach: String(raw?.approach ?? "").trim().slice(0, 2000),
    silentSteps: isSteps(raw?.silentSteps) ? [...raw.silentSteps] : [...DEFAULT_SILENT_STEPS],
    plan: cleanPlan(raw?.plan),
    state: LEAD_CAMPAIGN_STATES.includes(raw?.state) ? raw.state : "active",
    order: Number.isFinite(raw?.order) ? Number(raw.order) : index,
    createdAt: typeof raw?.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : now
  };
}

export function leadCampaigns() {
  return (Array.isArray(store.read()) ? store.read() : []).map(normalizeLeadCampaign).sort((left, right) => left.order - right.order);
}

export function leadCampaignById(id) {
  return leadCampaigns().find((campaign) => campaign.id === id) || null;
}

/**
 * Кампанія кожної людини: перша жива кампанія за порядком, у чиїй папці вона є.
 * Чиста частина — `pickCampaign`, щоб правило перевірялось без бази.
 */
export function pickCampaign(folderIds, campaigns) {
  const mine = new Set(folderIds);
  return campaigns.find((campaign) => campaign.state === "active" && campaign.folderIds.some((id) => mine.has(id))) || null;
}

export async function campaignsByContact(contactIds) {
  const campaigns = leadCampaigns().filter((campaign) => campaign.state === "active" && campaign.folderIds.length);
  const found = new Map();
  const ids = [...new Set((contactIds || []).map(String).filter(Boolean))];
  if (!campaigns.length || !ids.length) return found;
  const folders = [...new Set(campaigns.flatMap((campaign) => campaign.folderIds))];
  const foldersOf = new Map();
  for (const part of chunks(ids)) {
    const rows = await crm.from("contact_folder_memberships").select("contact_id,folder_id").in("contact_id", part).in("folder_id", folders).rows();
    for (const row of rows) foldersOf.set(String(row.contact_id), [...(foldersOf.get(String(row.contact_id)) || []), String(row.folder_id)]);
  }
  for (const [contactId, folderIds] of foldersOf) {
    const campaign = pickCampaign(folderIds, campaigns);
    if (campaign) found.set(contactId, campaign);
  }
  return found;
}

/**
 * Кампанія людини серед усіх — і на паузі теж (таск 207ffbc1, Марко 20.10: лід, якого взяли
 * з LinkedIn повз базу, обов'язково відносять до кампанії перед відповіддю). Людина в папці
 * кампанії на паузі вже віднесена — вимагати вибір ще раз не треба.
 */
export async function anyCampaignOf(contactId) {
  const campaigns = leadCampaigns().filter((campaign) => campaign.folderIds.length);
  if (!contactId || !campaigns.length) return null;
  const folders = [...new Set(campaigns.flatMap((campaign) => campaign.folderIds))];
  const rows = await crm.from("contact_folder_memberships").select("folder_id").eq("contact_id", String(contactId)).in("folder_id", folders).rows();
  const mine = new Set(rows.map((row) => String(row.folder_id)));
  const found = campaigns.find((campaign) => campaign.folderIds.some((id) => mine.has(id)));
  return found ? { id: found.id, name: found.name, state: found.state } : null;
}

/** Віднести людину до кампанії: додати в першу папку CRM кампанії (якщо її там ще немає). */
export async function assignToCampaign({ contactId, campaignId }) {
  const campaign = leadCampaignById(String(campaignId || ""));
  if (!campaign) throw refuse("Цієї кампанії вже немає.", 404);
  if (!campaign.folderIds.length) throw refuse("У кампанії немає папки CRM — додайте її в Campaign.");
  const id = String(contactId || "").trim();
  if (!id) throw refuse("Потрібен контакт.");
  const present = await crm.from("contact_folder_memberships").select("folder_id").eq("contact_id", id).in("folder_id", campaign.folderIds).rows();
  if (!present.length) await crm.from("contact_folder_memberships").insert({ contact_id: id, folder_id: campaign.folderIds[0] }).rows();
  return { id: campaign.id, name: campaign.name, state: campaign.state, added: !present.length };
}

/* ── HTTP ────────────────────────────────────────────────────────────────── */

function refuse(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function parseInput(body, { products }) {
  const out = {};
  if (body.name !== undefined) out.name = text(body.name, 120);
  if (body.folderIds !== undefined) {
    if (!Array.isArray(body.folderIds)) throw refuse("Папки — списком.");
    out.folderIds = body.folderIds.map((id) => text(id, 60)).filter(Boolean);
  }
  if (body.folderNames !== undefined && typeof body.folderNames === "object") out.folderNames = body.folderNames;
  if (body.productId !== undefined) {
    const productId = body.productId ? text(body.productId, 80) : null;
    if (productId && !products().some((product) => product.id === productId)) throw refuse(`Невідомий продукт: ${productId}`);
    out.productId = productId;
  }
  if (body.approach !== undefined) out.approach = String(body.approach ?? "").trim().slice(0, 2000);
  if (body.silentSteps !== undefined) {
    const steps = Array.isArray(body.silentSteps) ? body.silentSteps.map(Number) : null;
    if (!isSteps(steps)) throw refuse(`Нагадування — від 1 до ${MAX_SILENT_STEPS} чисел, кожне 1–30 робочих днів.`);
    out.silentSteps = steps;
  }
  if (body.plan !== undefined) out.plan = cleanPlan(body.plan);
  if (body.state !== undefined) {
    if (!LEAD_CAMPAIGN_STATES.includes(body.state)) throw refuse("Невідомий стан кампанії.");
    out.state = body.state;
  }
  return out;
}

export async function handleLeadCampaignApi({ request, response, url, sendJson, readJson, products = () => [] }) {
  if (url.pathname !== "/api/lead-campaigns" && url.pathname !== "/api/lead-campaigns/assign" && url.pathname !== "/api/lead-campaigns/skip") return false;
  try {
    if (url.pathname === "/api/lead-campaigns/skip") {
      if (request.method !== "POST") throw refuse("Невідомий метод.", 405);
      const body = (await readJson(request)) || {};
      sendJson(response, 200, await skipCampaign({ contactId: body.contactId }));
      return true;
    }
    if (url.pathname === "/api/lead-campaigns/assign") {
      if (request.method !== "POST") throw refuse("Невідомий метод.", 405);
      const body = (await readJson(request)) || {};
      sendJson(response, 200, { campaign: await assignToCampaign({ contactId: body.contactId, campaignId: body.campaignId }) });
      return true;
    }
    const list = leadCampaigns();
    if (request.method === "GET") {
      sendJson(response, 200, { campaigns: list });
      return true;
    }
    if (request.method === "DELETE") {
      const id = String(url.searchParams.get("id") || "");
      if (!list.some((campaign) => campaign.id === id)) throw refuse("Цієї кампанії вже немає.", 404);
      await store.write(list.filter((campaign) => campaign.id !== id));
      sendJson(response, 200, { deleted: id });
      return true;
    }
    const body = (await readJson(request)) || {};
    const input = parseInput(body, { products });
    if (request.method === "POST") {
      if (!input.name) throw refuse("Дайте кампанії назву.");
      if (!input.folderIds?.length) throw refuse("Оберіть хоча б одну папку CRM — з неї люди кампанії.");
      const created = normalizeLeadCampaign({ ...input, order: list.length });
      await store.write([...list, created]);
      sendJson(response, 201, { campaign: created });
      return true;
    }
    if (request.method === "PATCH") {
      const current = list.find((campaign) => campaign.id === String(body.id || ""));
      if (!current) throw refuse("Цієї кампанії вже немає.", 404);
      const next = normalizeLeadCampaign({ ...current, ...input, updatedAt: new Date().toISOString() });
      if (!next.folderIds.length) throw refuse("У кампанії має лишитись хоча б одна папка.");
      let saved = list.map((campaign) => (campaign.id === next.id ? next : campaign));
      if (Number.isFinite(Number(body.order)) && body.order !== null && body.order !== undefined) {
        const rest = saved.filter((campaign) => campaign.id !== next.id);
        rest.splice(Math.max(0, Math.min(rest.length, Number(body.order))), 0, next);
        saved = rest;
      }
      saved = saved.map((campaign, index) => ({ ...campaign, order: index }));
      await store.write(saved);
      sendJson(response, 200, { campaign: saved.find((campaign) => campaign.id === next.id) });
      return true;
    }
    throw refuse("Невідомий метод.", 405);
  } catch (error) {
    const status = Number(error?.statusCode || 0) || 500;
    if (status >= 500) console.error("[lead-campaigns]", error);
    sendJson(response, status, { error: error.message });
    return true;
  }
}
