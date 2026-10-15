// «Увійти через Google» (власник 13.10: «роби функціонал») — a mailbox is
// connected the way Instantly and Snov connect one: the person presses the
// button, picks the mailbox in Google's own window and presses «Дозволити».
// No password reaches this system; what comes back is a refresh token for that
// one mailbox, kept encrypted in the workspace state, and every Gmail call
// after it goes through the same connector code as before (esp/gmail.mjs).
//
// What the owner sets up once (ESP_GOOGLE_OAUTH.md):
//   ESP_GOOGLE_OAUTH_CLIENT_ID / ESP_GOOGLE_OAUTH_CLIENT_SECRET — an OAuth
//   client «Web application» in Google Cloud, with this server's callback
//   (`redirectUri`) among its redirect URIs. Mailboxes in the same Workspace
//   connect straight away («Internal» consent screen); another Workspace's
//   admin marks the Client ID «Trusted» first, as for Instantly.
//
// The flow:
//   1. GET /api/esp/oauth/google/start → a one-time `state` bound to the
//      signed-in person, and a redirect to Google with the Gmail scopes,
//      offline access and the consent screen forced (so a refresh token always
//      comes back).
//   2. Google → GET /api/esp/oauth/google/callback?code&state → the code is
//      exchanged, the mailbox read (`/profile`), the grant stored, the mailbox
//      registered as a sender, a pause for a lost connection lifted.
//   3. Any later call: the refresh token buys an hour's access token. If
//      Google says `invalid_grant` (password changed, access removed), the
//      grant is marked broken and the mailbox paused — «Увійти знову» fixes it.

import { randomBytes } from "node:crypto";

import { GMAIL_SCOPES, GmailApiConnector, WARMUP_SCOPES } from "./gmail.mjs";
import { MailboxError, normalizeMailbox } from "./provider.mjs";

const AUTHORIZE_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const REVOKE_URI = "https://oauth2.googleapis.com/revoke";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
export const CALLBACK_PATH = "/api/esp/oauth/google/callback";
/** Sending, reading replies, and the warm-up's labels — one consent for all three. */
export const OAUTH_SCOPES = ["openid", "email", "profile", ...GMAIL_SCOPES, ...WARMUP_SCOPES];
const STATE_TTL_MS = 10 * 60_000;

/** The OAuth client from the environment, and the callback Google must know. */
export function oauthConfigFromEnv(env = process.env) {
  const clientId = String(env.ESP_GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = String(env.ESP_GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  const base = String(env.ESP_GOOGLE_OAUTH_REDIRECT_URI || "").trim()
    || (env.PUBLIC_URL || env.APP_PUBLIC_URL ? `${String(env.PUBLIC_URL || env.APP_PUBLIC_URL).replace(/\/+$/, "")}${CALLBACK_PATH}` : "");
  return {
    clientId, clientSecret, redirectUri: base || null,
    configured: Boolean(clientId && clientSecret),
    missing: [!clientId && "ESP_GOOGLE_OAUTH_CLIENT_ID", !clientSecret && "ESP_GOOGLE_OAUTH_CLIENT_SECRET"].filter(Boolean)
  };
}

/** This server's own callback, from the request when the environment does not name it. */
export function redirectUriFor(config, request) {
  if (config.redirectUri) return config.redirectUri;
  const headers = request?.headers || {};
  const proto = String(headers["x-forwarded-proto"] || "").split(",")[0].trim() || (request?.socket?.encrypted ? "https" : "http");
  const host = String(headers["x-forwarded-host"] || headers.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}${CALLBACK_PATH}` : null;
}

export function authorizeUrl({ clientId, redirectUri, state, loginHint = "" }) {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    // Always the consent screen: without it Google sends a refresh token only
    // the first time, and a mailbox reconnected later would have none.
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state
  });
  if (loginHint) query.set("login_hint", loginHint);
  return `${AUTHORIZE_URI}?${query}`;
}

/** Google's words about the token request, said as what to do. */
function tokenFailure(status, body, { refreshing = false } = {}) {
  const error = body?.error || "";
  if (error === "invalid_grant") {
    return new MailboxError(refreshing
      ? "Google відкликав доступ до пошти (змінили пароль або прибрали дозвіл) — увійдіть через Google ще раз."
      : "Google не прийняв код входу: він уже використаний або застарів — спробуйте ще раз.", { code: "oauth_revoked", status, detail: body?.error_description || null });
  }
  if (error === "invalid_client" || error === "unauthorized_client") {
    return new MailboxError("Google не впізнав OAuth-клієнт цього сервера: перевірте ESP_GOOGLE_OAUTH_CLIENT_ID і _SECRET.", { code: "oauth_client", status, detail: body?.error_description || null });
  }
  if (error === "redirect_uri_mismatch") {
    return new MailboxError("Адреса повернення цього сервера не внесена в OAuth-клієнт у Google Cloud (Authorized redirect URIs).", { code: "oauth_redirect", status });
  }
  return new MailboxError(`Google не видав токен (${status}${error ? `, ${error}` : ""}).`, { code: "token_failed", status, detail: body?.error_description || null });
}

async function postForm(fetch, url, form) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString()
  });
  return { response, body: await response.json().catch(() => ({})) };
}

/**
 * The connected mailboxes, in the workspace state (`read()` / `write(value)`),
 * with each refresh token encrypted (`encrypt` / `decrypt`, the server's
 * secrets key). `list()` never returns a token.
 */
export function grantStore({ read, write, encrypt, decrypt }) {
  const all = () => ({ ...(read() || {}) });
  const save = async (value) => write(value);
  const publicView = (grant) => ({
    email: grant.email, name: grant.name || "", connectedBy: grant.connectedBy || "", connectedAt: grant.connectedAt || null,
    scopes: grant.scopes || [], status: grant.status || "connected", error: grant.error || null, errorAt: grant.errorAt || null,
    canModify: (grant.scopes || []).includes(WARMUP_SCOPES[0])
  });
  return {
    has: (email) => Boolean(all()[String(email || "").toLowerCase()]),
    connected: (email) => all()[String(email || "").toLowerCase()]?.status !== "broken" && Boolean(all()[String(email || "").toLowerCase()]),
    count: () => Object.values(all()).filter((grant) => grant.status !== "broken").length,
    list: () => Object.values(all()).map(publicView).sort((left, right) => left.email.localeCompare(right.email)),
    view: (email) => { const grant = all()[String(email || "").toLowerCase()]; return grant ? publicView(grant) : null; },
    refreshToken(email) {
      const grant = all()[String(email || "").toLowerCase()];
      if (!grant?.refresh) return null;
      return decrypt(grant.refresh);
    },
    scopes: (email) => all()[String(email || "").toLowerCase()]?.scopes || [],
    async put({ email, name = "", refreshToken, scopes = [], connectedBy = "" }) {
      const key = normalizeMailbox(email);
      const grants = all();
      grants[key] = {
        email: key, name, refresh: encrypt(refreshToken), scopes, connectedBy,
        connectedAt: new Date().toISOString(), status: "connected", error: null, errorAt: null
      };
      await save(grants);
      return publicView(grants[key]);
    },
    async markBroken(email, reason) {
      const key = String(email || "").toLowerCase();
      const grants = all();
      if (!grants[key] || grants[key].status === "broken") return;
      grants[key] = { ...grants[key], status: "broken", error: reason, errorAt: new Date().toISOString() };
      await save(grants);
    },
    async remove(email) {
      const key = String(email || "").toLowerCase();
      const grants = all();
      const gone = grants[key];
      delete grants[key];
      await save(grants);
      return gone ? { ...publicView(gone), refresh: gone.refresh } : null;
    }
  };
}

/**
 * The sign-in itself: the one-time `state`, the URL to Google, and the code
 * exchanged for the mailbox's tokens and address.
 */
export function googleSignIn({ config, fetch = globalThis.fetch, now = () => Date.now() }) {
  const pending = new Map();
  const sweep = () => { for (const [key, row] of pending) if (now() - row.at > STATE_TTL_MS) pending.delete(key); };
  return {
    config,
    /** Where to send the browser, and the state that brings the answer back to this person. */
    start({ user, redirectUri, loginHint = "" }) {
      if (!config.configured) throw new MailboxError(`Вхід через Google ще не налаштовано на сервері: немає ${config.missing.join(", ")}.`, { code: "oauth_not_configured" });
      if (!redirectUri) throw new MailboxError("Невідома адреса повернення з Google — задайте PUBLIC_URL або ESP_GOOGLE_OAUTH_REDIRECT_URI.", { code: "oauth_redirect" });
      sweep();
      const state = randomBytes(24).toString("base64url");
      pending.set(state, { user: String(user || ""), redirectUri, at: now() });
      return { url: authorizeUrl({ clientId: config.clientId, redirectUri, state, loginHint }), state };
    },
    /** The state Google returned: whose sign-in it was, once. */
    take(state) {
      sweep();
      const row = pending.get(String(state || ""));
      pending.delete(String(state || ""));
      return row || null;
    },
    /** The code for tokens, and the mailbox they are for. */
    async finish({ code, redirectUri }) {
      const { response, body } = await postForm(fetch, TOKEN_URI, {
        code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code"
      });
      if (!response.ok || !body.access_token) throw tokenFailure(response.status, body);
      const scopes = String(body.scope || "").split(/\s+/).filter(Boolean);
      const missing = GMAIL_SCOPES.filter((scope) => !scopes.includes(scope));
      if (missing.length) {
        throw new MailboxError("У вікні Google не поставили галочки на доступ до пошти — без них листи не надіслати й відповіді не прочитати. Увійдіть ще раз і дозвольте все.", { code: "oauth_scopes", detail: missing.join(" ") });
      }
      if (!body.refresh_token) {
        throw new MailboxError("Google не дав постійного доступу (refresh token). Приберіть застосунок у myaccount.google.com → «Безпека» → «Сторонні застосунки» й увійдіть ще раз.", { code: "oauth_no_refresh" });
      }
      const profileResponse = await fetch(`${GMAIL}/profile`, { headers: { authorization: `Bearer ${body.access_token}` } });
      const profile = await profileResponse.json().catch(() => ({}));
      if (!profileResponse.ok || !profile.emailAddress) {
        throw new MailboxError(`Gmail не відкрив пошту (${profileResponse.status}): ${profile?.error?.message || "без пояснення"}.`, { code: "gmail_error", status: profileResponse.status });
      }
      let name = "";
      try {
        const claims = JSON.parse(Buffer.from(String(body.id_token || "").split(".")[1] || "", "base64url").toString("utf8"));
        name = String(claims.name || "").slice(0, 120);
      } catch { /* the name is a nicety */ }
      return {
        email: String(profile.emailAddress).toLowerCase(), name, scopes,
        refreshToken: body.refresh_token, accessToken: body.access_token, expiresIn: Number(body.expires_in) || 3600
      };
    },
    /** Tell Google to forget the token too — «Відключити» means it. */
    async revoke(token) {
      if (!token) return;
      try { await postForm(fetch, REVOKE_URI, { token }); } catch { /* the grant is gone here either way */ }
    },
    async refresh(refreshToken) {
      const { response, body } = await postForm(fetch, TOKEN_URI, {
        client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token"
      });
      if (!response.ok || !body.access_token) throw tokenFailure(response.status, body, { refreshing: true });
      return { token: body.access_token, expiresIn: Number(body.expires_in) || 3600 };
    }
  };
}

/**
 * Gmail with each mailbox's own sign-in. Everything but the token is the
 * service-account connector's: send, inbox, warm-up letters, labels.
 */
export class GmailOAuthConnector extends GmailApiConnector {
  constructor({ signIn, grants, fetch = globalThis.fetch, now = () => Date.now(), liveSend = false }) {
    super({ serviceAccount: null, fetch, now, liveSend });
    this.kind = "gmail_oauth";
    this.signIn = signIn;
    this.grants = grants;
  }

  describe() {
    return {
      mode: "gmail_oauth",
      serviceAccountEmail: null,
      clientId: this.signIn.config.clientId || null,
      scopes: OAUTH_SCOPES,
      warmupScopes: WARMUP_SCOPES,
      liveSend: this.liveSend,
      connected: this.grants.count()
    };
  }

  /** One token per mailbox holds every scope it was granted; the `scopes` argument only says whether labels are allowed. */
  async accessToken(mailbox, scopes = GMAIL_SCOPES) {
    const key = normalizeMailbox(mailbox);
    if (scopes.includes(WARMUP_SCOPES[0]) && !this.grants.scopes(key).includes(WARMUP_SCOPES[0])) {
      throw new MailboxError("При вході через Google не дозволили змінювати мітки — прогрів не виймає листи зі спаму. Увійдіть ще раз і дозвольте все.", { code: "no_modify_scope", status: 403 });
    }
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - 60_000 > this.now()) return cached.token;
    const refreshToken = this.grants.refreshToken(key);
    if (!refreshToken) throw new MailboxError(`Пошту ${key} не підключено — «Прогрів пошт» → «Додати пошту» → «Увійти через Google».`, { code: "not_connected" });
    try {
      const { token, expiresIn } = await this.signIn.refresh(refreshToken);
      this.tokens.set(key, { token, expiresAt: this.now() + expiresIn * 1000 });
      return token;
    } catch (error) {
      if (error.code === "oauth_revoked") await this.grants.markBroken(key, error.message);
      throw error;
    }
  }

  async call(mailbox, path, init = {}, scopes = GMAIL_SCOPES) {
    try {
      return await super.call(mailbox, path, init, scopes);
    } catch (error) {
      // super keys its cache by mailbox and scopes; this one by mailbox alone.
      if (error.status === 401) this.tokens.delete(normalizeMailbox(mailbox));
      throw error;
    }
  }

  /** Forget a mailbox's token here (after «Відключити» or a new sign-in). */
  forget(mailbox) {
    this.tokens.delete(String(mailbox || "").toLowerCase());
  }
}

/**
 * The stand-in for a mailbox nobody connected, once real sending is on and no
 * service-account key exists: every call says what to do rather than letting
 * the stub pretend a letter went.
 */
export class NotConnectedConnector {
  constructor() { this.kind = "not_connected"; this.liveSend = false; }
  describe() { return { mode: "not_connected", liveSend: false, serviceAccountEmail: null, clientId: null, scopes: OAUTH_SCOPES }; }
  #no(mailbox) {
    return new MailboxError(`Пошту ${mailbox} не підключено — «Прогрів пошт» → «Додати пошту» → «Увійти через Google».`, { code: "not_connected" });
  }
  async checkMailbox(mailbox) { throw this.#no(mailbox); }
  async send(mailbox) { throw this.#no(mailbox); }
  async inboxSince(mailbox) { throw this.#no(mailbox); }
  async lettersFrom(mailbox) { throw this.#no(mailbox); }
  async setLabels(mailbox) { throw this.#no(mailbox); }
}
