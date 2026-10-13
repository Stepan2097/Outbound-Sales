// «Скриньки» → «Додати скриньку» → «Увійти через Google» (власник 13.10):
// the routes around the sign-in, as Instantly and Snov have them — the list of
// connected mailboxes with their state, the button that sends the browser to
// Google, the way back, «Перевірити» and «Відключити».
//
// Anybody signed in connects a mailbox — their own, as in Snov; disconnecting
// somebody else's is the registry's right (`registry.change`). A connected
// mailbox becomes a sender in the registry (esp/registry.mjs) on the first
// sign-in: its domain is added in «рампа» when it is new — the ramp's own
// limits (5 → … → 35 a day) are what keeps a fresh mailbox careful — and a
// pause for a lost connection is lifted when the person signs in again.
//
// The OAuth itself (tokens, Google's answers) is the provider's —
// esp/google-oauth.mjs, handed in as `esp.oauth`.

import { can } from "./access.mjs";
import { MailboxError } from "./provider.mjs";
import { addDomain, addSender, domainKey, registry, setSenderStatus } from "./registry.mjs";

/** Pauses that signing in again repairs: the connection itself was the problem. */
const CONNECTION_CODES = new Set(["oauth_revoked", "oauth_client", "not_connected", "token_failed", "delegation_missing", "mailbox_rejected"]);

const RETURN_TO = "/#mail-settings/mailbox";

function redirect(response, location, sendJson) {
  if (typeof response.writeHead === "function") {
    response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
    response.end();
  } else {
    sendJson(response, 302, { location });
  }
}

/** The mailbox's sender in the registry, created on its first sign-in. */
async function registerSender({ email, name, person }, actor) {
  const domain = domainKey(email.split("@")[1]);
  let { domains, senders } = await registry();
  const notes = [];
  if (!domains.some((row) => row.domain === domain)) {
    await addDomain({ domain, status: "ramp", note: `Додано під час входу через Google (${email}).` }, actor);
    notes.push(`домен ${domain} додано в реєстр у стані «рампа»`);
  }
  if (!senders.some((row) => row.email === email)) {
    await addSender({ email, displayName: name, person }, actor);
    notes.push("скриньку додано у відправники (5 листів на день на старті рампи)");
  }
  ({ senders } = await registry());
  const sender = senders.find((row) => row.email === email);
  const last = sender ? [...sender.history].reverse().find((row) => row.status === sender.status) || {} : {};
  if (sender?.status === "paused" && CONNECTION_CODES.has(last.code)) {
    await setSenderStatus({ email, status: "active" }, actor);
    notes.push("паузу через втрачене підключення знято");
  }
  return { sender, notes };
}

/** Each connected mailbox with what the registry says about it. */
async function mailboxRows(esp) {
  const { senders } = await registry();
  return esp.oauth.grants.list().map((grant) => {
    const sender = senders.find((row) => row.email === grant.email);
    return {
      ...grant,
      sender: sender ? { status: sender.status, effectiveStatus: sender.effectiveStatus || sender.status, rampStage: sender.rampStage, person: sender.person } : null
    };
  });
}

export async function handleMailboxConnect({ method, path, url, request, response, sendJson, readJson, esp, profile, actor, logged }) {
  if (!path.startsWith("/oauth/google")) return false;
  const oauth = esp.oauth;
  if (!oauth) {
    sendJson(response, 503, { success: false, error: "Вхід через Google на цьому сервері не зібрано." });
    return true;
  }
  const me = String(profile?.email || "").toLowerCase();

  if (method === "GET" && path === "/oauth/google") {
    sendJson(response, 200, {
      success: true,
      configured: oauth.config.configured,
      missing: oauth.config.missing,
      redirectUri: oauth.redirectUri(request),
      liveSend: Boolean(oauth.connector.liveSend),
      canManage: await can(profile, "registry.change"),
      me,
      mailboxes: await mailboxRows(esp)
    });
    return true;
  }

  // The browser goes to Google with this URL; the state brings the answer back to this person.
  if (method === "POST" && path === "/oauth/google/start") {
    const body = (await readJson(request)) || {};
    try {
      const { url: location } = oauth.signIn.start({ user: me, redirectUri: oauth.redirectUri(request), loginHint: String(body.mailbox || "").trim().toLowerCase() });
      sendJson(response, 200, { success: true, url: location });
    } catch (error) {
      if (!(error instanceof MailboxError)) throw error;
      sendJson(response, 409, { success: false, code: error.code, error: error.message });
    }
    return true;
  }

  // Google sends the person back here — a page, not an answer: back to «Скриньки» with what happened.
  if (method === "GET" && path === "/oauth/google/callback") {
    const back = (outcome, value) => redirect(response, `${RETURN_TO}/${outcome}/${encodeURIComponent(value)}`, sendJson);
    const pending = oauth.signIn.take(url.searchParams.get("state"));
    if (!pending) return back("error", "Вхід застарів або вже використаний — натисніть «Увійти через Google» ще раз."), true;
    if (pending.user && pending.user !== me) return back("error", "Вхід почав інший користувач платформи — почніть його зі свого акаунта."), true;
    const denied = url.searchParams.get("error");
    if (denied) return back("error", denied === "access_denied" ? "Доступ у вікні Google не дали — скриньку не підключено." : `Google відповів: ${denied}.`), true;
    try {
      const signed = await oauth.signIn.finish({ code: url.searchParams.get("code") || "", redirectUri: pending.redirectUri });
      await oauth.grants.put({ email: signed.email, name: signed.name, refreshToken: signed.refreshToken, scopes: signed.scopes, connectedBy: me });
      oauth.connector.forget(signed.email);
      const { notes } = await registerSender({ email: signed.email, name: signed.name, person: me }, actor || me);
      await logged("mailbox_connected", { mailbox: signed.email, via: "google_oauth", notes });
      back("ok", signed.email);
    } catch (error) {
      if (!(error instanceof MailboxError) && !error?.statusCode) throw error;
      back("error", error.message);
    }
    return true;
  }

  const body = method === "POST" ? (await readJson(request)) || {} : {};
  const mailbox = String(body.mailbox || "").trim().toLowerCase();
  const grant = mailbox ? oauth.grants.view(mailbox) : null;

  // «Перевірити»: a token from the refresh token and a read of the mailbox's profile — nothing is sent.
  if (method === "POST" && path === "/oauth/google/check") {
    if (!grant) return sendJson(response, 404, { success: false, error: "Такої підключеної скриньки немає." }), true;
    try {
      const result = await oauth.connector.checkMailbox(mailbox);
      sendJson(response, 200, { success: true, ok: true, ...result, mailboxes: await mailboxRows(esp) });
    } catch (error) {
      if (!(error instanceof MailboxError)) throw error;
      sendJson(response, 200, { success: true, ok: false, mailbox, code: error.code, error: error.message, mailboxes: await mailboxRows(esp) });
    }
    return true;
  }

  // «Відключити»: the token is revoked at Google and forgotten here; the sender is paused, not removed — its history stays.
  if (method === "POST" && path === "/oauth/google/disconnect") {
    if (!grant) return sendJson(response, 404, { success: false, error: "Такої підключеної скриньки немає." }), true;
    if (grant.connectedBy !== me && !await can(profile, "registry.change")) {
      sendJson(response, 403, { success: false, error: "Відключити чужу скриньку може лише адміністратор." });
      return true;
    }
    const token = oauth.grants.refreshToken(mailbox);
    await oauth.grants.remove(mailbox);
    oauth.connector.forget(mailbox);
    await oauth.signIn.revoke(token);
    try {
      await setSenderStatus({ email: mailbox, status: "paused", reason: "Скриньку відключено від платформи — листи з неї не йдуть, доки її не підключать знову.", code: "not_connected" }, actor || me);
    } catch { /* not a sender, or already so */ }
    await logged("mailbox_disconnected", { mailbox });
    sendJson(response, 200, { success: true, mailboxes: await mailboxRows(esp) });
    return true;
  }

  sendJson(response, 404, { success: false, error: "Невідомий маршрут підключення скриньки." });
  return true;
}
