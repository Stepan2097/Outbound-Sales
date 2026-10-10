// ESP 2 — the letter as it leaves: one text/plain part, a text signature, and
// nothing that tracks.
//
// Checklist (P0): «Лише text/plain — одна частина text/plain; charset=UTF-8,
// без text/html.» «Ніякого трекінгу — без пікселя відкриттів, без
// переписування посилань, без трекінг-домену.» «Підпис лише текстом — ім'я,
// посада, ADvantage, сайт. Для США — поштова адреса юрособи.»
//
// `buildLetter` is the only place a message is put together, and it has no way
// to make anything but one plain part: there is no HTML parameter to pass.
// `assertPlainLetter` reads a finished message back and refuses anything else
// — the sender gate runs it before every send, so a bug upstream stops at the
// gate instead of burning a domain.
//
// Links are written exactly as the template has them. Nothing here rewrites,
// wraps or redirects a URL, and no image or pixel exists to be added.

import { randomUUID } from "node:crypto";

export class LetterError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.code = code;
  }
}

const US = new Set(["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "сша", "америка"]);

export function isUnitedStates(country) {
  return US.has(String(country ?? "").trim().toLowerCase());
}

/**
 * The signature, as lines of text. The company's legal postal address goes
 * under it for a lead in the United States (CAN-SPAM); without one configured
 * such a letter is not built at all.
 */
export function signatureText({ name, title = "", company = "ADvantage", site = "", usPostalAddress = "" } = {}, { country = "" } = {}) {
  const lines = [name, title, company, site].map((line) => String(line ?? "").trim()).filter(Boolean);
  if (!String(name ?? "").trim()) throw new LetterError("У підписі немає імені відправника.", { code: "signature_name_missing" });
  if (isUnitedStates(country)) {
    const address = String(usPostalAddress ?? "").trim();
    if (!address) throw new LetterError("Лід зі США, а поштової адреси юрособи для підпису не задано.", { code: "us_address_missing" });
    lines.push(...address.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }
  return lines.join("\n");
}

// ── encoding ───────────────────────────────────────────────────────────────

/** RFC 2047: a header value that is not plain ASCII, as encoded words of at most 75 characters. */
export function encodeHeader(value) {
  const text = String(value ?? "");
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  const words = [];
  let chunk = "";
  for (const char of text) {
    // 45 bytes of UTF-8 base64-encode to 60 characters: with `=?UTF-8?B?` and
    // `?=` a word stays under 75, and no character is split between two words.
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

export function formatAddress({ email, name = "" }) {
  const address = String(email ?? "").trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw new LetterError(`Це не адреса: ${address || "(порожньо)"}.`, { code: "bad_address" });
  const display = String(name ?? "").replace(/[\r\n]/g, " ").trim();
  if (!display) return address;
  if (/^[\x20-\x7E]*$/.test(display)) return `"${display.replace(/(["\\])/g, "\\$1")}" <${address}>`;
  return `${encodeHeader(display)} <${address}>`;
}

/** Quoted-printable (RFC 2045), lines of at most 76 characters, CRLF between them. */
export function quotedPrintable(text) {
  return String(text).split("\n").map((line) => {
    const bytes = Buffer.from(line, "utf8");
    let encoded = "";
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      const last = index === bytes.length - 1;
      const plain = (byte >= 33 && byte <= 126 && byte !== 61) || (byte === 32 && !last);
      encoded += plain ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    const wrapped = [];
    while (encoded.length > 76) {
      let cut = 75;
      // Never split an `=XX` escape across a soft break.
      if (encoded[cut - 1] === "=") cut -= 1;
      else if (encoded[cut - 2] === "=") cut -= 2;
      wrapped.push(`${encoded.slice(0, cut)}=`);
      encoded = encoded.slice(cut);
    }
    wrapped.push(encoded);
    return wrapped.join("\r\n");
  }).join("\r\n");
}

function decodeQuotedPrintable(text) {
  const bytes = [];
  const source = String(text).replace(/=\r?\n/g, "");
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "=" && /^[0-9A-F]{2}$/i.test(source.slice(index + 1, index + 3))) {
      bytes.push(parseInt(source.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(source[index], "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function rfc5322Date(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (number) => String(number).padStart(2, "0");
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

export function messageIdFor(fromEmail) {
  const domain = String(fromEmail).split("@")[1] || "localhost";
  return `<${randomUUID()}@${domain}>`;
}

// ── the letter ─────────────────────────────────────────────────────────────

/**
 * One finished message: headers, a blank line, the body and the signature in
 * one text/plain part. `headers` carries what ESP 3 adds (List-Unsubscribe,
 * In-Reply-To, References); none of them may change the content type.
 */
export function buildLetter({ from, to, subject, body, signature = "", date = new Date(), messageId = null, headers = {} }) {
  const cleanSubject = String(subject ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!cleanSubject) throw new LetterError("Лист без теми не збирається.", { code: "empty_subject" });
  const text = [String(body ?? "").replace(/\r\n?/g, "\n").trimEnd(), String(signature ?? "").trim()].filter(Boolean).join("\n\n");
  if (!text.trim()) throw new LetterError("Лист без тексту не збирається.", { code: "empty_body" });

  const extra = Object.entries(headers).filter(([, value]) => value !== null && value !== undefined && value !== "");
  for (const [name] of extra) {
    if (/^(content-|mime-version$|from$|to$|subject$|date$|message-id$)/i.test(name) || !/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
      throw new LetterError(`Заголовок ${name} тут задавати не можна.`, { code: "bad_header" });
    }
  }
  const lines = [
    `From: ${formatAddress(from)}`,
    `To: ${formatAddress(to)}`,
    `Subject: ${encodeHeader(cleanSubject)}`,
    `Date: ${rfc5322Date(date)}`,
    `Message-ID: ${messageId || messageIdFor(from.email)}`,
    ...extra.map(([name, value]) => `${name}: ${String(value).replace(/[\r\n]+/g, " ")}`),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable"
  ];
  return `${lines.join("\r\n")}\r\n\r\n${quotedPrintable(text)}`;
}

/**
 * Read a finished message back and refuse anything but one plain part with
 * nothing that tracks. The sender gate runs this before every send.
 */
export function assertPlainLetter(raw) {
  const message = String(raw ?? "");
  const split = message.indexOf("\r\n\r\n");
  if (split === -1) throw new LetterError("У листі немає заголовків.", { code: "not_a_letter" });
  const head = message.slice(0, split);
  const types = head.match(/^content-type:.*$/gim) || [];
  if (types.length !== 1 || !/^content-type:\s*text\/plain;\s*charset=utf-8\s*$/i.test(types[0])) {
    throw new LetterError("Лист не є однією частиною text/plain; charset=UTF-8 — не відправляється.", { code: "not_plain" });
  }
  if (/multipart|text\/html/i.test(head)) throw new LetterError("У листі є HTML або кілька частин — не відправляється.", { code: "not_plain" });
  const encoding = (head.match(/^content-transfer-encoding:\s*(.+)$/im) || [])[1]?.trim().toLowerCase();
  const body = encoding === "quoted-printable" ? decodeQuotedPrintable(message.slice(split + 4)) : message.slice(split + 4);
  if (/<\s*(html|body|div|span|p|img|a|table|style|script|font)\b/i.test(body)) {
    throw new LetterError("У тексті листа HTML — не відправляється.", { code: "html_in_body" });
  }
  // A pixel cannot exist in a plain part, but an image link pretending to be
  // one, or a known click-tracking redirect, can.
  if (/https?:\/\/\S+\.(gif|png)(\?\S*)?\b|\/(track|open|pixel|click)\b[^\s]*[?&](id|e|u)=/i.test(body)) {
    throw new LetterError("У листі посилання, схоже на піксель чи трекінг, — не відправляється.", { code: "tracking" });
  }
  return true;
}
