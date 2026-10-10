import assert from "node:assert/strict";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

/**
 * The Контакти screen after the Панель has already read the folder list.
 *
 * Both share `fetchContactFolders`, and the Панель runs first. Before this the
 * screen saw "loaded" and returned without drawing, so the folder list stayed
 * empty until somebody pressed «Оновити» — and the conversation on a contact
 * card is only reachable through that list.
 */

function screen({ loaded, folders, folderId }) {
  const calls = { selected: [], rendered: 0, fetched: 0 };
  const excerpt = loadMain(["loadContactFolders"], {
    contactReads: { folders: null, session: 0 },
    contactFoldersLoaded: loaded,
    contactFolders: folders,
    contactFolderId: folderId,
    contactsLoading: false,
    contactsError: "",
    renderContacts: () => { calls.rendered += 1; },
    refreshIcons: () => {},
    selectContactFolder: async (id) => { calls.selected.push(id); },
    fetchContactFolders: async () => { calls.fetched += 1; return folders; }
  });
  return { load: excerpt.get("loadContactFolders"), calls };
}

test("folders the Панель already read are drawn, and the first one opened", async () => {
  const { load, calls } = screen({ loaded: true, folders: [{ id: "f-1" }, { id: "f-2" }], folderId: null });
  await load();
  assert.deepEqual(calls.selected, ["f-1"]);
  assert.equal(calls.fetched, 0, "the list is not read a second time");
});

test("with a folder already open, coming back redraws it instead of leaving it blank", async () => {
  const { load, calls } = screen({ loaded: true, folders: [{ id: "f-1" }], folderId: "f-1" });
  await load();
  assert.deepEqual(calls.selected, []);
  assert.equal(calls.rendered, 1);
  assert.equal(calls.fetched, 0);
});
