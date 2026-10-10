import { createHash } from "node:crypto";

import { append, contactKey } from "./journal.mjs";
import { canSend } from "./registry.mjs";

/**
 * What the sending code (ESP 1–5) writes into the journal, and how.
 *
 * The rule this module exists for: **what is recorded is exactly what went out.**
 * Not the template and its variables, not a preview, but the subject, the
 * text/plain body and the headers as they were handed to the provider — the
 * same bytes — with their SHA-256, so that a later dispute ("we never wrote
 * that") is settled by the journal and not by memory.
 *
 * Three steps, each its own line:
 *
 * - `message.sending` — before the provider is called: who, to whom, from which
 *   campaign step, and the exact content. A crash after this and before the
 *   next line leaves an attempt with no outcome, which is what it was.
 * - `message.sent` — the provider took it: its message and thread ids, and the
 *   hash of the content that `message.sending` recorded, so the two are tied.
 * - `message.failed` — it did not go, with the provider's answer.
 *
 * And the ones the rest of the ESP writes about a person, so their timeline is
 * whole: `message.replied`, `message.autoreplied`, `message.bounced` (with its
 * SMTP code), `contact.unsubscribed`, `contact.skipped` (a pre-send check said
 * no — ESP 6), `contact.note` — each with the sender, campaign and step it
 * belongs to, when there is one.
 */

export const TIMELINE_TYPES = [
  "message.sending", "message.sent", "message.failed", "message.replied", "message.autoreplied", "message.bounced",
  "contact.unsubscribed", "contact.skipped", "contact.note"
];

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function contentHash({ subject = "", text = "", headers = {} }) {
  const lines = Object.keys(headers).sort().map((name) => `${name}: ${headers[name]}`);
  return createHash("sha256").update(String(subject)).update("\n\n").update(lines.join("\n")).update("\n\n").update(String(text)).digest("hex");
}

/**
 * The attempt, recorded before the provider is asked. Refused — and nothing
 * recorded as sent — when the sender is not registered and active, when the
 * address is not one, or when the body is not plain text.
 */
export async function recordSending({ from, to, subject, text, headers = {}, campaignId = null, step = null, leadId = null, variantIds = null }, actor = "system") {
  const allowed = await canSend(from);
  if (!allowed.ok) throw fail(allowed.reason, 409);
  const contact = contactKey(to);
  if (!contact) throw fail(`Отримувач ${to} — не адреса пошти.`);
  if (typeof text !== "string" || !text.trim()) throw fail("Порожній лист не надсилається.");
  if (/<\s*(html|body|div|p|br|a|img|table)\b/i.test(text)) throw fail("Лист має бути лише text/plain — у тексті знайдено HTML.");
  const cleanHeaders = Object.fromEntries(Object.entries(headers || {}).map(([name, value]) => [String(name), String(value)]));
  const content = { subject: String(subject ?? ""), text, headers: cleanHeaders };
  return append({
    type: "message.sending", actor, contact,
    data: {
      from: allowed.sender.email, to: contact, ...content, contentType: "text/plain",
      hash: contentHash(content), campaignId, step, leadId,
      // Which A/B variants of the subject and body this one was (ESP 12).
      variantIds: variantIds && typeof variantIds === "object" ? variantIds : null
    }
  });
}

/** The provider accepted it. `sending` is the event `recordSending` returned. */
export async function recordSent(sending, { messageId, threadId = null }, actor = "system") {
  if (sending?.type !== "message.sending") throw fail("«Надіслано» пишеться лише до записаної спроби.");
  if (!messageId) throw fail("Провайдер не дав id листа — це не «надіслано».");
  return append({
    type: "message.sent", actor, contact: sending.contact,
    data: { sendingSeq: sending.seq, from: sending.data.from, to: sending.data.to, hash: sending.data.hash, messageId: String(messageId), threadId: threadId ? String(threadId) : null, campaignId: sending.data.campaignId ?? null, step: sending.data.step ?? null }
  });
}

export async function recordFailed(sending, { error }, actor = "system") {
  if (sending?.type !== "message.sending") throw fail("«Не пішло» пишеться лише до записаної спроби.");
  return append({
    type: "message.failed", actor, contact: sending.contact,
    data: {
      sendingSeq: sending.seq, from: sending.data.from, to: sending.data.to,
      campaignId: sending.data.campaignId ?? null, step: sending.data.step ?? null, error: String(error ?? "").slice(0, 1000)
    }
  });
}

/** Something about a person that is not a send: a reply, a bounce, an unsubscribe, a skip, a note. */
export async function recordAboutContact(type, email, data = {}, actor = "system") {
  // The three steps of a send have their own doors, with their own checks.
  if (!TIMELINE_TYPES.includes(type) || ["message.sending", "message.sent", "message.failed"].includes(type)) {
    throw fail(`Невідома подія про контакт: ${type}`);
  }
  const contact = contactKey(email);
  if (!contact) throw fail("Це не адреса пошти.");
  // A bounce is only as useful as its code: 5.1.1 goes to the exclusions,
  // 5.7.x raises an alarm on the sender, 4.x.x is counted apart (ESP 7).
  if (type === "message.bounced" && !/^[245]\.\d{1,3}\.\d{1,3}$/.test(String(data.code ?? ""))) {
    throw fail("Bounce пишеться з кодом SMTP на зразок 5.1.1.");
  }
  const { sender = null, campaignId = null, step = null, ...rest } = data || {};
  return append({ type, actor, contact, data: { sender: sender ? contactKey(sender) : null, campaignId, step, ...rest } });
}
