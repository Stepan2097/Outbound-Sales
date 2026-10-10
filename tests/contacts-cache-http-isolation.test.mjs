import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listeningOrigin } from "./server-origin.mjs";

// Real server authentication and HTTP routes over a private fake CRM. Five
// cookie identities request identical keys concurrently; per-load markers make
// accidental cross-user reuse observable, even though the CRM belongs to the
// whole workspace. No development bypass and no production credentials.
const FOLDER = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const users = Array.from({ length: 5 }, (_, index) => ({
  id: `33333333-3333-4333-8333-33333333333${index}`,
  email: `cache-user-${index}@test.invalid`, name: `Test user ${index}`,
  role: index === 0 ? "admin" : "seller", status: "active",
  createdAt: "2026-10-01T00:00:00Z"
}));
const tokenFor = (user) => `test-access-${user.id}`;
const cookieFor = (user) => `outbound_os_access=${tokenFor(user)}`;

async function fakeCrm() {
  const hits = { cards: 0, searches: 0, folders: 0 };
  let revision = 1;
  const contact = () => ({
    id: CONTACT, folder_id: FOLDER, name: `Marta revision ${revision}`,
    company: "Test company", email: "marta@test.invalid", country: "Poland",
    linkedin: "https://www.linkedin.com/in/test-person/", lead_status: "new"
  });
  const service = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fake-crm.invalid");
    const send = (body, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/auth/v1/user") {
      const bearer = String(request.headers.authorization || "").replace(/^Bearer /, "");
      const user = users.find((candidate) => tokenFor(candidate) === bearer);
      return user
        ? send({ id: user.id, email: user.email, user_metadata: { name: user.name } })
        : send({ msg: "invalid token" }, 401);
    }
    if (url.pathname === "/rest/v1/profiles") {
      return send(users.map((user) => ({ id: user.id, email: user.email, role: user.role === "admin" ? "admin" : "user", approval_status: "approved" })));
    }
    if (url.pathname === "/rest/v1/contact_folders") {
      hits.folders += 1;
      return send([{ id: FOLDER, name: "Test folder", is_archived: false }]);
    }
    if (url.pathname === "/rest/v1/folder_stats") return send([{ folder_id: FOLDER, contact_count: 1 }]);
    if (url.pathname === "/rest/v1/contacts") {
      const marker = ++hits.cards;
      const result = { ...contact(), description: `upstream-card-${marker}` };
      // Keep this response pending long enough for duplicate HTTP callers to
      // overlap, instead of relying on a fast completed-result cache hit.
      await new Promise((resolve) => setTimeout(resolve, 35));
      return send([result]);
    }
    if (url.pathname === "/rest/v1/rpc/outbound_search_contacts") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const query = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(query.p_folder_id, FOLDER);
      const marker = ++hits.searches;
      const result = { ...contact(), position: `upstream-search-${marker}` };
      await new Promise((resolve) => setTimeout(resolve, 35));
      return send([result]);
    }
    if (url.pathname === "/auth/v1/admin/users") return send({ users });
    request.resume();
    return send([]);
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${service.address().port}`, hits,
    change: () => { revision += 1; },
    close: async () => {
      service.closeAllConnections();
      await new Promise((resolve) => service.close(resolve));
    }
  };
}

async function portal(crmOrigin) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-cache-http-"));
  const statePath = join(directory, "state.json");
  await writeFile(statePath, JSON.stringify({ version: 1, users, prospects: [], interactions: [] }));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    // An allowlist prevents developer shell integration secrets from escaping
    // into a test that is supposed to talk only to loopback fixtures.
    env: {
      PATH: process.env.PATH, NODE_ENV: "test", PORT: "0", STATE_FILE_PATH: statePath,
      AUTH_DEV_BYPASS: "0", WARMUP_SCHEDULER_DISABLED: "1", CONTACTS_INDEXED_SEARCH: "1",
      SUPABASE_URL: crmOrigin, SUPABASE_API_KEY: "sb_secret_fake_fixture",
      WARMUP_CRM_SUPABASE_URL: crmOrigin, WARMUP_CRM_SERVICE_ROLE_KEY: "sb_secret_fake_fixture",
      OPENROUTER_API_KEY: "", OPENROUTER_ANALYSIS_MODEL: "", OPENROUTER_WRITING_MODEL: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let origin;
  try { origin = await listeningOrigin(child, { timeoutMs: 5000 }); }
  catch (error) {
    child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
    throw new Error(`${error.message}: ${errors.slice(-1500)}`);
  }
  return {
    async ask(user, path, { body, headers = {} } = {}) {
      const response = await fetch(origin + path, {
        method: body ? "POST" : "GET", signal: AbortSignal.timeout(3000),
        headers: { "Content-Type": "application/json", ...(user ? { Cookie: cookieFor(user) } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      return { status: response.status, body: await response.json() };
    },
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function duplicatedReads(app, path) {
  return Promise.all(users.map(async (user) => {
    const answers = await Promise.all(Array.from({ length: 3 }, () => app.ask(user, path)));
    for (const answer of answers) assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answers[1], answers[0]);
    assert.deepEqual(answers[2], answers[0]);
    return answers[0].body;
  }));
}

test("HTTP contacts cache isolates five authenticated users, shares duplicate reads and invalidates after a successful mutation", { timeout: 15000 }, async () => {
  const crm = await fakeCrm();
  let app;
  try {
    app = await portal(crm.origin);
    const sessions = await Promise.all(users.map((user) => app.ask(user, "/api/auth/status")));
    for (let index = 0; index < users.length; index += 1) {
      assert.equal(sessions[index].status, 200);
      assert.equal(sessions[index].body.authenticated, true);
      assert.equal(sessions[index].body.user.id, users[index].id);
      assert.equal(sessions[index].body.user.role, users[index].role);
      assert.ok(sessions[index].body.workspaceId, "scope must include the server workspace");
    }
    assert.equal((await app.ask(null, `/api/contacts/${CONTACT}`)).status, 401);
    assert.equal(crm.hits.cards, 0, "anonymous requests must never reach cache/CRM");

    const cardPath = `/api/contacts/${CONTACT}`;
    const searchPath = `/api/contacts/search?folderId=${FOLDER}&search=marta`;
    const cards = await duplicatedReads(app, cardPath);
    const searches = await duplicatedReads(app, searchPath);
    assert.equal(crm.hits.cards, 5, "three concurrent reads per identity should share one flight, with none shared across identities");
    assert.equal(crm.hits.searches, 5);
    assert.equal(new Set(cards.map((body) => body.contact.description)).size, 5, "a user's cached card was reused for another user");
    assert.equal(new Set(searches.map((body) => body.contacts[0].position)).size, 5, "a user's cached search was reused for another user");
    assert.equal(cards.every((body) => body.drafts === null), true);

    // Cache scope must come from request.auth.profile, not a supplied header
    // or query field pretending to be an already cached colleague.
    const forged = await app.ask(users[4], `${cardPath}?cacheScope=${users[0].id}`, { headers: { "X-User-Id": users[0].id } });
    assert.deepEqual(forged.body, cards[4]);
    assert.equal(crm.hits.cards, 5);

    crm.change();
    assert.match((await app.ask(users[0], cardPath)).body.contact.name, /revision 1/);
    assert.match((await app.ask(users[0], searchPath)).body.contacts[0].name, /revision 1/);
    const mutation = await app.ask(users[0], `${cardPath}/messages`, { body: { language: "uk", instruction: "Short" } });
    assert.equal(mutation.status, 200, JSON.stringify(mutation.body));
    assert.equal(mutation.body.drafts.provider, "local");
    assert.equal(crm.hits.cards, 6, "mutation must perform a fresh CRM read rather than use cached contact data");

    const updatedCards = await duplicatedReads(app, cardPath);
    const updatedSearches = await duplicatedReads(app, searchPath);
    assert.equal(crm.hits.cards, 11, "successful write must invalidate all users' cached cards");
    assert.equal(crm.hits.searches, 10, "successful write must invalidate all users' cached search results");
    for (const body of updatedCards) {
      assert.match(body.contact.name, /revision 2/);
      assert.deepEqual(body.drafts, mutation.body.drafts);
    }
    for (const body of updatedSearches) assert.match(body.contacts[0].name, /revision 2/);

    await duplicatedReads(app, cardPath);
    await duplicatedReads(app, searchPath);
    assert.equal(crm.hits.cards, 11, "new card answers should remain reusable until invalidated/expired");
    assert.equal(crm.hits.searches, 10);
  } finally {
    await app?.close();
    await crm.close();
  }
});
