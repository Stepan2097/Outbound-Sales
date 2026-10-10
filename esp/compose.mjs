// One letter of a sequence, from the template to the finished message — the
// only place ESP puts one together. ESP 2 gives the text and the signature,
// ESP 3 the unsubscribe headers and the thread; the sequence (ESP 5) asks this
// for each step and gets either a letter or the reason there is none.

import { LetterError, buildLetter, messageIdFor, signatureText } from "./letter.mjs";
import { TemplateError, renderTemplate } from "./template.mjs";
import { firstSubject, followUpOf } from "./thread.mjs";
import { unsubscribeHeaders } from "./unsubscribe.mjs";

/**
 * - `sender`: { email, name, title, company, site, usPostalAddress } — the
 *   mailbox and its signature.
 * - `lead`: { email, name, firstName, company, country, ... }.
 * - `previous`: the letter before this one as sent (null for the first) —
 *   { sender, subject, messageId, references, threadId }.
 * - `unsubscribe`: { secret, base } for the sender's domain.
 *
 * Returns `{ ok: true, raw, messageId, subject, text, threadId, references }`
 * or `{ ok: false, reason, message }`. Never throws for a lead that cannot be
 * written to — that is a skip with a reason, not a crash of the sequence.
 */
export function composeLetter({ template, sender, lead, previous = null, unsubscribe, campaignId = null, date = new Date() }) {
  try {
    const rendered = renderTemplate(template, lead, sender);
    if (!rendered.ok) return { ok: false, reason: rendered.reason, variables: rendered.variables, message: rendered.message };

    const thread = previous ? followUpOf(previous, sender.email) : null;
    // A follow-up's subject is the thread's, whatever its template says; a
    // first letter's is its own and may not pretend to be a reply.
    const subject = thread ? thread.subject : firstSubject(rendered.subject);
    const signature = signatureText(sender, { country: lead.country });
    const messageId = messageIdFor(sender.email);
    const raw = buildLetter({
      from: { email: sender.email, name: sender.name },
      to: { email: lead.email, name: lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(" ") },
      subject,
      body: rendered.body,
      signature,
      date,
      messageId,
      headers: {
        ...(thread ? thread.headers : {}),
        ...unsubscribeHeaders({ sender: sender.email, recipient: lead.email, campaignId, secret: unsubscribe?.secret, base: unsubscribe?.base })
      }
    });
    return {
      ok: true,
      raw,
      messageId,
      subject,
      text: [rendered.body, signature].join("\n\n"),
      threadId: thread?.threadId ?? null,
      references: thread ? thread.references : []
    };
  } catch (error) {
    if (error instanceof LetterError || error instanceof TemplateError) return { ok: false, reason: error.code, message: error.message };
    throw error;
  }
}
