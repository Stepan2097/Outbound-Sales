import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listeningOrigin } from "./server-origin.mjs";

// «Смисли» (таск 1b128e83): картки продуктів для лідгенів. Читають усі, пише
// лише адміністратор; зміст переживає рестарт, бо лежить поруч зі станом на
// томі /data, а seed береться тільки на порожньому томі.

const SEED = JSON.parse(await readFile(new URL("../knowledge/seed/pitch-products.json", import.meta.url), "utf8"));

async function startServer(dir, role = "admin") {
  const statePath = join(dir, "state.json");
  // Роль входу задає збережений профіль: AUTH_DEV_BYPASS заходить як dev-user.
  await writeFile(statePath, JSON.stringify({
    version: 1,
    users: [{ id: "dev-user", email: "developer@localhost", name: "Local Tester", role, status: "active", createdAt: new Date().toISOString() }]
  }), "utf8");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: "0", STATE_FILE_PATH: statePath, AUTH_DEV_BYPASS: "1", WARMUP_SCHEDULER_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const origin = await listeningOrigin(child);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const call = async (path, { method = "GET", json, body, headers = {} } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: json !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
      body: json !== undefined ? JSON.stringify(json) : body
    });
    const type = response.headers.get("content-type") || "";
    return {
      status: response.status,
      headers: response.headers,
      body: type.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer())
    };
  };
  return {
    call,
    stop: async () => {
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
  };
}

async function workspaceDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "outbound-pitch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a fresh volume opens with the six products from the artifact, in order, nothing dropped", async (t) => {
  const dir = await workspaceDir(t);
  const server = await startServer(dir);
  t.after(() => server.stop());

  const { status, body } = await server.call("/api/pitch");
  assert.equal(status, 200);
  assert.equal(body.canEdit, true);
  assert.deepEqual(body.products.map((product) => product.name), [
    "FB навчання — Black Affiliate", "FB аудит — Strategic Audit", "In-App / Unity навчання",
    "Google Ads for iGaming · Playbook", "Платформа з тулами", "Трафік — тільки як виняток"
  ]);
  for (const [index, product] of body.products.entries()) {
    const seeded = SEED.products[index];
    assert.deepEqual(product.sections.map((section) => section.title), seeded.sections.map((section) => section.title), `${product.name}: усі розділи`);
    assert.equal(product.links.length, seeded.links.length, `${product.name}: усі посилання`);
    assert.ok(product.price && product.pitch && product.oneLiner, `${product.name}: ціна, пітч і one-liner`);
  }
  const all = JSON.stringify(body);
  assert.match(all, /5 місяців/);
  assert.doesNotMatch(all, /4 months|звірити|3 місяці/, "доступ до навчання — 5 місяців, без приміток для дева");
  assert.doesNotMatch(all, /hasPwaAccess|Що треба полагодити/, "технічна примітка й розділ для дева не для лідгенів");
  const platform = body.products.find((product) => product.id === "platform");
  assert.match(platform.sections.find((section) => section.title === "Тріал").text, /включно з Traffstore/);
  assert.match(body.intro, /Пріоритет продажу/);
});

test("an admin edits, adds an update, a link, a file and a product — and all of it survives a restart", async (t) => {
  const dir = await workspaceDir(t);
  let server = await startServer(dir);

  const edited = await server.call("/api/pitch/products/fb-audit", {
    method: "POST",
    json: { price: "$600, одноразово", sections: [{ title: "Кому", text: "- Хто вже ллє FB\n- **І має бюджет**" }] }
  });
  assert.equal(edited.status, 200);
  const audit = edited.body.book.products.find((product) => product.id === "fb-audit");
  assert.equal(audit.price, "$600, одноразово");
  assert.equal(audit.updatedBy, "Local Tester");
  assert.equal(audit.updatedAt.slice(0, 10), new Date().toISOString().slice(0, 10), "дата ставиться сама");

  assert.equal((await server.call("/api/pitch/products/fb-audit/updates", { method: "POST", json: { text: "Ціна аудиту тепер $600" } })).status, 200);
  assert.equal((await server.call("/api/pitch/products/fb-audit/links", { method: "POST", json: { label: "Бриф аудиту", url: "https://example.com/brief" } })).status, 200);
  const bad = await server.call("/api/pitch/products/fb-audit/links", { method: "POST", json: { url: "javascript:alert(1)" } });
  assert.equal(bad.status, 400, "лише http(s)-посилання");

  const pdf = Buffer.from("%PDF-1.4\n% тестовий файл\n%%EOF\n", "utf8");
  const uploaded = await server.call("/api/pitch/products/fb-audit/files", {
    method: "POST",
    body: pdf,
    headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent("Аудит — приклад.pdf") }
  });
  assert.equal(uploaded.status, 200);
  const file = uploaded.body.book.products.find((product) => product.id === "fb-audit").files[0];
  assert.equal(file.name, "Аудит — приклад.pdf");

  const created = await server.call("/api/pitch/products", { method: "POST", json: { name: "Новий продукт для тесту" } });
  assert.equal(created.status, 201);
  await server.stop();

  server = await startServer(dir);
  t.after(() => server.stop());
  const { body } = await server.call("/api/pitch");
  const after = body.products.find((product) => product.id === "fb-audit");
  assert.equal(after.price, "$600, одноразово");
  assert.deepEqual(after.sections.map((section) => section.text), ["- Хто вже ллє FB\n- **І має бюджет**"]);
  assert.equal(after.updates[0].text, "Ціна аудиту тепер $600");
  assert.equal(after.updates[0].by, "Local Tester");
  assert.ok(after.links.some((link) => link.url === "https://example.com/brief"));
  assert.ok(body.products.some((product) => product.name === "Новий продукт для тесту"), "новий продукт на місці");

  const download = await server.call(`/api/pitch/files/${encodeURIComponent(after.files[0].id)}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/pdf");
  assert.deepEqual(download.body, pdf, "скачується той самий файл");
  assert.match(download.headers.get("content-disposition"), /filename\*=UTF-8''/);
});

test("a seller reads and downloads, and every write is refused with 403", async (t) => {
  const dir = await workspaceDir(t);
  // Спершу адмін кладе файл — щоб продавцю було що скачати.
  const admin = await startServer(dir);
  const uploaded = await admin.call("/api/pitch/products/platform/files", {
    method: "POST", body: Buffer.from("hello"), headers: { "Content-Type": "text/plain", "X-File-Name": "a.txt" }
  });
  const fileId = uploaded.body.book.products.find((product) => product.id === "platform").files[0].id;
  await admin.stop();

  const seller = await startServer(dir, "seller");
  t.after(() => seller.stop());
  const read = await seller.call("/api/pitch");
  assert.equal(read.status, 200);
  assert.equal(read.body.canEdit, false);
  assert.equal(read.body.products.length, 6);
  assert.equal((await seller.call(`/api/pitch/files/${fileId}`)).status, 200);

  const writes = [
    ["/api/pitch/products/platform", { price: "$1" }],
    ["/api/pitch/products/platform/updates", { text: "x" }],
    ["/api/pitch/products/platform/links", { url: "https://example.com" }],
    ["/api/pitch/products", { name: "x" }],
    ["/api/pitch/intro", { text: "x" }],
    ["/api/pitch/products/platform/archive", {}],
    [`/api/pitch/products/platform/files/${fileId}/delete`, {}]
  ];
  for (const [path, json] of writes) {
    const { status } = await seller.call(path, { method: "POST", json });
    assert.equal(status, 403, `${path} — лише адмін`);
  }
  const upload = await seller.call("/api/pitch/products/platform/files", { method: "POST", body: Buffer.from("x"), headers: { "Content-Type": "text/plain", "X-File-Name": "b.txt" } });
  assert.equal(upload.status, 403);
  const still = await seller.call("/api/pitch");
  assert.equal(still.body.products.find((product) => product.id === "platform").price, read.body.products.find((product) => product.id === "platform").price, "нічого не змінилось");
});

test("an archived product leaves the screen but its data stays on disk", async (t) => {
  const dir = await workspaceDir(t);
  const server = await startServer(dir);
  t.after(() => server.stop());
  assert.equal((await server.call("/api/pitch/products/traffic/archive", { method: "POST", json: {} })).status, 200);
  const { body } = await server.call("/api/pitch");
  assert.equal(body.products.some((product) => product.id === "traffic"), false);
  const onDisk = JSON.parse(await readFile(join(dir, "pitch", "index.json"), "utf8"));
  assert.equal(onDisk.products.find((product) => product.id === "traffic").archived, true);
});
