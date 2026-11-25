import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Власник 25.11: «щоб я міг включити і виключити, щоб він заглядав і не заглядав, коли прошу».
 * Людина пише й заходить на профілі сама — сервер в акаунт не заходить (LinkedIn бачить два входи
 * й обмежує). Пінгує через платформу — вмикає, і агент сам підтягує розмови.
 */
test("вимикач агента: найновіша подія каже; вимкнені акаунти випадають з усіх черг агента", async () => {
  const previous = { url: process.env.ANTY_SUPABASE_URL, key: process.env.ANTY_SERVICE_ROLE_KEY, fetch: globalThis.fetch };
  process.env.ANTY_SUPABASE_URL = "http://anty.test";
  process.env.ANTY_SERVICE_ROLE_KEY = "k";
  const rows = [
    { account_id: "a", meta: { enabled: false }, created_at: "2026-11-25T10:00:00Z" },
    { account_id: "a", meta: { enabled: true }, created_at: "2026-11-24T10:00:00Z" },
    { account_id: "b", meta: { enabled: true }, created_at: "2026-11-25T11:00:00Z" },
    { account_id: "b", meta: { enabled: false }, created_at: "2026-11-25T09:00:00Z" }
  ];
  globalThis.fetch = async () => new Response(JSON.stringify(rows), { status: 200 });
  try {
    const { agentOffSince, withoutAgentOff } = await import("../warmup/store.mjs");
    const off = await agentOffSince(["a", "b", "c"]);
    assert.deepEqual([...off.keys()], ["a"]);
    assert.equal(off.get("a"), "2026-11-25T10:00:00Z");
    assert.deepEqual((await withoutAgentOff([{ id: "a" }, { id: "b" }, { id: "c" }])).map((row) => row.id), ["b", "c"]);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [name, value] of [["ANTY_SUPABASE_URL", previous.url], ["ANTY_SERVICE_ROLE_KEY", previous.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("агент не бере вимкнений акаунт ні для прогріву, ні для нових повідомлень, ні для відправки; вартовий входу — теж", () => {
  const scheduler = readFileSync(new URL("../warmup/scheduler.mjs", import.meta.url), "utf8");
  assert.equal((scheduler.match(/withoutAgentOff\(await anty\.from\("wl_accounts"\)/g) || []).length, 3, "сесії дня, термінові відправки, чергування");
  assert.match(scheduler, /the server agent is switched off for this account/);
  const api = readFileSync(new URL("../warmup/api.mjs", import.meta.url), "utf8");
  assert.match(api, /path === "\/accounts\/agent"/);
  assert.match(api, /agentOff: account && agentOffMap\.has\(account\.id\)/);
  const watch = readFileSync(new URL("../agent/lib/login-watch.mjs", import.meta.url), "utf8");
  assert.match(watch, /&& !account\.agentOff\);/);
});

test("у списку акаунтів — режим «Авто / Вручну» окремою колонкою; відповідь з платформи каже, що чекає на «Авто»", () => {
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../app/screens/warmup-accounts.js", import.meta.url), "utf8");
  const inbox = readFileSync(new URL("../app/screens/inbox.js", import.meta.url), "utf8");
  // Власник 25.11: «заходить» — неточно, колонку «Акаунт» розбити на кілька.
  for (const head of ["Профіль", "LinkedIn", "Теги", "Режим", "Стан", "День", "Запити в друзі", "Кампанія"]) assert.match(html, new RegExp(`>${head}</th>`));
  assert.doesNotMatch(html, /Заходить|warmup-agent-help/);
  assert.match(ui, /label: auto \? "Авто" : "Вручну"/);
  assert.match(ui, /data: `data-warmup-agent="/);
  assert.match(ui, /"\/accounts\/agent"/);
  assert.match(inbox, /if \(reply\?\.agentOff\) return "коли акаунт перемкнуть з «Вручну» на «Авто»/);
});
