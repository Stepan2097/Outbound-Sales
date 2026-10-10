import assert from "node:assert/strict";
import test from "node:test";

import { composeLetter } from "../esp/compose.mjs";
import { LetterError, assertPlainLetter } from "../esp/letter.mjs";
import { prepareTemplate } from "../esp/template.mjs";
import { firstSubject, followUpOf, replySubject } from "../esp/thread.mjs";
import { handleUnsubscribe, readUnsubscribe, signUnsubscribe, unsubscribeHeaders, unsubscribeSecretFromEnv } from "../esp/unsubscribe.mjs";

/**
 * ESP 3 — List-Unsubscribe on the sender's own domain, and follow-ups in the
 * same thread from the same mailbox.
 */

const SECRET = "test-unsubscribe-secret-0123456789";
const SENDER = { email: "anna@advantage-mail.com", name: "Anna Koval", title: "Partnerships", site: "advantage.agency" };
const LEAD = { email: "olena@northwind.com", name: "Olena Hrytsenko", company: "Northwind", country: "Poland" };
const head = (raw) => raw.slice(0, raw.indexOf("\r\n\r\n")).replace(/\r\n /g, " ").split("\r\n");
const header = (raw, name) => (head(raw).find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`)) || "").slice(name.length + 1).trim();

// ── List-Unsubscribe ─────────────────────────────────────────────────────────

test("List-Unsubscribe is mailto the sending mailbox and https on its domain, with One-Click", () => {
  const headers = unsubscribeHeaders({ sender: "Anna@Advantage-Mail.com", recipient: "olena@northwind.com", secret: SECRET });
  const [mailto, https] = headers["List-Unsubscribe"].split(", ");
  assert.equal(mailto, "<mailto:anna@advantage-mail.com?subject=unsubscribe>");
  const url = new URL(https.slice(1, -1));
  assert.equal(url.protocol, "https:");
  assert.equal(url.host, "advantage-mail.com");
  assert.match(url.pathname, /^\/u\/[\w-]+\.[\w-]+$/);
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.deepEqual(readUnsubscribe(url.pathname.slice(3), SECRET), { sender: "anna@advantage-mail.com", recipient: "olena@northwind.com", campaignId: null });
});

test("a link base on the sender's subdomain is fine; on any other domain, or not https, the letter is not built", () => {
  const sub = unsubscribeHeaders({ sender: "anna@advantage-mail.com", recipient: "o@n.com", secret: SECRET, base: "https://go.advantage-mail.com" });
  assert.match(sub["List-Unsubscribe"], /<https:\/\/go\.advantage-mail\.com\/u\//);
  assert.throws(() => unsubscribeHeaders({ sender: "anna@advantage-mail.com", recipient: "o@n.com", secret: SECRET, base: "https://tracking.example.com" }), (error) => error instanceof LetterError && error.code === "unsubscribe_foreign_domain");
  assert.throws(() => unsubscribeHeaders({ sender: "anna@advantage-mail.com", recipient: "o@n.com", secret: SECRET, base: "https://evil-advantage-mail.com" }), (error) => error.code === "unsubscribe_foreign_domain", "a look-alike suffix is another domain");
  assert.throws(() => unsubscribeHeaders({ sender: "anna@advantage-mail.com", recipient: "o@n.com", secret: SECRET, base: "http://advantage-mail.com" }), (error) => error.code === "unsubscribe_foreign_domain");
  assert.throws(() => unsubscribeHeaders({ sender: "anna@advantage-mail.com", recipient: "o@n.com", secret: "" }), (error) => error.code === "unsubscribe_secret_missing");
});

test("a link this server did not sign, or that somebody edited, unsubscribes nobody", () => {
  const token = signUnsubscribe({ sender: "anna@advantage-mail.com", recipient: "olena@northwind.com" }, SECRET);
  assert.equal(readUnsubscribe(token, "another-secret-0123456789abcdef"), null);
  const [payload, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, s: "anna@advantage-mail.com", r: "ceo@northwind.com" })).toString("base64url");
  assert.equal(readUnsubscribe(`${forged}.${signature}`, SECRET), null);
  assert.equal(readUnsubscribe(`${payload}.`, SECRET), null);
  assert.equal(readUnsubscribe("nonsense", SECRET), null);
});

test("the signing key comes from the environment; without one it is random and said to be", () => {
  assert.deepEqual(unsubscribeSecretFromEnv({ ESP_UNSUBSCRIBE_SECRET: SECRET }), { secret: SECRET, ephemeral: false });
  const random = unsubscribeSecretFromEnv({});
  assert.equal(random.ephemeral, true);
  assert.ok(random.secret.length >= 32);
});

function exchange(method, path, body = "") {
  const recorded = [];
  const answer = { status: 0, headers: {}, body: "" };
  const response = { writeHead: (status, headers = {}) => { answer.status = status; answer.headers = headers; }, end: (text = "") => { answer.body = String(text); } };
  return handleUnsubscribe({
    request: { method }, response, url: new URL(`https://advantage-mail.com${path}`),
    readBody: async () => body, secret: SECRET, record: async (row) => { recorded.push(row); }
  }).then((handled) => ({ handled, answer, recorded }));
}

test("One-Click POST unsubscribes at once; opening the link only asks — a link scanner unsubscribes nobody", async () => {
  const token = signUnsubscribe({ sender: "anna@advantage-mail.com", recipient: "olena@northwind.com", campaignId: "c-1" }, SECRET);
  const opened = await exchange("GET", `/u/${token}`);
  assert.equal(opened.answer.status, 200);
  assert.match(opened.answer.body, /<form method="post">/);
  assert.equal(opened.recorded.length, 0, "opening the link unsubscribed somebody");

  const clicked = await exchange("POST", `/u/${token}`, "List-Unsubscribe=One-Click");
  assert.equal(clicked.answer.status, 200);
  assert.deepEqual(clicked.recorded, [{ sender: "anna@advantage-mail.com", recipient: "olena@northwind.com", campaignId: "c-1", via: "one-click" }]);
  assert.equal(clicked.answer.headers["cache-control"], "no-store");

  const forged = await exchange("POST", `/u/${token.slice(0, -2)}xx`, "List-Unsubscribe=One-Click");
  assert.equal(forged.answer.status, 404);
  assert.equal(forged.recorded.length, 0);
  assert.equal((await exchange("GET", "/somewhere-else")).handled, false);
});

// ── threads ─────────────────────────────────────────────────────────────────

test("a first letter may not pretend to be a reply", () => {
  for (const subject of ["Re: our call", "RE:hello", "Fwd: deck", "Відп: питання", "Re[2]: x"]) {
    assert.throws(() => firstSubject(subject), (error) => error.code === "fake_reply", subject);
  }
  assert.equal(firstSubject("Northwind and us"), "Northwind and us");
  assert.equal(firstSubject("Results: Q3"), "Results: Q3", "a colon is not a reply prefix");
});

test("a follow-up answers the letter before it, carries the whole chain, keeps the thread and the first subject", () => {
  const first = { sender: "anna@advantage-mail.com", subject: "Northwind and us", messageId: "<m1@advantage-mail.com>", references: [], threadId: "t-1" };
  const second = followUpOf(first, "anna@advantage-mail.com");
  assert.deepEqual(second.headers, { "In-Reply-To": "<m1@advantage-mail.com>", References: "<m1@advantage-mail.com>" });
  assert.equal(second.subject, "Re: Northwind and us");
  assert.equal(second.threadId, "t-1");
  const third = followUpOf({ ...first, subject: second.subject, messageId: "<m2@advantage-mail.com>", references: second.references }, "anna@advantage-mail.com");
  assert.equal(third.headers.References, "<m1@advantage-mail.com> <m2@advantage-mail.com>");
  assert.equal(third.headers["In-Reply-To"], "<m2@advantage-mail.com>");
  assert.equal(third.subject, "Re: Northwind and us", "not «Re: Re:»");
  assert.equal(replySubject("RE: Fwd: x"), "Re: x");
});

test("a follow-up from another mailbox is refused — the whole chain goes from one sender", () => {
  const first = { sender: "anna@advantage-mail.com", subject: "Hi", messageId: "<m1@advantage-mail.com>", threadId: "t-1" };
  assert.throws(() => followUpOf(first, "boris@advantage-mail.com"), (error) => error.code === "other_sender");
  assert.throws(() => followUpOf({ sender: "anna@advantage-mail.com" }, "anna@advantage-mail.com"), (error) => error.code === "no_previous");
});

// ── the whole letter ────────────────────────────────────────────────────────

test("composed: the first letter has its own subject and the unsubscribe headers; the follow-up is in its thread", () => {
  const opening = prepareTemplate({ subject: "{{company}} and us", body: "Hi {{first_name}}, a question." });
  const nudge = prepareTemplate({ subject: "whatever the template says", body: "{{first_name}}, a nudge." });
  const unsubscribe = { secret: SECRET };
  const first = composeLetter({ template: opening, sender: SENDER, lead: LEAD, unsubscribe, campaignId: "c-1" });
  assert.equal(first.ok, true);
  assert.equal(first.subject, "Northwind and us");
  assert.equal(header(first.raw, "In-Reply-To"), "");
  assert.match(header(first.raw, "List-Unsubscribe"), /^<mailto:anna@advantage-mail\.com\?subject=unsubscribe>, <https:\/\/advantage-mail\.com\/u\//);
  assert.equal(header(first.raw, "List-Unsubscribe-Post"), "List-Unsubscribe=One-Click");
  assert.equal(header(first.raw, "Message-ID"), first.messageId);
  assert.equal(assertPlainLetter(first.raw), true);

  const previous = { sender: SENDER.email, subject: first.subject, messageId: first.messageId, references: first.references, threadId: "gmail-thread-7" };
  const second = composeLetter({ template: nudge, sender: SENDER, lead: LEAD, previous, unsubscribe, campaignId: "c-1" });
  assert.equal(second.ok, true);
  assert.equal(second.subject, "Re: Northwind and us");
  assert.equal(header(second.raw, "In-Reply-To"), first.messageId);
  assert.equal(header(second.raw, "References"), first.messageId);
  assert.equal(second.threadId, "gmail-thread-7");
  assert.notEqual(second.messageId, first.messageId);
  assert.ok(header(second.raw, "List-Unsubscribe"), "a follow-up carries the way out too");
  assert.equal(assertPlainLetter(second.raw), true);

  const otherSender = composeLetter({ template: nudge, sender: { ...SENDER, email: "boris@advantage-mail.com" }, lead: LEAD, previous, unsubscribe });
  assert.deepEqual([otherSender.ok, otherSender.reason], [false, "other_sender"]);
  const noName = composeLetter({ template: opening, sender: SENDER, lead: { ...LEAD, name: "" }, unsubscribe });
  assert.deepEqual([noName.ok, noName.reason], [false, "empty_variable"]);
});
