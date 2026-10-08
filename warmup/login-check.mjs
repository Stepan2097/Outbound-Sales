import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The link in the group message: "I have logged in, carry on".
 *
 * It exists because the obvious thing — an inline button that reports back —
 * cannot be used. A Telegram callback needs `getUpdates` (or a webhook) on the
 * bot, that reading is exclusive per bot, and it acknowledges every update up
 * to its offset: on 08.10.2026 the warm-up's own polling swallowed the owner's
 * replies meant for another chat on the same bot. A **link** button tells
 * Telegram nothing, so one bot can carry both.
 *
 * What the link is: an account id, the moment it was issued and a nonce,
 * signed. Nothing secret travels in it — the id is already in the group
 * message — and the signature is what makes it an instruction rather than a
 * suggestion.
 *
 * **The key is derived from `WARMUP_AGENT_TOKEN`** rather than being a new
 * secret of its own. Both halves need it (the watcher writes the links, the
 * portal checks them) and both already hold that token; and the link grants
 * strictly less than the token does — the token can report any health for any
 * account, the link can only ask for one account to be looked at. A new secret
 * would be one more thing to deploy to two places and to rotate, for no gain.
 *
 * One use, and not for long: the portal records the nonce when the link is
 * opened and refuses it afterwards, and a link older than `MAX_AGE_MS` is
 * refused whether or not it was used. A link that lives in a group chat
 * forever must not stay usable forever.
 */
const PREFIX = "warmup-login-check-v1";

/** A week: longer than any "I will do it tomorrow", shorter than the chat's memory. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const RECHECK_REQUESTED = "login.recheck_requested";
export const RECHECK_DONE = "login.recheck_done";

function key(token = process.env.WARMUP_AGENT_TOKEN) {
  const raw = String(token ?? "").trim();
  return raw ? raw : null;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  return Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(payload, secret) {
  return base64url(createHmac("sha256", `${PREFIX}:${secret}`).update(payload).digest());
}

/** The token for one account's link. `nonce` is what makes it single-use. */
export function issueLoginCheck(accountId, { token, now = Date.now(), nonce = base64url(randomBytes(9)) } = {}) {
  const secret = key(token);
  if (!secret) throw new Error("WARMUP_AGENT_TOKEN is not set — refusing to sign a login-check link");
  const payload = base64url(JSON.stringify({ a: String(accountId), t: now, n: nonce }));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * What a link says, or why it is not being believed. Never throws: this reads
 * something a stranger may have typed.
 */
export function readLoginCheck(value, { token, now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  const secret = key(token);
  if (!secret) return { ok: false, why: "not_configured" };
  const [payload, signature] = String(value ?? "").split(".");
  if (!payload || !signature) return { ok: false, why: "malformed" };

  const expected = sign(payload, secret);
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  // Lengths first: timingSafeEqual throws on a mismatch, and a thrown link is
  // a 500 where a refusal belongs.
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { ok: false, why: "bad_signature" };

  let body;
  try {
    body = JSON.parse(fromBase64url(payload).toString("utf8"));
  } catch {
    return { ok: false, why: "malformed" };
  }
  const accountId = typeof body?.a === "string" ? body.a : "";
  const issuedAt = Number(body?.t);
  const nonce = typeof body?.n === "string" ? body.n : "";
  if (!accountId || !nonce || !Number.isFinite(issuedAt)) return { ok: false, why: "malformed" };
  if (now - issuedAt > maxAgeMs) return { ok: false, why: "expired" };
  // A link stamped in the future is a clock that moved, not an attack; it is
  // still refused, because "issued" has to mean something for the age check.
  if (issuedAt - now > 60_000) return { ok: false, why: "malformed" };

  return { ok: true, accountId, issuedAt, nonce };
}

/** The whole address, as it goes into the button. */
export function loginCheckUrl(portal, accountId, options = {}) {
  const base = String(portal ?? "").replace(/\/+$/, "");
  return `${base}/api/warmup/login-check?t=${encodeURIComponent(issueLoginCheck(accountId, options))}`;
}
