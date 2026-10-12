import { randomUUID } from "node:crypto";

import { cleanLead, parseLeadLines } from "./campaigns.mjs";
import { contactKey } from "./journal.mjs";

/**
 * ESP-UI 5 — lead lists, as Snov's «Leads» (screen 07): named lists of people
 * to write to, kept before and apart from any campaign. A person is added by
 * pasting rows from a sheet (the same columns as a campaign's «add people»),
 * lives in one or more lists, and is sent to a campaign from here — through
 * the same pre-send checks (ESP 6) as everywhere else.
 *
 * Kept in the workspace state beside the campaigns: `lists` and `leads`, each
 * lead `{ id, listId, email, …cleanLead fields, addedAt, addedBy }`. The same
 * address may sit in two lists (Snov allows it), never twice in one.
 *
 * ESP 17's erasure and ESP 16's retention reach these rows too (`forget`,
 * `anonymizeWhere`): a person forgotten is gone from every list.
 */

export class LeadError extends Error {
  constructor(message, { code, status = 400 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const LIST_NAME_MAX = 80;

export function leadStore({ readLists, writeLists, readLeads, writeLeads, now = () => new Date() }) {
  const lists = () => readLists() || [];
  const leads = () => readLeads() || [];
  const findList = (id) => lists().find((row) => row.id === id) || null;
  const mustList = (id) => {
    const list = findList(id);
    if (!list) throw new LeadError("Такого списку немає.", { code: "no_list", status: 404 });
    return list;
  };
  const cleanName = (name) => {
    const title = String(name ?? "").trim().replace(/\s+/g, " ").slice(0, LIST_NAME_MAX);
    if (!title) throw new LeadError("Дайте списку назву.", { code: "no_name" });
    return title;
  };

  return {
    lists,
    leads,
    findList,
    leadsOf(listId) { return leads().filter((row) => row.listId === listId); },

    async createList(name, actor = "") {
      const title = cleanName(name);
      if (lists().some((row) => row.name.toLowerCase() === title.toLowerCase())) throw new LeadError(`Список «${title}» уже є.`, { code: "duplicate_list" });
      const list = { id: randomUUID(), name: title, createdAt: now().toISOString(), createdBy: actor };
      await writeLists([...lists(), list]);
      return list;
    },

    async renameList(id, name) {
      mustList(id);
      const title = cleanName(name);
      if (lists().some((row) => row.id !== id && row.name.toLowerCase() === title.toLowerCase())) throw new LeadError(`Список «${title}» уже є.`, { code: "duplicate_list" });
      await writeLists(lists().map((row) => (row.id === id ? { ...row, name: title } : row)));
      return findList(id);
    },

    /** The list and its people. The people stay in their campaigns: a campaign keeps its own copy. */
    async deleteList(id) {
      const list = mustList(id);
      const removed = leads().filter((row) => row.listId === id).length;
      await writeLeads(leads().filter((row) => row.listId !== id));
      await writeLists(lists().filter((row) => row.id !== id));
      return { list, removed };
    },

    /**
     * Rows pasted from a sheet, into a list. A person already in the list is
     * updated with whatever the new row knows that the old one did not.
     */
    async addFromText(listId, text, actor = "") {
      mustList(listId);
      const { leads: parsed, rejected } = parseLeadLines(text);
      if (!parsed.length && !rejected.length) throw new LeadError("Вставте хоча б один рядок з адресою.", { code: "empty" });
      const current = leads();
      const inList = new Map(current.filter((row) => row.listId === listId).map((row) => [row.email, row]));
      const at = now().toISOString();
      let added = 0;
      let updated = 0;
      const next = [...current];
      for (const lead of parsed) {
        const known = inList.get(lead.email);
        if (known) {
          const merged = { ...known };
          for (const [key, value] of Object.entries(lead)) if (value && !known[key]) merged[key] = value;
          if (JSON.stringify(merged) !== JSON.stringify(known)) {
            next[next.indexOf(known)] = merged;
            inList.set(lead.email, merged);
            updated += 1;
          }
          continue;
        }
        const row = { id: randomUUID(), listId, ...lead, addedAt: at, addedBy: actor };
        next.push(row);
        inList.set(lead.email, row);
        added += 1;
      }
      await writeLeads(next);
      return { added, updated, rejected };
    },

    /** One person's details, corrected by hand on their card. */
    async updateLead(id, input) {
      const row = leads().find((item) => item.id === id);
      if (!row) throw new LeadError("Такого ліда немає.", { code: "no_lead", status: 404 });
      const fields = cleanLead({ ...row, ...input, email: row.email });
      const next = { ...row, ...Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "email")) };
      await writeLeads(leads().map((item) => (item.id === id ? next : item)));
      return next;
    },

    async removeLeads(ids) {
      const drop = new Set(ids);
      const before = leads().length;
      await writeLeads(leads().filter((row) => !drop.has(row.id)));
      return { removed: before - leads().length };
    },

    /** ESP 17: a person forgotten is gone from every list. */
    async forget(email) {
      const key = contactKey(email);
      const before = leads().length;
      await writeLeads(leads().filter((row) => row.email !== key));
      return before - leads().length;
    }
  };
}

const VERIFICATION_TONE = { valid: "valid", ok: "valid", deliverable: "valid", risky: "risky", "catch-all": "risky", catchall: "risky", accept_all: "risky", unknown: "unknown", invalid: "invalid", undeliverable: "invalid", bounced: "invalid" };

/** The verifier's word as one of four dots: green, yellow, red, grey. */
export function verificationTone(value) {
  return VERIFICATION_TONE[String(value || "").toLowerCase()] || "none";
}

/**
 * A page of a list (or of everybody, `listId` empty), with what the table
 * shows beside each person: the campaigns they are in and how they stand
 * there, and whether they are excluded for good.
 */
export function leadPage(store, { listId = "", q = "", offset = 0, limit = 50, enrollments = [], campaigns = new Map(), excluded = new Map() } = {}) {
  const rows = listId ? store.leadsOf(listId) : store.leads();
  const needle = String(q || "").trim().toLowerCase();
  const matches = rows.filter((row) => !needle || [row.email, row.name, row.company, row.position, row.country, row.source].some((value) => String(value || "").toLowerCase().includes(needle)));
  const size = Math.max(1, Math.min(200, Number(limit) || 50));
  const lastPage = Math.max(0, Math.ceil(matches.length / size) - 1);
  const start = Math.min(Math.floor(Math.max(0, Number(offset) || 0) / size), lastPage) * size;
  const counts = { valid: 0, risky: 0, invalid: 0, unknown: 0, none: 0 };
  for (const row of matches) counts[verificationTone(row.verification)] += 1;
  return {
    total: matches.length,
    offset: start,
    limit: size,
    verification: counts,
    rows: decorateLeads(matches.slice(start, start + size), { enrollments, campaigns, excluded })
  };
}

/**
 * What the table shows beside each person, wherever the rows came from (a list
 * here or a CRM folder): the verifier's dot, the campaigns they are in and how
 * they stand there, and whether they — or their whole domain — are excluded.
 */
export function decorateLeads(rows, { enrollments = [], campaigns = new Map(), excluded = new Map() } = {}) {
  const byEmail = new Map();
  for (const row of enrollments) {
    if (!byEmail.has(row.email)) byEmail.set(row.email, []);
    byEmail.get(row.email).push({ campaignId: row.campaignId, name: campaigns.get(row.campaignId) || row.campaignId, status: row.status, step: row.step });
  }
  const domainOf = (email) => `@${String(email).split("@")[1] || ""}`;
  return rows.map((row) => ({
    ...row,
    tone: verificationTone(row.verification),
    campaigns: byEmail.get(row.email) || [],
    excluded: excluded.get(row.email) || excluded.get(domainOf(row.email)) || null
  }));
}
