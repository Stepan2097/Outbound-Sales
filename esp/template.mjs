// ESP 2 — a template: subject and body as plain text, with variables.
//
// Checklist (P0): «Очищення шаблону при збереженні — знімати HTML-теги,
// стилі, нерозривні пробіли, невидимі символи. Шаблон із тегами не
// зберігається.» and «Порожня змінна блокує лист — "Hi ," не відправляється:
// або нейтральна заміна, або лід пропускається з причиною.»
//
// Our lesson: text pasted from Google Docs carried its formatting along and
// the letter became HTML. So the cleaning happens when a template is *saved*,
// not when it is sent: what is stored is already the text that will go out,
// and the screen says what was taken out of it.
//
// Variables are `{{first_name}}`, or `{{first_name|there}}` with a neutral
// stand-in after the bar for when the lead has no value. A variable that is
// empty and has no stand-in does not render: the lead is skipped, with the
// variable named as the reason.

export const TEMPLATE_VARIABLES = {
  first_name: "Ім'я",
  last_name: "Прізвище",
  full_name: "Повне ім'я",
  company: "Компанія",
  position: "Посада",
  country: "Країна",
  sender_name: "Ім'я відправника"
};

export class TemplateError extends Error {
  constructor(message, { code, detail = null } = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

// Spaces that look like spaces and are not: NBSP, narrow NBSP, figure space,
// the thin and hair spaces Docs and Word leave behind.
const ODD_SPACES = /[    -  　]/g;
// Characters that show nothing and still travel: zero-width space/joiners,
// word joiner, BOM, soft hyphen, the bidi controls.
const INVISIBLE = /[​-‍⁠﻿­‪-‮⁦-⁩᠎]/g;
const TAG = /<\/?[a-z!][^>]*>/i;

/**
 * One field of a template, as the text that will go out, and what had to be
 * taken out of it to get there.
 */
export function cleanText(input, { singleLine = false } = {}) {
  let text = String(input ?? "");
  const removed = new Set();

  if (/<(style|script)\b[\s\S]*?<\/\1>/i.test(text)) removed.add("styles");
  text = text.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "");
  if (/\sstyle\s*=/i.test(text)) removed.add("styles");
  if (TAG.test(text)) removed.add("html");
  // Where a tag meant a line break, the text keeps the break.
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    // A paragraph ends with a blank line, as it would in a letter; a div (one
    // line in Gmail's own editor) or a list item with a line break.
    .replace(/<\/(p|h[1-6])>/gi, "\n\n")
    .replace(/<\/(div|li|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  text = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name) => {
    removed.add(name.toLowerCase() === "nbsp" ? "nbsp" : "entities");
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
  if (ODD_SPACES.test(text)) removed.add("nbsp");
  text = text.replace(ODD_SPACES, " ");
  if (INVISIBLE.test(text)) removed.add("invisible");
  text = text.replace(INVISIBLE, "");
  // Tabs and other control characters have no business in a letter.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) removed.add("invisible");
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  text = text.replace(/\t/g, " ").replace(/\r\n?/g, "\n");

  if (singleLine) {
    text = text.replace(/\s*\n\s*/g, " ").replace(/ {2,}/g, " ").trim();
  } else {
    text = text.split("\n").map((line) => line.replace(/ +$/g, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  return { text, removed: [...removed] };
}

const VARIABLE = /\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/g;

function variablesIn(text) {
  return [...String(text).matchAll(VARIABLE)].map((match) => ({ name: match[1], fallback: match[2] === undefined ? null : match[2].trim() }));
}

/**
 * What a template is allowed to be when it is stored: cleaned, with no tag
 * left, with known variables only, and with something to say.
 */
export function prepareTemplate({ name, subject, body }) {
  const cleanedName = cleanText(name, { singleLine: true }).text;
  const cleanedSubject = cleanText(subject, { singleLine: true });
  const cleanedBody = cleanText(body);
  if (!cleanedSubject.text) throw new TemplateError("Тема порожня.", { code: "empty_subject" });
  if (!cleanedBody.text) throw new TemplateError("Текст листа порожній.", { code: "empty_body" });
  // Belt and braces: whatever the cleaning missed is refused, not stored.
  if (TAG.test(cleanedSubject.text) || TAG.test(cleanedBody.text)) {
    throw new TemplateError("У шаблоні лишилися HTML-теги — такий не зберігається.", { code: "html_left" });
  }
  const unknown = [...new Set([...variablesIn(cleanedSubject.text), ...variablesIn(cleanedBody.text)]
    .map((variable) => variable.name).filter((variable) => !(variable in TEMPLATE_VARIABLES)))];
  if (unknown.length) {
    throw new TemplateError(`Невідомі змінні: ${unknown.map((variable) => `{{${variable}}}`).join(", ")}. Доступні: ${Object.keys(TEMPLATE_VARIABLES).join(", ")}.`, { code: "unknown_variable", detail: unknown });
  }
  // A stray brace pair that is not a variable would go out as is.
  const leftover = (cleanedSubject.text + cleanedBody.text).replace(VARIABLE, "");
  if (/\{\{|\}\}/.test(leftover)) {
    throw new TemplateError("Незакрита або зіпсована змінна: перевір {{ … }}.", { code: "broken_variable" });
  }
  return {
    name: cleanedName || cleanedSubject.text.slice(0, 60),
    subject: cleanedSubject.text,
    body: cleanedBody.text,
    removed: [...new Set([...cleanedSubject.removed, ...cleanedBody.removed])]
  };
}

/** The lead's values for the variables, from whatever the CRM calls them. */
export function leadValues(lead = {}, sender = {}) {
  const first = String(lead.firstName ?? lead.first_name ?? "").trim();
  const last = String(lead.lastName ?? lead.last_name ?? "").trim();
  const full = String(lead.fullName ?? lead.full_name ?? lead.name ?? "").trim() || [first, last].filter(Boolean).join(" ");
  return {
    first_name: first || (full ? full.split(/\s+/)[0] : ""),
    last_name: last,
    full_name: full,
    company: String(lead.company ?? "").trim(),
    position: String(lead.position ?? "").trim(),
    country: String(lead.country ?? "").trim(),
    sender_name: String(sender.name ?? "").trim()
  };
}

/**
 * The template with this lead's values in it, or why it cannot be sent to
 * them. Never a half-filled letter.
 */
export function renderTemplate(template, lead, sender = {}) {
  const values = leadValues(lead, sender);
  const missing = new Set();
  const fill = (text) => String(text).replace(VARIABLE, (_whole, name, fallback) => {
    const value = values[name] ?? "";
    if (value) return value;
    if (fallback !== undefined && fallback.trim()) return fallback.trim();
    missing.add(name);
    return "";
  });
  const subject = fill(template.subject);
  const body = fill(template.body);
  if (missing.size) {
    return {
      ok: false,
      reason: "empty_variable",
      variables: [...missing],
      message: `Пропущено: у ліда порожнє ${[...missing].map((name) => `{{${name}}}`).join(", ")}, а нейтральної заміни в шаблоні немає.`
    };
  }
  return { ok: true, subject, body };
}
