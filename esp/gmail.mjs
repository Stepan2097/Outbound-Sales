// ESP 1 — the mailboxes, reached through the Gmail API.
//
// One Google Cloud service account with domain-wide delegation acts as each
// sending mailbox in turn: the assertion it signs names the mailbox as `sub`,
// Google answers with a token for that mailbox alone, and every call after it
// is `users/me` of that mailbox. No mailbox password and no per-mailbox OAuth
// consent exist anywhere in this system.
//
// Two connectors behind one shape — `checkMailbox(mailbox)` and
// `send(mailbox, raw, { threadId })` — so everything above them (the letter,
// the limits, the sequence) is written once and tested against the stub:
//
// - `StubGmailConnector` never opens a socket. It is what runs until the owner
//   hands over a real key, and what the tests run.
// - `GmailApiConnector` talks to Google. It can always *check* a mailbox (a
//   read of its profile), but it refuses to *send* unless it was built with
//   `liveSend: true`. Nothing goes out to a real person before ESP 11 is
//   accepted (manager, 10.10.2026), and that is a property of this class, not
//   a promise somebody has to remember at the call site.
//
// No dependencies: the assertion is an RS256 JWT signed with node:crypto.

import { createSign, randomUUID } from "node:crypto";

import { MailboxError, SendingLocked, normalizeMailbox } from "./provider.mjs";

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * The scopes every mail token asks for — what the Workspace admin lists for
 * the service account under domain-wide delegation. `gmail.send` to send;
 * `gmail.readonly` to check a mailbox now and to read replies and bounces later
 * (ESP 7). Nothing that can delete or change settings.
 */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly"
];

/**
 * The mailbox warm-up's one extra: `gmail.modify`, to take our own letters out
 * of Spam and mark them Important (labels only). Asked for in a token of its
 * own and only by `setLabels` — Google refuses a delegated token outright when
 * one of its scopes is not allowed, so asking for it with the mail scopes would
 * stop all sending and reading in a Workspace that has not added it yet.
 */
export const WARMUP_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

/** One header of a Gmail `format=metadata` message. */
const metaHeader = (message, name) => (message.payload?.headers || []).find((row) => String(row.name).toLowerCase() === name)?.value || "";

// The errors and the address rule are the provider contract's (esp/provider.mjs),
// re-exported so existing imports keep working.
export { MailboxError, SendingLocked, normalizeMailbox } from "./provider.mjs";

/**
 * The key file Google gives for a service account, checked for the three
 * things this uses. Throws a sentence, not a stack: the person reading it is
 * pasting a JSON file into an environment variable.
 */
export function parseServiceAccount(text) {
  let parsed;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    throw new MailboxError("Ключ сервісного акаунта — не JSON. Потрібен файл ключа з Google Cloud цілком.", { code: "key_not_json" });
  }
  if (parsed?.type !== "service_account") {
    throw new MailboxError("Це не ключ сервісного акаунта (type має бути service_account).", { code: "key_wrong_type" });
  }
  if (!parsed.client_email || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(String(parsed.private_key || ""))) {
    throw new MailboxError("У ключі немає client_email або private_key.", { code: "key_incomplete" });
  }
  return {
    clientEmail: String(parsed.client_email),
    clientId: parsed.client_id ? String(parsed.client_id) : null,
    privateKey: String(parsed.private_key),
    tokenUri: parsed.token_uri || TOKEN_URI
  };
}

const base64url = (input) => Buffer.from(input).toString("base64url");

/** The signed request "let this service account act as `subject`". */
export function signAssertion({ clientEmail, privateKey, tokenUri = TOKEN_URI }, { subject, scopes = GMAIL_SCOPES, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: clientEmail,
    sub: subject,
    scope: scopes.join(" "),
    aud: tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3600
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(privateKey, "base64url")}`;
}


/**
 * Google's refusals, said as what to fix. The two that matter in practice:
 * `unauthorized_client` — the delegation is missing or lacks a scope; and
 * `invalid_grant` — the mailbox is not a user of the delegated domain.
 */
function tokenRefusal(status, body) {
  const error = body?.error || "";
  if (error === "unauthorized_client") {
    return new MailboxError(
      "Google не дає сервісному акаунту діяти від імені цієї пошти: у консолі адміністратора Workspace делегування на рівні домену не налаштоване для його Client ID або не має потрібних scopes.",
      { code: "delegation_missing", status, detail: body?.error_description || null }
    );
  }
  if (error === "invalid_grant") {
    return new MailboxError(
      "Google не прийняв цю пошту: її немає серед користувачів домену, вона вимкнена, або годинник сервера розійшовся з Google.",
      { code: "mailbox_rejected", status, detail: body?.error_description || null }
    );
  }
  return new MailboxError(`Google не видав токен (${status}${error ? `, ${error}` : ""}).`, { code: "token_failed", status, detail: body?.error_description || null });
}

export class GmailApiConnector {
  constructor({ serviceAccount, fetch = globalThis.fetch, now = () => Date.now(), liveSend = false }) {
    this.kind = "gmail";
    // `null` for a connector whose tokens come from somewhere else — the
    // per-mailbox Google sign-in (esp/google-oauth.mjs) overrides accessToken().
    this.account = serviceAccount === null ? null
      : typeof serviceAccount === "object" && serviceAccount?.privateKey ? serviceAccount : parseServiceAccount(serviceAccount);
    this.fetch = fetch;
    this.now = now;
    this.liveSend = liveSend === true;
    this.tokens = new Map();
  }

  describe() {
    return {
      mode: "gmail",
      serviceAccountEmail: this.account.clientEmail,
      clientId: this.account.clientId,
      scopes: GMAIL_SCOPES,
      warmupScopes: WARMUP_SCOPES,
      liveSend: this.liveSend
    };
  }

  /**
   * A token for this one mailbox and these scopes, reused until a minute
   * before it lapses. The mail token and the warm-up's labels token are cached
   * apart: one refused never takes the other down.
   */
  async accessToken(mailbox, scopes = GMAIL_SCOPES) {
    const key = `${mailbox} ${scopes.join(" ")}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - 60_000 > this.now()) return cached.token;
    const assertion = signAssertion(this.account, { subject: mailbox, scopes, now: this.now() });
    const response = await this.fetch(this.account.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString()
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) throw tokenRefusal(response.status, body);
    this.tokens.set(key, { token: body.access_token, expiresAt: this.now() + (Number(body.expires_in) || 3600) * 1000 });
    return body.access_token;
  }

  async call(mailbox, path, init = {}, scopes = GMAIL_SCOPES) {
    const token = await this.accessToken(mailbox, scopes);
    const response = await this.fetch(`${GMAIL}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) this.tokens.delete(`${mailbox} ${scopes.join(" ")}`);
      throw new MailboxError(`Gmail API відповів ${response.status}: ${body?.error?.message || "без пояснення"}.`, {
        code: "gmail_error", status: response.status, detail: body?.error?.status || null
      });
    }
    return body;
  }

  /** Can the service account act as this mailbox? A read of its profile, nothing sent. */
  async checkMailbox(value) {
    const mailbox = normalizeMailbox(value);
    const profile = await this.call(mailbox, "/profile");
    return {
      ok: true,
      mailbox,
      // The address Google says the token is for — a mismatch would mean the
      // mailbox is an alias and replies would come from somewhere else.
      address: String(profile.emailAddress || "").toLowerCase(),
      messagesTotal: Number(profile.messagesTotal) || 0,
      stub: false
    };
  }

  /**
   * ESP 7: what arrived in this mailbox's inbox since `cursor` (a Gmail
   * historyId). Without a cursor — the first read, or one Google no longer
   * remembers (404) — the last two days of the inbox, and the cursor to go on
   * from. Messages come back raw (RFC 5322) for esp/inbound.mjs; our own sent
   * mail is left out. Reading only: `gmail.readonly` is enough.
   */
  async inboxSince(value, cursor = null) {
    const mailbox = normalizeMailbox(value);
    let ids = [];
    let next = null;
    let from = cursor;
    if (from) {
      try {
        let pageToken = null;
        do {
          const page = await this.call(mailbox, `/history?startHistoryId=${encodeURIComponent(from)}&historyTypes=messageAdded&labelId=INBOX${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
          for (const row of page.history || []) for (const added of row.messagesAdded || []) ids.push(added.message.id);
          next = page.historyId || next;
          pageToken = page.nextPageToken || null;
        } while (pageToken);
      } catch (error) {
        if (error.status !== 404) throw error;
        from = null;
        ids = [];
      }
    }
    if (!from) {
      next = (await this.call(mailbox, "/profile")).historyId;
      const list = await this.call(mailbox, `/messages?q=${encodeURIComponent("in:inbox newer_than:2d")}&maxResults=100`);
      ids = (list.messages || []).map((row) => row.id);
    }
    const messages = [];
    for (const id of [...new Set(ids)]) {
      const message = await this.call(mailbox, `/messages/${encodeURIComponent(id)}?format=raw`);
      const labels = message.labelIds || [];
      if (labels.includes("SENT") && !labels.includes("INBOX")) continue;
      messages.push({ id: message.id, threadId: message.threadId || null, raw: Buffer.from(message.raw || "", "base64url").toString("latin1") });
    }
    return { messages, cursor: String(next || cursor || "") || null };
  }

  /**
   * Mailbox warm-up: the letters our other mailboxes sent to this one in the
   * last few days, from every folder Spam included — Gmail's search skips Spam
   * and Trash unless asked. Headers only: the warm-up needs who, which letter
   * and where it landed, not the text.
   */
  async lettersFrom(value, senders, { newerThanDays = 3, inSpam = false } = {}) {
    const mailbox = normalizeMailbox(value);
    const from = [...new Set(senders.map((email) => normalizeMailbox(email)).filter((email) => email !== mailbox))];
    if (!from.length) return [];
    // `inSpam`: only what sits in Spam — the warm-up takes out every letter of ours there (15.10).
    const query = `${inSpam ? "in:spam " : ""}from:(${from.join(" OR ")}) newer_than:${Math.max(1, Number(newerThanDays) || 3)}d`;
    const list = await this.call(mailbox, `/messages?q=${encodeURIComponent(query)}&includeSpamTrash=true&maxResults=100`);
    const letters = [];
    for (const row of list.messages || []) {
      const message = await this.call(mailbox, `/messages/${encodeURIComponent(row.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=In-Reply-To`);
      letters.push({
        id: message.id, threadId: message.threadId || null, labels: message.labelIds || [],
        from: (metaHeader(message, "from").match(/<([^>]+)>/)?.[1] || metaHeader(message, "from")).trim().toLowerCase(),
        messageId: metaHeader(message, "message-id"), inReplyTo: metaHeader(message, "in-reply-to"), subject: metaHeader(message, "subject")
      });
    }
    return letters;
  }

  /**
   * Labels on one message: the warm-up's «not spam» and «important». With its
   * own `gmail.modify` token — a Workspace that has not allowed that scope gets
   * `no_modify_scope` here, and its sending and reading go on untouched.
   */
  async setLabels(value, id, { add = [], remove = [] } = {}) {
    const mailbox = normalizeMailbox(value);
    try {
      const message = await this.call(mailbox, `/messages/${encodeURIComponent(id)}/modify`, {
        method: "POST", body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove })
      }, WARMUP_SCOPES);
      return { id: message.id, labels: message.labelIds || [] };
    } catch (error) {
      if (error.code === "delegation_missing" || error.status === 403) {
        throw new MailboxError("Google не дає змінювати мітки: у делегуванні домену немає scope gmail.modify — без нього прогрів не виймає листи зі спаму (ESP_GMAIL_SETUP.md).", { code: "no_modify_scope", status: error.status ?? null });
      }
      throw error;
    }
  }

  /**
   * The Message-ID Gmail actually gave a sent message. Gmail replaces the one
   * in the raw letter with its own (13.10: a warm-up letter left as
   * <…@trafpush.com> and arrived as <CA…@mail.gmail.com>), so whoever matches
   * letters by Message-ID has to ask for the real one.
   */
  async messageIdOf(value, id) {
    const message = await this.call(normalizeMailbox(value), `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Message-ID`);
    return metaHeader(message, "message-id") || null;
  }

  /**
   * One finished RFC 5322 message (built by ESP 2/3), sent as `mailbox`. With
   * `threadId` Gmail keeps a follow-up in the conversation it continues.
   */
  async send(value, raw, { threadId = null } = {}) {
    const mailbox = normalizeMailbox(value);
    if (!this.liveSend) throw new SendingLocked();
    const body = { raw: Buffer.from(raw).toString("base64url"), ...(threadId ? { threadId } : {}) };
    const sent = await this.call(mailbox, "/messages/send", { method: "POST", body: JSON.stringify(body) });
    return { id: sent.id, threadId: sent.threadId, stub: false };
  }
}

/**
 * The stand-in until the owner hands over a key. It answers like Gmail and
 * keeps what it was given, so the layers above can be built and tested end to
 * end; it never reaches the network.
 */
export class StubGmailConnector {
  constructor({ domains = [] } = {}) {
    this.kind = "stub";
    this.domains = domains.map((domain) => String(domain).toLowerCase());
    this.sent = [];
    // ESP 7: what has "arrived" per mailbox — the tests put mail here.
    this.inboxes = new Map();
  }

  /**
   * A message arriving in `mailbox` (tests and the acceptance cycle on the
   * stub). `labels` is where it landed — `["SPAM"]` for the warm-up's tests.
   */
  deliver(value, raw, { threadId = null, labels = ["INBOX"] } = {}) {
    const mailbox = normalizeMailbox(value);
    if (!this.inboxes.has(mailbox)) this.inboxes.set(mailbox, []);
    const list = this.inboxes.get(mailbox);
    const message = { id: `in-${randomUUID()}`, threadId: threadId || `thread-${randomUUID()}`, raw: String(raw), labels: [...labels] };
    list.push(message);
    return message;
  }

  async inboxSince(value, cursor = null) {
    const list = (this.inboxes.get(normalizeMailbox(value)) || []);
    const from = Number(cursor) || 0;
    // Gmail's inbox read skips Spam; so does the stub's.
    return { messages: list.slice(from).filter((message) => !message.labels?.includes("SPAM")), cursor: String(list.length) };
  }

  async lettersFrom(value, senders, { inSpam = false } = {}) {
    const from = new Set(senders.map((email) => normalizeMailbox(email)));
    const read = (raw, name) => (String(raw).match(new RegExp(`^${name}:\\s*(.*)$`, "im")) || [])[1]?.trim() || "";
    return (this.inboxes.get(normalizeMailbox(value)) || []).map((message) => ({
      id: message.id, threadId: message.threadId, labels: [...(message.labels || [])],
      from: (read(message.raw, "From").match(/<([^>]+)>/)?.[1] || read(message.raw, "From")).toLowerCase(),
      messageId: read(message.raw, "Message-ID"), inReplyTo: read(message.raw, "In-Reply-To"), subject: read(message.raw, "Subject")
    })).filter((letter) => from.has(letter.from) && (!inSpam || letter.labels.includes("SPAM")));
  }

  async setLabels(value, id, { add = [], remove = [] } = {}) {
    const message = (this.inboxes.get(normalizeMailbox(value)) || []).find((row) => row.id === id);
    if (!message) throw new MailboxError("Заглушка: такого листа в пошті немає.", { code: "gmail_error", status: 404 });
    message.labels = [...new Set([...(message.labels || []).filter((label) => !remove.includes(label)), ...add])];
    return { id, labels: message.labels };
  }

  describe() {
    return { mode: "stub", serviceAccountEmail: null, clientId: null, scopes: GMAIL_SCOPES, warmupScopes: WARMUP_SCOPES, liveSend: false };
  }

  async checkMailbox(value) {
    const mailbox = normalizeMailbox(value);
    const domain = mailbox.split("@")[1];
    if (this.domains.length && !this.domains.includes(domain)) {
      throw new MailboxError("Заглушка: цей домен не серед підключених.", { code: "mailbox_rejected" });
    }
    return { ok: true, mailbox, address: mailbox, messagesTotal: 0, stub: true };
  }

  async messageIdOf(value, id) {
    const sent = this.sent.find((row) => row.id === id);
    return sent ? (String(sent.raw).match(/^Message-ID:\s*(.*)$/im) || [])[1]?.trim() || null : null;
  }

  async send(value, raw, { threadId = null } = {}) {
    const mailbox = normalizeMailbox(value);
    const id = `stub-${randomUUID()}`;
    const sent = { id, threadId: threadId || id, mailbox, raw: String(raw), at: new Date().toISOString() };
    this.sent.push(sent);
    return { id, threadId: sent.threadId, stub: true };
  }
}

/**
 * The connector this server runs with, from its environment:
 *
 * - `ESP_GMAIL_SERVICE_ACCOUNT_JSON` — the key file's contents (or
 *   `ESP_GMAIL_SERVICE_ACCOUNT_BASE64`, the same file base64-encoded, for hosts
 *   that mangle multi-line values). Absent: the stub.
 * - `ESP_LIVE_SEND=1` — the only way `send` reaches Google. Not set anywhere
 *   until ESP 11 is accepted.
 * - `ESP_STUB_DOMAINS` — comma-separated domains the stub accepts (optional).
 *
 * A key that does not parse is not quietly replaced by the stub: the error is
 * returned with it, so the screen can say the key is broken rather than
 * pretend no key was given.
 */
export function connectorFromEnv(env = process.env, { fetch = globalThis.fetch } = {}) {
  const raw = env.ESP_GMAIL_SERVICE_ACCOUNT_JSON
    || (env.ESP_GMAIL_SERVICE_ACCOUNT_BASE64 ? Buffer.from(env.ESP_GMAIL_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8") : "");
  const stub = () => new StubGmailConnector({ domains: String(env.ESP_STUB_DOMAINS || "").split(",").map((d) => d.trim()).filter(Boolean) });
  if (!raw.trim()) return { connector: stub(), keyError: null };
  try {
    return { connector: new GmailApiConnector({ serviceAccount: raw, fetch, liveSend: env.ESP_LIVE_SEND === "1" }), keyError: null };
  } catch (error) {
    return { connector: stub(), keyError: error.message };
  }
}
