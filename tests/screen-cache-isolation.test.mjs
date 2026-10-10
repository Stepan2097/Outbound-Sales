import assert from "node:assert/strict";
import test from "node:test";
import {
  cachedRead, forgetScreens, getCacheEpoch, invalidateReads, onCacheReset,
  recallScreen, rememberScreen, setCacheScope
} from "../app/cache.js";

const storage = new Map();
globalThis.window = { sessionStorage: {
  get length() { return storage.size; },
  key: (index) => [...storage.keys()][index] || null,
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
} };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("display snapshots cannot be recalled anonymously or across users/workspaces", () => {
  setCacheScope("");
  rememberScreen("contacts", { name: "anonymous" });
  assert.equal(recallScreen("contacts"), null);
  setCacheScope("workspace-a:user-a:admin");
  rememberScreen("contacts", { name: "Alice" });
  assert.equal(recallScreen("contacts").value.name, "Alice");
  setCacheScope("workspace-a:user-b:seller");
  assert.equal(recallScreen("contacts"), null);
  rememberScreen("contacts", { name: "Bob" });
  setCacheScope("workspace-b:user-b:seller");
  assert.equal(recallScreen("contacts"), null);
  assert.equal([...storage.keys()].some((key) => storage.get(key).includes("Alice")), false);
});

test("a page reload keeps only the newly authenticated person's display snapshots", async () => {
  setCacheScope("reload-workspace:user-a");
  rememberScreen("contacts", { name: "same user" });
  storage.set('outbound:screen:v2:someone-else:contacts', JSON.stringify({ at: Date.now(), value: { name: "other user" } }));
  const reloaded = await import("../app/cache.js?reload-isolation-test");
  assert.equal(reloaded.recallScreen("contacts"), null, "auth must finish first");
  reloaded.setCacheScope("reload-workspace:user-a");
  assert.equal(reloaded.recallScreen("contacts").value.name, "same user");
  assert.equal(storage.has('outbound:screen:v2:someone-else:contacts'), false);
});

test("scope changes reset in-memory screens and advance the guard even for same-user relogin", () => {
  setCacheScope("same-user");
  const before = getCacheEpoch();
  let resets = 0;
  const off = onCacheReset(() => { resets += 1; });
  setCacheScope("");
  setCacheScope("same-user");
  assert.equal(resets, 2);
  assert.ok(getCacheEpoch() > before);
  off();
});

test("identical concurrent safe reads share one upstream and TTL starts after success", async () => {
  setCacheScope("singleflight");
  const gate = deferred();
  let calls = 0;
  const load = () => { calls += 1; return gate.promise; };
  const first = cachedRead("folders", load, { ttlMs: 15 });
  const second = cachedRead("folders", load, { ttlMs: 15 });
  assert.equal(calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve({ folders: ["fresh"] });
  assert.deepEqual(await first, { folders: ["fresh"] });
  assert.deepEqual(await second, { folders: ["fresh"] });
  await cachedRead("folders", load, { ttlMs: 15 });
  assert.equal(calls, 1, "slow initial load consumed the result TTL");
});

test("a failed read is retried and never cached as an empty success", async () => {
  setCacheScope("errors");
  await assert.rejects(cachedRead("search", () => Promise.reject(new Error("offline"))), /offline/);
  let calls = 0;
  assert.deepEqual(await cachedRead("search", () => { calls += 1; return ["Alice"]; }), ["Alice"]);
  assert.equal(calls, 1);
});

test("cancelling one waiter leaves another alive; cancelling the final waiter aborts upstream", async () => {
  setCacheScope("abort");
  const gate = deferred();
  let upstream;
  const one = new AbortController();
  const two = new AbortController();
  const load = ({ signal }) => { upstream = signal; return gate.promise; };
  const first = cachedRead("card", load, { signal: one.signal });
  const second = cachedRead("card", load, { signal: two.signal });
  one.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(upstream.aborted, false);
  two.abort();
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(upstream.aborted, true);
  gate.resolve({ stale: true });
});

test("writes and logout invalidate resolved and in-flight reads, including late answers", async () => {
  setCacheScope("invalidation");
  let calls = 0;
  await cachedRead("card", () => ++calls);
  invalidateReads("card");
  assert.equal(await cachedRead("card", () => ++calls), 2);
  const gate = deferred();
  const pending = cachedRead("old-session", () => gate.promise);
  forgetScreens();
  gate.resolve({ name: "old user" });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(await cachedRead("old-session", () => "new read"), "new read");
});

test("an oversized persisted snapshot is omitted instead of filling tab storage", () => {
  setCacheScope("bounded");
  rememberScreen("inbox", { body: "x".repeat(512_001) });
  assert.equal(recallScreen("inbox"), null);
});

test("a background Home write during Contacts navigation retries the current read without showing its old answer", async () => {
  setCacheScope("navigation-mutation");
  const gates = [deferred(), deferred()];
  const signals = [];
  let calls = 0;
  const load = ({ signal }) => {
    signals.push(signal);
    return gates[calls++].promise;
  };
  const current = cachedRead("contacts:folders", load);
  const duplicate = cachedRead("contacts:folders", load);
  invalidateReads("", { retryPending: true });
  assert.equal(signals[0].aborted, false, "mutation must retire, not cancel, the current screen read");
  gates[0].resolve({ folders: ["before background write"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "the current screen needs a new answer after the write");
  gates[1].resolve({ folders: ["after background write"] });
  assert.deepEqual(await current, { folders: ["after background write"] });
  assert.deepEqual(await duplicate, { folders: ["after background write"] });
  assert.deepEqual(await cachedRead("contacts:folders", () => assert.fail("fresh answer should remain cached")), { folders: ["after background write"] });
});

test("a retired read retries its failure too, but user navigation still cancels the retry", async () => {
  setCacheScope("navigation-cancel-retry");
  const gates = [deferred(), deferred()];
  const controller = new AbortController();
  const signals = [];
  let calls = 0;
  const current = cachedRead("contacts:search", ({ signal }) => {
    signals.push(signal);
    return gates[calls++].promise;
  }, { signal: controller.signal });
  invalidateReads("", { retryPending: true });
  gates[0].reject(new Error("old read failed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  controller.abort();
  await assert.rejects(current, { name: "AbortError" });
  assert.equal(signals[1].aborted, true, "old search cancellation must reach its replacement");
  gates[1].resolve({ contacts: ["cancelled search"] });
});

test("an auth switch hard-aborts a retired mutation read and must never retry as the next person", async () => {
  setCacheScope("old-auth");
  const gate = deferred();
  let calls = 0;
  let signal;
  const old = cachedRead("contacts:card", (options) => { calls += 1; signal = options.signal; return gate.promise; });
  invalidateReads("", { retryPending: true });
  setCacheScope("new-auth");
  assert.equal(signal.aborted, true);
  gate.resolve({ name: "old person" });
  await assert.rejects(old, { name: "AbortError" });
  assert.equal(calls, 1, "auth reset must not replay old reads in the new session");
});


test("an auth switch between a resolved cache hit and its delivery rejects the old user's value", async () => {
  setCacheScope("old-auth-hit");
  await cachedRead("contacts:card", () => ({ name: "private old contact" }));
  const cached = cachedRead("contacts:card", () => assert.fail("already cached"));
  setCacheScope("new-auth-hit");
  await assert.rejects(cached, { name: "AbortError" });
});

test("a mutation between a resolved cache hit and delivery replaces the old cached answer", async () => {
  setCacheScope("write-before-hit-delivery");
  await cachedRead("contacts:card", () => ({ name: "before write" }));
  let reloads = 0;
  const hit = cachedRead("contacts:card", () => { reloads += 1; return { name: "after write" }; });
  invalidateReads("", { retryPending: true });
  assert.deepEqual(await hit, { name: "after write" });
  assert.equal(reloads, 1);
});

test("a mutation after the loader resolves but before its waiter delivery replaces the old answer", async () => {
  setCacheScope("write-before-pending-delivery");
  const gate = deferred();
  let loads = 0;
  const pending = cachedRead("contacts:folders", () => {
    loads += 1;
    return loads === 1 ? gate.promise : { folders: ["after write"] };
  });
  gate.resolve({ folders: ["before write"] });
  await Promise.resolve();
  invalidateReads("", { retryPending: true });
  assert.deepEqual(await pending, { folders: ["after write"] });
  assert.equal(loads, 2);
});
