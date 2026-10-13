import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleEspApi } from "../esp/api.mjs";
import { StubGmailConnector } from "../esp/gmail.mjs";
import { GmailOAuthConnector, NotConnectedConnector, OAUTH_SCOPES, authorizeUrl, googleSignIn, grantStore, oauthConfigFromEnv, redirectUriFor } from "../esp/google-oauth.mjs";
import { useJournal } from "../esp/journal.mjs";
import { MicrosoftGraphConnector, providerRouter } from "../esp/provider.mjs";
import { registry } from "../esp/registry.mjs";
import { isAuthFailure } from "../esp/senders.mjs";

/**
 * «Увійти через Google» (власник 13.10: «роби функціонал»): скринька
 * підключається так, як в Instantly і Snov — кнопка, вікно Google, «Дозволити».
 * Пароля система не бачить; токен скриньки зберігається зашифрованим.
 */

const KEY = randomBytes(32);
const encrypt = (text) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const encryptedValue = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
  return { encryptedValue, iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
};
const decrypt = (record) => {
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.encryptedValue, "base64")), decipher.final()]).toString("utf8");
};

const GMAIL_SCOPE_TEXT = "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify";
const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

/** Google as far as these tests need it: the token endpoint, the profile, sending, revoking. */
function fakeGoogle({ email = "anna@advantage-send.com", scope = GMAIL_SCOPE_TEXT, refreshFails = false } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? String(init.body) : "";
    calls.push({ url: String(url), method: init.method || "GET", body, auth: init.headers?.authorization || null });
    const json = (status, payload) => ({ ok: status < 300, status, json: async () => payload });
    if (String(url).endsWith("/token")) {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code") {
        return json(200, { access_token: "access-1", refresh_token: "refresh-SECRET-1", expires_in: 3600, scope, id_token: idToken({ name: "Anna Koval", email }) });
      }
      if (refreshFails) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      return json(200, { access_token: `access-from-${form.get("refresh_token")}`, expires_in: 3600 });
    }
    if (String(url).endsWith("/profile")) return json(200, { emailAddress: email, messagesTotal: 12, historyId: "1" });
    if (String(url).endsWith("/messages/send")) return json(200, { id: "m-1", threadId: "t-1" });
    if (String(url).includes("/revoke")) return json(200, {});
    return json(404, { error: { message: "not here" } });
  };
  return { fetch, calls };
}

const CONFIG = oauthConfigFromEnv({ ESP_GOOGLE_OAUTH_CLIENT_ID: "client-1.apps.googleusercontent.com", ESP_GOOGLE_OAUTH_CLIENT_SECRET: "secret-1", PUBLIC_URL: "https://outbound.example.com/" });

function setup({ google = fakeGoogle(), liveSend = true } = {}) {
  let saved = {};
  const grants = grantStore({ read: () => saved, write: async (value) => { saved = value; }, encrypt, decrypt });
  const signIn = googleSignIn({ config: CONFIG, fetch: google.fetch });
  const connector = new GmailOAuthConnector({ signIn, grants, fetch: google.fetch, liveSend });
  return { grants, signIn, connector, google, saved: () => saved };
}

test("the button sends the browser to Google with mail scopes, offline access and the consent screen", () => {
  assert.equal(CONFIG.redirectUri, "https://outbound.example.com/api/esp/oauth/google/callback");
  const url = new URL(authorizeUrl({ clientId: CONFIG.clientId, redirectUri: CONFIG.redirectUri, state: "s-1", loginHint: "anna@advantage-send.com" }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.match(url.searchParams.get("prompt"), /consent/);
  assert.deepEqual(url.searchParams.get("scope").split(" "), OAUTH_SCOPES);
  assert.equal(url.searchParams.get("login_hint"), "anna@advantage-send.com");
  // Without PUBLIC_URL the callback is this server's own, from the request.
  const bare = oauthConfigFromEnv({ ESP_GOOGLE_OAUTH_CLIENT_ID: "a", ESP_GOOGLE_OAUTH_CLIENT_SECRET: "b" });
  assert.equal(redirectUriFor(bare, { headers: { "x-forwarded-proto": "https", host: "outbound-sales.example.io" } }), "https://outbound-sales.example.io/api/esp/oauth/google/callback");
  assert.deepEqual(oauthConfigFromEnv({}).missing, ["ESP_GOOGLE_OAUTH_CLIENT_ID", "ESP_GOOGLE_OAUTH_CLIENT_SECRET"]);
});

test("a sign-in's state works once, for the person who started it", () => {
  const { signIn } = setup();
  const { state } = signIn.start({ user: "olena@advantage-agency.co", redirectUri: CONFIG.redirectUri });
  assert.equal(signIn.take(state).user, "olena@advantage-agency.co");
  assert.equal(signIn.take(state), null, "a second use finds nothing");
  assert.throws(() => googleSignIn({ config: oauthConfigFromEnv({}) }).start({ user: "x", redirectUri: "https://x" }), /не налаштовано/);
});

test("the code becomes the mailbox's grant — the refresh token stored only encrypted — and Gmail works on it", async () => {
  const { signIn, grants, connector, google, saved } = setup();
  const signed = await signIn.finish({ code: "code-1", redirectUri: CONFIG.redirectUri });
  assert.equal(signed.email, "anna@advantage-send.com");
  assert.equal(signed.name, "Anna Koval");
  await grants.put({ ...signed, connectedBy: "olena@advantage-agency.co" });
  assert.equal(JSON.stringify(saved()).includes("refresh-SECRET-1"), false, "the token is not in the state in clear");
  assert.equal(JSON.stringify(grants.list()).includes("refresh"), false, "the list carries no token at all");
  assert.equal(grants.refreshToken("anna@advantage-send.com"), "refresh-SECRET-1");

  const sent = await connector.send("anna@advantage-send.com", "From: anna@advantage-send.com\r\nTo: x@y.com\r\nSubject: hi\r\n\r\nhello");
  assert.equal(sent.id, "m-1");
  const send = google.calls.find((call) => call.url.endsWith("/messages/send"));
  assert.equal(send.auth, "Bearer access-from-refresh-SECRET-1");
  assert.equal((await connector.checkMailbox("anna@advantage-send.com")).address, "anna@advantage-send.com");
  assert.equal(google.calls.filter((call) => call.url.endsWith("/token") && call.body.includes("refresh_token")).length, 1, "the hour's token is reused");
});

test("access withdrawn at Google: the grant is marked broken and the gate pauses the mailbox", async () => {
  const { signIn, grants, connector } = setup({ google: fakeGoogle({ refreshFails: true }) });
  await grants.put({ ...(await signIn.finish({ code: "c", redirectUri: CONFIG.redirectUri })), connectedBy: "olena@advantage-agency.co" });
  const error = await connector.send("anna@advantage-send.com", "raw").catch((caught) => caught);
  assert.equal(error.code, "oauth_revoked");
  assert.match(error.message, /увійдіть через Google ще раз/);
  assert.equal(isAuthFailure(error), true, "the sender gate pauses on it, as on a lost delegation");
  assert.equal(grants.view("anna@advantage-send.com").status, "broken");
});

test("without the mail checkboxes ticked in Google's window, nothing is connected and the person is told why", async () => {
  const { signIn } = setup({ google: fakeGoogle({ scope: "openid email" }) });
  const error = await signIn.finish({ code: "c", redirectUri: CONFIG.redirectUri }).catch((caught) => caught);
  assert.equal(error.code, "oauth_scopes");
});

test("each mailbox to its own connection: signed-in ones to Google, the rest as before; live sending never lets the stub pretend", async () => {
  const { grants, signIn, connector: signedIn } = setup();
  await grants.put({ ...(await signIn.finish({ code: "c", redirectUri: CONFIG.redirectUri })), connectedBy: "o" });
  const stub = new StubGmailConnector();
  const router = providerRouter({
    connectors: { gmail: stub, google_oauth: signedIn, microsoft: new MicrosoftGraphConnector() },
    providerOf: (mailbox) => (grants.has(mailbox) ? "google_oauth" : "gmail"),
    primary: () => (grants.count() ? "google_oauth" : "gmail")
  });
  assert.equal(router.providerOf("anna@advantage-send.com"), "gmail_oauth");
  assert.equal(router.providerOf("boris@advantage-send.com"), "stub");
  assert.equal(router.describe().mode, "gmail_oauth", "the screens stop saying «заглушка» once a mailbox is in");
  assert.equal(router.liveSend, true);
  const refused = await new NotConnectedConnector().send("boris@advantage-send.com").catch((caught) => caught);
  assert.equal(refused.code, "not_connected");
  assert.equal(isAuthFailure(refused), true);
});

// ── the routes ────────────────────────────────────────────────────────────

const OLENA = { email: "olena@advantage-agency.co", role: "seller" };
const PAVLO = { email: "pavlo@advantage-agency.co", role: "admin" };

async function routes(t) {
  const dir = await mkdtemp(join(tmpdir(), "esp-oauth-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  const world = setup();
  const esp = {
    connector: world.connector,
    oauth: { config: CONFIG, signIn: world.signIn, grants: world.grants, connector: world.connector, redirectUri: () => CONFIG.redirectUri }
  };
  const call = async (method, pathAndQuery, { body = {}, profile = OLENA } = {}) => {
    let captured = null;
    const response = { writeHead: (status, headers) => { captured = { status, location: headers.Location }; }, end: () => {} };
    await handleEspApi({
      request: { method, auth: { profile }, headers: {} }, response, url: new URL(`http://x/api/esp${pathAndQuery}`),
      sendJson: (_response, status, payload) => { captured = { status, payload }; }, readJson: async () => body, esp
    });
    return captured;
  };
  return { call, world };
}

test("a seller connects their own mailbox: back on «Скриньки», the domain in «рампа», the mailbox a sender", async (t) => {
  const { call } = await routes(t);
  const started = await call("POST", "/oauth/google/start", { body: { mailbox: "anna@advantage-send.com" } });
  assert.equal(started.status, 200);
  const state = new URL(started.payload.url).searchParams.get("state");

  const back = await call("GET", `/oauth/google/callback?state=${state}&code=code-1`);
  assert.equal(back.status, 302);
  assert.equal(back.location, "/#mail-settings/mailbox/ok/anna%40advantage-send.com");
  const { domains, senders } = await registry();
  assert.equal(domains.find((row) => row.domain === "advantage-send.com").status, "ramp");
  const sender = senders.find((row) => row.email === "anna@advantage-send.com");
  assert.equal(sender.rampStage, 5);
  assert.equal(sender.person, "olena@advantage-agency.co");

  const list = await call("GET", "/oauth/google");
  assert.deepEqual(list.payload.mailboxes.map((row) => [row.email, row.connectedBy, row.status, row.sender.status]), [["anna@advantage-send.com", "olena@advantage-agency.co", "connected", "active"]]);
  assert.equal(JSON.stringify(list.payload).includes("refresh-SECRET-1"), false);

  const reused = await call("GET", `/oauth/google/callback?state=${state}&code=code-1`);
  assert.match(decodeURIComponent(reused.location), /mailbox\/error\/Вхід застарів/);
});

test("a refusal in Google's window, or somebody else's sign-in, comes back as words and connects nothing", async (t) => {
  const { call, world } = await routes(t);
  const first = new URL((await call("POST", "/oauth/google/start")).payload.url).searchParams.get("state");
  const denied = await call("GET", `/oauth/google/callback?state=${first}&error=access_denied`);
  assert.match(decodeURIComponent(denied.location), /mailbox\/error\/Доступ у вікні Google не дали/);
  const second = new URL((await call("POST", "/oauth/google/start")).payload.url).searchParams.get("state");
  const stranger = await call("GET", `/oauth/google/callback?state=${second}&code=c`, { profile: PAVLO });
  assert.match(decodeURIComponent(stranger.location), /інший користувач/);
  assert.equal(world.grants.count(), 0);
});

test("«Відключити»: somebody else's only by an admin; the token is revoked and the sender paused, not deleted", async (t) => {
  const { call, world } = await routes(t);
  const state = new URL((await call("POST", "/oauth/google/start")).payload.url).searchParams.get("state");
  await call("GET", `/oauth/google/callback?state=${state}&code=c`);
  const other = await call("POST", "/oauth/google/disconnect", { body: { mailbox: "anna@advantage-send.com" }, profile: { email: "ivan@advantage-agency.co", role: "seller" } });
  assert.equal(other.status, 403);
  const done = await call("POST", "/oauth/google/disconnect", { body: { mailbox: "anna@advantage-send.com" }, profile: PAVLO });
  assert.equal(done.status, 200);
  assert.deepEqual(done.payload.mailboxes, []);
  assert.ok(world.google.calls.some((call) => call.url.includes("/revoke")), "Google is told to forget the token too");
  const sender = (await registry()).senders.find((row) => row.email === "anna@advantage-send.com");
  assert.equal(sender.status, "paused");

  // Signing in again lifts that pause.
  const again = new URL((await call("POST", "/oauth/google/start")).payload.url).searchParams.get("state");
  await call("GET", `/oauth/google/callback?state=${again}&code=c`);
  assert.equal((await registry()).senders.find((row) => row.email === "anna@advantage-send.com").status, "active");
});
