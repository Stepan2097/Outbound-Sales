// ESP 14 — the team's one inbox for cold email: every conversation a sending
// mailbox has had with a lead, from the journal, and a quick reply from the
// same mailbox in the same thread.
//
// Checklist (P1): «Спільна вхідна для команди — усі відповіді в одному місці
// зі швидкою відповіддю від того ж сендера.»
//
// A conversation is one sender and one person: our letters (the exact text
// that went, from `message.sending`), their replies, auto-replies, bounces and
// an unsubscribe, oldest first. Only conversations where something came back
// are listed — a letter nobody answered is not inbox.
//
// The quick reply is built like every other letter (one text/plain part,
// esp/letter.mjs), answers the newest letter of the thread by its Message-ID,
// and goes through the sender gate — which, until ESP 11 is accepted, refuses
// to send anything real (`SendingLocked`). Nothing here bypasses that.

import { buildLetter, messageIdFor, signatureText } from "./letter.mjs";
import { currentLabels } from "./replies.mjs";
import { cleanText } from "./template.mjs";
import { replySubject } from "./thread.mjs";

const INBOUND = new Set(["message.replied", "message.autoreplied", "message.bounced", "contact.unsubscribed"]);

export function conversations(entries) {
  const sendings = new Map();
  for (const entry of entries) if (entry.type === "message.sending") sendings.set(entry.seq, entry);
  const labels = currentLabels(entries);
  const threads = new Map();
  const thread = (sender, contact) => {
    const key = `${sender}|${contact}`;
    if (!threads.has(key)) threads.set(key, { key, sender, contact, campaignId: null, subject: "", threadId: null, messages: [], inbound: 0, label: null, lastAt: null });
    return threads.get(key);
  };
  for (const entry of entries) {
    if (entry.type === "message.sent") {
      const sending = sendings.get(entry.data?.sendingSeq);
      if (!sending) continue;
      const row = thread(entry.data.from, entry.contact);
      row.campaignId = entry.data.campaignId ?? row.campaignId;
      row.subject = row.subject || sending.data.subject;
      row.threadId = entry.data.threadId || row.threadId;
      row.messages.push({ direction: "out", kind: "sent", at: entry.at, subject: sending.data.subject, text: sending.data.text, messageId: sending.data.headers?.["Message-ID"] || null, step: entry.data.step ?? null });
    } else if (INBOUND.has(entry.type) && entry.data?.sender) {
      const row = thread(entry.data.sender, entry.contact);
      row.inbound += 1;
      row.threadId = entry.data.threadId || row.threadId;
      const label = entry.data.gmailId ? labels.get(entry.data.gmailId) : null;
      if (entry.type === "message.replied" && label) row.label = label.label;
      row.messages.push({
        direction: "in", kind: entry.type.split(".")[1], at: entry.at, subject: entry.data.subject || null,
        text: entry.data.text || null, code: entry.data.code || null, gmailId: entry.data.gmailId || null,
        messageId: entry.data.messageId || null, label: label?.label || null, labelBy: label?.by || null
      });
    }
  }
  for (const row of threads.values()) row.lastAt = row.messages.at(-1)?.at || null;
  return [...threads.values()].filter((row) => row.inbound > 0).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

export class ReplyError extends Error {
  constructor(message, { code, status = 400 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * The quick reply as a finished letter: from the conversation's own sender,
 * "Re:" its subject, answering its newest letter, text cleaned like a
 * template. `sender` carries the signature (name, title, …).
 */
export function quickReply(conversation, text, sender, { date = new Date(), lead = {} } = {}) {
  const body = cleanText(text).text;
  if (!body) throw new ReplyError("Відповідь порожня.", { code: "empty_reply" });
  const ids = conversation.messages.map((message) => message.messageId).filter(Boolean);
  if (!ids.length) throw new ReplyError("У розмові немає листа, на який відповідати в треді.", { code: "no_thread" });
  const messageId = messageIdFor(conversation.sender);
  const raw = buildLetter({
    from: { email: conversation.sender, name: sender.name },
    to: { email: conversation.contact, name: lead.name || "" },
    subject: replySubject(conversation.subject || ""),
    body,
    signature: signatureText(sender, { country: lead.country }),
    date,
    messageId,
    headers: { "In-Reply-To": ids.at(-1), References: [...new Set(ids)].join(" ") }
  });
  return { raw, messageId, subject: replySubject(conversation.subject || ""), text: `${body}\n\n${signatureText(sender, { country: lead.country })}`, threadId: conversation.threadId };
}
