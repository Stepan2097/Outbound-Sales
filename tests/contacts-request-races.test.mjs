import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { loadMain } from "./app-main-excerpt.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness(read) {
  const asked = [];
  const handlers = {};
  const elements = new Map();
  const names = [
    "CONTACTS_STALE_MS", "CONTACT_PAGE_SIZE", "contactReads", "contactSearchTimer", "contactFolders", "contactFoldersLoaded",
    "contactFolderId", "crmContactRows", "contactTotal", "contactOffset", "contactSearch", "selectedContactId",
    "contactRecord", "contactDrafts", "contactDraftsBusy", "contactDraftsError", "contactDraftForm", "contactsLoadedAt",
    "contactsLoading", "contactsError", "fetchContactFolders", "loadContactFolders", "loadContactPage", "selectContactFolder",
    "openContactsScreen", "openContact"
  ];
  const globals = {
    api: (path, options) => { asked.push({ path, signal: options?.signal }); return read(path, options); },
    cachedRead: (key, loader, options) => loader({ signal: options?.signal }),
    renderContacts: () => {}, refreshIcons: () => {}, rememberContacts: () => {}, recallContacts: () => false,
    loadContactHistory: () => {}, loadContactMail: () => {}, AbortController, URLSearchParams,
    document: { getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, { value: "", addEventListener: (type, fn) => { handlers[`${id}:${type}`] = fn; } });
      return elements.get(id);
    } },
    window: { clearTimeout: () => {}, setTimeout: (fn) => { handlers.debounced = fn; return 1; } }
  };
  const main = loadMain(names, globals, ['document.getElementById("contactSearchInput").addEventListener("input"']);
  return { asked, handlers, elements, get: main.get, set: (name, value) => { main.context.assigned = value; vm.runInContext(`${name} = assigned`, main.context); } };
}

test("cold opening contacts fetches first folder page exactly once even with overlapping opens", async () => {
  const folders = deferred();
  const s = harness(async (path) => path === "/api/contacts/folders" ? folders.promise : { contacts: [], total: 0 });
  const first = s.get("openContactsScreen")();
  const second = s.get("openContactsScreen")();
  folders.resolve({ folders: [{ id: "f", name: "Folder" }] });
  await Promise.all([first, second]);
  assert.equal(s.asked.filter(({ path }) => path === "/api/contacts/folders").length, 1);
  assert.equal(s.asked.filter(({ path }) => path.startsWith("/api/contacts?")).length, 1);
});

test("older folder/search response cannot replace a newer query even if transport ignores abort", async () => {
  const gates = [];
  const s = harness(() => { const gate = deferred(); gates.push(gate); return gate.promise; });
  s.set("contactFolderId", "folder-a");
  const old = s.get("loadContactPage")();
  s.set("contactFolderId", "folder-b");
  s.set("contactSearch", "new");
  const current = s.get("loadContactPage")();
  assert.equal(s.asked[0].signal.aborted, true);
  gates[1].resolve({ contacts: [{ name: "correct" }], total: 1 });
  await current;
  gates[0].resolve({ contacts: [{ name: "stale" }], total: 1 });
  await old;
  assert.equal(s.get("crmContactRows")[0].name, "correct");
  assert.equal(s.get("contactsLoading"), false);
});

test("typing invalidates the previous search immediately, before its debounce fires", async () => {
  const gate = deferred();
  const s = harness(() => gate.promise);
  s.set("contactFolderId", "folder-a");
  const old = s.get("loadContactPage")();
  s.handlers["contactSearchInput:input"]({ target: { value: "new query" } });
  assert.equal(s.asked[0].signal.aborted, true);
  gate.resolve({ contacts: [{ name: "old query" }], total: 1 });
  await old;
  assert.equal(s.get("crmContactRows").length, 0);
});

test("A → B → A card navigation rejects the first A response", async () => {
  const gates = [];
  const s = harness(() => { const gate = deferred(); gates.push(gate); return gate.promise; });
  const firstA = s.get("openContact")("a");
  const b = s.get("openContact")("b");
  const lastA = s.get("openContact")("a");
  gates[2].resolve({ contact: { id: "a", name: "new A" } });
  await lastA;
  gates[0].resolve({ contact: { id: "a", name: "old A" } });
  gates[1].resolve({ contact: { id: "b", name: "B" } });
  await Promise.all([firstA, b]);
  assert.equal(s.get("contactRecord").name, "new A");
});
