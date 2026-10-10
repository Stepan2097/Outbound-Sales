import assert from "node:assert/strict";
import test from "node:test";

import { MailboxError, SendingLocked, StubGmailConnector } from "../esp/gmail.mjs";
import { SenderGate, SenderPaused, isAuthFailure, stateSenderStore } from "../esp/senders.mjs";

/**
 * Checklist, ESP 1 (P0): «Відкликаний токен = пауза сендера — помилка
 * авторизації чи блок акаунта → сендер на паузу, сповіщення людині. Не
 * повторювати спроби в циклі.»
 */

function gateWith(connector) {
  let saved = {};
  const writes = [];
  const notices = [];
  const store = stateSenderStore({ read: () => saved, write: async (value) => { saved = value; writes.push(value); } });
  const gate = new SenderGate({ connector, store, notify: async (pause) => { notices.push(pause); }, now: () => new Date("2026-10-10T08:00:00Z") });
  return { gate, notices, writes, saved: () => saved };
}

const refusing = (error) => {
  const connector = { attempts: 0, async send() { connector.attempts += 1; throw error; } };
  return connector;
};

test("Google refusing the mailbox pauses it, tells a person once, and the next send is refused without asking Google", async () => {
  const connector = refusing(new MailboxError("Google не дає діяти від імені скриньки", { code: "delegation_missing", status: 401 }));
  const { gate, notices, saved } = gateWith(connector);
  await assert.rejects(gate.send("Anna@Advantage-Mail.com", "raw"), (error) => error instanceof SenderPaused && error.pause.code === "delegation_missing");
  assert.equal(saved()["anna@advantage-mail.com"].reason, "Google не дає діяти від імені скриньки");
  assert.equal(saved()["anna@advantage-mail.com"].at, "2026-10-10T08:00:00.000Z");
  assert.equal(notices.length, 1);

  await assert.rejects(gate.send("anna@advantage-mail.com", "raw"), SenderPaused);
  await assert.rejects(gate.send("anna@advantage-mail.com", "raw"), SenderPaused);
  assert.equal(connector.attempts, 1, "a paused mailbox was tried again");
  assert.equal(notices.length, 1, "the person was told more than once");
});

test("a revoked token (401) and a suspended account (403) pause; load (429, 5xx) and our own lock do not", () => {
  assert.equal(isAuthFailure(new MailboxError("x", { code: "gmail_error", status: 401 })), true);
  assert.equal(isAuthFailure(new MailboxError("x", { code: "gmail_error", status: 403 })), true);
  assert.equal(isAuthFailure(new MailboxError("x", { code: "mailbox_rejected", status: 400 })), true);
  assert.equal(isAuthFailure(new MailboxError("x", { code: "gmail_error", status: 429 })), false);
  assert.equal(isAuthFailure(new MailboxError("x", { code: "gmail_error", status: 503 })), false);
  assert.equal(isAuthFailure(new SendingLocked()), false);
  assert.equal(isAuthFailure(new Error("socket hang up")), false);
});

test("a failure that is not about authorisation goes back to the caller and pauses nothing", async () => {
  const connector = refusing(new MailboxError("Gmail API відповів 503", { code: "gmail_error", status: 503 }));
  const { gate, saved, notices } = gateWith(connector);
  await assert.rejects(gate.send("anna@advantage-mail.com", "raw"), (error) => error.code === "gmail_error");
  assert.deepEqual(saved(), {});
  assert.equal(notices.length, 0);
});

test("only a person lifts the pause, and then the mailbox sends again", async () => {
  const stub = new StubGmailConnector();
  let refuse = true;
  const connector = { async send(...args) { if (refuse) throw new MailboxError("revoked", { code: "gmail_error", status: 401 }); return stub.send(...args); } };
  const { gate } = gateWith(connector);
  await assert.rejects(gate.send("anna@advantage-mail.com", "raw"), SenderPaused);
  refuse = false;
  await assert.rejects(gate.send("anna@advantage-mail.com", "raw"), SenderPaused, "fixed on Google's side, but nobody lifted the pause");
  assert.equal(await gate.resume("anna@advantage-mail.com"), true);
  assert.equal((await gate.send("anna@advantage-mail.com", "raw")).stub, true);
  assert.deepEqual(await gate.paused(), []);
});

test("a second failure keeps the first reason — the sentence that started the pause", async () => {
  let saved = { "anna@advantage-mail.com": { code: "delegation_missing", reason: "перша причина", at: "x" } };
  const store = stateSenderStore({ read: () => saved, write: async (value) => { saved = value; } });
  await store.pause("anna@advantage-mail.com", { code: "gmail_error", reason: "друга", at: "y" });
  assert.equal(saved["anna@advantage-mail.com"].reason, "перша причина");
});
