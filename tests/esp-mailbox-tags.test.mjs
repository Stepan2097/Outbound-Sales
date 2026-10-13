import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleEspApi } from "../esp/api.mjs";
import { handleEspDataApi } from "../esp/data-api.mjs";
import { StubGmailConnector } from "../esp/gmail.mjs";
import { allEntries, useJournal } from "../esp/journal.mjs";
import { MAILBOX_TAGS, addDomain, addSender, cleanTags, registry, setDomainStatus, setSenderTags, tagCatalog } from "../esp/registry.mjs";

/**
 * Теги пошт (власник 13.10): «Розсилка», «Прогрів» або свій — кілька на пошту.
 * Тег — рядок журналу з автором, як усе в реєстрі; його видно в «Поштах», у
 * «Прогріві пошт» (за замовчуванням — лише «Прогрів») і в конструкторі
 * кампанії (за замовчуванням — «Розсилка»).
 */

const ADMIN = { email: "stepan@advantage-agency.co", role: "admin" };
const SELLER = { email: "ira@advantage-agency.co", role: "seller" };
const ANNA = "anna@advantage-mail.com";
const OLGA = "olga@advantage-mail.com";

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), "esp-tags-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "advantage-mail.com" }, "test");
  await setDomainStatus({ domain: "advantage-mail.com", status: "ramp" }, "test");
  await addSender({ email: ANNA, person: "Anna Koval" }, "test");
  await addSender({ email: OLGA, person: "Olga Sych" }, "test");
}

async function data({ path, body, profile = ADMIN }) {
  let captured = null;
  await handleEspDataApi({
    request: { method: "POST" }, response: {}, url: new URL(`http://x${path}`),
    sendJson: (_r, status, payload) => { captured = { status, payload }; },
    readJson: async () => body, profile, env: {},
    dns: { resolveMx: async () => [], resolveTxt: async () => [] }
  });
  return captured;
}

async function api(method, path, body = {}, role = "admin") {
  let captured = null;
  await handleEspApi({
    request: { method, auth: { profile: { email: `${role}@x.com`, role } } }, response: {}, url: new URL(`http://x/api/esp${path}`),
    sendJson: (_r, status, payload) => { captured = { status, payload }; }, readJson: async () => body,
    esp: { connector: new StubGmailConnector(), sequenceOn: false, halted: () => false }
  });
  return captured;
}

test("тег чиститься: пробіли, довжина, повтори без огляду на регістр, вбудовані — у своєму написанні, не більше восьми", () => {
  assert.deepEqual(MAILBOX_TAGS, ["Розсилка", "Прогрів"]);
  assert.deepEqual(cleanTags(["  прогрів ", "ПРОГРІВ", "Клієнт  А", "", null, "клієнт а"]), ["Прогрів", "Клієнт А"]);
  assert.equal(cleanTags(["x".repeat(50)])[0].length, 30);
  assert.equal(cleanTags(Array.from({ length: 12 }, (_, index) => `t${index}`)).length, 8);
  assert.deepEqual(cleanTags("Розсилка"), [], "не масив — нічого");
});

test("каталог: вбудовані першими, далі свої за абеткою, без повторів", () => {
  assert.deepEqual(tagCatalog([]), ["Розсилка", "Прогрів"]);
  assert.deepEqual(tagCatalog([{ tags: ["Прогрів", "Юля"] }, { tags: ["Агенція", "Юля"] }, {}]), ["Розсилка", "Прогрів", "Агенція", "Юля"]);
});

test("тег ставить той, хто має право реєстру; рядок журналу з автором; те саме вдруге — без рядка", async (t) => {
  await world(t);
  const refused = await data({ path: "/api/esp/senders/tags", body: { email: ANNA, tags: ["Прогрів"] }, profile: SELLER });
  assert.equal(refused.status, 403);
  assert.match(refused.payload.error, /registry\.change/);

  const saved = await data({ path: "/api/esp/senders/tags", body: { email: ANNA.toUpperCase(), tags: ["прогрів", "Розсилка", "Юля"] } });
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.payload.senders.find((row) => row.email === ANNA).tags, ["Прогрів", "Розсилка", "Юля"]);
  const again = await data({ path: "/api/esp/senders/tags", body: { email: ANNA, tags: ["Прогрів", "Розсилка", "Юля"] } });
  assert.equal(again.payload.unchanged, true);
  const lines = (await allEntries()).filter((entry) => entry.type === "sender.tags");
  assert.deepEqual(lines.map((entry) => [entry.actor, entry.data.email]), [[ADMIN.email, ANNA]]);

  assert.equal((await data({ path: "/api/esp/senders/tags", body: { email: "nobody@advantage-mail.com", tags: [] } })).status, 404);
  await setSenderTags({ email: ANNA, tags: [] }, "test");
  assert.deepEqual((await registry()).senders.find((row) => row.email === ANNA).tags, [], "зняти всі теги можна");
  assert.deepEqual((await registry()).senders.find((row) => row.email === OLGA).tags, [], "нова пошта — без тегів");
});

test("теги видно в лімітах (конструктор) і в прогріві; «Запустити всі» стартує лише показані пошти", async (t) => {
  await world(t);
  await setSenderTags({ email: ANNA, tags: ["Прогрів"] }, "test");
  await setSenderTags({ email: OLGA, tags: ["Розсилка", "Клієнт"] }, "test");

  const limits = await api("GET", "/limits", {}, "seller");
  assert.equal(limits.status, 200);
  assert.deepEqual(limits.payload.senders.find((row) => row.email === OLGA).tags, ["Розсилка", "Клієнт"]);
  assert.deepEqual(limits.payload.tagCatalog, ["Розсилка", "Прогрів", "Клієнт"]);

  const view = await api("GET", "/warmup", {}, "seller");
  assert.deepEqual(view.payload.tagCatalog, ["Розсилка", "Прогрів", "Клієнт"]);
  assert.deepEqual(view.payload.rows.find((row) => row.email === ANNA).tags, ["Прогрів"]);

  const started = await api("POST", "/warmup/start", { mailboxes: [ANNA] });
  assert.equal(started.status, 200);
  assert.deepEqual(started.payload.changed, [ANNA], "Ольга не показана фільтром — не стартує");
  assert.equal((await api("POST", "/warmup/start", { mailboxes: [] })).status, 200, "порожній список — нічого, не помилка");
  assert.equal((await api("POST", "/warmup/start", {})).status, 400, "без пошти й без списку — помилка, як раніше");
});

test("сторінки: фільтр за тегом у «Поштах», «Прогріві» і конструкторі; позначену пошту фільтр не ховає", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const accounts = read("app/screens/mail-accounts.js");
  assert.match(accounts, /id="mailAccountsTag"/);
  assert.match(accounts, /\/api\/esp\/senders\/tags/);
  const warmup = read("app/screens/mail-warmup.js");
  assert.match(warmup, /id="mailWarmupTag"/);
  assert.match(warmup, /"Прогрів"/);
  const builder = read("app/screens/mail-campaigns.js");
  assert.match(builder, /data-mc-sender-tag>/);
  assert.match(builder, /"Розсилка"/);
  assert.match(builder, /campaign\.senders\.includes\(sender\.email\)\) return false/);
  assert.match(read("app/styles/mail-campaigns.css"), /\.mc-sender\[hidden\]/);
});

test("вбудовані теги й «Призначення» — один факт: тег міняє роль, роль міняє теги, свої теги лишаються", async (t) => {
  await world(t);
  const { setSenderRole } = await import("../esp/registry.mjs");
  const of = async (email) => (await registry()).senders.find((row) => row.email === email);

  await setSenderTags({ email: ANNA, tags: ["Прогрів", "UK"] }, "test");
  assert.equal((await of(ANNA)).role, "warmup", "лише «Прогрів» — пошта лише для прогріву");
  await setSenderTags({ email: ANNA, tags: ["Прогрів", "Розсилка", "UK"] }, "test");
  assert.equal((await of(ANNA)).role, "cold");

  await setSenderRole({ email: ANNA, role: "warmup" }, "test");
  assert.deepEqual((await of(ANNA)).tags, ["Прогрів", "UK"]);
  await setSenderRole({ email: ANNA, role: "cold" }, "test");
  assert.deepEqual((await of(ANNA)).tags, ["Розсилка", "Прогрів", "UK"], "пошта для розсилки теж гріється — «Прогрів» лишається");
  await setSenderRole({ email: ANNA, role: null }, "test");
  assert.deepEqual((await of(ANNA)).tags, ["UK"]);
  assert.equal((await of(ANNA)).role, null);
  await setSenderTags({ email: ANNA, tags: ["UK"] }, "test");
  assert.equal((await of(ANNA)).role, null, "без вбудованих — без ролі");
});
