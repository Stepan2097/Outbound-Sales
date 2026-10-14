import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { espRouteRight, handleEspApi } from "../esp/api.mjs";
import { StubGmailConnector } from "../esp/gmail.mjs";
import { pollInboxes } from "../esp/inbound.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { sendLedger } from "../esp/limits.mjs";
import { BACKOFF_MINUTES, WARMUP_MAX, cleanPlan, planFor, runWarmupTick, warmupLedger, warmupMode, warmupPlan, warmupView } from "../esp/mail-warmup.mjs";
import { recordAboutContact } from "../esp/messages.mjs";
import { addDomain, addSender, registry, registrySenderStore, setDomainStatus } from "../esp/registry.mjs";
import { summaryReport } from "../esp/reports.mjs";
import { SenderGate } from "../esp/senders.mjs";
import { uniboxList } from "../esp/unibox.mjs";

/**
 * Прогрів пошт — our own mailboxes writing to each other: the plan grows with
 * the days, a third of the letters are answered in their thread, a letter in
 * Spam goes to the Inbox marked Important, and warm-up and cold mail together
 * keep within ESP 4's limits. Nothing of it reaches the cold-mail screens.
 */

// Monday 12.10.2026, 12:00 in Kyiv — a working day, inside the window.
const MONDAY = new Date("2026-10-12T09:00:00Z");
const at = (days, minutes = 0) => new Date(MONDAY.getTime() + days * 86_400_000 + minutes * 60_000);
const ANNA = "anna@advantage-mail.com";
const BORIS = "boris@growadvantage.co";
const OLGA = "olga@advantage-mail.com";

async function world(t, { annaDomain = "ramp", rampStage = 35 } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: MONDAY.getTime() - 86_400_000 });
  const dir = await mkdtemp(join(tmpdir(), "esp-warmup-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "advantage-mail.com" }, "test");
  if (annaDomain !== "aging") await setDomainStatus({ domain: "advantage-mail.com", status: annaDomain }, "test");
  await addDomain({ domain: "growadvantage.co" }, "test");
  await setDomainStatus({ domain: "growadvantage.co", status: "ramp" }, "test");
  await addSender({ email: ANNA, person: "Anna Koval", rampStage }, "test");
  await addSender({ email: BORIS, person: "Boris Lee", rampStage }, "test");
  await addSender({ email: OLGA, person: "Olga Sych", rampStage }, "test");
  const connector = new StubGmailConnector();
  let halted = false;
  const gate = new SenderGate({ connector, store: registrySenderStore("test"), halted: () => halted });
  const tick = async (now, options = {}) => {
    t.mock.timers.setTime(now.getTime());
    return runWarmupTick({ journal: { allEntries, append }, senders: (await registry()).senders, connector, gate, now, ...options });
  };
  const start = async (mailbox, now) => {
    t.mock.timers.setTime(now.getTime());
    await append({ type: "warmup.started", actor: "stepan@x.co", data: { mailbox } });
  };
  // The stub does not route mail between mailboxes; this does, the way Gmail would.
  const route = (labels = ["INBOX"]) => {
    for (const letter of connector.sent.splice(0)) {
      const to = (letter.raw.match(/^To:.*<([^>]+)>|^To:\s*(\S+@\S+)/m) || []).slice(1).find(Boolean);
      connector.deliver(to, letter.raw, { labels });
    }
  };
  return { connector, gate, tick, start, route, halt: () => { halted = true; } };
}

test("план росте з днями: 2, 4, 6 … до 20; день — лише робочий день, коли прогрів ішов", () => {
  assert.deepEqual([1, 2, 3, 9, 10, 30].map((day) => planFor(day)), [2, 4, 6, 18, 20, WARMUP_MAX]);
  assert.equal(planFor(0), 0);
  const entries = [
    { seq: 1, at: at(0).toISOString(), type: "warmup.started", data: { mailbox: ANNA } },
    { seq: 2, at: at(1).toISOString(), type: "warmup.paused", data: { mailbox: ANNA } },
    { seq: 3, at: at(3).toISOString(), type: "warmup.started", data: { mailbox: ANNA } }
  ];
  const anna = warmupLedger(entries, { now: at(3, 60) }).rows.get(ANNA);
  assert.deepEqual([anna.running, anna.day, anna.plannedToday], [true, 3, 6], "понеділок і вівторок ішов, середа — пауза, у четвер знову: третій день");
  // Started on Friday: Saturday and Sunday are not warm-up days, so Monday is its second.
  const weekend = warmupLedger([{ seq: 1, at: at(-3).toISOString(), type: "warmup.started", data: { mailbox: ANNA } }], { now: at(0, 60) }).rows.get(ANNA);
  assert.deepEqual([weekend.day, weekend.plannedToday], [2, 4]);
  const paused = warmupLedger(entries.slice(0, 2), { now: at(5) }).rows.get(ANNA);
  assert.deepEqual([paused.running, paused.day, paused.plannedToday], [false, 2, 0]);
});

test("пошти пишуть одна одній — інший домен першим, по одному листу за прохід, з паузами між листами; у журналі warmup.*, без контакту", async (t) => {
  const { connector, tick, start } = await world(t);
  await start(ANNA, at(0, -60));
  await start(BORIS, at(0, -60));
  const first = await tick(at(0));
  assert.equal(first.sent, 2);
  const sent = (await allEntries()).filter((entry) => entry.type === "warmup.sending");
  assert.deepEqual(sent.map((entry) => [entry.data.from, entry.data.to, entry.data.kind]), [[ANNA, BORIS, "first"], [BORIS, ANNA, "first"]]);
  assert.ok(sent.every((entry) => entry.contact == null), "не людина — жодної хронології контакта");
  assert.equal(connector.sent.length, 2);
  assert.match(connector.sent[0].raw, /Content-Type: text\/plain; charset=UTF-8/);
  const again = await tick(at(0, 1));
  assert.equal(again.sent, 0, "наступний лист — не раніше ніж за 12–40 хвилин");
  assert.ok(again.skipped.every((row) => row.reason === "too_soon"));
  const later = await tick(at(0, 45));
  assert.equal(later.sent, 2);
  const day = await tick(at(0, 90));
  assert.equal(day.sent, 0, "перший день — план 2 листи");
  assert.ok(day.skipped.every((row) => row.reason === "plan_done"));
});

test("лист прогріву, що впав у спам, переноситься у вхідні й позначається важливим — один раз", async (t) => {
  const { connector, tick, start, route } = await world(t);
  await start(ANNA, at(0, -60));
  await start(BORIS, at(0, -60));
  await tick(at(0));
  route(["SPAM"]);
  const pass = await tick(at(0, 5));
  assert.deepEqual([pass.received, pass.rescued], [2, 2]);
  const inBoris = connector.inboxes.get(BORIS)[0];
  assert.deepEqual(inBoris.labels.sort(), ["IMPORTANT", "INBOX"]);
  const entries = await allEntries();
  assert.deepEqual(entries.filter((entry) => entry.type === "warmup.rescued").map((entry) => entry.data.mailbox).sort(), [ANNA, BORIS]);
  assert.ok(entries.filter((entry) => entry.type === "warmup.received").every((entry) => entry.data.inSpam));
  const once = await tick(at(0, 6));
  assert.deepEqual([once.received, once.rescued], [0, 0]);
  const view = warmupView(await allEntries(), { ...(await registry()), now: at(0, 6) });
  const anna = view.find((row) => row.email === ANNA);
  assert.deepEqual([anna.rescued, anna.landedInSpam, anna.received], [1, 1, 1], "Анна вийняла лист Бориса; її лист у Бориса теж був у спамі");
});

test("відповідь — у тому ж треді (In-Reply-To, тема «Re:»), через годину-дві після отримання, і стає «відповіддю» для того, хто писав", async (t) => {
  const { connector, tick, start, route } = await world(t);
  await start(ANNA, at(0, -60));
  await start(BORIS, at(0, -60));
  await tick(at(0));
  const annaLetter = connector.sent.find((letter) => letter.mailbox === ANNA);
  const annaMessageId = annaLetter.raw.match(/^Message-ID: (.+)$/m)[1].trim();
  route();
  await tick(at(0, 5), { replyPercent: 100 });
  const early = await tick(at(0, 20), { replyPercent: 100 });
  assert.equal(early.replied, 0, "не одразу — щонайменше 25 хвилин");
  const pass = await tick(at(0, 150), { replyPercent: 100 });
  assert.equal(pass.replied, 2);
  const reply = connector.sent.find((letter) => letter.mailbox === BORIS && /In-Reply-To/.test(letter.raw));
  assert.match(reply.raw, new RegExp(`^In-Reply-To: ${annaMessageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
  assert.match(reply.raw, /^Subject: Re: /m);
  const boris = connector.inboxes.get(BORIS).find((message) => message.raw.includes(annaMessageId));
  assert.equal(reply.threadId, boris.threadId, "у треді, який Gmail Бориса відкрив для листа Анни");
  const view = warmupView(await allEntries(), { ...(await registry()), now: at(0, 150) });
  assert.deepEqual([view.find((row) => row.email === ANNA).repliesReceived, view.find((row) => row.email === BORIS).repliesSent], [1, 1]);
  const twice = await tick(at(0, 200), { replyPercent: 100 });
  assert.equal(twice.replied, 0, "на лист відповідають один раз");
});

test("прогрів і холодні листи разом — у межах ліміту ESP 4: прогрів не перевищує, а холодні бачать листи прогріву", async (t) => {
  const { tick, start } = await world(t, { rampStage: 5 });
  await start(ANNA, at(0, -60));
  await start(BORIS, at(0, -60));
  t.mock.timers.setTime(at(0, -30).getTime());
  for (let n = 0; n < 5; n += 1) await append({ type: "message.sending", contact: `lead${n}@x.com`, data: { from: ANNA, campaignId: "c1", step: 0, subject: "s", text: "t" } });
  const pass = await tick(at(0));
  assert.deepEqual(pass.skipped.filter((row) => row.mailbox === ANNA).map((row) => row.reason), ["sender_daily_limit"]);
  assert.equal(pass.sent, 1, "лише Борис");
  const ledger = sendLedger(await allEntries(), { now: at(0, 1) });
  assert.equal(ledger.senders.get(BORIS).today, 1, "лист прогріву Бориса рахується в його ліміт і для холодних листів");
  const view = warmupView(await allEntries(), { ...(await registry()), now: at(0, 1) });
  assert.equal(view.find((row) => row.email === ANNA).plannedToday, 0, "план на сьогодні — не більше, ніж лишилось від ліміту");
});

test("прогріву не видно в кампаніях, звітах, Unibox і хронології; читач вхідних не бере його листи за відповіді", async (t) => {
  const { connector, tick, start, route } = await world(t);
  await start(ANNA, at(0, -60));
  await start(BORIS, at(0, -60));
  await tick(at(0));
  route();
  t.mock.timers.setTime(at(0, 3).getTime());
  const cursors = {};
  const summary = await pollInboxes({
    connector, mailboxes: [ANNA, BORIS], now: at(0, 3),
    cursors: { read: (mailbox) => cursors[mailbox] || null, write: async (mailbox, cursor) => { cursors[mailbox] = cursor; } },
    journal: { allEntries, append, recordAboutContact }, postpone: async () => {}
  });
  assert.equal(summary.actions.warmup, 2);
  const entries = await allEntries();
  assert.equal(entries.some((entry) => entry.type.startsWith("message.") || entry.type.startsWith("contact.")), false);
  assert.equal(summaryReport(entries).totals.sent, 0);
  assert.equal(uniboxList(entries, { folder: "sent" }).total, 0);
});

test("шлюз: прогрів можна вести на домені, що ще старіє, холодні листи звідти — ні; пошта на паузі не гріється", async (t) => {
  const { gate, tick, start } = await world(t, { annaDomain: "aging" });
  const store = registrySenderStore("test");
  assert.equal((await store.pausedFor(ANNA)).code, "sender_held", "холодний лист з домену, що старіє, — ні");
  assert.equal(await store.pausedFor(ANNA, { purpose: "warmup" }), null, "прогрів — так");
  await start(ANNA, at(0, -60));
  await start(BORIS, at(0, -60));
  const pass = await tick(at(0));
  assert.equal(pass.sent, 2);
  await setDomainStatus({ domain: "advantage-mail.com", status: "reserve" }, "test");
  assert.match((await store.pausedFor(ANNA, { purpose: "warmup" })).reason, /запас/);
  const blocked = warmupView(await allEntries(), { ...(await registry()), now: at(0, 1) }).find((row) => row.email === ANNA);
  assert.equal(blocked.status, "blocked");
  void gate;
});

test("після відмови пошта чекає пів години, а не пише по рядку відмови щопроходу; «Стоп усе» зупиняє і прогрів", async (t) => {
  const { tick, start, halt } = await world(t);
  await start(ANNA, at(0, -60));
  await start(BORIS, at(0, -60));
  halt();
  const refused = await tick(at(0));
  assert.equal(refused.sent, 0);
  assert.equal((await allEntries()).filter((entry) => entry.type === "warmup.failed").length, 2);
  const resting = await tick(at(0, 15));
  assert.ok(resting.skipped.every((row) => row.reason === "backoff"));
  assert.equal((await allEntries()).filter((entry) => entry.type === "warmup.failed").length, 2, "без нових рядків відмови");
  assert.equal(BACKOFF_MINUTES, 30);
});

test("режим сторінки: заглушка, вимкнена відправка, тестовий цикл, вимкнено", () => {
  assert.deepEqual([warmupMode({ describe: { mode: "stub" } }).mode, warmupMode({ describe: { mode: "stub" } }).runs], ["stub", false]);
  assert.match(warmupMode({ describe: { mode: "stub" } }).text, /Увійти через Google/);
  assert.equal(warmupMode({ describe: { mode: "stub" }, sequenceOn: true }).runs, true);
  assert.deepEqual([warmupMode({ describe: { mode: "gmail", liveSend: false } }).mode, warmupMode({ describe: { mode: "gmail", liveSend: true } }).runs], ["locked", true]);
  assert.equal(warmupMode({ describe: { mode: "gmail", liveSend: true }, env: { ESP_WARMUP: "off" } }).runs, false);
});

test("маршрути: таблицю бачить команда; «Старт» і «Пауза» — право лімітів, у журналі дій; заблоковану пошту не запустити", async (t) => {
  await world(t);
  await setDomainStatus({ domain: "growadvantage.co", status: "reserve" }, "test");
  const esp = { connector: new StubGmailConnector(), sequenceOn: false, halted: () => false };
  const call = async (method, path, body = {}, role = "seller") => {
    let captured = null;
    await handleEspApi({
      request: { method, auth: { profile: { email: `${role}@x.com`, role } } }, response: {}, url: new URL(`http://x/api/esp${path}`),
      sendJson: (_r, status, payload) => { captured = { status, payload }; }, readJson: async () => body, esp
    });
    return captured;
  };
  assert.deepEqual([espRouteRight("GET", "/warmup"), espRouteRight("POST", "/warmup/start"), espRouteRight("POST", "/warmup/pause")], ["replies.read", "limits.change", "limits.change"]);
  const view = await call("GET", "/warmup");
  assert.equal(view.status, 200);
  assert.equal(view.payload.mode.mode, "stub");
  assert.deepEqual(view.payload.rows.map((row) => [row.email, row.status]).sort(), [[ANNA, "never"], [BORIS, "blocked"], [OLGA, "never"]]);
  assert.equal((await call("POST", "/warmup/start", { mailbox: ANNA })).status, 403);
  assert.equal((await call("POST", "/warmup/start", { mailbox: BORIS }, "admin")).status, 400, "домен у резерві");
  const all = await call("POST", "/warmup/start", { all: true }, "admin");
  assert.deepEqual(all.payload.changed.sort(), [ANNA, OLGA]);
  assert.equal(all.payload.refused[0].mailbox, BORIS);
  assert.equal((await call("POST", "/warmup/pause", { mailbox: OLGA }, "admin")).payload.changed[0], OLGA);
  const entries = await allEntries();
  assert.deepEqual(entries.filter((entry) => entry.type.startsWith("warmup.")).map((entry) => [entry.type, entry.actor]), [["warmup.started", "admin@x.com"], ["warmup.started", "admin@x.com"], ["warmup.paused", "admin@x.com"]]);
  assert.ok(entries.some((entry) => entry.type === "admin.warmup_started"));
});

test("план налаштовується без коду: збережений на сторінці, або ESP_WARMUP_START/STEP/MAX; межі перевіряються", () => {
  assert.deepEqual(warmupPlan([], {}), { start: 2, step: 2, max: 20 });
  assert.deepEqual(warmupPlan([], { ESP_WARMUP_START: "1", ESP_WARMUP_STEP: "1", ESP_WARMUP_MAX: "8" }), { start: 1, step: 1, max: 8 });
  const saved = [{ seq: 1, at: at(0).toISOString(), type: "warmup.plan", actor: "stepan@x.co", data: { start: 1, step: 1, max: 10 } }];
  assert.deepEqual(warmupPlan(saved, { ESP_WARMUP_START: "5" }), { start: 1, step: 1, max: 10, savedAt: at(0).toISOString(), by: "stepan@x.co" }, "збережене на сторінці головніше за сервер");
  assert.deepEqual([1, 2, 5, 20].map((day) => planFor(day, { start: 1, step: 1, max: 10 })), [1, 2, 5, 10]);
  const started = [...saved, { seq: 2, at: at(-3).toISOString(), type: "warmup.started", data: { mailbox: ANNA } }];
  assert.equal(warmupLedger(started, { now: at(0, 60) }).rows.get(ANNA).plannedToday, 2, "п'ятниця й понеділок — другий день за повільним планом: 2, не 4");
  assert.match(cleanPlan({ start: 0, step: 1, max: 5 }).error, /Старт/);
  assert.match(cleanPlan({ start: 5, step: 1, max: 3 }).error, /Межа не може бути меншою/);
  assert.match(cleanPlan({ start: 2, step: 1, max: 99 }).error, /Межа — ціле число від 1 до 35/);
});

test("Workspace без gmail.modify: прогрів шле й відповідає далі, зі спаму не виймає, і сторінка каже чому — раз на день", async (t) => {
  const { connector, tick, start, route } = await world(t);
  connector.setLabels = async () => { const error = new Error("Google не дає змінювати мітки"); error.code = "no_modify_scope"; throw error; };
  await start(ANNA, at(0, -60));
  await start(BORIS, at(0, -60));
  await tick(at(0));
  route(["SPAM"]);
  const pass = await tick(at(0, 50));
  assert.equal(pass.rescued, 0);
  assert.equal(pass.sent, 2, "листи йдуть далі");
  assert.ok(pass.errors.every((error) => error.code === "no_modify_scope"));
  await tick(at(0, 100));
  const refused = (await allEntries()).filter((entry) => entry.type === "warmup.rescue_refused");
  assert.equal(refused.length, 1, "раз на день, не щопроходу");
});

test("маршрут плану: лише з правом лімітів, з перевіркою, у журналі дій; GET віддає план і межі", async (t) => {
  await world(t);
  const esp = { connector: new StubGmailConnector(), sequenceOn: false, halted: () => false };
  const call = async (method, path, body = {}, role = "seller") => {
    let captured = null;
    await handleEspApi({
      request: { method, auth: { profile: { email: `${role}@x.com`, role } } }, response: {}, url: new URL(`http://x/api/esp${path}`),
      sendJson: (_r, status, payload) => { captured = { status, payload }; }, readJson: async () => body, esp
    });
    return captured;
  };
  assert.equal(espRouteRight("POST", "/warmup/plan"), "limits.change");
  assert.equal((await call("POST", "/warmup/plan", { start: 1, step: 1, max: 10 })).status, 403);
  assert.equal((await call("POST", "/warmup/plan", { start: 1, step: 1, max: 99 }, "admin")).status, 400);
  assert.deepEqual((await call("POST", "/warmup/plan", { start: "1", step: "1", max: "10" }, "admin")).payload.plan, { start: 1, step: 1, max: 10 });
  const view = await call("GET", "/warmup");
  assert.deepEqual([view.payload.plan.start, view.payload.plan.step, view.payload.plan.max, view.payload.plan.by], [1, 1, 10, "admin@x.com"]);
  assert.deepEqual(view.payload.planBounds.max, [1, 35]);
  assert.ok((await allEntries()).some((entry) => entry.type === "admin.warmup_plan"));
});

test("партнера обирають за навантаженням: п'ять пошт одного домену не валять усе на одну пошту іншого", async (t) => {
  const { tick, start } = await world(t);
  const extra = ["ira@advantage-mail.com", "max@advantage-mail.com", "lev@advantage-mail.com"];
  for (const email of extra) await addSender({ email, rampStage: 35 }, "test");
  const all = [ANNA, BORIS, OLGA, ...extra];
  for (const mailbox of all) await start(mailbox, at(0));
  await tick(at(0, 30));
  const sent = (await allEntries()).filter((entry) => entry.type === "warmup.sending").map((entry) => entry.data.to);
  assert.equal(sent.length, all.length, "кожна написала по листу");
  assert.ok(sent.filter((to) => to === BORIS).length <= 2, `єдина пошта іншого домену не отримує всі листи (${sent.join(", ")})`);
  const most = Math.max(...all.map((mailbox) => sent.filter((to) => to === mailbox).length));
  assert.ok(most <= 2, "листи розходяться по всіх");
});

test("прогрів пише й увечері — 08:00–22:00 за Києвом; холодні листи лишаються у вікні одержувача 08–17", async (t) => {
  const { tick, start } = await world(t);
  for (const mailbox of [ANNA, BORIS]) await start(mailbox, at(0));
  // 19:00 у Києві, понеділок.
  const evening = at(0, 7 * 60);
  const summary = await tick(evening);
  assert.equal(summary.sent, 2, `увечері прогрів іде (${JSON.stringify(summary.skipped)})`);
  const cold = sendLedger(await allEntries(), { now: evening });
  const { sendDecision } = await import("../esp/limits.mjs");
  assert.equal(sendDecision({ sender: { email: "x@advantage-mail.com", rampStage: 35 }, recipient: { country: "Ukraine", timezone: "Europe/Kyiv" }, ledger: cold, now: evening }).reason, "outside_window");
  const late = await tick(at(0, 13 * 60 + 30));
  assert.equal(late.sent, 0, "після 22:00 — ні");
});

test("лист прогріву звертається на ім'я одержувача й підписаний іменем відправника — не того, хто підключав пошти", async () => {
  const { warmupLetter } = await import("../esp/mail-warmup.mjs");
  const from = { email: "maryna.advantage@gmail.com", displayName: "Maryna Koval", person: "pavlo.work.101@gmail.com" };
  const to = { email: "advantage.inbox1@gmail.com", displayName: "", person: "pavlo.work.101@gmail.com" };
  const letter = warmupLetter({ from, to, seed: "s", date: new Date("2026-10-13T10:00:00Z") });
  assert.doesNotMatch(letter.raw, /Pavlo/i);
  assert.match(letter.text, /Advantage/, "без імені в Google — з адреси до @");
  assert.match(letter.text, /\n\nMaryna$/, "підпис — ім'я відправника");
  assert.match(letter.raw, /^From: .*Maryna Koval/m);
});

test("кожен лист прогріву пише модель; якщо вона мовчить чи помиляється — лист однаково йде з готових шматків", async (t) => {
  const { tick, start } = await world(t);
  for (const mailbox of [ANNA, BORIS]) await start(mailbox, at(0));
  const asked = [];
  const writer = async (request) => {
    asked.push(request);
    if (request.from.email === BORIS) throw new Error("model down");
    return { subject: "Budget review slot", body: `Hi ${request.to.name},\n\nCan we move the budget review to Thursday at 11?` };
  };
  await tick(at(0, 30), { writer });
  const sending = (await allEntries()).filter((entry) => entry.type === "warmup.sending");
  const anna = sending.find((entry) => entry.data.from === ANNA);
  const boris = sending.find((entry) => entry.data.from === BORIS);
  assert.equal(anna.data.writtenBy, "model");
  assert.equal(anna.data.subject, "Budget review slot");
  assert.match(anna.data.text, /^Hi Boris,/);
  assert.equal(boris.data.writtenBy, "template", "модель упала — лист з шматків");
  assert.equal(asked[0].to.name, asked[0].to.email === BORIS ? "Boris" : "Anna");
});

test("призначення: таблиця за доменами; пошта «лише прогрів» не шле холодних листів, але гріється", async (t) => {
  await world(t);
  const { setSenderRole, canSend, registry: read } = await import("../esp/registry.mjs");
  await setSenderRole({ email: OLGA, role: "cold" }, "test");
  await setSenderRole({ email: ANNA, role: "warmup" }, "test");
  const { senders, domains } = await read();
  const rows = warmupView(await allEntries(), { senders, domains });
  // The table goes by domain, then address (14.10); the role is shown, not sorted by.
  assert.deepEqual(rows.map((row) => [row.email, row.role]), [[ANNA, "warmup"], [OLGA, "cold"], [BORIS, null]]);
  assert.equal((await canSend(OLGA)).ok, true);
  const refused = await canSend(ANNA);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /лише для прогріву/);
});

test("пошти для розсилки гріються першими: помічники пишуть насамперед їм — у межах подвійного плану", async (t) => {
  const { tick, start } = await world(t);
  const extra = ["ira@advantage-mail.com", "max@advantage-mail.com", "lev@advantage-mail.com"];
  for (const email of extra) await addSender({ email, rampStage: 35 }, "test");
  const { setSenderRole } = await import("../esp/registry.mjs");
  await setSenderRole({ email: BORIS, role: "cold" }, "test");
  for (const email of [ANNA, OLGA, ...extra]) await setSenderRole({ email, role: "warmup" }, "test");
  for (const mailbox of [ANNA, BORIS, OLGA, ...extra]) await start(mailbox, at(0));
  await tick(at(0, 30));
  const sent = (await allEntries()).filter((entry) => entry.type === "warmup.sending");
  assert.equal(sent[0].data.from, BORIS, "пошта для розсилки шле першою");
  const toBoris = sent.filter((entry) => entry.data.to === BORIS).length;
  assert.equal(toBoris, 4, `Борис отримує до подвійного плану (мін. 4): ${sent.map((entry) => entry.data.to).join(", ")}`);
});

test("Gmail підміняє Message-ID: лист однаково впізнається у вхідних і на нього відповідають (13.10: жодної відповіді)", async (t) => {
  const { connector, tick, start } = await world(t);
  // Gmail's behaviour: what arrives carries Gmail's own Message-ID, not ours.
  const realIds = new Map();
  connector.messageIdOf = async (_mailbox, id) => realIds.get(id) || null;
  const route = () => {
    for (const letter of connector.sent.splice(0)) {
      const real = `<CA${letter.id.slice(5, 15)}@mail.gmail.com>`;
      realIds.set(letter.id, real);
      const to = (letter.raw.match(/^To:.*<([^>]+)>|^To:\s*(\S+@\S+)/m) || []).slice(1).find(Boolean);
      connector.deliver(to, letter.raw.replace(/^Message-ID:.*$/im, `Message-ID: ${real}`));
    }
  };
  // the stub must remember what it sent to answer messageIdOf
  const send = connector.send.bind(connector);
  connector.send = async (mailbox, raw, options) => { const result = await send(mailbox, raw, options); connector.sent.at(-1).id = result.id; return result; };
  for (const mailbox of [ANNA, BORIS]) await start(mailbox, at(0));
  await tick(at(0, 30));
  route();
  await tick(at(0, 32));
  const received = (await allEntries()).filter((entry) => entry.type === "warmup.received");
  assert.equal(received.length, 2, "обидва листи впізнано за справжнім Message-ID");
  const replies = await tick(at(0, 32 + 141), { replyPercent: 100 });
  assert.ok(replies.replied >= 1, `на них відповідають (${JSON.stringify(replies.skipped)})`);
});
