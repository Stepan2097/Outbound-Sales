import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { espRouteRight, handleEspApi } from "../esp/api.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { UNIBOX_PAGE, uniboxList, uniboxMarks, uniboxProblems, uniboxThread } from "../esp/unibox.mjs";

/**
 * ESP-UI 4 — the cold-email Unibox: folders as Snov's (Вхідні, Надіслані,
 * Із зірочкою, Bounce), filters, pages of 50, stars and «read» as journal lines.
 */

let dir;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "esp-unibox-"));
  useJournal(join(dir, "esp-journal.jsonl"));
});
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

let seq = 0;
const at = (minute) => new Date(Date.UTC(2026, 9, 12, 8, minute)).toISOString();
function letter(from, to, minute, { campaignId = "c1", subject = "uk traffic", text = "Hi there", step = 0 } = {}) {
  seq += 2;
  return [
    { seq: seq - 1, at: at(minute), type: "message.sending", contact: to, data: { from, campaignId, step, subject, text, headers: { "Message-ID": `<m${seq}@x>` } } },
    { seq, at: at(minute), type: "message.sent", contact: to, data: { from, campaignId, step, sendingSeq: seq - 1 } }
  ];
}
const inbound = (type, from, to, minute, data = {}) => ({ seq: ++seq, at: at(minute), type, contact: to, data: { sender: from, campaignId: "c1", ...data } });

function world() {
  seq = 0;
  return [
    ...letter("anna@send.com", "olga@acme.com", 1),
    inbound("message.replied", "anna@send.com", "olga@acme.com", 5, { text: "Yes, call me Tuesday", gmailId: "g1", label: "positive" }),
    ...letter("anna@send.com", "ivan@beta.com", 2, { subject: "a question" }),
    inbound("message.bounced", "anna@send.com", "ivan@beta.com", 3, { code: "5.1.1" }),
    ...letter("boris@send.com", "kate@gamma.com", 4, { campaignId: "c2" }),
    ...letter("boris@send.com", "max@delta.com", 6, { campaignId: "c2" }),
    inbound("message.replied", "boris@send.com", "max@delta.com", 9, { text: "Not interested", gmailId: "g2", label: "negative" })
  ];
}

const LEADS = new Map([["olga@acme.com", { name: "Olga Shevchenko", company: "Acme" }]]);
const CAMPAIGNS = new Map([["c1", "UK operators"], ["c2", "Affiliates"]]);

test("папки як у Snov: Вхідні — щось повернулось; Надіслані — усі розмови; Bounce — недоставлені; новіші зверху", () => {
  const inboxList = uniboxList(world(), { leads: LEADS, campaigns: CAMPAIGNS });
  assert.deepEqual(inboxList.rows.map((row) => row.contact), ["max@delta.com", "olga@acme.com", "ivan@beta.com"]);
  assert.deepEqual(inboxList.counts, { inbox: 3, unread: 3, sent: 4, starred: 0, bounced: 1 });
  const olga = inboxList.rows.find((row) => row.contact === "olga@acme.com");
  assert.deepEqual([olga.name, olga.company, olga.campaignName, olga.count, olga.label, olga.snippet], ["Olga Shevchenko", "Acme", "UK operators", 2, "positive", "Yes, call me Tuesday"]);
  assert.equal(inboxList.rows.find((row) => row.contact === "ivan@beta.com").snippet, "Лист не доставлено (5.1.1)");
  assert.equal(uniboxList(world(), { folder: "sent" }).total, 4, "kate не відповіла — лише в Надісланих");
  assert.deepEqual(uniboxList(world(), { folder: "bounced" }).rows.map((row) => row.contact), ["ivan@beta.com"]);
});

test("фільтри: мітка відповіді, непрочитані, кампанія, скринька, пошук по імені, темі й тексту листів", () => {
  const entries = world();
  assert.deepEqual(uniboxList(entries, { label: "positive" }).rows.map((row) => row.contact), ["olga@acme.com"]);
  assert.deepEqual(uniboxList(entries, { campaign: "c2" }).rows.map((row) => row.contact), ["max@delta.com"]);
  assert.deepEqual(uniboxList(entries, { sender: "anna@send.com" }).rows.map((row) => row.contact), ["olga@acme.com", "ivan@beta.com"]);
  assert.deepEqual(uniboxList(entries, { q: "tuesday" }).rows.map((row) => row.contact), ["olga@acme.com"]);
  assert.deepEqual(uniboxList(entries, { q: "shevchenko", leads: LEADS }).rows.map((row) => row.contact), ["olga@acme.com"]);
  assert.deepEqual(uniboxList(entries, { folder: "sent", q: "a question" }).rows.map((row) => row.contact), ["ivan@beta.com"]);
  assert.deepEqual(uniboxList(entries, { campaigns: CAMPAIGNS }).campaigns, [{ id: "c2", name: "Affiliates" }, { id: "c1", name: "UK operators" }]);
});

test("сторінки по 50: 1–50 із N, наступна; сторінка, якої вже немає, — остання", () => {
  seq = 0;
  const entries = [];
  for (let n = 0; n < 120; n += 1) {
    entries.push(...letter("anna@send.com", `p${n}@x.com`, 1), inbound("message.replied", "anna@send.com", `p${n}@x.com`, 2, { text: `reply ${n}` }));
  }
  const first = uniboxList(entries);
  assert.deepEqual([first.total, first.offset, first.rows.length, first.limit], [120, 0, UNIBOX_PAGE, 50]);
  const third = uniboxList(entries, { offset: 100 });
  assert.deepEqual([third.offset, third.rows.length], [100, 20]);
  assert.equal(uniboxList(entries, { offset: 9999 }).offset, 100);
  assert.equal(uniboxList(entries, { offset: 57 }).offset, 50, "зсув вирівнюється на сторінку");
});

test("зірочка й «прочитано» — рядки журналу; рядок знову жирний, коли прийшла новіша відповідь", () => {
  const entries = world();
  const key = "anna@send.com|olga@acme.com";
  entries.push({ seq: 100, at: at(6), type: "conversation.read", data: { key } }, { seq: 101, at: at(6), type: "conversation.starred", data: { key, on: true } });
  let olga = uniboxList(entries).rows.find((row) => row.key === key);
  assert.deepEqual([olga.unread, olga.starred], [false, true]);
  assert.deepEqual(uniboxList(entries, { folder: "starred" }).rows.map((row) => row.key), [key]);
  assert.deepEqual(uniboxList(entries, { label: "unread" }).rows.map((row) => row.contact), ["max@delta.com", "ivan@beta.com"]);
  entries.push(inbound("message.replied", "anna@send.com", "olga@acme.com", 30, { text: "One more thing" }));
  olga = uniboxList(entries).rows.find((row) => row.key === key);
  assert.equal(olga.unread, true);
  entries.push({ seq: 102, at: at(31), type: "conversation.starred", data: { key, on: false } });
  assert.equal(uniboxMarks(entries).starred.has(key), false);
});

test("тред: усі листи розмови по черзі, з рядком на початку", () => {
  const thread = uniboxThread(world(), "anna@send.com|olga@acme.com", { leads: LEADS });
  assert.deepEqual(thread.messages.map((message) => [message.direction, message.kind]), [["out", "sent"], ["in", "replied"]]);
  assert.equal(thread.messages[0].text, "Hi there");
  assert.equal(thread.name, "Olga Shevchenko");
  assert.equal(uniboxThread(world(), "nobody|x"), null);
});

test("жовтий банер: заглушка замість пошти, скриньки не читаються, відправники на паузі", () => {
  assert.equal(uniboxProblems({ mode: "stub" })[0].code, "stub");
  assert.equal(uniboxProblems({ mode: "gmail", polling: false })[0].code, "not_polling");
  assert.deepEqual(uniboxProblems({ mode: "gmail", polling: true }), []);
  const paused = uniboxProblems({ mode: "gmail", polling: true, senders: [{ email: "anna@send.com", status: "paused" }, { email: "b@send.com", status: "active" }] });
  assert.deepEqual(paused[0].senders, ["anna@send.com"]);
});

test("маршрути: список і тред — праву «бачити відповіді»; зірочка — «відповідати»; обидві дії пишуться з тим, хто й про кого", async () => {
  for (const row of world()) await append({ type: row.type, contact: row.contact, data: row.data });
  const esp = {
    campaigns: { enrollments: () => [{ email: "olga@acme.com", lead: { name: "Olga Shevchenko" } }], list: () => [{ id: "c1", name: "UK operators" }] },
    connector: { describe: () => ({ mode: "stub", liveSend: false }) }
  };
  const call = async (method, path, body = {}, role = "seller") => {
    let captured = null;
    await handleEspApi({
      request: { method, auth: { profile: { email: `${role}@x.com`, role } } }, response: {}, url: new URL(`http://x/api/esp${path}`),
      sendJson: (_r, status, payload) => { captured = { status, payload }; }, readJson: async () => body, esp
    });
    return captured;
  };
  assert.deepEqual([espRouteRight("GET", "/unibox"), espRouteRight("GET", "/unibox/thread"), espRouteRight("POST", "/unibox/read"), espRouteRight("POST", "/unibox/star")], ["replies.read", "replies.read", "replies.read", "replies.write"]);
  const list = await call("GET", "/unibox?folder=inbox");
  assert.equal(list.status, 200);
  assert.equal(list.payload.rows.find((row) => row.contact === "olga@acme.com").name, "Olga Shevchenko");
  assert.equal(list.payload.problems[0].code, "stub");
  const thread = await call("GET", `/unibox/thread?key=${encodeURIComponent("anna@send.com|olga@acme.com")}`);
  assert.equal(thread.payload.thread.messages.length, 2);
  assert.equal((await call("GET", "/unibox/thread?key=x")).status, 404);
  assert.equal((await call("POST", "/unibox/read", { key: "anna@send.com|olga@acme.com" })).status, 200);
  assert.equal((await call("POST", "/unibox/star", { key: "anna@send.com|olga@acme.com" })).status, 403, "продавцю за замовчуванням зірочка недоступна");
  assert.equal((await call("POST", "/unibox/star", { keys: ["anna@send.com|olga@acme.com", "nobody|x"] }, "admin")).payload.keys.length, 1);
  assert.equal((await call("POST", "/unibox/star", { key: "nobody|x" }, "admin")).status, 404);
  const marks = (await allEntries()).filter((entry) => entry.type.startsWith("conversation."));
  assert.deepEqual(marks.map((entry) => [entry.type, entry.actor, entry.contact]), [["conversation.read", "seller@x.com", "olga@acme.com"], ["conversation.starred", "admin@x.com", "olga@acme.com"]]);
  const after = await call("GET", "/unibox?folder=starred");
  assert.deepEqual(after.payload.rows.map((row) => row.contact), ["olga@acme.com"]);
  assert.equal(after.payload.counts.unread, 2);
});
