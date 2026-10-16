import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FRIENDS_FOLDER, FRIENDS_FOLDER_NAME, friendsFolder } from "../contacts/friends-folder.mjs";
import { networkStore } from "../warmup/network.mjs";

/**
 * «Усі друзі LinkedIn-акаунтів» (власник 16.10: «але ж їх не 349»): у папці CRM
 * «Друзі LinkedIn-акаунтів» лише ті, кого не було в базі; решта друзів сидять
 * у робочих папках. Ця папка — усі друзі всіх акаунтів, знайдені в CRM за
 * профілем, нікого не переносячи.
 */

async function world(t, friends) {
  const dir = await mkdtemp(join(tmpdir(), "friends-folder-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const network = networkStore(join(dir, "network.json"));
  for (const [accountId, people] of Object.entries(friends)) {
    await network.batch(accountId, people, { first: true });
    await network.done(accountId, { complete: true, total: people.length });
  }
  return { dir, network };
}

const CRM = {
  "c-anna": { id: "c-anna", name: "Anna Koval", company: "Glovo", position: "UA lead" },
  "c-ivan": { id: "c-ivan", name: "Ivan Petrov", company: "Pixel Forge", position: "Head of UA" },
  "c-olga": { id: "c-olga", name: "Olga Sych", company: "Northwind", position: "CMO" }
};

test("усі друзі всіх акаунтів, кожен раз, найновіші першими; лише ті, кого знайдено в CRM; пошук; сторінки", async (t) => {
  const { dir, network } = await world(t, {
    "acc-mary": [
      { slug: "anna-koval", name: "Anna Koval", connectedAt: "2026-09-01" },
      { slug: "ivan-petrov", name: "Ivan Petrov", connectedAt: "2026-10-01" },
      { slug: "nobody-here", name: "Not In Crm" }
    ],
    "acc-chloe": [
      { slug: "ivan-petrov", name: "Ivan Petrov", connectedAt: "2026-10-05" },
      { slug: "olga-sych", name: "Olga Sych", connectedAt: "2026-08-01" }
    ]
  });
  const looked = [];
  const ids = { "anna-koval": "c-anna", "ivan-petrov": "c-ivan", "olga-sych": "c-olga" };
  const folder = friendsFolder({
    network, path: join(dir, "matches.json"),
    lookup: async (slug) => { looked.push(slug); return ids[slug] || null; },
    fetchRows: async (wanted) => wanted.map((id) => CRM[id]).filter(Boolean)
  });

  const before = await folder.folder();
  assert.deepEqual([before.id, before.name, before.contactCount, before.pending, before.friends], [FRIENDS_FOLDER, FRIENDS_FOLDER_NAME, 0, 4, 4]);
  await folder.resolve();
  assert.deepEqual(looked.sort(), ["anna-koval", "ivan-petrov", "nobody-here", "olga-sych"], "друг двох акаунтів шукається раз");

  const after = await folder.folder();
  assert.equal(after.contactCount, 3);
  assert.equal(after.pending, 0);
  const page = await folder.page({});
  assert.deepEqual(page.contacts.map((row) => row.id), ["c-ivan", "c-anna", "c-olga"], "найновіший друг першим");
  assert.equal(page.total, 3);
  assert.deepEqual((await folder.page({ search: "glovo" })).contacts.map((row) => row.id), ["c-anna"]);
  assert.deepEqual((await folder.page({ limit: 1, offset: 1 })).contacts.map((row) => row.id), ["c-anna"]);

  // Знайдений раз не шукається знову; не знайдений — лише через добу.
  looked.length = 0;
  await folder.resolve();
  assert.deepEqual(looked, []);
  const saved = JSON.parse(await readFile(join(dir, "matches.json"), "utf8")).matches;
  assert.equal(saved["anna-koval"].id, "c-anna");
  assert.equal(saved["nobody-here"].id, null);
});

test("не знайденого в CRM шукає знову через добу — перенесення могло його вже додати", async (t) => {
  const { dir, network } = await world(t, { "acc-mary": [{ slug: "late-one", name: "Late One" }] });
  let clock = Date.parse("2026-10-16T10:00:00Z");
  let found = null;
  const looked = [];
  const folder = friendsFolder({
    network, path: join(dir, "matches.json"), now: () => clock,
    lookup: async (slug) => { looked.push(slug); return found; },
    fetchRows: async (wanted) => wanted.map((id) => ({ id, name: "Late One" }))
  });
  await folder.resolve();
  found = "c-late";
  clock += 3_600_000;
  await folder.resolve();
  assert.equal(looked.length, 1, "за годину — не шукає");
  clock += 86_400_000;
  await folder.resolve();
  assert.equal(looked.length, 2);
  assert.equal((await folder.folder()).contactCount, 1);
});
