import test from "node:test";
import assert from "node:assert/strict";
import { createReadCache } from "../contacts/read-cache.mjs";

test("concurrent reads share one load; TTL starts after success and returned data is isolated", async () => {
  let clock = 0, loads = 0, finish;
  const cache = createReadCache({ now: () => clock });
  const load = () => { loads++; return new Promise((resolve) => { finish = resolve; }); };
  const first = cache.read("scope:one", { ttl: 60 }, load);
  const second = cache.read("scope:one", { ttl: 60 }, load);
  await Promise.resolve();
  assert.equal(loads, 1);
  clock = 100;
  finish({ contacts: [{ id: "one" }] });
  const [a, b] = await Promise.all([first, second]);
  a.contacts[0].id = "mutated";
  assert.equal(b.contacts[0].id, "one");
  clock = 159;
  assert.equal((await cache.read("scope:one", { ttl: 60 }, () => assert.fail("still cached"))).contacts[0].id, "one");
  clock = 160;
  assert.deepEqual(await cache.read("scope:one", { ttl: 60 }, async () => ({ contacts: [] })), { contacts: [] });
});

test("failed loads can retry and invalidation fences off an older in-flight read", async () => {
  const cache = createReadCache();
  await assert.rejects(cache.read("one", { ttl: 1000 }, async () => { throw Error("CRM offline"); }), /CRM offline/);
  assert.equal(await cache.read("one", { ttl: 1000 }, async () => "retry"), "retry");
  let finish;
  const old = cache.read("two", { ttl: 1000, tags: ["folder:one"] }, () => new Promise((resolve) => { finish = resolve; }));
  await Promise.resolve();
  cache.invalidate(["folder:one"]);
  assert.equal(await cache.read("two", { ttl: 1000, tags: ["folder:one"] }, async () => "updated"), "updated");
  finish("old");
  await old;
  assert.equal(await cache.read("two", { ttl: 1000 }, () => assert.fail("old read must not replace new")), "updated");
});

test("cache scope, entry count and byte cap bound what can be reused", async () => {
  const cache = createReadCache({ maxEntries: 2, maxBytes: 100 });
  const read = (key, value) => cache.read(key, { ttl: 1000 }, async () => value);
  await read("workspaceA:userA", "a");
  assert.equal(await read("workspaceA:userB", "b"), "b");
  assert.equal(await read("workspaceA:userA", "not fetched"), "a");
  await read("workspaceB:userA", "c");
  assert.equal(await read("workspaceA:userB", "evicted"), "evicted");
  await read("oversize", "x".repeat(200));
  assert.equal(await read("oversize", "next"), "next");
  assert.equal(await read(null, "uncached one"), "uncached one");
  assert.equal(await read(null, "uncached two"), "uncached two");
});


test("fresh reads replace an older pending read and only the new flight can populate the cache", async () => {
  const cache = createReadCache();
  let finishOld, finishFresh;
  let oldLoads = 0, freshLoads = 0;
  const old = cache.read("contact:one", { ttl: 1000 }, () => {
    oldLoads++;
    return new Promise((resolve) => { finishOld = resolve; });
  });
  await Promise.resolve();
  const fresh = cache.read("contact:one", { ttl: 1000, fresh: true }, () => {
    freshLoads++;
    return new Promise((resolve) => { finishFresh = resolve; });
  });
  const follower = cache.read("contact:one", { ttl: 1000 }, () => assert.fail("must share the fresh flight"));
  await Promise.resolve();
  assert.equal(oldLoads, 1);
  assert.equal(freshLoads, 1, "fresh reused the old in-flight answer");
  finishFresh({ status: "updated" });
  assert.deepEqual(await fresh, { status: "updated" });
  assert.deepEqual(await follower, { status: "updated" });
  finishOld({ status: "old" });
  assert.deepEqual(await old, { status: "old" }, "the original read can still resolve for its original caller");
  assert.deepEqual(await cache.read("contact:one", { ttl: 1000 }, () => assert.fail("new answer should remain cached")), { status: "updated" });
});

test("an older pending answer cannot become cached when its fresh replacement fails", async () => {
  const cache = createReadCache();
  let finishOld;
  const old = cache.read("contact:one", { ttl: 1000 }, () => new Promise((resolve) => { finishOld = resolve; }));
  await Promise.resolve();
  await assert.rejects(cache.read("contact:one", { ttl: 1000, fresh: true }, async () => {
    throw new Error("authoritative read failed");
  }), /authoritative read failed/);
  finishOld("stale");
  await old;
  assert.equal(await cache.read("contact:one", { ttl: 1000 }, async () => "retry fresh"), "retry fresh");
});
