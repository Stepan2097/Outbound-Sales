import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { invalidateContactCaches, listFolderContacts } from "../contacts/store.mjs";
import { listeningOrigin } from "./server-origin.mjs";

const FOLDER = "11111111-1111-4111-8111-111111111111";
const OTHER_FOLDER = "33333333-3333-4333-8333-333333333333";
const options = { folderId: FOLDER, search: "Mic", limit: 2, offset: 0, cacheScope: "workspace:user" };
const originalEnv = { url: process.env.WARMUP_CRM_SUPABASE_URL, key: process.env.WARMUP_CRM_SERVICE_ROLE_KEY };
let service, origin, calls = [], revision = 1, failRows = false, rowGate;

function holdNextRows() {
  let release, started;
  const gate = { held: new Promise((resolve) => { release = resolve; }), started: new Promise((resolve) => { started = resolve; }), release, mark: () => started() };
  rowGate = gate;
  return gate;
}

test.before(async () => {
  service = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture");
    assert.equal(url.pathname, "/rest/v1/contacts", "the paginated API must keep reading one filtered page, never the ranked-search RPC");
    const count = String(request.headers.prefer).includes("count=exact");
    const marker = calls.length + 1, snapshot = revision;
    calls.push({ count, params: url.searchParams });
    const folder = url.searchParams.get("folder_id")?.slice(3);
    const term = /ilike\.\*([^*]+)\*/.exec(url.searchParams.get("or") || "")?.[1]?.toLowerCase() || "";
    let contacts = Array.from({ length: 8 }, (_, n) => ({
      id: `22222222-2222-4222-8222-${String(n + 1).padStart(12, "0")}`,
      name: n < 6 ? `Michael ${n}` : `Nina ${n}`, company: `revision ${snapshot}; read ${marker}`,
      created_at: `2026-09-${String(n + 1).padStart(2, "0")}T10:00:00Z`,
      folder_id: FOLDER, email: `person${n}@test.invalid`
    })).filter((contact) => contact.folder_id === folder && contact.name.toLowerCase().includes(term));
    response.setHeader("Content-Type", "application/json");
    if (count) {
      response.setHeader("Content-Range", `0-0/${contacts.length}`);
      response.end("[]");
      return;
    }
    if (rowGate) {
      const gate = rowGate;
      rowGate = null;
      gate.mark();
      await gate.held;
    } else await new Promise((resolve) => setTimeout(resolve, 10));
    if (failRows) { response.statusCode = 503; response.end(JSON.stringify({ message: "CRM page unavailable" })); return; }
    const ascending = url.searchParams.get("order")?.startsWith("created_at.asc");
    contacts.sort((a, b) => (ascending ? 1 : -1) * a.created_at.localeCompare(b.created_at));
    const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 25);
    response.end(JSON.stringify(contacts.slice(offset, offset + limit)));
  });
  await new Promise((resolve, reject) => { service.once("error", reject); service.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${service.address().port}`;
  process.env.WARMUP_CRM_SUPABASE_URL = origin;
  process.env.WARMUP_CRM_SERVICE_ROLE_KEY = "sb_secret_page_fixture";
});
test.beforeEach(() => { invalidateContactCaches(); calls = []; revision = 1; failRows = false; rowGate = null; });
test.after(async () => {
  if (originalEnv.url === undefined) delete process.env.WARMUP_CRM_SUPABASE_URL;
  else process.env.WARMUP_CRM_SUPABASE_URL = originalEnv.url;
  if (originalEnv.key === undefined) delete process.env.WARMUP_CRM_SERVICE_ROLE_KEY;
  else process.env.WARMUP_CRM_SERVICE_ROLE_KEY = originalEnv.key;
  service.closeAllConnections();
  await new Promise((resolve) => service.close(resolve));
});

const rowCalls = () => calls.filter((call) => !call.count).length;
const countCalls = () => calls.filter((call) => call.count).length;

test("five identical cold page reads coalesce and warm pages retain the existing API shape", async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => listFolderContacts(options)));
  assert.equal(rowCalls(), 1);
  assert.equal(countCalls(), 1);
  assert.deepEqual(Object.keys(results[0]).sort(), ["contacts", "limit", "offset", "total"]);
  assert.equal(results[0].limit, 2);
  assert.equal(results[0].offset, 0);
  assert.equal(results[0].total, 6);
  assert.deepEqual(results[0].contacts.map((contact) => contact.name), ["Michael 5", "Michael 4"]);
  assert.ok(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0])));
  results[0].contacts[0].name = "caller mutation";
  const warm = await listFolderContacts(options);
  assert.equal(warm.contacts[0].name, "Michael 5", "a caller cannot mutate the cached response");
  assert.equal(rowCalls(), 1);
  assert.equal(countCalls(), 1);
});

test("query, folder, page size, offset, order and authenticated scope all distinguish pages", async () => {
  await listFolderContacts(options);
  const variants = [
    { search: "Nina" }, { folderId: OTHER_FOLDER }, { limit: 3 }, { offset: 2 },
    { queueOrder: true }, { cacheScope: "workspace:other-user" }, { cacheScope: "other-workspace:user" }
  ];
  for (const change of variants) {
    const before = rowCalls();
    const result = await listFolderContacts({ ...options, ...change });
    assert.equal(rowCalls(), before + 1, JSON.stringify(change));
    assert.deepEqual(await listFolderContacts({ ...options, ...change }), result);
    assert.equal(rowCalls(), before + 1, `warm ${JSON.stringify(change)}`);
    if (change.search) assert.equal(result.contacts[0].name, "Nina 7");
    if (change.folderId) assert.equal(result.total, 0);
    if (change.limit) assert.equal(result.contacts.length, 3);
    if (change.offset) assert.equal(result.contacts[0].name, "Michael 3");
    if (change.queueOrder) assert.equal(result.contacts[0].name, "Michael 0");
  }
});

test("contact-only and folder invalidation refresh pages across scopes; unscoped reads do not cache", async () => {
  const other = { ...options, cacheScope: "workspace:other-user" };
  await Promise.all([listFolderContacts(options), listFolderContacts(other)]);
  revision = 2;
  assert.match((await listFolderContacts(options)).contacts[0].company, /revision 1/);
  invalidateContactCaches({ contactId: "22222222-2222-4222-8222-000000000006" });
  const updated = await Promise.all([listFolderContacts(options), listFolderContacts(other)]);
  assert.equal(rowCalls(), 4);
  assert.ok(updated.every((result) => result.contacts[0].company.startsWith("revision 2")));
  revision = 3;
  invalidateContactCaches({ folderId: FOLDER });
  assert.match((await listFolderContacts(options)).contacts[0].company, /revision 3/);
  const before = rowCalls();
  await listFolderContacts({ ...options, cacheScope: undefined });
  await listFolderContacts({ ...options, cacheScope: undefined });
  assert.equal(rowCalls(), before + 2);
});

test("a new page reads its own total instead of extending another page's count lifetime", async () => {
  await listFolderContacts(options);
  const nextPage = await listFolderContacts({ ...options, offset: 2 });
  assert.equal(rowCalls(), 2);
  assert.equal(countCalls(), 2, "a new page must not embed a previously cached count for another minute");
  assert.equal(nextPage.total, 6);
  await listFolderContacts({ ...options, offset: 2 });
  assert.equal(countCalls(), 2, "rows and total are reused together while this page is fresh");
});

test("fresh reads replace pending pages and invalidation prevents an old answer from repopulating cache", async () => {
  const gate = holdNextRows();
  const older = listFolderContacts(options);
  await gate.started;
  revision = 2;
  const fresh = await listFolderContacts({ ...options, fresh: true });
  assert.match(fresh.contacts[0].company, /revision 2/);
  gate.release();
  assert.match((await older).contacts[0].company, /revision 1/);
  assert.deepEqual(await listFolderContacts(options), fresh);
  assert.equal(rowCalls(), 2);

  invalidateContactCaches();
  const nextGate = holdNextRows();
  const invalidated = listFolderContacts(options);
  await nextGate.started;
  invalidateContactCaches({ folderId: FOLDER });
  revision = 3;
  const current = await listFolderContacts(options);
  nextGate.release();
  await invalidated;
  assert.deepEqual(await listFolderContacts(options), current);
  assert.match(current.contacts[0].company, /revision 3/);
});

test("failed page loads are not cached as empty or successful results", async () => {
  failRows = true;
  await assert.rejects(listFolderContacts(options), /CRM page unavailable/);
  failRows = false;
  assert.equal((await listFolderContacts(options)).contacts.length, 2);
  assert.equal(rowCalls(), 2);
  await listFolderContacts(options);
  assert.equal(rowCalls(), 2);
});

test("aborting one HTTP reader leaves the shared page available to another reader and subsequent requests", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-page-cache-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH, PORT: "0", STATE_FILE_PATH: join(directory, "state.json"), AUTH_DEV_BYPASS: "1",
      WARMUP_CRM_SUPABASE_URL: origin, WARMUP_CRM_SERVICE_ROLE_KEY: "sb_secret_page_fixture", WARMUP_SCHEDULER_DISABLED: "1" },
    stdio: ["ignore", "pipe", "ignore"]
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const gate = holdNextRows();
  try {
    const portal = await listeningOrigin(child, { timeoutMs: 5000 });
    const path = `${portal}/api/contacts?folderId=${FOLDER}&search=Mic&limit=2&offset=0`;
    const controller = new AbortController();
    const abandoned = fetch(path, { signal: controller.signal });
    await gate.started;
    const surviving = fetch(path);
    controller.abort();
    await assert.rejects(abandoned, { name: "AbortError" });
    gate.release();
    const response = await surviving;
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.deepEqual(Object.keys(page).sort(), ["contacts", "limit", "offset", "total"]);
    assert.equal(page.total, 6);
    assert.equal(page.limit, 2);
    assert.equal(rowCalls(), 1, "a canceled consumer must not cancel or duplicate the shared CRM read");
    assert.equal(countCalls(), 1);
    assert.deepEqual(await fetch(path).then((answer) => answer.json()), page);
    assert.equal(rowCalls(), 1, "the successful shared read remains cached for subsequent HTTP callers");
  } finally {
    gate.release();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});
