// ESP 3 — follow-ups in the same thread.
//
// Checklist (P0): «Фолоуапи в тому самому треді — той самий сендер,
// In-Reply-To і References, "Re:" лише як справжня відповідь у треді.»
//
// So: a first letter never starts with "Re:" or "Fwd:" (a fake reply is a
// spam signal and a lie); a follow-up comes from the mailbox that sent the
// letter before it, answers that letter's Message-ID, carries the whole chain
// in References, keeps Gmail's threadId, and its subject is "Re: " and the
// first letter's subject — whatever the follow-up template's subject says.

import { LetterError } from "./letter.mjs";

const REPLY_PREFIX = /^\s*((re|fw|fwd|aw|wg|sv|tr|rv|відп|отв|пер)\s*(\[\d+\])?\s*:\s*)+/i;

/** The subject of a first letter, refused if it pretends to be a reply. */
export function firstSubject(subject) {
  const text = String(subject ?? "").trim();
  if (REPLY_PREFIX.test(text)) {
    throw new LetterError("Перший лист не може починатися з «Re:» чи «Fwd:» — це ще не відповідь.", { code: "fake_reply" });
  }
  return text;
}

export function replySubject(subject) {
  return `Re: ${String(subject ?? "").replace(REPLY_PREFIX, "").trim()}`;
}

/**
 * What a follow-up needs from the letter before it: `previous` is that letter
 * as sent — { sender, subject, messageId, references, threadId }.
 */
export function followUpOf(previous, mailbox) {
  if (!previous?.messageId) throw new LetterError("Фолоуап без попереднього листа: немає Message-ID, на який відповідати.", { code: "no_previous" });
  if (String(previous.sender).toLowerCase() !== String(mailbox).toLowerCase()) {
    throw new LetterError(`Фолоуап має йти з тієї самої скриньки (${previous.sender}), а не з ${mailbox}.`, { code: "other_sender" });
  }
  const chain = [...(Array.isArray(previous.references) ? previous.references : String(previous.references || "").split(/\s+/)), previous.messageId]
    .filter(Boolean);
  const references = [...new Set(chain)];
  return {
    subject: replySubject(previous.subject),
    threadId: previous.threadId || null,
    references,
    headers: { "In-Reply-To": previous.messageId, References: references.join(" ") }
  };
}
