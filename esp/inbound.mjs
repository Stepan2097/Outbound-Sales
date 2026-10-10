// ESP 7 — what came into a sending mailbox, and what it means for the chain.
//
// Checklist (P0):
// - «Читання вхідних кожної скриньки — Gmail API (history або push). Відповідь
//   у треді → ланцюжок ліда зупиняється.»
// - «"У відпустці" і автовідповіді — розпізнавати (Auto-Submitted, типові теми
//   й тексти) → переносити крок, а не зупиняти і не рахувати як відповідь.»
// - «Розбір bounce з кодами — листи від mailer-daemon: 5.1.1 → у виключення;
//   5.7.x → тривога по сендеру; 4.x.x — рахувати окремо.»
// - «Відписка того ж дня — one-click, mailto і відповіді "ні", "unsubscribe",
//   "remove" → глобальні виключення автоматично.»
//
// One message is classified in that order — a bounce, an auto-reply, an
// unsubscribe, a reply — and tied to the letter it answers by Gmail's thread,
// by In-Reply-To/References against our own Message-IDs, or by the address it
// comes from. Mail that answers nothing we sent is left alone: the mailbox is
// a person's, and not everything in it is ours to journal.
//
// What it writes goes through the journal (ESP 9): `message.bounced`,
// `message.autoreplied`, `contact.unsubscribed`, `message.replied`, and
// `sender.alert` for a 5.7.x. The sequence (ESP 5) reads the stoppers from
// there; the exclusions (ESP 6) read the unsubscribes and the 5.1.1s.

import { deliveryReport, header, parseMessage, plainText } from "./mime.mjs";

const AUTO_SUBJECT = /(?<!\p{L})(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|auto:|away from (the )?office|on vacation|on holiday|abwesenheit|automatische antwort|fuera de la oficina|respuesta autom[aá]tica|ausente|resposta autom[aá]tica|aus[eê]ncia|r[ée]ponse automatique|absence|absent|niedost[eę]pno[sś][cć]|automatyczna odpowied[zź]|відсутн|автоматична відповідь|автоответ|отсутств)/iu;
const AUTO_TEXT = /\b(i am|i'm) (currently )?(out of (the )?office|on (annual )?leave|away|on vacation|travelling|traveling)\b|limited access to (my )?e-?mail|will (be back|return) on|i will respond (to your (e-?mail|message) )?(upon|when i) return|ich bin (bis|ab)|estoy fuera|я у відпустці|я в отпуске|nie ma mnie w biurze/i;
const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery (subsystem|system)|delivery status notification/i;
const BOUNCE_SUBJECT = /delivery status notification|undeliver(able|ed)|returned mail|failure notice|mail delivery failed|delivery (has )?failed|non[- ]?delivery|message not delivered|nicht zustellbar|no entregado/i;
// The whole of a short reply that means "leave me alone".
// No \b: JavaScript's word boundary does not see Cyrillic letters as letters.
const UNSUB_SHORT = /^(unsubscribe|remove( me)?|stop|no|nope|no thanks?|not interested|ні|нi|не цікаво|не потрібно|нет|не интересно|nein|no gracias|não|nie)(?!\p{L})[\s.!,]*$/iu;
const UNSUB_ANY = /(?<!\p{L})(unsubscribe|remove me|take me off|opt[- ]?out|stop (emailing|sending|writing)|відпиш(іть|и)|видаліть мене|отпиш(ите|и)|удалите меня)(?!\p{L})/iu;

export function addressOf(value) {
  const match = String(value || "").match(/<([^<>\s]+@[^<>\s]+)>/) || String(value || "").match(/([^\s<>"]+@[^\s<>"]+)/);
  return match ? match[1].toLowerCase().replace(/[.,;:]+$/, "") : "";
}

/** The part of a reply that is new: everything above the quoted letter. */
export function freshText(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const kept = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*(on .{3,120} wrote:|.{3,120} (пише|написав|написала|написал|schrieb|escribió|a écrit|napisał\(a\)|escreveu):)\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*(original message|forwarded message|оригінальне повідомлення|исходное сообщение)/i.test(line)) break;
    if (/^\s*(from|від|от|von|de):\s.+@/i.test(line) && kept.length) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** The date an auto-reply says its person is back, if it says one (YYYY-MM-DD). */
export function returnDate(text, now = new Date()) {
  const source = String(text || "");
  const asDate = (year, month, day) => {
    const date = new Date(Date.UTC(year, month, day, 12));
    return Number.isNaN(date.getTime()) || date.getUTCMonth() !== month ? null : date;
  };
  const candidates = [];
  for (const match of source.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) candidates.push(asDate(+match[1], +match[2] - 1, +match[3]));
  for (const match of source.matchAll(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/g)) {
    const year = match[3] ? (match[3].length === 2 ? 2000 + +match[3] : +match[3]) : now.getUTCFullYear();
    candidates.push(asDate(year, +match[2] - 1, +match[1]));
  }
  for (const match of source.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/gi)) {
    candidates.push(asDate(match[3] ? +match[3] : now.getUTCFullYear(), MONTHS[match[1].toLowerCase()], +match[2]));
  }
  const today = now.getTime() - 86_400_000;
  const future = candidates.filter((date) => date && date.getTime() >= today && date.getTime() <= now.getTime() + 120 * 86_400_000);
  if (!future.length) return null;
  return new Date(Math.max(...future.map((date) => date.getTime()))).toISOString().slice(0, 10);
}

/**
 * What one incoming message is. `kind`: bounce, autoreply, unsubscribe, reply,
 * or own (something the mailbox itself sent).
 */
export function classifyInbound(raw, { mailbox, now = new Date() } = {}) {
  const message = parseMessage(raw);
  const from = addressOf(header(message.headers, "from"));
  const subject = header(message.headers, "subject");
  const text = plainText(message);
  const base = {
    from, subject,
    inReplyTo: header(message.headers, "in-reply-to"),
    references: String(header(message.headers, "references")).split(/\s+/).filter(Boolean)
  };
  if (from && from === String(mailbox).toLowerCase()) return { ...base, kind: "own" };

  const reportType = /multipart\/report/i.test(message.contentType) && /delivery-status/i.test(message.contentType);
  if (reportType || BOUNCE_FROM.test(header(message.headers, "from")) || (BOUNCE_SUBJECT.test(subject) && /daemon|postmaster|mail/i.test(from))) {
    const report = deliveryReport(message);
    // A report without a code is read by its words: "delayed" is temporary,
    // anything else that calls itself a failure is permanent.
    const code = report.code || (/delay|will (keep|retry)|not yet been delivered/i.test(text + subject) ? "4.0.0" : "5.0.0");
    return { ...base, kind: "bounce", code, recipient: report.recipient, originalMessageId: report.originalMessageId };
  }

  const auto = String(header(message.headers, "auto-submitted")).toLowerCase();
  const precedence = String(header(message.headers, "precedence")).toLowerCase();
  if ((auto && auto !== "no") || header(message.headers, "x-autoreply") || header(message.headers, "x-autorespond")
    || /^(auto_reply|bulk|junk)$/.test(precedence) || AUTO_SUBJECT.test(subject) || AUTO_TEXT.test(text.slice(0, 600))) {
    return { ...base, kind: "autoreply", returnDate: returnDate(text, now) };
  }

  const fresh = freshText(text);
  // The mailto in List-Unsubscribe sends exactly this subject (ESP 3).
  if (/^\s*unsubscribe\s*$/i.test(subject) || UNSUB_SHORT.test(fresh.split("\n")[0]?.trim() || "") && fresh.length <= 60 || UNSUB_ANY.test(fresh)) {
    return { ...base, kind: "unsubscribe", via: /^\s*unsubscribe\s*$/i.test(subject) ? "mailto" : "reply", text: fresh.slice(0, 2000) };
  }
  return { ...base, kind: "reply", text: fresh.slice(0, 5000), rawText: text.slice(0, 20000) };
}

/** Our letters from this mailbox, by Gmail thread, by our Message-ID and by recipient. */
export function sentIndex(entries, mailbox) {
  const key = String(mailbox).toLowerCase();
  const sendings = new Map();
  for (const entry of entries) if (entry.type === "message.sending" && entry.data?.from === key) sendings.set(entry.seq, entry);
  const byThread = new Map();
  const byMessageId = new Map();
  const byContact = new Map();
  for (const entry of entries) {
    if (entry.type !== "message.sent" || entry.data?.from !== key) continue;
    const sending = sendings.get(entry.data.sendingSeq);
    const letter = { contact: entry.contact, campaignId: entry.data.campaignId ?? null, step: entry.data.step ?? null, threadId: entry.data.threadId || null, at: entry.at };
    if (letter.threadId) byThread.set(letter.threadId, letter);
    const ours = sending?.data?.headers?.["Message-ID"];
    if (ours) byMessageId.set(ours, letter);
    byContact.set(entry.contact, letter);
  }
  return { byThread, byMessageId, byContact };
}

function letterFor(index, { threadId, classified }) {
  if (threadId && index.byThread.has(threadId)) return index.byThread.get(threadId);
  for (const id of [classified.inReplyTo, classified.originalMessageId, ...(classified.references || [])].filter(Boolean)) {
    if (index.byMessageId.has(id)) return index.byMessageId.get(id);
  }
  const who = classified.kind === "bounce" ? classified.recipient : classified.from;
  return who ? index.byContact.get(who) || null : null;
}

/**
 * Journal one message, once. `gmailId` is the dedupe key: a message already in
 * the journal (by that id) is skipped, so a restart re-reading the inbox
 * writes nothing twice. Returns what was done.
 */
export async function processInbound({ mailbox, message, entries, index, record, append, postpone, now = new Date() }) {
  if (entries.some((entry) => entry.data?.gmailId === message.id)) return { action: "seen" };
  const classified = classifyInbound(message.raw, { mailbox, now });
  if (classified.kind === "own") return { action: "own" };
  const letter = letterFor(index, { threadId: message.threadId, classified });
  if (!letter) return { action: "not_ours", kind: classified.kind };
  const common = { sender: mailbox, campaignId: letter.campaignId, step: letter.step, gmailId: message.id, threadId: message.threadId || null };

  if (classified.kind === "bounce") {
    await record("message.bounced", letter.contact, { ...common, code: classified.code });
    // 5.7.x is the receiving side refusing by policy — about the sender, not
    // the address. Raised for the alerts and the auto-pauses (ESP 8).
    if (/^5\.7\./.test(classified.code)) {
      await append({ type: "sender.alert", actor: "esp-inbox", data: { email: mailbox, code: classified.code, reason: "policy_bounce", contact: letter.contact } });
    }
    return { action: "bounce", code: classified.code, contact: letter.contact };
  }
  if (classified.kind === "autoreply") {
    await record("message.autoreplied", letter.contact, { ...common, returnDate: classified.returnDate, subject: classified.subject.slice(0, 300) });
    if (letter.campaignId) await postpone({ campaignId: letter.campaignId, email: letter.contact, until: classified.returnDate });
    return { action: "autoreply", contact: letter.contact, returnDate: classified.returnDate };
  }
  if (classified.kind === "unsubscribe") {
    await record("contact.unsubscribed", letter.contact, { ...common, via: classified.via, text: classified.text });
    return { action: "unsubscribe", contact: letter.contact };
  }
  await record("message.replied", letter.contact, { ...common, subject: classified.subject.slice(0, 300), text: classified.text, rawText: classified.rawText });
  return { action: "reply", contact: letter.contact };
}

/**
 * One pass over the sending mailboxes: what arrived since each one's cursor.
 * `cursors` — { read(mailbox), write(mailbox, cursor) }. A mailbox Google
 * refuses is skipped here; the gate's pause (ESP 1) and the alerts (ESP 8)
 * deal with it.
 */
export async function pollInboxes({ connector, mailboxes, cursors, journal, postpone, now = new Date() }) {
  const summary = { checked: 0, actions: {}, errors: [] };
  for (const mailbox of mailboxes) {
    try {
      const { messages, cursor } = await connector.inboxSince(mailbox, cursors.read(mailbox));
      const entries = [...await journal.allEntries()];
      const index = sentIndex(entries, mailbox);
      for (const message of messages) {
        const result = await processInbound({ mailbox, message, entries, index, record: journal.recordAboutContact, append: journal.append, postpone, now });
        summary.actions[result.action] = (summary.actions[result.action] || 0) + 1;
        // Seen in this pass too: a message listed twice is journalled once.
        entries.push({ data: { gmailId: message.id } });
      }
      await cursors.write(mailbox, cursor);
      summary.checked += 1;
    } catch (error) {
      summary.errors.push({ mailbox, error: error.message });
    }
  }
  return summary;
}
