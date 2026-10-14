import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connectedDate, parseCard } from "../agent/lib/network.mjs";
import { NETWORK_EVERY_DAYS, cleanPerson, networkDue, networkStore } from "../warmup/network.mjs";

/**
 * Усі друзі LinkedIn (власник 14.10): агент читає сторінку «Контакти», сервер
 * тримає знімок по акаунту. Повне читання замінює список, неповне — лише
 * доповнює; читати раз на 3 дні або після «Оновити».
 */

test("картка зі сторінки «Контакти»: ім'я, посада, дата; кнопки й шум відкинуто", () => {
  // Текст картки Chloe 14.10.2026, як його віддає innerText.
  const card = { href: "https://www.linkedin.com/in/waltersantolli/", lines: ["Walter Oliveira", "", "Events & VIP Account Manager @BetBoom LATAM", "", "Встановлено контакт October 14, 2026", "Повідомлення"] };
  assert.deepEqual(parseCard(card), { slug: "waltersantolli", name: "Walter Oliveira", headline: "Events & VIP Account Manager @BetBoom LATAM", connectedAt: "2026-10-14" });
  assert.equal(parseCard({ href: "/company/x/", lines: ["X"] }), null, "не профіль — не людина");
  assert.equal(parseCard({ href: "/in/a/", lines: ["", "Повідомлення"] }), null, "без імені — не вгадуємо");
  assert.equal(connectedDate("Connected on March 3, 2025"), "2025-03-03");
  assert.equal(connectedDate("Встановлено контакт 14 жовт. 2026 р."), "2026-10-14");
  assert.equal(connectedDate("Встановлено контакт вчора"), null);
});

test("людина чиститься: slug з посилання, довжини, дата лише ISO", () => {
  assert.deepEqual(cleanPerson({ slug: "Jo%C3%A3o-Pedro", name: "  João   Pedro ", headline: "x".repeat(400), connectedAt: "14.10.2026" }),
    { slug: "joão-pedro", name: "João Pedro", headline: "x".repeat(220), connectedAt: null });
  assert.equal(cleanPerson({ slug: "a/b" }), null);
  assert.equal(cleanPerson({}), null);
});

test("коли читати: ніколи не читали, минуло 3 дні, або замовили «Оновити»", () => {
  const now = new Date("2026-10-14T10:00:00Z");
  assert.equal(networkDue(null, now), true);
  assert.equal(networkDue({ syncedAt: "2026-10-13T10:00:00Z" }, now), false);
  assert.equal(networkDue({ syncedAt: new Date(now - NETWORK_EVERY_DAYS * 86_400_000).toISOString() }, now), true);
  assert.equal(networkDue({ syncedAt: "2026-10-13T10:00:00Z", requestedAt: "2026-10-14T09:00:00Z" }, now), true);
});

test("сховище: частини збираються до «done»; повне читання замінює список, неповне лише доповнює; файл переживає перезапуск", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "net-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "linkedin-network.json");
  let clock = new Date("2026-10-14T10:00:00Z");
  const store = networkStore(path, { now: () => clock });

  assert.equal((await store.view("acc")).due, true);
  await store.batch("acc", [{ slug: "a", name: "Anna" }, { slug: "b", name: "Bo" }], { first: true });
  assert.equal((await store.view("acc")).people.length, 0, "до done список не змінюється");
  await store.batch("acc", [{ slug: "b", name: "Bo" }, { slug: "c", name: "Cy" }]);
  const done = await store.done("acc", { total: 3, complete: true });
  assert.deepEqual([done.count, done.read], [3, 3]);
  assert.equal((await store.view("acc")).due, false);

  await store.batch("acc", [{ slug: "d", name: "Di" }], { first: true });
  await store.done("acc", { total: 4, complete: false });
  assert.deepEqual((await store.view("acc")).people.map((p) => p.slug), ["a", "b", "c", "d"], "неповне — нікого не викреслено");

  await store.batch("acc", [{ slug: "a", name: "Anna" }], { first: true });
  await store.done("acc", { total: 1, complete: true });
  assert.deepEqual((await store.view("acc")).people.map((p) => p.slug), ["a"], "повне — список як на сторінці");

  clock = new Date("2026-10-14T11:00:00Z");
  await store.request("acc");
  assert.equal((await store.view("acc")).due, true, "«Оновити» робить читання потрібним");

  // Two copies of the server on one file (a deploy): each writes on top of what the other wrote.
  const other = networkStore(path, { now: () => clock });
  await other.batch("bbb", [{ slug: "z", name: "Zed" }], { first: true });
  await other.done("bbb", { total: 1, complete: true });
  await store.batch("acc", [{ slug: "a", name: "Anna" }], { first: true });
  await store.done("acc", { total: 1, complete: true });
  assert.deepEqual((await other.view("bbb")).people.map((p) => p.slug), ["z"], "запис одного не затер іншого");
  assert.deepEqual((await store.view("bbb")).people.map((p) => p.slug), ["z"]);

  const again = networkStore(path, { now: () => clock });
  assert.deepEqual((await again.view("acc")).people.map((p) => p.slug), ["a"]);
  assert.ok(JSON.parse(await readFile(path, "utf8")).accounts.acc);
});

test("проводка: план агента, дії агента, маршрути сторінки, етап агента і вкладка", async () => {
  const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const api = await read("warmup/api.mjs");
  assert.match(api, /network: \{ due: Boolean\(network\) && !paused/);
  assert.match(api, /action === "network\.batch" \|\| action === "network\.done"/);
  assert.match(api, /path === "\/network"/);
  assert.match(api, /path === "\/network\/refresh"/);
  assert.match(await read("server.mjs"), /network: linkedinNetwork,/);
  const agent = await read("agent/run-account.mjs");
  assert.match(agent, /plan\.network\?\.due === true/);
  assert.match(await read("agent/lib/portal.mjs"), /action: 'network\.batch'/);
  const page = await read("app/screens/warmup-accounts.js");
  assert.match(page, /Усі друзі LinkedIn/);
  assert.match(page, /data-warmup-network-refresh/);
});
