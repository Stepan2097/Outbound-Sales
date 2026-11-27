import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TOKEN_PREFIX, issueToken, publicToken, revokeToken, tokenRow } from "../state/access-tokens.mjs";
import { MCP_TOOL_NAMES, mcpServer } from "../state/mcp.mjs";
import { listeningOrigin } from "./server-origin.mjs";

/**
 * Власник 27.11: «зробити можливість щоб чат гпт підключався до оутбаун і мав можливість писати
 * листи людям через лінкедин … дати таку можливість Богдану». ChatGPT підключається як конектор
 * MCP з особистим ключем людини й робить те саме, що вона в Workspace, — не більше.
 */

test("ключ: показується раз, зберігається лише хеш, відкликається одразу", () => {
  const { plain, row, list } = issueToken([], { userId: "bohdan", email: "Bohdan@x.co" });
  assert.ok(plain.startsWith(TOKEN_PREFIX));
  assert.equal(JSON.stringify(list).includes(plain), false, "сам ключ ніде не лежить");
  assert.equal(tokenRow(list, plain)?.userId, "bohdan");
  assert.equal(tokenRow(list, `${plain}x`), null);
  assert.equal(tokenRow(list, "obk_short"), null);
  assert.deepEqual(Object.keys(publicToken(row)).sort(), ["createdAt", "id", "label", "lastUsedAt"]);
  assert.equal(tokenRow(revokeToken(list, { id: row.id, userId: "someone-else" }), plain)?.userId, "bohdan", "чужий ключ не відкликати");
  assert.equal(tokenRow(revokeToken(list, { id: row.id, userId: "bohdan" }), plain), null);
});

function fakePortal() {
  const calls = [];
  const threads = [
    { accountId: "acc-bohdan", accountIdentity: "Bohdan N", threadKey: "t1", participant: { name: "Ivan Petrenko", headline: "CMO" }, unread: true, answered: true, lastMessage: { direction: "in", body: "Hi! Let's talk", sentAt: "2026-11-27T09:00:00Z" } },
    { accountId: "acc-chloe", accountIdentity: "Chloe", threadKey: "t2", participant: { name: "Somebody Else" }, unread: false, answered: false, lastMessage: { direction: "out", body: "Hello", sentAt: "2026-11-26T09:00:00Z" } }
  ];
  const call = async (path, { method = "GET", body } = {}) => {
    calls.push({ path, method, body });
    if (path.startsWith("/api/warmup/inbox/thread")) return { status: 200, data: { thread: { participant: { name: "Ivan Petrenko" } }, messages: [{ direction: "in", body: "Hi! Let's talk", sentAt: "2026-11-27T09:00:00Z" }], outbox: [] } };
    if (path.startsWith("/api/warmup/inbox/reply")) return { status: 201, data: { success: true, goesOutNow: true, goesOutAt: "2026-11-27T09:05:00Z" } };
    if (path.startsWith("/api/warmup/inbox")) return { status: 200, data: { threads } };
    if (path.startsWith("/api/today")) return { status: 200, data: { configured: true, blocks: { replies: [{ name: "Ivan Petrenko", reasonTitle: "Відповісти", accountId: "acc-bohdan", threadKey: "t1", preview: { direction: "in", body: "Hi" } }], first: [{ name: "Olena", accountId: "acc-chloe", outreachId: "o9" }] } } };
    if (path.startsWith("/api/warmup/first-messages/send")) return { status: 409, data: { error: "Перше повідомлення цій людині вже надіслано." } };
    return { status: 404, data: { error: "?" } };
  };
  return { call, calls };
}

const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, params });

test("MCP: знайомство, інструменти, лідген бачить і пише лише зі своїх акаунтів", async () => {
  const portal = fakePortal();
  const handle = mcpServer({ call: portal.call, allowed: (accountId) => accountId === "acc-bohdan" });

  const hello = await handle(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chatgpt" } }));
  assert.equal(hello.result.protocolVersion, "2025-06-18");
  assert.ok(hello.result.capabilities.tools);
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null, "сповіщення — без відповіді");

  const list = await handle(rpc(2, "tools/list"));
  assert.deepEqual(list.result.tools.map((tool) => tool.name), MCP_TOOL_NAMES);
  assert.ok(list.result.tools.every((tool) => tool.inputSchema?.type === "object"));

  const conversations = await handle(rpc(3, "tools/call", { name: "list_conversations", arguments: {} }));
  assert.deepEqual(conversations.result.structuredContent.conversations.map((row) => row.person), ["Ivan Petrenko"], "чужого акаунта не видно");

  const foreign = await handle(rpc(4, "tools/call", { name: "send_message", arguments: { account_id: "acc-chloe", thread_key: "t2", text: "hi" } }));
  assert.equal(foreign.result.isError, true);
  assert.equal(portal.calls.some((call) => call.path === "/api/warmup/inbox/reply"), false, "з чужого акаунта нічого не пішло");

  const sent = await handle(rpc(5, "tools/call", { name: "send_message", arguments: { account_id: "acc-bohdan", thread_key: "t1", text: "Привіт, Іване!" } }));
  assert.equal(sent.result.isError, undefined);
  assert.match(sent.result.content[0].text, /Поставлено в чергу: піде за кілька хвилин/);
  assert.deepEqual(portal.calls.find((call) => call.path === "/api/warmup/inbox/reply").body, { accountId: "acc-bohdan", threadKey: "t1", text: "Привіт, Іване!" });

  const work = await handle(rpc(6, "tools/call", { name: "todays_work", arguments: {} }));
  assert.deepEqual(work.result.structuredContent.items.map((item) => item.person), ["Ivan Petrenko"]);

  const first = await handle(rpc(7, "tools/call", { name: "send_first_message", arguments: { outreach_id: "o9", text: "Hi" } }));
  assert.equal(first.result.isError, true);
  assert.match(first.result.content[0].text, /вже надіслано/);

  assert.equal((await handle(rpc(8, "nope"))).error.code, -32601);
  assert.equal((await handle(rpc(9, "tools/call", { name: "nope" }))).error.code, -32602);
});

test("сервер: ключ із Налаштувань пускає в /mcp як цю людину; без ключа й з відкликаним — ні; ключем ключ не створити", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-mcp-test-"));
  const statePath = join(directory, "state.json");
  await writeFile(statePath, JSON.stringify({ version: 1 }), "utf8");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: "0", STATE_FILE_PATH: statePath, AUTH_DEV_BYPASS: "1", WARMUP_SCHEDULER_DISABLED: "1", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" },
    stdio: ["ignore", "pipe", "ignore"]
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const origin = await listeningOrigin(child);
    const json = async (path, init = {}) => {
      const response = await fetch(`${origin}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
      return { status: response.status, body: response.status === 202 ? null : await response.json() };
    };
    const made = await json("/api/account/tokens", { method: "POST", body: JSON.stringify({ label: "ChatGPT" }) });
    assert.equal(made.status, 201);
    const key = made.body.token;
    assert.ok(key.startsWith(TOKEN_PREFIX));

    assert.equal((await json("/mcp", { method: "POST", body: JSON.stringify(rpc(1, "tools/list")) })).status, 401, "без ключа");
    const viaUrl = await json(`/mcp?key=${key}`, { method: "POST", body: JSON.stringify(rpc(1, "tools/list")) });
    assert.equal(viaUrl.status, 200);
    assert.ok(viaUrl.body.result.tools.length >= 5);
    const viaHeader = await json("/mcp", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(rpc(2, "initialize", { protocolVersion: "2025-03-26" })) });
    assert.equal(viaHeader.body.result.serverInfo.name, "outbound");
    assert.equal((await json(`/mcp?key=${key}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status, 202);
    assert.equal((await fetch(`${origin}/mcp?key=${key}`)).status, 405);

    // Ключ — та сама людина в API; але ключами керують лише з порталу.
    assert.equal((await json("/api/account/tokens", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "{}" })).status, 403);
    const listed = await json("/api/account/tokens", { headers: { authorization: `Bearer ${key}` } });
    assert.equal(listed.status, 200);
    assert.equal(JSON.stringify(listed.body).includes(key), false, "список не показує ключ");

    await json(`/api/account/tokens?id=${made.body.created.id}`, { method: "DELETE" });
    assert.equal((await json(`/mcp?key=${key}`, { method: "POST", body: JSON.stringify(rpc(3, "tools/list")) })).status, 401, "відкликаний");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await rm(directory, { recursive: true, force: true });
  }
});
