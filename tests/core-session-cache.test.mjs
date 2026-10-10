import assert from "node:assert/strict";
import test from "node:test";
import { loadMain } from "./app-main-excerpt.mjs";

function harness(fetch) {
  let epoch = 0;
  let scope = "";
  let gates = 0;
  let invalidations = 0;
  const invalidationOptions = [];
  let renders = 0;
  const openedScopes = [];
  const main = loadMain(["api", "state", "authState", "authMode", "bootApplication", "enterWorkspace", "refresh", "setAuthState"], {
    fetch, getCacheEpoch: () => epoch,
    getCacheScope: () => scope,
    setCacheScope: (next) => { if (scope !== next) epoch += 1; scope = next; },
    invalidateReads: (prefix, options) => { invalidations += 1; invalidationOptions.push({ prefix, options }); }, invalidateScreens: () => {},
    showAuthGate: () => { gates += 1; epoch += 1; },
    document: { getElementById: () => ({ hidden: false }) },
    window: { location: { hash: "", origin: "https://workspace.example" } }, URLSearchParams,
    rememberedView: () => "contacts", setView: () => openedScopes.push(scope),
    render: () => { renders += 1; }, startActivityHeartbeat: () => {}, enterHooks: []
  });
  return { get: main.get, switchSession: () => { epoch += 1; }, openedScopes,
    invalidationOptions, gates: () => gates, invalidations: () => invalidations, renders: () => renders, scope: () => scope };
}

const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("boot establishes user/workspace cache scope before opening screens with one auth request and one state render", async () => {
  const requests = [];
  const h = harness(async (path) => {
    requests.push(path);
    return answer(path === "/api/auth/status"
      ? { authenticated: true, workspaceId: "w-1", user: { id: "u-1", role: "seller" } }
      : { prospects: [] });
  });
  await h.get("bootApplication")();
  assert.deepEqual(requests, ["/api/auth/status", "/api/state"]);
  assert.deepEqual(JSON.parse(h.openedScopes[0]), ["https://workspace.example", "w-1", "u-1", "seller"]);
  assert.equal(h.renders(), 1);
});

test("an old session's successful GET is rejected instead of reaching a new user's screen", async () => {
  let release;
  const h = harness(() => new Promise((resolve) => { release = () => resolve(answer({ private: "old user" })); }));
  const pending = h.get("api")("/api/contacts");
  h.switchSession();
  release();
  await assert.rejects(pending, { name: "AbortError" });
});

test("a delayed old 401 body cannot log the next person out", async () => {
  let release;
  const h = harness(async () => ({ ok: false, status: 401, json: () => new Promise((resolve) => { release = resolve; }) }));
  const pending = h.get("api")("/api/contacts");
  await new Promise((resolve) => setImmediate(resolve));
  h.switchSession();
  release({ error: "expired" });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.gates(), 0);
});

test("successful mutations invalidate safe read caches but heartbeat and GET do not", async () => {
  const h = harness(async () => answer({ success: true }));
  await h.get("api")("/api/contacts");
  await h.get("api")("/api/account/heartbeat", { method: "POST", body: "{}" });
  assert.equal(h.invalidations(), 0);
  await h.get("api")("/api/warmup/inbox/reply", { method: "POST", body: "{}" });
  assert.equal(h.invalidations(), 1);
  assert.equal(h.invalidationOptions[0].prefix, "");
  assert.equal(h.invalidationOptions[0].options.retryPending, true);
});
