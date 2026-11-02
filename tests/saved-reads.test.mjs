import assert from "node:assert/strict";
import test from "node:test";

const local = new Map();
const store = (map) => ({
  get length() { return map.size; },
  key: (index) => [...map.keys()][index] || null,
  getItem: (key) => map.get(key) ?? null,
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: (key) => map.delete(key)
});
globalThis.window = { sessionStorage: store(new Map()), localStorage: store(local) };
const { forgetReads, recallRead, rememberRead, setCacheScope } = await import("../app/cache.js?saved-reads");

// Збережені відповіді сторінок (02.11) — лише цієї людини й не до виходу.
test("збережена відповідь — лише своя: без входу нічого, інша людина не бачить і стирає чуже, вихід стирає все", () => {
  rememberRead("/api/stats", { n: 1 });
  assert.equal(recallRead("/api/stats"), undefined, "без входу нічого не пам'ятається");
  setCacheScope("w:alice");
  rememberRead("/api/stats", { n: 1 });
  assert.deepEqual(recallRead("/api/stats"), { n: 1 });
  setCacheScope("w:bob");
  assert.equal(recallRead("/api/stats"), undefined);
  rememberRead("/api/pitch", { bob: true });
  assert.equal([...local.values()].some((raw) => raw.includes('"n":1')), false, "Алісине стерто");
  forgetReads();
  assert.equal(local.size, 0);
});

test("завелика відповідь не зберігається; стара за тиждень — не віддається", () => {
  setCacheScope("w:carol");
  rememberRead("/api/huge", { text: "x".repeat(500_000) });
  assert.equal(recallRead("/api/huge"), undefined);
  local.set("outbound:read:v1:w:carol:/api/old", JSON.stringify({ at: Date.now() - 8 * 86_400_000, value: 1 }));
  assert.equal(recallRead("/api/old"), undefined);
});
