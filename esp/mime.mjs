// ESP 7 — reading a message that came in: headers, the text a person wrote,
// and the delivery report inside a bounce. No dependencies; enough MIME for
// what mailboxes actually receive — multipart (mixed/alternative/report),
// quoted-printable and base64, UTF-8 and Latin-1.

/** Unfolded headers, names lower-cased; a repeated header keeps every value. */
export function parseHeaders(block) {
  const headers = {};
  const unfolded = String(block).replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = decodeWords(line.slice(colon + 1).trim());
    headers[name] = headers[name] === undefined ? value : [].concat(headers[name], value);
  }
  return headers;
}

export function header(headers, name) {
  const value = headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value[0] : value ?? "";
}

/** RFC 2047 encoded words back to text. */
export function decodeWords(value) {
  return String(value).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_whole, charset, encoding, text) => {
    const bytes = encoding.toUpperCase() === "B"
      ? Buffer.from(text, "base64")
      : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1");
    return decodeBytes(bytes, charset);
  });
}

function decodeBytes(bytes, charset = "utf-8") {
  const name = String(charset).toLowerCase();
  if (name === "iso-8859-1" || name === "latin1" || name === "us-ascii" || name === "windows-1252") return bytes.toString("latin1");
  return bytes.toString("utf8");
}

function param(value, name) {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(String(value));
  return match ? (match[1] ?? match[2]) : "";
}

function decodeBody(body, transfer, charset) {
  const encoding = String(transfer || "").toLowerCase();
  if (encoding === "base64") return decodeBytes(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset);
  if (encoding === "quoted-printable") {
    const joined = body.replace(/=\r?\n/g, "");
    const bytes = [];
    for (let index = 0; index < joined.length; index += 1) {
      if (joined[index] === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(index + 1, index + 3))) {
        bytes.push(parseInt(joined.slice(index + 1, index + 3), 16));
        index += 2;
      } else {
        bytes.push(...Buffer.from(joined[index], "latin1"));
      }
    }
    return decodeBytes(Buffer.from(bytes), charset);
  }
  return decodeBytes(Buffer.from(body, "latin1"), charset);
}

/**
 * A whole message (or a part) as { headers, type, text, parts }. `text` is the
 * decoded body of a leaf; a multipart's parts are parsed the same way.
 */
export function parseMessage(raw) {
  const source = String(raw);
  const split = source.search(/\r?\n\r?\n/);
  const head = split === -1 ? source : source.slice(0, split);
  const body = split === -1 ? "" : source.slice(split).replace(/^\r?\n\r?\n/, "");
  const headers = parseHeaders(head);
  const contentType = header(headers, "content-type") || "text/plain";
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = param(contentType, "boundary");
    const parts = boundary
      ? body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*\\r?\\n?`))
        .map((chunk) => chunk.replace(/^\r?\n/, ""))
        .filter((chunk) => chunk.trim() && !/^--\s*$/.test(chunk.trim()))
        .map((chunk) => parseMessage(chunk))
      : [];
    return { headers, type, contentType, text: "", parts };
  }
  if (type === "message/rfc822" || type === "text/rfc822-headers") {
    return { headers, type, contentType, text: body, parts: [parseMessage(body)] };
  }
  return { headers, type, contentType, text: decodeBody(body, header(headers, "content-transfer-encoding"), param(contentType, "charset") || "utf-8"), parts: [] };
}

function* walk(part) {
  yield part;
  for (const child of part.parts || []) yield* walk(child);
}

/** The first plain-text body a person wrote (HTML stripped when that is all there is). */
export function plainText(message) {
  for (const part of walk(message)) if (part.type === "text/plain" && part.text) return part.text;
  for (const part of walk(message)) {
    if (part.type === "text/html" && part.text) {
      return part.text.replace(/<(br|\/p|\/div)[^>]*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
    }
  }
  return "";
}

/**
 * What a bounce says: the status code and the address it is about, from the
 * delivery-status part (RFC 3464) or, failing that, from the text Gmail and
 * other servers write. Also the Message-ID of the letter that bounced, when
 * the report carries its headers.
 */
export function deliveryReport(message) {
  let code = "";
  let recipient = "";
  let original = "";
  for (const part of walk(message)) {
    if (part.type === "message/delivery-status") {
      const fields = parseHeaders(part.text.replace(/\r?\n\r?\n/g, "\n"));
      code = code || (String(header(fields, "status")).match(/[245]\.\d{1,3}\.\d{1,3}/) || [""])[0];
      recipient = recipient || String(header(fields, "final-recipient") || header(fields, "original-recipient")).replace(/^rfc822;\s*/i, "").trim().toLowerCase();
    }
    if ((part.type === "message/rfc822" || part.type === "text/rfc822-headers") && part.parts?.[0]) {
      original = original || header(part.parts[0].headers, "message-id");
    }
  }
  const text = plainText(message);
  code = code || (text.match(/\b([45]\.\d{1,3}\.\d{1,3})\b/) || [])[1] || "";
  if (!recipient) {
    const address = text.match(/(?:to|address|recipient)[^\n@]{0,40}?<?([^\s<>@]+@[^\s<>]+\.[a-z]{2,})>?/i);
    recipient = address ? address[1].toLowerCase().replace(/[.,;:]+$/, "") : "";
  }
  return { code, recipient, originalMessageId: original };
}
