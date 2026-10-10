import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  GMAIL_SCOPES, GmailApiConnector, MailboxError, SendingLocked, StubGmailConnector,
  connectorFromEnv, parseServiceAccount, signAssertion
} from "../esp/gmail.mjs";

/**
 * ESP 1 — the mailboxes through the Gmail API, one service account with
 * domain-wide delegation acting as each of them. Google is a fake here: a
 * function standing in for `fetch` that answers the token endpoint and the
 * Gmail API the way they answer, and records what it was asked.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = {
  type: "service_account",
  client_email: "esp-sender@advantage-esp.iam.gserviceaccount.com",
  client_id: "111222333444555666777",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  token_uri: "https://oauth2.googleapis.com/token"
};

function google({ token = () => ({ status: 200, body: { access_token: "ya29.token", expires_in: 3600 } }), gmail = () => ({ status: 200, body: {} }) } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const answer = url.startsWith("https://oauth2.googleapis.com/") ? token(init) : gmail(url, init);
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  };
  return { fetch, calls };
}

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

test("the assertion names the mailbox as its subject, asks only for send and read, and is signed by the key", () => {
  const account = parseServiceAccount(JSON.stringify(KEY));
  const jwt = signAssertion(account, { subject: "anna@advantage-mail.com", now: Date.UTC(2026, 9, 10, 9) });
  const [header, claims, signature] = jwt.split(".");
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  const body = decode(claims);
  assert.equal(body.iss, KEY.client_email);
  assert.equal(body.sub, "anna@advantage-mail.com");
  assert.equal(body.aud, "https://oauth2.googleapis.com/token");
  assert.equal(body.exp - body.iat, 3600);
  assert.deepEqual(body.scope.split(" "), GMAIL_SCOPES);
  assert.ok(!body.scope.includes("mail.google.com"), "full mailbox access is not asked for");
  const verify = createVerify("RSA-SHA256");
  verify.update(`${header}.${claims}`);
  assert.equal(verify.verify(publicKey, signature, "base64url"), true);
});

test("a key file that is not a service account's says what is wrong with it", () => {
  assert.throws(() => parseServiceAccount("{not json"), (error) => error.code === "key_not_json");
  assert.throws(() => parseServiceAccount(JSON.stringify({ ...KEY, type: "authorized_user" })), (error) => error.code === "key_wrong_type");
  assert.throws(() => parseServiceAccount(JSON.stringify({ ...KEY, private_key: "" })), (error) => error.code === "key_incomplete");
});

test("checking a mailbox reads its profile as that mailbox, and sends nothing", async () => {
  const { fetch, calls } = google({ gmail: () => ({ status: 200, body: { emailAddress: "Anna@Advantage-Mail.com", messagesTotal: 12 } }) });
  const connector = new GmailApiConnector({ serviceAccount: JSON.stringify(KEY), fetch });
  const result = await connector.checkMailbox(" Anna@Advantage-Mail.com ");
  assert.deepEqual(result, { ok: true, mailbox: "anna@advantage-mail.com", address: "anna@advantage-mail.com", messagesTotal: 12, stub: false });
  assert.equal(calls.length, 2);
  assert.equal(decode(new URLSearchParams(calls[0].init.body).get("assertion").split(".")[1]).sub, "anna@advantage-mail.com");
  assert.equal(calls[1].url, "https://gmail.googleapis.com/gmail/v1/users/me/profile");
  assert.equal(calls[1].init.method, undefined, "a GET");
  assert.equal(calls[1].init.headers.authorization, "Bearer ya29.token");
});

test("one token per mailbox, reused until a minute before it lapses", async () => {
  let clock = Date.UTC(2026, 9, 10, 9);
  let issued = 0;
  const { fetch, calls } = google({ token: () => ({ status: 200, body: { access_token: `t${++issued}`, expires_in: 3600 } }), gmail: () => ({ status: 200, body: { emailAddress: "x@d.com" } }) });
  const connector = new GmailApiConnector({ serviceAccount: KEY, fetch, now: () => clock });
  await connector.checkMailbox("a@d.com");
  await connector.checkMailbox("a@d.com");
  await connector.checkMailbox("b@d.com");
  assert.equal(calls.filter((call) => call.url.includes("oauth2")).length, 2, "a second token for the same mailbox");
  clock += 59 * 60_000 + 1;
  await connector.checkMailbox("a@d.com");
  assert.equal(calls.filter((call) => call.url.includes("oauth2")).length, 3, "a token on its last minute was used");
});

test("Google's two usual refusals come back as what to fix", async () => {
  const delegation = new GmailApiConnector({ serviceAccount: KEY, fetch: google({ token: () => ({ status: 401, body: { error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens using this method" } }) }).fetch });
  await assert.rejects(delegation.checkMailbox("a@d.com"), (error) => error instanceof MailboxError && error.code === "delegation_missing" && /делегування на рівні домену/.test(error.message));
  const unknown = new GmailApiConnector({ serviceAccount: KEY, fetch: google({ token: () => ({ status: 400, body: { error: "invalid_grant", error_description: "Invalid email or User ID" } }) }).fetch });
  await assert.rejects(unknown.checkMailbox("ghost@d.com"), (error) => error.code === "mailbox_rejected");
  await assert.rejects(unknown.checkMailbox("not an address"), (error) => error.code === "bad_mailbox");
});

/**
 * Manager, 10.10.2026: no real letter goes out before ESP 11 is accepted. The
 * real connector refuses to send unless it was built for it — before a token
 * is even asked for — so a key arriving early changes nothing.
 */
test("the real connector refuses to send unless built with liveSend, and asks Google for nothing", async () => {
  const { fetch, calls } = google();
  const connector = new GmailApiConnector({ serviceAccount: KEY, fetch });
  await assert.rejects(connector.send("anna@advantage-mail.com", "Subject: hi\r\n\r\nhello"), SendingLocked);
  assert.equal(calls.length, 0);
  assert.equal(connector.describe().liveSend, false);
});

test("with liveSend it posts the message base64url-encoded, in the thread it continues", async () => {
  const { fetch, calls } = google({ gmail: () => ({ status: 200, body: { id: "m-1", threadId: "t-9" } }) });
  const connector = new GmailApiConnector({ serviceAccount: KEY, fetch, liveSend: true });
  const raw = "From: anna@advantage-mail.com\r\nTo: lead@example.com\r\nSubject: Re: hi\r\n\r\nПривіт";
  assert.deepEqual(await connector.send("anna@advantage-mail.com", raw, { threadId: "t-9" }), { id: "m-1", threadId: "t-9", stub: false });
  const post = calls.at(-1);
  assert.equal(post.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal(post.init.method, "POST");
  const body = JSON.parse(post.init.body);
  assert.equal(Buffer.from(body.raw, "base64url").toString("utf8"), raw);
  assert.equal(body.threadId, "t-9");
});

test("the stub answers like Gmail, keeps what it was given, and never touches the network", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("the stub went to the network"); };
  try {
    const stub = new StubGmailConnector({ domains: ["advantage-mail.com"] });
    assert.equal((await stub.checkMailbox("anna@advantage-mail.com")).stub, true);
    await assert.rejects(stub.checkMailbox("anna@elsewhere.com"), (error) => error.code === "mailbox_rejected");
    const first = await stub.send("anna@advantage-mail.com", "Subject: a\r\n\r\nb");
    const follow = await stub.send("anna@advantage-mail.com", "Subject: Re: a\r\n\r\nc", { threadId: first.threadId });
    assert.equal(follow.threadId, first.threadId);
    assert.equal(stub.sent.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the environment picks the connector: no key — the stub; a key — Gmail, still locked; a broken key — said, not hidden", () => {
  assert.equal(connectorFromEnv({}).connector.kind, "stub");
  const real = connectorFromEnv({ ESP_GMAIL_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY) }).connector;
  assert.equal(real.kind, "gmail");
  assert.equal(real.describe().liveSend, false);
  assert.equal(real.describe().serviceAccountEmail, KEY.client_email);
  assert.equal(JSON.stringify(real.describe()).includes("PRIVATE KEY"), false, "the key never leaves in a description");
  const base64 = connectorFromEnv({ ESP_GMAIL_SERVICE_ACCOUNT_BASE64: Buffer.from(JSON.stringify(KEY)).toString("base64") }).connector;
  assert.equal(base64.kind, "gmail");
  assert.equal(connectorFromEnv({ ESP_GMAIL_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY), ESP_LIVE_SEND: "1" }).connector.liveSend, true);
  const broken = connectorFromEnv({ ESP_GMAIL_SERVICE_ACCOUNT_JSON: "{oops" });
  assert.equal(broken.connector.kind, "stub");
  assert.match(broken.keyError, /не JSON/);
});
