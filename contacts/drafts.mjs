/**
 * Three drafts for one contact: an email, a Telegram message, and LinkedIn.
 *
 * The rules below are not style preferences — they are the workspace's own
 * outbound playbook, the same document the knowledge library feeds the model:
 * a subject a colleague could have written, a first line that carries the
 * reason, one ask, no links in a first touch, and an invitation note that does
 * not pitch. They live here so the prompt and the no-AI fallback cannot drift
 * apart, and so they can be argued with in one place.
 */

export const DRAFT_CHANNELS = ["email", "telegram", "linkedin"];

export const LANGUAGES = {
  uk: { label: "Українською", instruction: "Write every draft in Ukrainian." },
  en: { label: "English", instruction: "Write every draft in English." },
  ru: { label: "Русский", instruction: "Write every draft in Russian." }
};

export function normalizeLanguage(value) {
  const clean = String(value || "").trim().toLowerCase();
  return LANGUAGES[clean] ? clean : "en";
}

/**
 * What each channel allows, in one place.
 *
 * Exported because the Панель writes the same three channels through a
 * different prompt: two writers with two private ideas of "how long is a
 * LinkedIn invitation" is how the same workspace ends up sending a 400-character
 * note from one screen and a 260-character one from the next.
 */
export const CHANNEL_RULES = {
  email: [
    "Subject: 2-5 specific words, lowercase, no punctuation tricks, something a colleague could have written.",
    "Body under 90 words, four sentences: the reason this person now, a hedged problem guess, one proof with a real number, one easy question.",
    "No links, no attachments, no bullet points, no signature block."
  ],
  telegram: [
    "Under 60 words, plain text, no links, no formatting.",
    "It reads like one professional messaging another, not like a broadcast.",
    "Ends with one question that can be answered from a phone in ten seconds."
  ],
  linkedin: [
    "invite: under 300 characters, a reason to connect and nothing that sells. No question, no meeting, no pitch.",
    "body: the first message after the invitation is accepted, 40-90 words, one question at the end.",
    "Both mention something true about this person or company, or say plainly that it is a guess."
  ]
};

/** Only what the CRM actually knows, so nothing empty reaches the model. */
export function contactForPrompt(contact = {}) {
  const fields = {
    name: contact.name,
    company: contact.company,
    position: contact.position,
    country: contact.country,
    category: contact.category,
    website: contact.website,
    linkedin: contact.linkedin,
    telegram: contact.telegram,
    email: contact.email,
    leadStatus: contact.lead_status,
    lifecycleStage: contact.lifecycle_stage,
    notes: contact.description
  };
  return Object.fromEntries(
    Object.entries(fields)
      .map(([key, value]) => [key, typeof value === "string" ? value.trim() : value])
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
  );
}

/**
 * What the model is asked. Sources in, format out, inference forbidden: the
 * contact record and the product are the only facts, and a guess has to be
 * written as a guess rather than as something we know about their company.
 */
export function draftsPromptPayload({ contact, product, language, instruction = "" }) {
  return {
    instruction: [
      "Write three first-touch drafts for this one contact: an email, a Telegram message, and LinkedIn (an invitation note plus the first message after it is accepted).",
      "Use only the contact record and the product below. Never invent a company fact, a metric, a mutual connection, a recent event, or anything the sources do not state.",
      "A guess is allowed when it is written as a guess — 'usually', 'from the outside', 'if I am reading this right' — and it must be specific enough to be wrong.",
      "No compliments, no 'I hope this finds you well', no three-adjective lists, no landscape sentences about the industry, no 'quick call'.",
      "One ask per draft, and it is a question, not a meeting.",
      LANGUAGES[normalizeLanguage(language)].instruction,
      instruction ? `Extra instruction from the seller: ${instruction}` : ""
    ].filter(Boolean).join(" "),
    channelRules: CHANNEL_RULES,
    requiredJsonShape: {
      email: { subject: "string", body: "string" },
      telegram: { body: "string" },
      linkedin: { invite: "string", body: "string" },
      // What the drafts lean on, and what a human should check before sending.
      grounding: ["the exact fact from the contact record or the product each draft used"],
      verifyBeforeSending: ["anything written as a guess that a human should confirm"]
    },
    contact: contactForPrompt(contact),
    product
  };
}

function firstLine(value = "") {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
}

function trimWordsTo(value, limit) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  return words.length <= limit ? words.join(" ") : `${words.slice(0, limit).join(" ")}…`;
}

/**
 * The drafts written without a model.
 *
 * They are deliberately plain: a reason, one guess marked as a guess, and a
 * question. This is what the page shows when OpenRouter is off, and it is
 * better to hand somebody four honest sentences they will edit than a polished
 * paragraph nobody stands behind.
 */
export function buildFallbackDrafts({ contact = {}, product = {}, language = "en" } = {}) {
  const code = normalizeLanguage(language);
  const person = firstLine(contact.name || "").split(/\s+/)[0] || "";
  const company = contact.company || "";
  const role = contact.position || "";
  const brief = product.brief || {};
  const offer = firstLine(brief.offer) || product.positioning || "";
  const pain = firstLine(brief.pain) || (product.useCases || [])[0] || "";
  const proof = firstLine(brief.proof) || (product.proofPoints || [])[0] || "";
  const step = firstLine(brief.firstStep) || "";

  const strings = {
    uk: {
      subject: company ? `${company.toLowerCase()} — коротке питання` : "коротке питання",
      hello: person ? `${person}, ` : "",
      reason: company ? `пишу через ${company}${role ? ` і вашу роль (${role})` : ""}.` : "пишу напряму, без розсилки.",
      guess: pain ? `Ззовні це зазвичай виглядає так: ${pain.toLowerCase()}.` : "",
      proof: proof ? `У нас із цим так: ${proof}` : offer ? `Що ми робимо: ${offer}` : "",
      ask: step ? `Перший крок маленький: ${step.toLowerCase()}. Це зараз актуально чи ні?` : "Це зараз актуально чи ні?",
      invite: company ? `${person ? `${person}, ` : ""}працюю з темою, близькою до ${company}. Без пропозицій — просто хочу бути на зв'язку.` : "Хочу бути на зв'язку — працюю в суміжній темі.",
      note: "Чернетка без AI: зібрана з брифу продукту, перечитай перед відправкою."
    },
    ru: {
      subject: company ? `${company.toLowerCase()} — короткий вопрос` : "короткий вопрос",
      hello: person ? `${person}, ` : "",
      reason: company ? `пишу из-за ${company}${role ? ` и вашей роли (${role})` : ""}.` : "пишу напрямую, не рассылкой.",
      guess: pain ? `Со стороны это обычно выглядит так: ${pain.toLowerCase()}.` : "",
      proof: proof ? `У нас с этим так: ${proof}` : offer ? `Что мы делаем: ${offer}` : "",
      ask: step ? `Первый шаг небольшой: ${step.toLowerCase()}. Это сейчас актуально или нет?` : "Это сейчас актуально или нет?",
      invite: company ? `${person ? `${person}, ` : ""}работаю с темой, близкой к ${company}. Без предложений — просто хочу быть на связи.` : "Хочу быть на связи — работаю в смежной теме.",
      note: "Черновик без AI: собран из брифа продукта, перечитай перед отправкой."
    },
    en: {
      subject: company ? `${company.toLowerCase()} — one question` : "one question",
      hello: person ? `${person}, ` : "",
      reason: company ? `I am writing about ${company}${role ? ` and your role (${role})` : ""}.` : "I am writing directly, not from a list.",
      guess: pain ? `From the outside this usually looks like: ${pain.toLowerCase()}.` : "",
      proof: proof ? `On our side: ${proof}` : offer ? `What we do: ${offer}` : "",
      ask: step ? `The first step is small: ${step.toLowerCase()}. Is that live right now, or not?` : "Is that live right now, or not?",
      invite: company ? `${person ? `${person}, ` : ""}I work on something close to what ${company} does. No pitch — happy to just be connected.` : "Happy to be connected — I work in an adjacent area.",
      note: "Draft without AI: assembled from the product brief. Read it before sending."
    }
  }[code];

  const emailBody = [
    `${strings.hello}${strings.reason}`,
    strings.guess,
    strings.proof,
    strings.ask
  ].filter(Boolean).join("\n\n");

  return {
    email: { subject: strings.subject, body: emailBody },
    telegram: { body: trimWordsTo([`${strings.hello}${strings.reason}`, strings.guess, strings.ask].filter(Boolean).join(" "), 60) },
    linkedin: {
      invite: String(strings.invite).slice(0, 300),
      body: trimWordsTo([`${strings.hello}${strings.reason}`, strings.guess, strings.proof, strings.ask].filter(Boolean).join(" "), 90)
    },
    grounding: [company ? `Компанія з картки CRM: ${company}` : "", role ? `Посада з картки CRM: ${role}` : "", offer ? `Оферта з брифу продукту` : ""].filter(Boolean),
    verifyBeforeSending: [strings.note]
  };
}

function cleanDraftText(value, limit = 4000) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, limit);
}

function stringList(value, limit = 6) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanDraftText(item, 300)).filter(Boolean).slice(0, limit);
}

/**
 * The model's answer, made safe to show: every field a string, the invitation
 * cut to the 300 characters LinkedIn actually allows, and anything missing
 * filled from the fallback rather than rendered as an empty card.
 */
export function normalizeDrafts(data, fallback) {
  const source = data && typeof data === "object" ? data : {};
  const email = source.email && typeof source.email === "object" ? source.email : {};
  const telegram = source.telegram && typeof source.telegram === "object" ? source.telegram : {};
  const linkedin = source.linkedin && typeof source.linkedin === "object" ? source.linkedin : {};
  return {
    email: {
      subject: cleanDraftText(email.subject, 160) || fallback.email.subject,
      body: cleanDraftText(email.body) || fallback.email.body
    },
    telegram: { body: cleanDraftText(telegram.body) || fallback.telegram.body },
    linkedin: {
      invite: cleanDraftText(linkedin.invite || linkedin.note, 300) || fallback.linkedin.invite,
      body: cleanDraftText(linkedin.body || linkedin.message) || fallback.linkedin.body
    },
    grounding: stringList(source.grounding).length ? stringList(source.grounding) : fallback.grounding,
    // Like grounding above: a model that answers without this list leaves a
    // seller with an empty «перевір перед відправкою» block, which reads as
    // "nothing to check" rather than "the model said nothing". The stand-in is
    // its own sentence rather than the fallback's, because the fallback's line
    // says the draft was written without a model — and this one was not.
    verifyBeforeSending: stringList(source.verifyBeforeSending).length
      ? stringList(source.verifyBeforeSending)
      : ["Модель не назвала, що перевірити — перечитай сам перед відправкою."]
  };
}
