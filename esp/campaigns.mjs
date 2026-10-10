// ESP 5 — the cold-email campaigns and who is in them.
//
// A campaign is a list of steps (a template and how many working days after
// the step before it), the mailboxes it sends from, and its people. A person
// in a campaign — an enrolment — has one sender for the whole chain, picked
// when they join and never changed, and is in at most one live campaign.
//
// Stored in the workspace state (`espCampaigns`, `espEnrollments`). What was
// actually sent lives in the ESP journal (ESP 9); an enrolment only says where
// the person is in the chain and what the last letter was, so the next one can
// answer it in the same thread.

import { randomUUID } from "node:crypto";

import { contactKey } from "./journal.mjs";

export const DEFAULT_STEP_DELAYS = [0, 3, 4];
export const CAMPAIGN_STATES = ["draft", "running", "paused", "done"];
// An enrolment that may still get a letter. `uncertain`: an attempt whose
// outcome nobody knows — counted as live so the person cannot be put into a
// second campaign while somebody checks.
const LIVE_ENROLMENT = new Set(["active", "uncertain"]);

export class CampaignError extends Error {
  constructor(message, { code, status = 400 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function cleanSteps(steps, templates) {
  if (!Array.isArray(steps) || !steps.length) throw new CampaignError("У кампанії має бути хоча б один лист.", { code: "no_steps" });
  if (steps.length > 6) throw new CampaignError("Не більше шести листів у ланцюжку.", { code: "too_many_steps" });
  return steps.map((step, index) => {
    const templateId = String(step?.templateId || "");
    if (!templates.some((template) => template.id === templateId)) {
      throw new CampaignError(`Лист ${index + 1}: такого шаблону немає.`, { code: "unknown_template" });
    }
    const fallback = DEFAULT_STEP_DELAYS[index] ?? 4;
    const delay = index === 0 ? 0 : Number.isInteger(Number(step.delayDays)) ? Number(step.delayDays) : fallback;
    if (delay < 0 || delay > 30) throw new CampaignError(`Лист ${index + 1}: затримка 0–30 робочих днів.`, { code: "bad_delay" });
    return { templateId, delayDays: delay };
  });
}

function cleanSenders(senders) {
  const list = [...new Set((Array.isArray(senders) ? senders : []).map((email) => contactKey(email)).filter(Boolean))];
  if (!list.length) throw new CampaignError("Оберіть хоча б одну скриньку-відправника.", { code: "no_senders" });
  return list;
}

/** A person from a pasted line or a CRM row: an email, and what the letter may use. */
export function cleanLead(input) {
  const email = contactKey(input?.email);
  if (!email) return null;
  const text = (value) => String(value ?? "").trim().slice(0, 200);
  return {
    email,
    name: text(input.name || [input.firstName, input.lastName].filter(Boolean).join(" ")),
    firstName: text(input.firstName),
    lastName: text(input.lastName),
    company: text(input.company),
    position: text(input.position),
    country: text(input.country),
    timezone: text(input.timezone)
  };
}

/**
 * `email, name, company, country` per line — what a person pastes from a
 * sheet. Extra columns are ignored, a line without an email is reported.
 */
export function parseLeadLines(text) {
  const leads = [];
  const rejected = [];
  for (const [index, line] of String(text ?? "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const [email, name, company, country, timezone] = line.split(/[,;\t]/).map((cell) => cell.trim());
    const lead = cleanLead({ email, name, company, country, timezone });
    if (lead) leads.push(lead);
    else rejected.push({ line: index + 1, text: line.slice(0, 120) });
  }
  return { leads, rejected };
}

export function campaignStore({ read, write, readEnrollments, writeEnrollments, templates, now = () => new Date() }) {
  const list = () => (Array.isArray(read()) ? read() : []);
  const enrollments = () => (Array.isArray(readEnrollments()) ? readEnrollments() : []);
  const find = (id) => list().find((campaign) => campaign.id === id) || null;

  return {
    list,
    find,
    enrollments,
    enrollmentsOf(campaignId) { return enrollments().filter((row) => row.campaignId === campaignId); },

    async create({ name, steps, senders }) {
      const title = String(name ?? "").trim().slice(0, 120);
      if (!title) throw new CampaignError("Дайте кампанії назву.", { code: "no_name" });
      const at = now().toISOString();
      const campaign = {
        id: randomUUID(), name: title, state: "draft",
        steps: cleanSteps(steps, templates()), senders: cleanSenders(senders),
        createdAt: at, updatedAt: at
      };
      await write([...list(), campaign]);
      return campaign;
    },

    async update(id, input) {
      const campaign = find(id);
      if (!campaign) throw new CampaignError("Такої кампанії немає.", { code: "not_found", status: 404 });
      const next = { ...campaign, updatedAt: now().toISOString() };
      if (input.name !== undefined) next.name = String(input.name).trim().slice(0, 120) || campaign.name;
      // The chain and the senders are fixed once anybody is in it: a letter
      // already sent from one mailbox has its follow-ups owed from the same.
      const started = enrollments().some((row) => row.campaignId === id && row.step > 0);
      if (input.steps !== undefined) {
        if (started) throw new CampaignError("Ланцюжок уже почався — листи в ньому не змінюються.", { code: "started", status: 409 });
        next.steps = cleanSteps(input.steps, templates());
      }
      if (input.senders !== undefined) {
        const senders = cleanSenders(input.senders);
        const assigned = new Set(enrollments().filter((row) => row.campaignId === id && LIVE_ENROLMENT.has(row.status)).map((row) => row.sender));
        const dropped = [...assigned].filter((email) => !senders.includes(email));
        if (dropped.length) throw new CampaignError(`Скринька ${dropped.join(", ")} уже веде людей цієї кампанії — її не прибрати, доки вони в ланцюжку.`, { code: "sender_in_use", status: 409 });
        next.senders = senders;
      }
      await write(list().map((row) => (row.id === id ? next : row)));
      return next;
    },

    async setState(id, state) {
      if (!CAMPAIGN_STATES.includes(state) || state === "draft") throw new CampaignError("Стан кампанії: running, paused або done.", { code: "bad_state" });
      const campaign = find(id);
      if (!campaign) throw new CampaignError("Такої кампанії немає.", { code: "not_found", status: 404 });
      if (campaign.state === "done") throw new CampaignError("Завершену кампанію не перезапускають — створіть нову.", { code: "done", status: 409 });
      const next = { ...campaign, state, updatedAt: now().toISOString() };
      await write(list().map((row) => (row.id === id ? next : row)));
      if (state === "done") {
        // Finishing a campaign lets its people go: nobody still in the chain
        // gets anything more from it.
        await writeEnrollments(enrollments().map((row) => (row.campaignId === id && row.status === "active"
          ? { ...row, status: "stopped", reason: "campaign_done", stoppedAt: now().toISOString() } : row)));
      }
      return next;
    },

    /**
     * Put people into a campaign. Each gets the campaign's least-loaded sender,
     * for good. Somebody already live in another campaign — or in this one —
     * is not added, and is reported with the reason.
     */
    async enroll(id, leads, { blocked = () => null } = {}) {
      const campaign = find(id);
      if (!campaign) throw new CampaignError("Такої кампанії немає.", { code: "not_found", status: 404 });
      if (campaign.state === "done") throw new CampaignError("Кампанія завершена.", { code: "done", status: 409 });
      const all = enrollments();
      const live = new Map(all.filter((row) => LIVE_ENROLMENT.has(row.status)).map((row) => [row.email, row]));
      const here = new Set(all.filter((row) => row.campaignId === id).map((row) => row.email));
      const load = new Map(campaign.senders.map((email) => [email, 0]));
      for (const row of all) if (row.campaignId === id && LIVE_ENROLMENT.has(row.status) && load.has(row.sender)) load.set(row.sender, load.get(row.sender) + 1);

      const added = [];
      const skipped = [];
      for (const raw of leads) {
        const lead = cleanLead(raw);
        if (!lead) { skipped.push({ email: String(raw?.email ?? ""), reason: "not_an_email" }); continue; }
        if (here.has(lead.email)) { skipped.push({ email: lead.email, reason: "already_in_campaign" }); continue; }
        const elsewhere = live.get(lead.email);
        if (elsewhere) {
          const other = find(elsewhere.campaignId);
          skipped.push({ email: lead.email, reason: "in_other_campaign", campaign: other?.name || elsewhere.campaignId });
          continue;
        }
        const stop = blocked(lead.email);
        if (stop) { skipped.push({ email: lead.email, reason: stop }); continue; }
        const sender = [...load.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0][0];
        load.set(sender, load.get(sender) + 1);
        const enrollment = {
          id: randomUUID(), campaignId: id, email: lead.email, lead, sender,
          step: 0, status: "active", nextDueDate: null, lastSent: null,
          enrolledAt: now().toISOString()
        };
        added.push(enrollment);
        here.add(lead.email);
        live.set(lead.email, enrollment);
      }
      await writeEnrollments([...all, ...added]);
      return { added, skipped };
    },

    async saveEnrollment(enrollment) {
      await writeEnrollments(enrollments().map((row) => (row.id === enrollment.id ? enrollment : row)));
      return enrollment;
    }
  };
}
