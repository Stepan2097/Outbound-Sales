import assert from "node:assert/strict";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

// Власник 02.11: «всі сторінки мають кешуватися щоб постійно не завантажуватися
// з нуля». Читання сторінки з `stale: true` уперше за життя вкладки одразу
// віддає збережене минулого разу, свіже йде фоном, і сторінка відкривається
// знову вже зі свіжим — без другого запиту.

const NAMES = ["staleServed", "staleFresh", "staleFlights", "STALE_FRESH_MS", "shownView", "reopenTimer", "reopenViews", "reopenLater", "staleRead"];

function harness(saved = {}) {
  const asked = [];
  const remembered = new Map();
  const opened = [];
  const answers = new Map();
  const timers = [];
  const main = loadMain(NAMES, {
    JSON, Date, Promise,
    window: { setTimeout: (run) => { timers.push(run); return timers.length; }, clearTimeout: () => {} },
    recallRead: (path) => saved[path],
    rememberRead: (path, value) => remembered.set(path, value),
    api: (path) => { asked.push(path); return new Promise((resolve) => answers.set(path, resolve)); },
    screenHooks: new Map([["stats", [{ open: () => opened.push("stats") }]]])
  });
  main.get(`shownView = "stats"`);
  return { main, asked, remembered, opened, answers, flush: () => timers.splice(0).forEach((run) => run()) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("збережене — одразу, свіже — фоном; сторінка відкривається знову й бере свіже без мережі", async () => {
  const { main, asked, remembered, opened, answers, flush } = harness({ "/api/stats?preset=this_week": { n: 1 } });
  const read = main.get("staleRead");
  assert.deepEqual(await read("/api/stats?preset=this_week", { stale: true }), { n: 1 }, "збережене — не чекаючи сервера");
  assert.deepEqual(asked, ["/api/stats?preset=this_week"], "свіже читається фоном");
  answers.get("/api/stats?preset=this_week")({ n: 2 });
  await tick();
  flush();
  assert.deepEqual(opened, ["stats"], "сторінку відкрито знову");
  assert.deepEqual(remembered.get("/api/stats?preset=this_week"), { n: 2 });
  assert.deepEqual(await read("/api/stats?preset=this_week", { stale: true }), { n: 2 });
  assert.equal(asked.length, 1, "свіже взято без другого запиту");
  // Далі — звичайне читання (сторінка й так показує, що було).
  const again = read("/api/stats?preset=this_week", { stale: true });
  answers.get("/api/stats?preset=this_week")({ n: 3 });
  assert.deepEqual(await again, { n: 3 });
});

test("нічого не збережено — звичайне читання; однакова відповідь не відкриває сторінку вдруге", async () => {
  const { main, asked, opened, answers, flush } = harness({ "/api/pitch": { same: true } });
  const read = main.get("staleRead");
  const first = read("/api/work/day", { stale: true });
  await tick();
  answers.get("/api/work/day")({ fresh: true });
  assert.deepEqual(await first, { fresh: true });
  assert.deepEqual(await read("/api/pitch", { stale: true }), { same: true });
  answers.get("/api/pitch")({ same: true });
  await tick();
  flush();
  assert.deepEqual(opened, []);
  assert.deepEqual(asked, ["/api/work/day", "/api/pitch"]);
});
