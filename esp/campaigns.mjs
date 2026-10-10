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
import { SPIN_MODES } from "./spintax.mjs";

export const DEFAULT_STEP_DELAYS = [0, 3, 4];
export const CAMPAIGN_STATES = ["draft", "running", "paused", "done"];
// An enrolment that may still get a letter. `uncertain`: an attempt whose
// outcome nobody knows — counted as live so the person cannot be put into a
// second campaign while somebody checks.
// `paused` (ESP 14): somebody else at the company answered; a person decides.
const LIVE_ENROLMENT = new Set(["active", "uncertain", "paused"]);

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
    timezone: text(input.timezone),
    // ESP 6: where the address came from and when, and what the verifier said
    // about it — without these the pre-send checks do not let it go.
    source: text(input.source),
    sourceDate: text(input.sourceDate),
    verification: text(input.verification).toLowerCase(),
    verifiedAt: text(input.verifiedAt)
  };
}

/**
 * `email, name, company, country` per line — what a person pastes from a
 * sheet. Extra columns are ignored, a line without an email is reported.
 */
/**
 * Columns, in order, when there is no header line: what a person pastes from a
 * sheet. A header line (one that names an `email` column) maps by name instead,
 * so a sheet in any order works — `source`, `source_date`, `verification`,
 * `verified_at` are the ESP 6 columns.
 */
const LEAD_COLUMNS = ["email", "name", "company", "country", "timezone", "source", "sourceDate", "verification", "verifiedAt"];
const HEADER_NAMES = {
  email: "email", "e-mail": "email", mail: "email", name: "name", "full name": "name", company: "company", country: "country",
  timezone: "timezone", tz: "timezone", source: "source", "source date": "sourceDate", source_date: "sourceDate", sourcedate: "sourceDate",
  obtained: "sourceDate", verification: "verification", status: "verification", "email status": "verification",
  verified_at: "verifiedAt", "verified at": "verifiedAt", verifiedat: "verifiedAt", position: "position", title: "position"
};

export function parseLeadLines(text) {
  const leads = [];
  const rejected = [];
  let columns = LEAD_COLUMNS;
  let first = true;
  for (const [index, line] of String(text ?? "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const cells = line.split(/[,;\t]/).map((cell) => cell.trim());
    // Only the first line can be a header: it names an email column and holds no address.
    if (first) {
      first = false;
      const named = cells.map((cell) => HEADER_NAMES[cell.toLowerCase()] || null);
      if (named.includes("email") && !cells.some((cell) => cell.includes("@"))) { columns = named; continue; }
    }
    const row = Object.fromEntries(columns.map((column, at) => [column, cells[at]]).filter(([column]) => column));
    const lead = cleanLead(row);
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

    async create({ name, steps, senders, spinMode = "all" }) {
      const title = String(name ?? "").trim().slice(0, 120);
      if (!title) throw new CampaignError("Дайте кампанії назву.", { code: "no_name" });
      const at = now().toISOString();
      const campaign = {
        id: randomUUID(), name: title, state: "draft",
        steps: cleanSteps(steps, templates()), senders: cleanSenders(senders),
        // ESP 12: spintax for everybody, for half (A/B against the base text), or for nobody.
        spinMode: SPIN_MODES.includes(spinMode) ? spinMode : "all",
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
      if (input.spinMode !== undefined) {
        if (started) throw new CampaignError("Ланцюжок уже почався — режим спінтаксу не змінюється, інакше A/B порівнює різне.", { code: "started", status: 409 });
        next.spinMode = SPIN_MODES.includes(input.spinMode) ? input.spinMode : campaign.spinMode;
      }
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

    /**
     * ESP 8: a campaign paused by an alarm, with why — its source marked for
     * checking. A person reads the note and decides; nothing resumes on its own.
     */
    async pauseForReview(id, reason) {
      const campaign = find(id);
      if (!campaign || campaign.state !== "running") return null;
      const next = { ...campaign, state: "paused", sourceReview: { reason, at: now().toISOString() }, updatedAt: now().toISOString() };
      await write(list().map((row) => (row.id === id ? next : row)));
      return next;
    },

    /**
     * A person picks a held person back up: one set aside after a company
     * colleague answered (ESP 14), or one whose last send nobody could confirm
     * — after checking the mailbox's Sent folder. Back to `active`, due now.
     */
    async resumePerson(id, email) {
      const row = enrollments().find((item) => item.campaignId === id && item.email === String(email).toLowerCase());
      if (!row) throw new CampaignError("Такої людини в кампанії немає.", { code: "not_found", status: 404 });
      if (!["paused", "uncertain"].includes(row.status)) throw new CampaignError("Продовжити можна лише паузу або «невідомо, чи пішов».", { code: "not_held", status: 409 });
      const next = { ...row, status: "active", reason: null, resumedAt: now().toISOString() };
      await writeEnrollments(enrollments().map((item) => (item.id === row.id ? next : item)));
      return next;
    },

    async saveEnrollment(enrollment) {
      await writeEnrollments(enrollments().map((row) => (row.id === enrollment.id ? enrollment : row)));
      return enrollment;
    }
  };
}
