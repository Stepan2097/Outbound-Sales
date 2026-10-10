import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleEspDataApi } from "../esp/data-api.mjs";
import { allEntries, append, contactKey, defaultJournalPath, entries, timeline, useJournal, verify } from "../esp/journal.mjs";
import { contentHash, recordAboutContact, recordFailed, recordSending, recordSent } from "../esp/messages.mjs";
import { RAMP_STAGES, registrySenderStore, addDomain, addSender, blocklists, canSend, checkDomain, domainKey, registry, setDomainStatus, setSenderStatus, updateSender } from "../esp/registry.mjs";

/**
 * ESP 9 — the journal that is only ever added to, the exact text of what went
 * out, and the registry of sending domains and senders.
 *
 * Each case gets its own journal file in a temporary folder. What is checked is
 * what a dispute would need: that nothing can be changed or removed without the
 * file saying so, that a sent message is recorded as the very bytes handed to
 * the provider, that only a registered and active sender is let through, and
 * that a person's history reads as one timeline.
 */

let dir;
let file;

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "esp-journal-"));
  file = join(dir, "esp-journal.jsonl");
  useJournal(file);
});

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lines = async () => (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

async function readySender(email = "mary@send.example.com") {
  await addDomain({ domain: email.split("@")[1], status: "ramp", registeredAt: "2026-08-01" }, "admin@team.com");
  await addSender({ email, displayName: "Mary Lindsay", mailboxRef: "GMAIL_MARY_TOKEN", person: "Павло" }, "admin@team.com");
}

// ── журнал ────────────────────────────────────────────────────────────────

test("кожна подія — рядок у файлі з номером, часом, автором і ланцюгом хешів", async () => {
  const first = await append({ type: "contact.note", actor: "a@team.com", contact: "  Ivan@Example.COM ", data: { text: "перший" } });
  const second = await append({ type: "contact.note", actor: "b@team.com", data: { text: "другий" } });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.contact, "ivan@example.com");
  assert.equal(first.prev, "0".repeat(64));
  assert.equal(second.prev, first.hash);
  const saved = await lines();
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1], second, "у файлі рівно те, що повернуто");
  assert.deepEqual(await verify(), { ok: true, count: 2, lastSeq: 2, lastHash: second.hash, problems: [] });
});

test("будь-яка правка рядка чи його видалення ламає ланцюг — і verify каже де", async () => {
  for (let at = 0; at < 4; at += 1) await append({ type: "contact.note", data: { at } });
  const raw = await readFile(file, "utf8");

  await writeFile(file, raw.replace('"at":1}', '"at":100}'));
  let check = await verify();
  assert.equal(check.ok, false);
  assert.deepEqual(check.problems.map((row) => [row.seq, row.problem]), [[2, "hash_mismatch"]]);

  await writeFile(file, raw.split("\n").filter((line, index) => index !== 1).join("\n"));
  check = await verify();
  assert.equal(check.ok, false);
  assert.deepEqual(check.problems.map((row) => [row.seq, row.problem]), [[3, "chain_broken"]], "вирізаний рядок видно по наступному");
});

test("рядок, обірваний на півдорозі, лишається видимим, а журнал продовжується з останнього цілого", async () => {
  await append({ type: "contact.note", data: { n: 1 } });
  await appendFile(file, '{"seq":2,"at":"2026');
  useJournal(file);
  let check = await verify();
  assert.deepEqual(check.problems.map((row) => row.problem), ["torn"]);
  const next = await append({ type: "contact.note", data: { n: 2 } });
  assert.equal(next.seq, 2, "ланцюг продовжено з останнього цілого рядка");
  const raw = await readFile(file, "utf8");
  assert.match(raw, /\{"seq":2,"at":"2026\n\{"seq":2/, "обірваний рядок не вирізано, новий почався з нового рядка");
  check = await verify();
  assert.deepEqual(check.problems.map((row) => row.problem), ["not_json"], "обірваний тепер усередині — і його досі видно");
  assert.equal(check.lastSeq, 2);
});

test("одночасні записи не ламають ланцюг і не дублюють номерів", async () => {
  await Promise.all(Array.from({ length: 25 }, (_, at) => append({ type: "contact.note", data: { at } })));
  const saved = await lines();
  assert.deepEqual(saved.map((row) => row.seq), Array.from({ length: 25 }, (_, at) => at + 1));
  assert.equal((await verify()).ok, true);
});

test("журнал переживає перезапуск: прочитаний заново, він продовжує той самий ланцюг", async () => {
  const first = await append({ type: "contact.note", data: {} });
  useJournal(file);
  const second = await append({ type: "contact.note", data: {} });
  assert.equal(second.seq, 2);
  assert.equal(second.prev, first.hash);
});

test("тип події — лише крапкове ім'я; адреса — лише адреса", async () => {
  await assert.rejects(() => append({ type: "DROP TABLE" }), /Невідомий тип/);
  assert.equal(contactKey("not an email"), null);
  assert.equal(contactKey(" A@B.co "), "a@b.co");
});

test("файл за замовчуванням — поруч зі станом робочого простору", () => {
  assert.equal(defaultJournalPath({ STATE_FILE_PATH: "/data/outbound-state.json" }), "/data/esp-journal.jsonl");
  assert.equal(defaultJournalPath({ ESP_JOURNAL_PATH: "/x/j.jsonl", STATE_FILE_PATH: "/data/s.json" }), "/x/j.jsonl");
});

// ── реєстр ────────────────────────────────────────────────────────────────

test("реєстр — це журнал, складений докупи: домени, відправники, їхні стани й історія", async () => {
  await readySender();
  await setSenderStatus({ email: "mary@send.example.com", status: "paused", reason: "bounce 6%" }, "admin@team.com");
  const { domains, senders } = await registry();
  assert.equal(domains.length, 1);
  assert.equal(domains[0].domain, "send.example.com");
  assert.equal(senders[0].status, "paused");
  assert.equal(senders[0].mailboxRef, "GMAIL_MARY_TOKEN");
  assert.deepEqual(senders[0].history.map((row) => [row.status, row.reason ?? null]), [["active", null], ["paused", "bounce 6%"]]);
  assert.deepEqual((await allEntries()).map((row) => row.type), ["domain.added", "sender.added", "sender.status"]);
});

test("домен і відправник перевіряються: формат, дублі, домен спершу, причина паузи, виведений — назавжди", async () => {
  await assert.rejects(() => addDomain({ domain: "not a domain" }, "a"), /не схоже на домен/);
  assert.equal(domainKey("https://Mail.Example.com/path"), "mail.example.com");
  await addDomain({ domain: "mail.example.com" }, "a");
  await assert.rejects(() => addDomain({ domain: "MAIL.example.com" }, "a"), /уже є/);
  await assert.rejects(() => addSender({ email: "x@other.com" }, "a"), /Спершу додайте домен other\.com/);
  await assert.rejects(() => addSender({ email: "x@mail.example.com", mailboxRef: "ya29.a0AfB_secret-token" }, "a"), /лише назва змінної/, "ключ у реєстр не потрапляє");
  await addSender({ email: "x@mail.example.com" }, "a");
  await assert.rejects(() => addSender({ email: "X@mail.example.com" }, "a"), /уже є/);
  await assert.rejects(() => setSenderStatus({ email: "x@mail.example.com", status: "paused" }, "a"), /чому/);
  await assert.rejects(() => setDomainStatus({ domain: "mail.example.com", status: "retired" }, "a"), /чому/);
  await setDomainStatus({ domain: "mail.example.com", status: "retired", reason: "спалений" }, "a");
  await assert.rejects(() => setDomainStatus({ domain: "mail.example.com", status: "active" }, "a"), /назавжди/);
  await assert.rejects(() => addSender({ email: "y@mail.example.com" }, "a"), /виведено/);
  assert.equal((await registry()).senders[0].effectiveStatus, "retired", "виведений домен забирає своїх відправників");
});

test("надсилати може лише зареєстрований активний відправник на активному домені", async () => {
  assert.match((await canSend("ghost@nowhere.com")).reason, /немає в реєстрі/);
  await readySender();
  assert.equal((await canSend("MARY@send.example.com")).ok, true);
  await setDomainStatus({ domain: "send.example.com", status: "paused", reason: "перевірка DNS" }, "a");
  const paused = await canSend("mary@send.example.com");
  assert.equal(paused.ok, false);
  assert.match(paused.reason, /у стані «пауза»/);
  for (const state of ["aging", "reserve"]) {
    await setDomainStatus({ domain: "send.example.com", status: state }, "a");
    assert.match((await canSend("mary@send.example.com")).reason, new RegExp(`«${state === "aging" ? "старіє" : "запас"}»`));
  }
  await setDomainStatus({ domain: "send.example.com", status: "active" }, "a");
  assert.equal((await canSend("mary@send.example.com")).ok, true);
});

test("перевірка DNS домену записує, що знайдено: MX, SPF, DMARC з політикою, DKIM за селектором", async () => {
  await addDomain({ domain: "send.example.com" }, "a");
  const dns = {
    resolveMx: async () => [{ exchange: "aspmx.l.google.com", priority: 1 }],
    resolveTxt: async (name) => ({
      "send.example.com": [["v=spf1 include:_spf.google.com ~all"], ["google-site-verification=x"]],
      "_dmarc.send.example.com": [["v=DMARC1; p=quarantine; rua=mailto:d@example.com"]],
      "google._domainkey.send.example.com": [["v=DKIM1; k=rsa; ", "p=MIIBIjAN"]]
    })[name] ?? (() => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); })()
  };
  const checks = await checkDomain({ domain: "send.example.com", dkimSelector: "google" }, "a", dns);
  assert.deepEqual(checks.mx, ["aspmx.l.google.com"]);
  assert.match(checks.spf, /^v=spf1/);
  assert.equal(checks.dmarcPolicy, "quarantine");
  assert.match(checks.dkim, /p=MIIBIjAN/);
  assert.equal((await registry()).domains[0].checks.dmarcPolicy, "quarantine");

  const bare = await checkDomain({ domain: "send.example.com" }, "a", { resolveMx: async () => [], resolveTxt: async () => { throw new Error("nx"); } });
  assert.deepEqual([bare.mx, bare.spf, bare.dmarc, bare.dkim], [null, null, null, null]);
});

// ── точний відправлений текст ─────────────────────────────────────────────

test("спроба записує рівно той текст і ті заголовки, що пішли, з хешем; «надіслано» прив'язане до неї", async () => {
  await readySender();
  const text = "Hi Luke,\n\nquick question about your UK casino traffic.\n\n— Mary\n\nНе хочете листів — відповідайте «stop».";
  const headers = { "List-Unsubscribe": "<mailto:unsub@send.example.com?subject=stop>", "Message-ID": "<abc@send.example.com>" };
  const sending = await recordSending({ from: "Mary@Send.example.com", to: "Luke@SB.co.uk", subject: "uk casino traffic", text, headers, campaignId: "camp-1", step: 1, leadId: "c-1", variantIds: { subject: "A", body: "B2" } }, "system");
  assert.deepEqual(sending.data.variantIds, { subject: "A", body: "B2" }, "які варіанти пішли");
  assert.equal(sending.type, "message.sending");
  assert.equal(sending.contact, "luke@sb.co.uk");
  assert.equal(sending.data.text, text, "байт у байт");
  assert.deepEqual(sending.data.headers, headers);
  assert.equal(sending.data.contentType, "text/plain");
  assert.equal(sending.data.hash, contentHash({ subject: "uk casino traffic", text, headers }));

  const sent = await recordSent(sending, { messageId: "18c2f", threadId: "18c2e" });
  assert.equal(sent.data.sendingSeq, sending.seq);
  assert.equal(sent.data.hash, sending.data.hash);
  assert.equal(sent.contact, "luke@sb.co.uk");
  await assert.rejects(() => recordSent(sending, {}), /не дав id/);
  await assert.rejects(() => recordSent(sent, { messageId: "x" }), /лише до записаної спроби/);
});

test("незареєстрований чи призупинений відправник, не-адреса, порожній лист чи HTML — не записуються як спроба", async () => {
  await assert.rejects(() => recordSending({ from: "x@nowhere.com", to: "a@b.co", subject: "s", text: "t" }), /немає в реєстрі/);
  await readySender();
  await assert.rejects(() => recordSending({ from: "mary@send.example.com", to: "not-an-email", subject: "s", text: "t" }), /не адреса/);
  await assert.rejects(() => recordSending({ from: "mary@send.example.com", to: "a@b.co", subject: "s", text: "  " }), /Порожній/);
  await assert.rejects(() => recordSending({ from: "mary@send.example.com", to: "a@b.co", subject: "s", text: "Hi <a href=x>here</a>" }), /text\/plain/);
  await setSenderStatus({ email: "mary@send.example.com", status: "paused", reason: "bounce" }, "a");
  await assert.rejects(() => recordSending({ from: "mary@send.example.com", to: "a@b.co", subject: "s", text: "t" }), /на паузі/);
  assert.equal((await entries({ type: "message" })).length, 0);
});

test("хронологія людини — усе про неї по порядку: спроба, надіслано, відповідь, відписка; чужого там немає", async () => {
  await readySender();
  const sending = await recordSending({ from: "mary@send.example.com", to: "luke@sb.co.uk", subject: "s", text: "Hi Luke" });
  await recordSent(sending, { messageId: "m1" });
  await recordSending({ from: "mary@send.example.com", to: "other@x.com", subject: "s", text: "Hi other" });
  await recordAboutContact("message.replied", "LUKE@sb.co.uk", { snippet: "Mainly casino" });
  await recordAboutContact("contact.unsubscribed", "luke@sb.co.uk", { via: "reply stop" });
  const events = await timeline("luke@sb.co.uk");
  assert.deepEqual(events.map((row) => row.type), ["message.sending", "message.sent", "message.replied", "contact.unsubscribed"]);
  await assert.rejects(() => recordAboutContact("message.sent", "luke@sb.co.uk"), /Невідома подія/, "«надіслано» лише через recordSent");
  const failedTry = await recordSending({ from: "mary@send.example.com", to: "z@z.co", subject: "s", text: "t" });
  const failed = await recordFailed(failedTry, { error: "quota" });
  assert.equal(failed.data.error, "quota");
});

// ── маршрути ──────────────────────────────────────────────────────────────

async function call({ method = "GET", path, body = null, role = "admin" }) {
  let captured = null;
  const handled = await handleEspDataApi({
    request: { method }, response: {}, url: new URL(`http://x${path}`),
    sendJson: (_response, status, payload) => { captured = { status, payload }; },
    readJson: async () => body, profile: { email: role === "admin" ? "admin@team.com" : "seller@team.com", role },
    dns: { resolveMx: async () => [], resolveTxt: async () => [] }
  });
  return { handled, ...captured };
}

test("маршрути: реєстр читає кожен, міняє лише адміністратор; і зміна, і її автор у журналі", async () => {
  assert.equal((await call({ path: "/api/other" })).handled, false);
  const refused = await call({ method: "POST", path: "/api/esp/domains", body: { domain: "send.example.com" }, role: "seller" });
  assert.equal(refused.status, 403);
  const added = await call({ method: "POST", path: "/api/esp/domains", body: { domain: "send.example.com" } });
  assert.equal(added.status, 201);
  assert.equal(added.payload.domains[0].domain, "send.example.com");
  assert.equal(added.payload.event.actor, "admin@team.com");
  const seen = await call({ path: "/api/esp/registry", role: "seller" });
  assert.equal(seen.status, 200);
  assert.equal(seen.payload.canEdit, false);
  const bad = await call({ method: "POST", path: "/api/esp/senders", body: { email: "x@other.com" } });
  assert.equal(bad.status, 409);
  const same = await call({ method: "POST", path: "/api/esp/domains/status", body: { domain: "send.example.com", status: "aging" } });
  assert.equal(same.payload.unchanged, true, "той самий стан — нічого не дописано");
  assert.equal((await allEntries()).length, 1);
});

test("маршрути: весь журнал і перевірка ланцюга — адміністраторові; хронологія людини — кожному", async () => {
  await readySender();
  const sending = await recordSending({ from: "mary@send.example.com", to: "luke@sb.co.uk", subject: "s", text: "Hi Luke" });
  await recordSent(sending, { messageId: "m1" });
  assert.equal((await call({ path: "/api/esp/journal", role: "seller" })).status, 403);
  assert.equal((await call({ path: "/api/esp/journal/verify", role: "seller" })).status, 403);
  const journal = await call({ path: "/api/esp/journal?type=message&limit=1" });
  assert.deepEqual(journal.payload.events.map((row) => row.type), ["message.sent"], "найновіше першим, з обмеженням");
  assert.equal((await call({ path: "/api/esp/journal/verify" })).payload.ok, true);
  const story = await call({ path: "/api/esp/contacts/timeline?email=Luke@SB.co.uk", role: "seller" });
  assert.deepEqual(story.payload.events.map((row) => row.type), ["message.sending", "message.sent"]);
  assert.equal(story.payload.events[0].data.text, "Hi Luke");
});

test("немає маршруту, що міняє чи видаляє рядок журналу: такі запити цей модуль не бере", async () => {
  for (const [method, path] of [["POST", "/api/esp/journal"], ["DELETE", "/api/esp/journal"], ["POST", "/api/esp/journal/1"], ["PATCH", "/api/esp/journal/1"]]) {
    assert.equal((await call({ method, path, body: {} })).handled, false, `${method} ${path}`);
  }
  assert.equal((await allEntries()).length, 0);
});

// ── критерії ESP 9: стани домену, рампа, блоклисти, коди bounce ───────────

test("домен: дата реєстрації і стан з п'яти (плюс пауза); новий починає «старіє», дату з майбутнього не приймає", async () => {
  await addDomain({ domain: "a.example.com", registeredAt: "2026-07-15" }, "a");
  const [domain] = (await registry()).domains;
  assert.equal(domain.status, "aging");
  assert.equal(domain.registeredAt, "2026-07-15");
  await assert.rejects(() => addDomain({ domain: "b.example.com", registeredAt: "2099-01-01" }, "a"), /не в майбутньому/);
  await assert.rejects(() => addDomain({ domain: "b.example.com", registeredAt: "15.07.2026" }, "a"), /РРРР-ММ-ДД/);
  await assert.rejects(() => addDomain({ domain: "b.example.com", status: "retired" }, "a"), /починає/);
  await addDomain({ domain: "b.example.com", status: "reserve" }, "a");
  for (const state of ["ramp", "active", "reserve", "aging"]) await setDomainStatus({ domain: "a.example.com", status: state }, "a");
  assert.deepEqual((await registry()).domains[0].history.map((row) => row.status), ["aging", "ramp", "active", "reserve", "aging"]);
});

test("відправник: людина за ним, етап рампи — це його ліміт; вгору по одному етапу, вниз — будь-коли", async () => {
  await readySender();
  let [sender] = (await registry()).senders;
  assert.equal(sender.person, "Павло");
  assert.equal(sender.rampStage, 5);
  assert.equal(sender.limit, 5);
  assert.equal(sender.rampStep, 1);
  await updateSender({ email: "mary@send.example.com", rampStage: 10 }, "a");
  await assert.rejects(() => updateSender({ email: "mary@send.example.com", rampStage: 20 }, "a"), /по одному етапу/);
  await assert.rejects(() => updateSender({ email: "mary@send.example.com", rampStage: 12 }, "a"), /Етап рампи/);
  await updateSender({ email: "mary@send.example.com", rampStage: 15 }, "a");
  await updateSender({ email: "mary@send.example.com", rampStage: 5, person: "Марко" }, "a");
  [sender] = (await registry()).senders;
  assert.equal(sender.limit, 5);
  assert.equal(sender.person, "Марко");
  assert.equal(await updateSender({ email: "mary@send.example.com", rampStage: 5 }, "a"), null, "без змін — без рядка");
  assert.deepEqual(RAMP_STAGES, [5, 10, 15, 20, 25, 30, 35]);
  await assert.rejects(() => addSender({ email: "x@send.example.com", rampStage: 35 }, "a").then(() => updateSender({ email: "x@send.example.com", mailboxRef: "sk-live-123" }, "a")), /лише назва змінної/);
});

test("блоклисти: Spamhaus DBL лише з ключем DQS (без нього — «не перевірено», а не «чисто»), SURBL; лістинг видно", async () => {
  const nx = () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); };
  const asked = [];
  const clean = await blocklists("send.example.com", { resolve4: async (name) => { asked.push(name); return nx(); } }, {});
  assert.equal(clean.spamhausDbl.status, "not_checked");
  assert.equal(clean.surbl.status, "clean");
  assert.equal(clean.listed, false);
  assert.deepEqual(asked, ["send.example.com.multi.surbl.org"], "без ключа Spamhaus через публічний DNS не питаємо");

  const listed = await blocklists("send.example.com", {
    resolve4: async (name) => (name.includes("dq.spamhaus.net") ? ["127.0.1.2"] : nx())
  }, { SPAMHAUS_DQS_KEY: "abcdef0123456789" });
  assert.equal(listed.spamhausDbl.status, "listed");
  assert.equal(listed.listed, true);
  const refused = await blocklists("send.example.com", { resolve4: async () => ["127.255.255.254"] }, { SPAMHAUS_DQS_KEY: "abcdef0123456789" });
  assert.equal(refused.spamhausDbl.status, "error", "відмова сервісу — не «чисто» і не «в списку»");

  await addDomain({ domain: "send.example.com" }, "a");
  const checks = await checkDomain({ domain: "send.example.com" }, "a",
    { resolveMx: async () => [], resolveTxt: async () => [], resolve4: async () => nx() }, {});
  assert.equal(checks.blocklists.surbl.status, "clean");
  const raw = await readFile(file, "utf8");
  assert.doesNotMatch(raw, /abcdef0123456789/, "ключ DQS не потрапляє в журнал");
});

test("журнал подій про людину: автовідповідь, bounce з кодом, відписка — з сендером, кампанією й кроком", async () => {
  await recordAboutContact("message.autoreplied", "a@b.co", { sender: "Mary@Send.example.com", campaignId: "c1", step: 2, subject: "Out of office" });
  await assert.rejects(() => recordAboutContact("message.bounced", "a@b.co", { sender: "mary@send.example.com" }), /з кодом SMTP/);
  const bounce = await recordAboutContact("message.bounced", "a@b.co", { sender: "mary@send.example.com", campaignId: "c1", step: 2, code: "5.1.1" });
  assert.equal(bounce.data.code, "5.1.1");
  assert.equal(bounce.data.sender, "mary@send.example.com");
  const story = await timeline("a@b.co");
  assert.deepEqual(story.map((row) => [row.type, row.data.sender, row.data.campaignId, row.data.step]), [
    ["message.autoreplied", "mary@send.example.com", "c1", 2],
    ["message.bounced", "mary@send.example.com", "c1", 2]
  ]);
});

test("помилка відправки несе кампанію й крок спроби", async () => {
  await readySender();
  const sending = await recordSending({ from: "mary@send.example.com", to: "a@b.co", subject: "s", text: "t", campaignId: "c9", step: 3 });
  const failed = await recordFailed(sending, { error: "429 rate limit" });
  assert.deepEqual([failed.data.campaignId, failed.data.step, failed.data.from], ["c9", 3, "mary@send.example.com"]);
});

test("реєстр як сховище пауз для SenderGate (ESP 1): відмова Google ставить сендера на паузу в реєстрі з кодом, і саме реєстр не пускає", async () => {
  const { SenderGate, SenderPaused } = await import("../esp/senders.mjs");
  // The gate reads every letter back before sending (ESP 2), so it is given a real one.
  const { buildLetter } = await import("../esp/letter.mjs");
  const LETTER = buildLetter({ from: { email: "mary@send.example.com", name: "Mary" }, to: { email: "lead@example.com" }, subject: "Hi", body: "Hello" });
  await readySender();
  const store = registrySenderStore();
  assert.equal(await store.pausedFor("mary@send.example.com"), null);
  assert.equal((await store.pausedFor("ghost@send.example.com")).code, "not_registered", "незареєстрована скринька не надсилає");

  const { MailboxError } = await import("../esp/gmail.mjs");
  const refusal = new MailboxError("Делегування для скриньки не налаштовано", { code: "delegation_missing" });
  const gate = new SenderGate({ connector: { send: async () => { throw refusal; } }, store });
  await assert.rejects(() => gate.send("mary@send.example.com", LETTER), SenderPaused);
  const [sender] = (await registry()).senders;
  assert.equal(sender.status, "paused");
  assert.equal(sender.history.at(-1).code, "delegation_missing");
  assert.deepEqual((await store.list()).map((row) => [row.mailbox, row.code]), [["mary@send.example.com", "delegation_missing"]]);

  let called = false;
  const quiet = new SenderGate({ connector: { send: async () => { called = true; return { id: "x" }; } }, store });
  await assert.rejects(() => quiet.send("mary@send.example.com", LETTER), SenderPaused);
  assert.equal(called, false, "поки на паузі — провайдера не питають");

  assert.equal(await gate.resume("mary@send.example.com"), true);
  assert.equal(await quiet.send("mary@send.example.com", LETTER).then(() => called), true);
  assert.equal(await store.resume("mary@send.example.com"), false, "знімати нічого");
});
