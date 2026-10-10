import { createHash } from "node:crypto";

import { allEntries, append, contactKey } from "./journal.mjs";

/**
 * ESP 16 — how long a lead's data is kept (checklist «Безпека», P1: «Строк
 * зберігання — неактивні ліди видаляються або анонімізуються після визначеного
 * строку; виключення лишаються назавжди»).
 *
 * A lead is inactive when its chain is over — done or stopped, not active,
 * paused or uncertain — and nothing has happened to it for `ESP_RETENTION_DAYS`
 * (365 by default). Its enrolment is then anonymised: the address becomes a
 * one-way hash, the name, company, position and time zone go, and only what the
 * reports need without knowing who it was stays — country, source and its date.
 * One `retention.anonymized` line says how many and which hashes, never the
 * addresses.
 *
 * What it does not touch: the exclusions — an unsubscribe or a «no» is kept
 * forever, it is the promise — and the journal's lines themselves, which are
 * append-only by ESP 9 and are the record of what was sent. Views of the journal
 * hide an anonymised person's words (`redactFor`); removing them from the disk
 * as well is the person's own request (ESP 17), done by erasing a per-person key.
 */

export const DEFAULT_RETENTION_DAYS = 365;
const LIVE = new Set(["active", "paused", "uncertain"]);
const DAY = 86_400_000;

export function retentionDays(env = process.env) {
  const value = Number(env.ESP_RETENTION_DAYS);
  return Number.isInteger(value) && value >= 30 && value <= 3650 ? value : DEFAULT_RETENTION_DAYS;
}

/** The one-way name an anonymised lead keeps: the same address always gives the same hash. */
export function anonymousId(email) {
  return `anon:${createHash("sha256").update(String(contactKey(email) || email)).digest("hex").slice(0, 32)}`;
}

/** When anything last happened to this enrolment. */
function lastActivity(enrollment) {
  return [enrollment.lastSent?.at, enrollment.stoppedAt, enrollment.doneAt, enrollment.completedAt, enrollment.enrolledAt]
    .map((value) => Date.parse(value || "")).filter(Number.isFinite).reduce((max, value) => Math.max(max, value), 0);
}

/** The enrolments due for anonymising now, and why each one is. */
export function dueForRetention(enrollments, { now = new Date(), days = retentionDays() } = {}) {
  const cutoff = now.getTime() - days * DAY;
  return enrollments.filter((row) => !String(row.email || "").startsWith("anon:") && !LIVE.has(row.status) && lastActivity(row) > 0 && lastActivity(row) < cutoff);
}

/** One enrolment with the person taken out of it. */
export function anonymize(enrollment, { now = new Date() } = {}) {
  const id = anonymousId(enrollment.email);
  const lead = enrollment.lead || {};
  // `pausedBecause` is a colleague's address (ESP 14) — another person, so it goes too.
  const { pausedBecause, ...rest } = enrollment;
  return {
    ...rest,
    email: id,
    lead: { email: id, country: lead.country || "", source: lead.source || "", sourceDate: lead.sourceDate || "" },
    lastSent: enrollment.lastSent ? { at: enrollment.lastSent.at } : null,
    anonymizedAt: now.toISOString()
  };
}

/**
 * Anonymise what is due. `campaigns` is ESP 5's store (`enrollments()`,
 * `saveEnrollment()`). A second run the same day is a no-op unless `force`.
 */
export async function runRetention({ campaigns, now = new Date(), days = retentionDays(), force = false, actor = "esp-retention" }) {
  const entries = await allEntries();
  const today = now.toISOString().slice(0, 10);
  if (!force && entries.some((entry) => entry.type === "retention.anonymized" && String(entry.at).startsWith(today))) {
    return { skipped: true, anonymized: 0 };
  }
  const due = dueForRetention(campaigns.enrollments(), { now, days });
  for (const enrollment of due) await campaigns.saveEnrollment(anonymize(enrollment, { now }));
  await append({ type: "retention.anonymized", actor, data: { days, count: due.length, ids: due.map((row) => anonymousId(row.email)) } });
  return { skipped: false, anonymized: due.length, days };
}

/** The hashes of everybody anonymised so far. */
export function anonymizedIds(entries) {
  const ids = new Set();
  for (const entry of entries) if (entry.type === "retention.anonymized") for (const id of entry.data?.ids || []) ids.add(id);
  return ids;
}

/**
 * A journal line as a view may show it: for an anonymised person, the words —
 * subject, text, headers — are gone; what happened, when and by whom stays.
 */
export function redactFor(entry, ids) {
  if (!entry.contact || !ids.has(anonymousId(entry.contact))) return entry;
  const { text, rawText, subject, headers, snippet, ...rest } = entry.data || {};
  return { ...entry, contact: anonymousId(entry.contact), data: { ...rest, redacted: true } };
}
