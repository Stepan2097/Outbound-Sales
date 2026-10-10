// ESP 17 — a person's request about their data: what we hold, and forgetting it.
//
// Checklist (P2, «Дані і звітність»): «Експорт і видалення за email — для
// запитів людей про їхні дані: показати, звідки адреса і що надсилали;
// видалити, лишивши хеш у виключеннях.»
//
// What the ESP holds about a person lives in two places: the campaigns' rows
// (the lead as it was pasted — name, company, where the address came from and
// when) and the journal (every letter exactly as sent, replies, bounces,
// unsubscribes, skips). The export reads both; the erasure empties both and
// leaves only `erasureKey(email)` in the exclusions, so the same address is
// refused if somebody pastes it again.

import { contactKey, erasureKey, eraseContact } from "./journal.mjs";

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const RECEIVED = new Set(["message.replied", "message.autoreplied", "message.bounced"]);

/**
 * Everything about one address, for the person who asked: where it came
 * from, every letter as it was sent, what came back, what else happened, and
 * whether the address is excluded or was already forgotten.
 */
export function exportPerson(email, { entries, enrollments = [], campaigns = [], exclusions = new Map(), now = new Date() }) {
  const address = contactKey(email);
  if (!address) throw fail("Це не адреса пошти.");
  const campaignName = new Map(campaigns.map((campaign) => [campaign.id, campaign.name]));
  const mine = entries.filter((entry) => entry.contact === address);
  const marker = erasureKey(address);
  const erasure = entries.findLast((entry) => entry.type === "contact.erased" && entry.data?.key === marker) || null;
  const sentSeqs = new Set(mine.filter((entry) => entry.type === "message.sent").map((entry) => entry.data?.sendingSeq));

  const sources = enrollments.filter((row) => row.email === address).map((row) => ({
    campaign: campaignName.get(row.campaignId) || row.campaignId,
    source: row.lead?.source || "",
    sourceDate: row.lead?.sourceDate || "",
    enrolledAt: row.enrolledAt,
    status: row.status,
    sender: row.sender,
    lead: row.lead || {}
  }));
  const sent = mine.filter((entry) => entry.type === "message.sending").map((entry) => ({
    at: entry.at,
    from: entry.data?.from,
    subject: entry.data?.subject,
    text: entry.data?.text,
    campaign: campaignName.get(entry.data?.campaignId) || entry.data?.campaignId || null,
    step: entry.data?.step ?? null,
    state: sentSeqs.has(entry.seq) ? "sent" : mine.some((other) => other.type === "message.failed" && other.data?.sendingSeq === entry.seq) ? "failed" : "unconfirmed"
  }));
  const received = mine.filter((entry) => RECEIVED.has(entry.type)).map((entry) => ({
    at: entry.at, type: entry.type, subject: entry.data?.subject || "", text: entry.data?.text || "", code: entry.data?.code || null
  }));
  const events = mine.filter((entry) => !entry.type.startsWith("message.")).map((entry) => ({ at: entry.at, type: entry.type, data: entry.data }));
  const excluded = exclusions.get(address) || exclusions.get(`@${address.split("@")[1]}`) || exclusions.get(marker) || null;

  return {
    email: address,
    exportedAt: now.toISOString(),
    found: Boolean(sources.length || mine.length),
    erased: erasure ? { at: erasure.at, by: erasure.actor, lines: erasure.data.entries.length } : null,
    sources,
    sent,
    received,
    events,
    excluded: excluded ? { category: excluded.category, at: excluded.at, domain: excluded.key.startsWith("@") } : null
  };
}

/**
 * Forget the address: the journal first (from then on the hash keeps them
 * out, even if the rest failed), then the campaigns' rows. Irreversible —
 * the route asks for the address typed twice.
 */
export async function erasePerson(email, { campaigns, actor, note = "" }) {
  const address = contactKey(email);
  if (!address) throw fail("Це не адреса пошти.");
  const event = await eraseContact(address, { actor, note });
  const rows = campaigns ? await campaigns.forget(address) : 0;
  return { email: address, key: event.data.key, journalLines: event.data.entries.length, campaignRows: rows, at: event.at };
}
