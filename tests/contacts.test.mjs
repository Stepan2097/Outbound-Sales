import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildFallbackDrafts, normalizeDrafts, normalizeLanguage } from "../contacts/drafts.mjs";

const port = 43221;
const origin = `http://127.0.0.1:${port}`;

/**
 * A stand-in for the CRM's PostgREST, answering the four questions the Contacts
 * screen asks. It is here rather than a mocked module because the thing worth
 * testing is the round trip: the query this app builds, the header PostgREST
 * answers a count in, and the row that comes back out of it.
 */
function startFakeCrm(contacts) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://crm.test");
    const send = (rows, { total = null } = {}) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        ...(total === null ? {} : { "content-range": `0-0/${total}` })
      });
      response.end(JSON.stringify(rows));
    };

    if (url.pathname === "/rest/v1/contact_folders") {
      send([{ id: "11111111-1111-4111-8111-111111111111", name: "Mobile studios", color: "#fff", owner_id: null, is_archived: false }]);
      return;
    }
    if (url.pathname === "/rest/v1/folder_stats") {
      send([{ folder_id: "11111111-1111-4111-8111-111111111111", contact_count: contacts.length }]);
      return;
    }
    if (url.pathname === "/rest/v1/contacts") {
      const idFilter = url.searchParams.get("id");
      if (idFilter) {
        const id = idFilter.replace("eq.", "");
        send(contacts.filter((contact) => contact.id === id));
        return;
      }
      const or = url.searchParams.get("or") || "";
      const term = /ilike\.\*([^*]+)\*/.exec(or)?.[1] || "";
      const matched = term
        ? contacts.filter((contact) => `${contact.name} ${contact.company} ${contact.position} ${contact.email}`.toLowerCase().includes(term.toLowerCase()))
        : contacts;
      if (request.headers.prefer?.includes("count=exact")) {
        send([], { total: matched.length });
        return;
      }
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 25);
      send(matched.slice(offset, offset + limit));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: `unexpected ${url.pathname}` }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Real uuids, not readable stand-ins: the CRM's own columns are uuid, and a
// fixture that could not exist in that database tests a path production never
// takes — which is exactly how a missing check on those ids stayed invisible.
const FOLDER = "11111111-1111-4111-8111-111111111111";

const people = [
  {
    id: "22222222-2222-4222-8222-222222222221",
    created_at: "2026-09-01T10:00:00Z",
    name: "Marta Kovalenko",
    company: "Fleetify",
    position: "Head of User Acquisition",
    country: "Poland",
    email: "marta@fleetify.example",
    phone: "+48 555 0111",
    telegram: "@marta",
    linkedin: "https://linkedin.com/in/marta",
    lead_status: "new",
    lifecycle_stage: "lead",
    description: "Met at a conference, runs UA for two titles.",
    folder_id: "11111111-1111-4111-8111-111111111111",
    custom_fields: { source: "conference" }
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    created_at: "2026-08-20T10:00:00Z",
    name: "Piotr Nowak",
    company: "Gamebridge",
    position: "CMO",
    country: "Poland",
    email: "piotr@gamebridge.example",
    lead_status: "new",
    folder_id: "11111111-1111-4111-8111-111111111111"
  }
];

test("contacts are read from the CRM, and three drafts are written for one of them", async () => {
  const { server: crm, url: crmUrl } = await startFakeCrm(people);
  const directory = await mkdtemp(join(tmpdir(), "outbound-contacts-test-"));
  const statePath = join(directory, "state.json");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE_PATH: statePath,
      AUTH_DEV_BYPASS: "1",
      WARMUP_CRM_SUPABASE_URL: crmUrl,
      WARMUP_CRM_SERVICE_ROLE_KEY: "test-key"
    },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));

  try {
    await waitForHealth();

    const { folders } = await getJson("/api/contacts/folders");
    assert.deepEqual(folders.map((folder) => [folder.name, folder.contactCount]), [["Mobile studios", 2]]);

    const page = await getJson("/api/contacts?folderId=11111111-1111-4111-8111-111111111111&limit=1");
    assert.equal(page.total, 2, "the total counts the folder, not the page");
    assert.equal(page.contacts.length, 1, "the page is the page that was asked for");

    const searched = await getJson("/api/contacts?folderId=11111111-1111-4111-8111-111111111111&search=gamebridge");
    assert.deepEqual(searched.contacts.map((contact) => contact.name), ["Piotr Nowak"]);

    const card = await getJson("/api/contacts/22222222-2222-4222-8222-222222222221");
    assert.equal(card.contact.telegram, "@marta");
    assert.equal(card.contact.description, "Met at a conference, runs UA for two titles.");
    assert.equal(card.drafts, null, "nothing has been written for her yet");
    assert.equal(card.prospectId, null, "and she is not in the queue");

    // No OpenRouter key in a test, so this is the fallback path: it still has
    // to answer with three usable drafts rather than an error.
    const { drafts } = await postJson("/api/contacts/22222222-2222-4222-8222-222222222221/messages", { language: "uk" });
    assert.equal(drafts.provider, "local");
    assert.ok(drafts.email.subject, "an email needs a subject");
    assert.match(drafts.email.body, /Marta/, "the person's name reaches the draft");
    assert.ok(drafts.telegram.body.length > 0);
    assert.ok(drafts.linkedin.invite.length <= 300, "LinkedIn cuts an invitation note at 300 characters");
    assert.ok(drafts.linkedin.body.length > 0);
    assert.equal(drafts.language, "uk");
    assert.ok(drafts.verifyBeforeSending.length, "a draft written without a model says so");

    const reopened = await getJson("/api/contacts/22222222-2222-4222-8222-222222222221");
    assert.equal(reopened.drafts.email.subject, drafts.email.subject, "reopening shows what was already written");

    const imported = await postJson("/api/contacts/22222222-2222-4222-8222-222222222221/import", {});
    const prospect = imported.prospects.find((item) => item.id === imported.prospectId);
    assert.equal(prospect.name, "Marta Kovalenko");
    assert.equal(prospect.crmSource.contact_id, "22222222-2222-4222-8222-222222222221");
    // Twice is still one lead: the CRM id is what makes them the same person.
    const again = await postJson("/api/contacts/22222222-2222-4222-8222-222222222221/import", {});
    assert.equal(again.prospects.filter((item) => item.crmSource?.contact_id === "22222222-2222-4222-8222-222222222221").length, 1);
    assert.equal((await getJson("/api/contacts/22222222-2222-4222-8222-222222222221")).prospectId, again.prospectId);

    const missing = await fetch(`${origin}/api/contacts/nope`);
    assert.equal(missing.status, 404);

    // Without a folder this would be a page of the whole CRM plus an exact
    // count of it, which on a real base comes back as a statement timeout.
    const unscoped = await fetch(`${origin}/api/contacts?limit=3`);
    assert.equal(unscoped.status, 400);
    assert.match((await unscoped.json()).error, /обери папку/i);

    await waitForFile(statePath);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.ok(saved.contactDrafts["22222222-2222-4222-8222-222222222221"], "drafts outlive the process that wrote them");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    crm.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a CRM this workspace cannot reach is said to be the CRM, not a bug here", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-contacts-nocrm-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port + 1),
      STATE_FILE_PATH: join(directory, "state.json"),
      AUTH_DEV_BYPASS: "1",
      WARMUP_CRM_SUPABASE_URL: "",
      WARMUP_CRM_SERVICE_ROLE_KEY: "",
      SUPABASE_URL: "",
      SUPABASE_API_KEY: ""
    },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  try {
    await waitForHealth(`http://127.0.0.1:${port + 1}`);
    const response = await fetch(`http://127.0.0.1:${port + 1}/api/contacts/folders`);
    assert.equal(response.status, 503);
    const body = await response.json();
    // The sentence names the variables somebody has to set.
    assert.match(body.error, /CRM не налаштована/);
    assert.match(body.error, /WARMUP_CRM_SUPABASE_URL/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * The Панель does not browse a folder — it walks it.
 *
 * So what it asks the server for is a position, and what it must get back is
 * the person standing there, taken into the lead queue, with the size of the
 * folder beside them. The three things that decide whether the walk works are
 * all here: the same position twice is the same lead and not a second one, a
 * row the CRM cannot make a lead out of is named rather than silently skipped,
 * and walking off the end says so instead of erroring.
 */
test("the panel walks a folder by position and takes each person into the queue", async () => {
  const roster = [
    people[0],
    people[1],
    { id: "22222222-2222-4222-8222-222222222223", created_at: "2026-09-05T10:00:00Z", name: "Olena Bila", company: "", position: "", folder_id: "11111111-1111-4111-8111-111111111111" }
  ];
  const { server: crm, url: crmUrl } = await startFakeCrm(roster);
  const directory = await mkdtemp(join(tmpdir(), "outbound-panel-test-"));
  const walkPort = port + 2;
  const walkOrigin = `http://127.0.0.1:${walkPort}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(walkPort),
      STATE_FILE_PATH: join(directory, "state.json"),
      AUTH_DEV_BYPASS: "1",
      WARMUP_CRM_SUPABASE_URL: crmUrl,
      WARMUP_CRM_SERVICE_ROLE_KEY: "test-key"
    },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  const open = async (index) => {
    const response = await fetch(`${walkOrigin}/api/contacts/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId: "11111111-1111-4111-8111-111111111111", index })
    });
    assert.ok(response.ok, `position ${index} answered ${response.status}`);
    return response.json();
  };

  try {
    await waitForHealth(walkOrigin);

    const first = await open(0);
    assert.equal(first.queue.total, 3, "the position is reported against the whole folder");
    assert.equal(first.queue.contact.id, "22222222-2222-4222-8222-222222222221");
    assert.ok(first.queue.prospectId, "the person opened is a lead the rest of the page can work with");
    assert.equal(first.prospects.find((item) => item.id === first.queue.prospectId).name, "Marta Kovalenko");

    const fromFolder = (payload) => payload.prospects.filter((item) => item.crmSource?.folder_id === "11111111-1111-4111-8111-111111111111");

    const second = await open(1);
    assert.equal(second.queue.contact.id, "22222222-2222-4222-8222-222222222222");
    assert.equal(fromFolder(second).length, 2);

    // Coming back to somebody already walked past reopens the same lead rather
    // than making a second one with its own research bill.
    const back = await open(0);
    assert.equal(back.queue.prospectId, first.queue.prospectId);
    assert.equal(fromFolder(back).length, 2, "walking back does not grow the queue");

    const unusable = await open(2);
    assert.equal(unusable.queue.contact.id, "22222222-2222-4222-8222-222222222223");
    assert.equal(unusable.queue.prospectId, "", "a row with no company is not a lead");
    assert.match(unusable.queue.warning, /компанії/, "and the panel is told why");

    const past = await open(3);
    assert.equal(past.queue.contact, null);
    assert.equal(past.queue.total, 3);
    assert.match(past.queue.warning, /кінець папки/);

    // A name of ours is never a contact id. Any request to this block's own
    // endpoints that does not match its method used to fall through to "fetch
    // the person whose id is `queue`", and the seller saw a database error
    // about a uuid for a route that exists.
    const wrongMethod = await fetch(`${walkOrigin}/api/contacts/queue`);
    assert.equal(wrongMethod.status, 405);
    const refusal = await wrongMethod.json();
    assert.equal(refusal.expected, "POST");
    // The method is in the answer because a screenshot cannot show it, and it
    // is the one fact that separates "the client sent the wrong thing" from
    // "something between the client and here changed it".
    assert.equal(refusal.received, "GET");
    assert.doesNotMatch(refusal.error, /uuid/i);

    const foldersWrongMethod = await fetch(`${walkOrigin}/api/contacts/folders`, { method: "POST" });
    assert.equal(foldersWrongMethod.status, 405);
    assert.equal((await foldersWrongMethod.json()).expected, "GET");

    // A folder id that cannot be one is answered by us, naming the field and
    // the value, rather than by Postgres naming a type. The two produced the
    // same sentence before — `invalid input syntax for type uuid: "queue"` —
    // whichever field was wrong, which is why a live report of it could not be
    // traced to either the path or the body.
    const badFolder = await fetch(`${walkOrigin}/api/contacts/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId: "queue", index: 0 })
    });
    assert.equal(badFolder.status, 400);
    const complaint = await badFolder.json();
    assert.match(complaint.error, /Папка/);
    assert.match(complaint.error, /queue/);
    assert.doesNotMatch(complaint.error, /uuid/i);

    // And a contact id that cannot be one is nobody we have, not a type error.
    const badContact = await fetch(`${walkOrigin}/api/contacts/not-an-id`);
    assert.equal(badContact.status, 404);
    assert.doesNotMatch((await badContact.json()).error, /uuid/i);

    // A folder is still required: a position in the whole CRM is not a queue.
    const unscoped = await fetch(`${walkOrigin}/api/contacts/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: 0 })
    });
    assert.equal(unscoped.status, 400);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    crm.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the drafts written without a model still follow the channel's limits", () => {
  const contact = { name: "Marta Kovalenko", company: "Fleetify", position: "Head of UA" };
  const product = {
    name: "AdAction",
    brief: {
      offer: "Value-exchange реклама для застосунків.",
      pain: "Канали вигоряють, CPI росте",
      proof: "Студія на 60 людей: 40% інсталів за два квартали",
      firstStep: "Тест на одну країну і одну подію"
    }
  };

  for (const language of ["uk", "en", "ru"]) {
    const drafts = buildFallbackDrafts({ contact, product, language });
    assert.ok(drafts.email.subject.length <= 80);
    assert.match(drafts.email.body, /Marta/);
    assert.ok(drafts.telegram.body.split(/\s+/).length <= 61, "Telegram stays short");
    assert.ok(drafts.linkedin.invite.length <= 300);
    assert.ok(drafts.linkedin.body.split(/\s+/).length <= 91);
  }

  // An unknown language is English rather than an empty page.
  assert.equal(normalizeLanguage("klingon"), "en");

  // A model that answers with half the shape still produces four usable drafts.
  const fallback = buildFallbackDrafts({ contact, product, language: "en" });
  const merged = normalizeDrafts({ email: { subject: "your two ua roles" }, linkedin: { note: "x".repeat(400) } }, fallback);
  assert.equal(merged.email.subject, "your two ua roles");
  assert.equal(merged.email.body, fallback.email.body, "a missing body falls back rather than rendering empty");
  assert.equal(merged.linkedin.invite.length, 300, "an over-long note is cut to what LinkedIn accepts");
});

async function getJson(path) {
  const response = await fetch(`${origin}${path}`);
  assert.equal(response.status, 200, `${path} answered ${response.status}`);
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.ok(response.ok, `${path} answered ${response.status}`);
  return response.json();
}

async function waitForHealth(base = origin) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not start.");
}

async function waitForFile(path) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const saved = JSON.parse(await readFile(path, "utf8"));
      if (saved.contactDrafts) return;
    } catch {
      // Still being written.
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Persistent state was not written.");
}
