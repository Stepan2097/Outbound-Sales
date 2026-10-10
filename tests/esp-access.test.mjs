import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ESP_PERMISSIONS, ROLE_DEFAULTS, accessView, adminLog, can, changeAccess, logAdminAction, permissionsOf } from "../esp/access.mjs";
import { handleEspApi } from "../esp/api.mjs";
import { handleEspDataApi } from "../esp/data-api.mjs";
import { allEntries, useJournal } from "../esp/journal.mjs";
import { addDomain, addSender } from "../esp/registry.mjs";
import { SECRET_SHAPES, looksLikeSecret, secretsStatus } from "../esp/secrets.mjs";
import { listeningOrigin } from "./server-origin.mjs";

/**
 * ESP 10 — who may do what, the log of what administrators did, and secrets
 * that never leave the environment.
 *
 * Roles are the workspace's two (admin, seller); the rights on top of them are
 * the checklist's — launching campaigns, changing limits, reading replies — and
 * an administrator can hand one to a seller or take one away, every time as a
 * journal line with their name on it.
 */

let dir;

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "esp-access-"));
  useJournal(join(dir, "esp-journal.jsonl"));
});

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ADMIN = { email: "stepan@advantage-agency.co", role: "admin" };
const SELLER = { email: "Ira@Advantage-Agency.co", role: "seller" };

async function data({ method = "GET", path, body = null, profile = ADMIN, env = {} }) {
  let captured = null;
  const handled = await handleEspDataApi({
    request: { method }, response: {}, url: new URL(`http://x${path}`),
    sendJson: (_response, status, payload) => { captured = { status, payload }; },
    readJson: async () => body, profile, env,
    dns: { resolveMx: async () => [], resolveTxt: async () => [] }
  });
  return { handled, ...captured };
}

// ── права ─────────────────────────────────────────────────────────────────

test("за замовчуванням: адміністратор може все, продавець — лише бачити відповіді", async () => {
  assert.deepEqual([...await permissionsOf(ADMIN)].sort(), Object.keys(ESP_PERMISSIONS).sort());
  assert.deepEqual([...await permissionsOf(SELLER)], ["replies.read"]);
  assert.deepEqual(ROLE_DEFAULTS.seller, ["replies.read"]);
  for (const right of ["campaigns.launch", "limits.change", "registry.change", "stop.all", "journal.read", "access.manage", "templates.edit"]) {
    assert.equal(await can(SELLER, right), false, right);
  }
  assert.equal(await can(null, "replies.read"), true, "без профілю — як продавець, не як адмін");
  assert.equal(await can(null, "limits.change"), false);
});

test("адміністратор видає продавцю право й забирає його; кожна зміна — рядок із його іменем", async () => {
  const granted = await changeAccess({ email: "ira@advantage-agency.co", permission: "campaigns.launch", grant: true }, ADMIN);
  assert.equal(granted.type, "access.granted");
  assert.equal(granted.actor, "stepan@advantage-agency.co");
  assert.equal(await can(SELLER, "campaigns.launch"), true, "адреса порівнюється без регістру");
  assert.equal(await changeAccess({ email: "ira@advantage-agency.co", permission: "campaigns.launch", grant: true }, ADMIN), null, "вже є — нічого не дописано");

  await changeAccess({ email: "ira@advantage-agency.co", permission: "replies.read", grant: false }, ADMIN);
  assert.equal(await can(SELLER, "replies.read"), false, "і право за замовчуванням можна забрати");
  await changeAccess({ email: "ira@advantage-agency.co", permission: "campaigns.launch", grant: false }, ADMIN);
  assert.deepEqual([...await permissionsOf(SELLER)], []);
  assert.deepEqual((await allEntries()).map((row) => row.type), ["access.granted", "access.revoked", "access.revoked"]);
});

test("продавець прав не видає; «видавати доступи» — це роль, її не видають; адміністратора не позбавити прав", async () => {
  await assert.rejects(() => changeAccess({ email: "x@y.co", permission: "limits.change", grant: true }, SELLER), /лише адміністратор/);
  await assert.rejects(() => changeAccess({ email: "ira@advantage-agency.co", permission: "access.manage", grant: true }, ADMIN), /роль адміністратора/);
  await assert.rejects(() => changeAccess({ email: "ira@advantage-agency.co", permission: "drop.everything", grant: true }, ADMIN), /Такого права немає/);
  await changeAccess({ email: "stepan@advantage-agency.co", permission: "replies.read", grant: false }, ADMIN);
  assert.equal(await can(ADMIN, "replies.read"), true, "адміністратор має все, що б не було записано");
});

test("права діють на маршрутах: етап рампи — «ліміти», виведення — «реєстр», хронологія — «відповіді»", async () => {
  await addDomain({ domain: "send.example.com", status: "ramp" }, "a");
  await addSender({ email: "mary@send.example.com" }, "a");
  await addSender({ email: "mark@send.example.com" }, "a");

  let ramp = await data({ method: "POST", path: "/api/esp/senders/update", body: { email: "mary@send.example.com", rampStage: 10 }, profile: SELLER });
  assert.equal(ramp.status, 403);
  assert.match(ramp.payload.error, /limits\.change/);
  await changeAccess({ email: SELLER.email, permission: "limits.change", grant: true }, ADMIN);
  ramp = await data({ method: "POST", path: "/api/esp/senders/update", body: { email: "mary@send.example.com", rampStage: 10 }, profile: SELLER });
  assert.equal(ramp.status, 201);
  assert.equal((await data({ method: "POST", path: "/api/esp/senders/status", body: { email: "mary@send.example.com", status: "paused", reason: "bounce" }, profile: SELLER })).status, 201, "пауза — теж ліміт");
  const retire = await data({ method: "POST", path: "/api/esp/senders/status", body: { email: "mark@send.example.com", status: "retired", reason: "x" }, profile: SELLER });
  assert.equal(retire.status, 403, "вивести назавжди — право реєстру, не ліміту");
  assert.equal((await data({ method: "POST", path: "/api/esp/domains", body: { domain: "new.example.com" }, profile: SELLER })).status, 403);

  assert.equal((await data({ path: "/api/esp/contacts/timeline?email=a@b.co", profile: SELLER })).status, 200);
  await changeAccess({ email: SELLER.email, permission: "replies.read", grant: false }, ADMIN);
  assert.equal((await data({ path: "/api/esp/contacts/timeline?email=a@b.co", profile: SELLER })).status, 403);

  const registry = await data({ path: "/api/esp/registry", profile: SELLER });
  assert.equal(registry.payload.canLimit, true);
  assert.equal(registry.payload.canAdd, false);
});

test("маршрути доступів: матриця й свої права — кожному, люди й зміни — лише адміністратору", async () => {
  await changeAccess({ email: SELLER.email, permission: "templates.edit", grant: true }, ADMIN);
  const mine = await data({ path: "/api/esp/access", profile: SELLER });
  assert.deepEqual(mine.payload.mine.sort(), ["replies.read", "templates.edit"]);
  assert.deepEqual(mine.payload.people, [], "продавець не бачить, кому що видано");
  const all = await data({ path: "/api/esp/access" });
  assert.equal(all.payload.people[0].email, "ira@advantage-agency.co");
  assert.deepEqual(all.payload.people[0].granted, ["templates.edit"]);
  assert.equal((await data({ method: "POST", path: "/api/esp/access/grant", body: { email: "x@y.co", permission: "stop.all" }, profile: SELLER })).status, 403);
  const given = await data({ method: "POST", path: "/api/esp/access/grant", body: { email: "x@y.co", permission: "stop.all" } });
  assert.equal(given.status, 200);
  assert.equal(given.payload.event.type, "access.granted");
});

// ── журнал дій адміністраторів ────────────────────────────────────────────

test("журнал дій адміністраторів: реєстр, доступи й admin.* — найновіше першим; листи туди не потрапляють", async () => {
  await addDomain({ domain: "send.example.com", status: "ramp" }, "stepan@advantage-agency.co");
  await changeAccess({ email: SELLER.email, permission: "campaigns.launch", grant: true }, ADMIN);
  await logAdminAction("role_changed", "stepan@advantage-agency.co", { email: "ira@advantage-agency.co", role: "admin" });
  const { recordAboutContact } = await import("../esp/messages.mjs");
  await recordAboutContact("contact.note", "a@b.co", { text: "не адмінська дія" });
  const log = await adminLog();
  assert.deepEqual(log.map((row) => row.type), ["admin.role_changed", "access.granted", "domain.added"]);
  assert.ok(log.every((row) => row.actor === "stepan@advantage-agency.co"));
  assert.equal((await data({ path: "/api/esp/admin-log", profile: SELLER })).status, 403);
  assert.equal((await data({ path: "/api/esp/admin-log?limit=1" })).payload.events.length, 1);
});

test("у журнал дій не потрапляє жоден ключ, пароль чи токен, навіть якщо його передали", async () => {
  const event = await logAdminAction("model_provider_set", "a@b.co", { provider: "openrouter", apiKey: "sk-or-v1-0123456789abcdef0123", password: "x", accessToken: "y", version: 2 });
  assert.deepEqual(event.data, { provider: "openrouter", version: 2 });
  await assert.rejects(() => logAdminAction("Drop Table", "a"), /Невідома дія/);
});

test("налаштування пошти ESP 1/2 теж за правами: підпис — «шаблони»; зняття паузи — «ліміти»; і обидва в журналі дій", async () => {
  const written = [];
  const esp = {
    templates: { list: () => [] },
    signature: { read: () => null, write: async (value) => { written.push(value); } },
    gate: { resume: async () => true, paused: async () => [] },
    connector: { describe: () => ({ kind: "stub" }) }
  };
  const call = async (method, path, body, profile) => {
    let captured = null;
    await handleEspApi({
      request: { method, auth: { profile } }, response: {}, url: new URL(`http://x/api/esp${path}`),
      sendJson: (_response, status, payload) => { captured = { status, payload }; },
      readJson: async () => body, esp
    });
    return captured;
  };
  assert.equal((await call("PUT", "/signature", { name: "Mary" }, SELLER)).status, 403);
  await changeAccess({ email: SELLER.email, permission: "templates.edit", grant: true }, ADMIN);
  assert.equal((await call("PUT", "/signature", { name: "Mary" }, SELLER)).status, 200);
  assert.equal(written.length, 1);
  assert.equal((await call("POST", "/senders/resume", { mailbox: "mary@send.example.com" }, SELLER)).status, 403);
  assert.equal((await call("POST", "/senders/resume", { mailbox: "mary@send.example.com" }, ADMIN)).status, 200);
  assert.equal((await call("GET", "/connection", null, SELLER)).status, 403, "підключення — право реєстру");
  const log = await adminLog();
  assert.deepEqual(log.map((row) => [row.type, row.actor]).slice(0, 2), [
    ["admin.mailbox_resumed", "stepan@advantage-agency.co"],
    ["admin.signature_changed", "ira@advantage-agency.co"]
  ]);
});

// ── секрети ───────────────────────────────────────────────────────────────

test("стан секретів — лише назви й так/ні: ні значення, ні його початку, ні довжини", async () => {
  const env = {
    ESP_GMAIL_SERVICE_ACCOUNT_BASE64: "eyJ0eXBlIjoic2VydmljZV9hY2NvdW50In0=",
    SPAMHAUS_DQS_KEY: "",
    GMAIL_MARY_TOKEN: "ya29.secret-access-token-value-123",
    ESP_LIVE_SEND: "0"
  };
  const status = secretsStatus(env, [{ email: "mary@send.example.com", mailboxRef: "GMAIL_MARY_TOKEN" }, { email: "x@send.example.com", mailboxRef: "GMAIL_X" }]);
  assert.deepEqual(status.secrets.map((row) => [row.name, row.set, row.via]), [
    ["ESP_GMAIL_SERVICE_ACCOUNT_JSON", true, "ESP_GMAIL_SERVICE_ACCOUNT_BASE64"],
    ["SPAMHAUS_DQS_KEY", false, null]
  ]);
  assert.deepEqual(status.switches, [{ name: "ESP_LIVE_SEND", purpose: status.switches[0].purpose, on: false }]);
  assert.deepEqual(status.mailboxes.map((row) => [row.email, row.set]), [["mary@send.example.com", true], ["x@send.example.com", false]]);
  const text = JSON.stringify(status);
  for (const value of Object.values(env).filter((value) => value.length > 2)) assert.equal(text.includes(value), false, "значення не видно");
  assert.equal((await data({ path: "/api/esp/secrets", profile: SELLER, env })).status, 403);
  assert.equal((await data({ path: "/api/esp/secrets", env })).payload.secrets[0].set, true);
});

test("у репозиторії немає жодного ключа: приватних ключів, ключів Google, токенів OAuth, ключів OpenRouter", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).split("\n").filter(Boolean)
    .filter((file) => !/\.(png|jpe?g|gif|webp|ico|pdf|woff2?)$/i.test(file));
  assert.ok(files.length > 50, "файли репозиторію прочитано");
  const offenders = [];
  for (const file of files) {
    let text;
    try { text = execFileSync("git", ["show", `HEAD:${file}`], { cwd: new URL("..", import.meta.url), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); } catch { continue; }
    if (file === "esp/secrets.mjs" || file === "tests/esp-access.test.mjs") continue;
    if (looksLikeSecret(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
  assert.equal(looksLikeSecret("-----BEGIN PRIVATE KEY-----\nMIIE"), true);
  assert.equal(looksLikeSecret('"private_key": "-----BEGIN PRIVATE KEY-----'), true);
  assert.equal(looksLikeSecret("AIza" + "S".repeat(35)), true);
  assert.equal(SECRET_SHAPES.length >= 5, true);
});

test("сервер із ключами в середовищі не пише їх ні в стан, ні в журнал, ні у відповіді", async () => {
  const folder = await mkdtemp(join(tmpdir(), "esp-secrets-run-"));
  const privateKey = "-----BEGIN PRIVATE KEY-----\\nFAKEKEYDATAforTESTonlyQQQQ\\n-----END PRIVATE KEY-----\\n";
  const serviceAccount = JSON.stringify({ type: "service_account", client_email: "esp@proj.iam.gserviceaccount.com", private_key: privateKey, token_uri: "https://oauth2.googleapis.com/token" });
  const dqs = "dqsFAKEkey0123456789";
  const env = { ...process.env, PORT: "0", STATE_FILE_PATH: join(folder, "state.json"), AUTH_DEV_BYPASS: "1", WARMUP_SCHEDULER_DISABLED: "1",
    ESP_GMAIL_SERVICE_ACCOUNT_JSON: serviceAccount, SPAMHAUS_DQS_KEY: dqs, ESP_LIVE_SEND: "0" };
  delete env.APP_ENV;
  delete env.NODE_ENV;
  delete env.ESP_JOURNAL_PATH;
  const child = spawn(process.execPath, ["server.mjs"], { cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const origin = await listeningOrigin(child);
    const answers = [];
    const ask = async (path, init) => { const response = await fetch(`${origin}${path}`, init); answers.push(await response.text()); return response; };
    await ask("/api/esp/secrets");
    await ask("/api/esp/connection");
    await ask("/api/esp/domains", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domain: "send.example.com", status: "ramp" }) });
    await ask("/api/esp/domains/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domain: "send.example.com" }) });
    await ask("/api/esp/signature", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Mary" }) });
    const secrets = JSON.parse(answers[0]);
    assert.equal(secrets.secrets.find((row) => row.name === "SPAMHAUS_DQS_KEY").set, true);
    const journal = await readFile(join(folder, "esp-journal.jsonl"), "utf8");
    assert.match(journal, /domain\.added/);
    const state = await readFile(join(folder, "state.json"), "utf8").catch(() => "");
    for (const [label, text] of [["відповіді", answers.join("\n")], ["журнал", journal], ["стан", state]]) {
      assert.equal(text.includes("FAKEKEYDATAforTESTonly"), false, `приватний ключ у ${label}`);
      assert.equal(text.includes(dqs), false, `ключ DQS у ${label}`);
      assert.equal(looksLikeSecret(text), false, `щось схоже на ключ у ${label}`);
    }
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    await rm(folder, { recursive: true, force: true });
  }
});

test("огляд доступів для екрана: матриця, ролі, люди з їхніми змінами", async () => {
  await changeAccess({ email: "ira@advantage-agency.co", permission: "limits.change", grant: true }, ADMIN);
  const view = await accessView(ADMIN);
  assert.equal(view.permissions["limits.change"], ESP_PERMISSIONS["limits.change"]);
  assert.deepEqual(view.people[0].rights.sort(), ["limits.change", "replies.read"]);
  assert.equal(view.people[0].history[0].actor, "stepan@advantage-agency.co");
});
