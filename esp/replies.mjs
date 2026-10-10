// ESP 14 — what a reply says: positive, negative, a referral, or neutral.
//
// Checklist (P1): «Класифікація відповідей — позитивна, негативна,
// переадресація, нейтральна. Зберігати сирий текст і мітку.» The raw text is
// already on `message.replied` (ESP 7); the label is stored next to it, at the
// moment the reply is journalled, and a person can correct it — the correction
// is its own journal entry (`reply.labelled`), never an edit of the first.
//
// Rules, not a model: the reply is short, the phrases are few, and a rule says
// why it decided. The order matters — "not the right person, talk to Maria"
// is a referral before it is a no; "not now, maybe next quarter" is neutral.

export const REPLY_LABELS = { positive: "позитивна", negative: "негативна", referral: "переадресація", neutral: "нейтральна" };

const REFERRAL = /(not the right person|wrong person|better (person|contact) (would be|is)|you (should|could|might want to) (talk|speak|reach out|contact|write) (to|with)|please (contact|reach out to|write to|talk to)|(i'?ve|i have) (forwarded|cc'?d|copied)|cc'?ing|looping in|reach out to my colleague|in charge of (this|that)|handles (this|that)|не (та|той) людин|зверніться до|напишіть (моєму|моїй|колезі)|переслав (вашого листа|колезі)|обратитесь к|напишите (моему|моей|коллеге)|wenden sie sich an|contacte con|entre em contato com|zwróć się do)/iu;
const NEGATIVE = /(not interested|no thanks?|no,? thank you|we('re| are) (all )?(set|good|covered)|already (have|work with|use)|don'?t (contact|email|write)|please (stop|remove)|unsubscribe|not (a )?(fit|relevant)|no need|не цікаво|не потрібно|не актуально|не пишіть|нам не треба|вже маємо|не интересно|не нужно|kein interesse|no me interesa|não tenho interesse|nie jestem zainteresowan)/iu;
const POSITIVE = /(interested|sounds (good|great|interesting)|let'?s (talk|chat|meet|connect|schedule|set up)|happy to (talk|chat|meet|connect)|(book|schedule|set up) a (call|meeting|time)|what (time|day) (works|suits)|(free|available) (on|at|next|this|tomorrow)|send (me )?(more|details|info|the deck|a proposal)|tell me more|(call|ring) me|my (calendar|number)|calendly|^yes\b|^sure\b|цікаво|давайте|можемо (поговорити|созвонитися|зідзвонитися)|коли (вам )?зручно|надішліть (деталі|більше|презентацію)|так,? (цікаво|давайте)|интересно|давайте (созвонимся|обсудим)|interessiert|me interesa|tenho interesse|chętnie)/iu;
const DEFERRAL = /(not (right )?now|maybe (later|next)|next (quarter|year|month)|after (the )?(holidays|summer)|come back|reach out (again )?(in|later)|пізніше|не зараз|наступного (місяця|кварталу|року)|позже|не сейчас)/iu;

/** `{ label, rule }` — the label and the phrase that decided it. */
export function classifyReply(text) {
  const fresh = String(text || "").trim();
  if (!fresh) return { label: "neutral", rule: "empty" };
  const first = fresh.slice(0, 800);
  const hit = (pattern) => (first.match(pattern) || [])[0] || null;
  let match;
  if ((match = hit(REFERRAL))) return { label: "referral", rule: match };
  // "Not now, maybe next quarter" is a timing answer, not a no.
  if ((match = hit(DEFERRAL)) && !hit(/not interested|не цікаво|не интересно/iu)) return { label: "neutral", rule: match };
  if ((match = hit(NEGATIVE))) return { label: "negative", rule: match };
  if ((match = hit(POSITIVE))) return { label: "positive", rule: match };
  return { label: "neutral", rule: "no rule matched" };
}

/** The label a reply has now: a person's correction if there is one, else the first. */
export function currentLabels(entries) {
  const labels = new Map();
  for (const entry of entries) {
    if (entry.type === "message.replied" && entry.data?.gmailId && entry.data?.label) labels.set(entry.data.gmailId, { label: entry.data.label, by: "rule", rule: entry.data.labelRule || null });
    if (entry.type === "reply.labelled" && entry.data?.gmailId) labels.set(entry.data.gmailId, { label: entry.data.label, by: entry.actor, at: entry.at });
  }
  return labels;
}
