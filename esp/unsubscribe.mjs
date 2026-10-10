// ESP 3 — List-Unsubscribe: a one-click way out, on the sender's own domain.
//
// Checklist (P0): «Заголовок List-Unsubscribe — List-Unsubscribe (mailto +
// https на домені відправника) і List-Unsubscribe-Post:
// List-Unsubscribe=One-Click. Посилання — лише на домен, з якого йде лист.»
//
// - mailto: the sending mailbox itself, subject "unsubscribe". It exists on the
//   sender's domain by definition, and its inbox is the one ESP 7 reads.
// - https: `https://<sender domain>/u/<token>` (or a base on a subdomain of
//   it). Any other host is refused when the letter is built.
// - The token names who unsubscribes from whom, signed with HMAC so a guessed
//   or edited link unsubscribes nobody.
// - POST /u/<token> with `List-Unsubscribe=One-Click` (RFC 8058, what Gmail
//   and Yahoo send) unsubscribes at once. GET only shows a page with a button:
//   link scanners open URLs, and must not unsubscribe people by doing so.
//
// The unsubscription is written to the ESP journal as `contact.unsubscribed`
// (esp/messages.mjs, ESP 9); the pre-send checks (ESP 6) read it from there.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { LetterError } from "./letter.mjs";

/**
 * The key the links are signed with: `ESP_UNSUBSCRIBE_SECRET`. Without one a
 * random key is made for this process — links would stop working after a
 * restart, so the connection screen says so, and ESP 11 does not pass with it.
 */
export function unsubscribeSecretFromEnv(env = process.env) {
  const secret = String(env.ESP_UNSUBSCRIBE_SECRET || "").trim();
  if (secret.length >= 16) return { secret, ephemeral: false };
  return { secret: randomBytes(32).toString("hex"), ephemeral: true };
}

const b64 = (value) => Buffer.from(value).toString("base64url");
const sign = (payload, secret) => createHmac("sha256", secret).update(payload).digest("base64url");

export function signUnsubscribe({ sender, recipient, campaignId = null }, secret) {
  const payload = b64(JSON.stringify({ v: 1, s: String(sender).toLowerCase(), r: String(recipient).toLowerCase(), c: campaignId }));
  return `${payload}.${sign(payload, secret)}`;
}

/** Who unsubscribes from whom, or null for a link this server did not sign. */
export function readUnsubscribe(token, secret) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.v !== 1 || !data.s || !data.r) return null;
    return { sender: data.s, recipient: data.r, campaignId: data.c ?? null };
  } catch {
    return null;
  }
}

export function senderDomain(mailbox) {
  return String(mailbox).toLowerCase().split("@")[1] || "";
}

/**
 * The two headers for one letter. `base` is where the sender's domain serves
 * `/u/`; by default the domain itself. A base on any other domain is refused —
 * a link to somewhere else is exactly what the checklist forbids.
 */
export function unsubscribeHeaders({ sender, recipient, campaignId = null, secret, base = null }) {
  if (!secret) throw new LetterError("Немає ключа для посилань відписки.", { code: "unsubscribe_secret_missing" });
  const domain = senderDomain(sender);
  let url;
  try {
    url = new URL(base || `https://${domain}`);
  } catch {
    throw new LetterError(`Адреса для відписки не читається: ${base}.`, { code: "unsubscribe_bad_base" });
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(host === domain || host.endsWith(`.${domain}`))) {
    throw new LetterError(`Посилання відписки має бути https на домені відправника (${domain}), а не ${url.host}.`, { code: "unsubscribe_foreign_domain" });
  }
  const token = signUnsubscribe({ sender, recipient, campaignId }, secret);
  const path = `${url.pathname.replace(/\/$/, "")}/u/${token}`;
  return {
    "List-Unsubscribe": `<mailto:${String(sender).toLowerCase()}?subject=unsubscribe>, <https://${url.host}${path}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
  };
}

const PAGE = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;color:#1f2a2a}button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #1f2a2a;background:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));

/**
 * `/u/<token>` on any host — the request comes in on a sender's domain. GET
 * answers a page with one button; POST unsubscribes. True when it answered.
 */
export async function handleUnsubscribe({ request, response, url, readBody, secret, record }) {
  const match = /^\/u\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!match) return false;
  const found = readUnsubscribe(match[1], secret);
  const send = (status, html) => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" });
    response.end(html);
  };
  if (!found) {
    send(404, PAGE("Link not valid", "<p>This unsubscribe link is not valid. Reply to the email with “unsubscribe” and we will remove you.</p>"));
    return true;
  }
  if (request.method === "POST") {
    // One-click (RFC 8058) carries `List-Unsubscribe=One-Click`; our own page's
    // button sends the same, so both are one path.
    const body = await readBody(request).catch(() => "");
    const oneClick = /List-Unsubscribe=One-Click/i.test(String(body));
    await record({ ...found, via: oneClick ? "one-click" : "page" });
    send(200, PAGE("Unsubscribed", `<p>Done — ${escape(found.recipient)} will not get any more emails from ${escape(found.sender)}.</p>`));
    return true;
  }
  if (request.method === "GET" || request.method === "HEAD") {
    send(200, PAGE("Unsubscribe", `<p>Stop emails from ${escape(found.sender)} to ${escape(found.recipient)}?</p>
<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>`));
    return true;
  }
  response.writeHead(405, { allow: "GET, POST" });
  response.end();
  return true;
}
