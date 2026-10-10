import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { invalidateContactCaches, listContactFolders, readContact, searchFolderContacts } from "../contacts/store.mjs";

const folderId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
let stub, base, calls = [], failure = false;

test.before(async () => {
  stub = createServer(async (request, response) => {
    const url = new URL(request.url, "http://crm");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const args = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ path: url.pathname, method: request.method, args, query: url.searchParams });
    await new Promise((resolve) => setTimeout(resolve, 10));
    response.setHeader("Content-Type", "application/json");
    if (failure) { response.statusCode = 503; response.end(JSON.stringify({ message: "CRM offline" })); return; }
    if (url.pathname === "/rest/v1/rpc/outbound_search_contacts") response.end(JSON.stringify([{ id: contactId, name: "Michaél" }]));
    else if (url.pathname === "/rest/v1/contacts") response.end(JSON.stringify([{ id: contactId, folder_id: folderId, name: "Michaél" }]));
    else if (url.pathname === "/rest/v1/contact_folders") response.end(JSON.stringify([{ id: folderId, name: "Team" }]));
    else if (url.pathname === "/rest/v1/folder_stats") response.end(JSON.stringify([{ folder_id: folderId, contact_count: 27000 }]));
    else { response.statusCode = 404; response.end(JSON.stringify({ message: "unexpected path" })); }
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  base = process.env.WARMUP_CRM_SUPABASE_URL;
  process.env.WARMUP_CRM_SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
  process.env.WARMUP_CRM_SERVICE_ROLE_KEY = "test-service-role";
  process.env.CONTACTS_INDEXED_SEARCH = "1";
});
test.beforeEach(() => { calls = []; failure = false; invalidateContactCaches(); });
test.after(async () => {
  if (base === undefined) delete process.env.WARMUP_CRM_SUPABASE_URL;
  else process.env.WARMUP_CRM_SUPABASE_URL = base;
  await new Promise((resolve) => stub.close(resolve));
});

test("five concurrent cold searches make one bounded RPC, no folder download", async () => {
  const options = { folderId, search: "Michaél", cacheScope: "workspace-one:user-one" };
  const results = await Promise.all(Array.from({ length: 5 }, () => searchFolderContacts(options)));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/rest/v1/rpc/outbound_search_contacts");
  assert.deepEqual(calls[0].args, { p_folder_id: folderId, p_search: "michael" });
  assert.ok(calls[0].query.get("select").includes("id,name"));
  assert.ok(results.every((result) => result.contacts[0].id === contactId && result.contacts.length <= 5));
  await searchFolderContacts({ ...options, search: "michael" });
  assert.equal(calls.length, 1, "accent/case-normalized search reuses successful result");
  await searchFolderContacts({ ...options, cacheScope: "workspace-one:user-two" });
  assert.equal(calls.length, 2, "another authenticated user has a separate cache");
});

test("read caches invalidate after changes, errors retry, unscoped reads bypass cache", async () => {
  const options = { folderId, search: "Michael", cacheScope: "workspace:user" };
  failure = true;
  await assert.rejects(searchFolderContacts(options), /CRM offline/);
  failure = false;
  await searchFolderContacts(options);
  await searchFolderContacts(options);
  assert.equal(calls.length, 2);
  invalidateContactCaches({ contactId, folderId });
  await searchFolderContacts(options);
  assert.equal(calls.length, 3);
  await searchFolderContacts({ folderId, search: "Michael" });
  await searchFolderContacts({ folderId, search: "Michael" });
  assert.equal(calls.length, 5);
});

test("folder and contact reads share in-flight work but fresh reads and mutation invalidation refetch", async () => {
  const options = { cacheScope: "workspace:user" };
  await Promise.all([listContactFolders(options), listContactFolders(options)]);
  assert.equal(calls.length, 2, "one folders query and one folder_stats query");
  await Promise.all([readContact(contactId, options), readContact(contactId, options)]);
  assert.equal(calls.length, 3);
  await readContact(contactId, { ...options, fresh: true });
  assert.equal(calls.length, 4);
  invalidateContactCaches({ contactId });
  await readContact(contactId, options);
  assert.equal(calls.length, 5);
  await listContactFolders(options);
  assert.equal(calls.length, 7);
});
