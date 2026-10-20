import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSavedState } from "./saved-state.mjs";
import { listeningOrigin } from "./server-origin.mjs";

/**
 * 20.10: перехід кампаній на нові кроки нагадувань читав константу, оголошену
 * нижче за рядок, з якого стан завантажується на старті, — завантаження
 * обривалось посередині, і все після кампаній (пошта: кампанії, шаблони, ліди;
 * бюджети…) лишалось порожнім, а сервер записував це у файл. Тут сервер стартує
 * зі станом, де є і стара кампанія, і те, що читається після неї, — і нічого не
 * губиться, а кампанія переходить на [2, 3, 5, 7].
 */
test("стан завантажується повністю, а кампанія зі старими кроками переходить на нові", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-state-load-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const old = "2026-10-16T13:49:59.535Z";
  await writeFile(statePath, JSON.stringify({
    version: 1,
    leadCampaigns: [{ id: "lc-1", name: "Оператори", folderIds: ["f-1"], silentSteps: [3, 3], state: "active", createdAt: old, updatedAt: old }],
    warmupCampaigns: [{ id: "wc-1", name: "Warm-up", folderId: "f-2", silentSteps: [3, 3], state: "running", createdAt: old, updatedAt: old }],
    pingSteps: [2, 4],
    espTemplates: [{ id: "tpl-1", name: "Чернетка — лист 1", subject: "Hi", body: "Hello" }],
    budgets: { warningThresholdPercent: 77 }
  }), "utf8");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: "0", STATE_FILE_PATH: statePath, AUTH_DEV_BYPASS: "1", WARMUP_SCHEDULER_DISABLED: "1" },
    stdio: ["ignore", "pipe", "ignore"]
  });
  t.after(() => child.kill("SIGTERM"));
  await listeningOrigin(child);
  // The migration writes the state once it has moved a campaign.
  let saved = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    saved = await readSavedState(statePath);
    if (saved.savedAt) break;
  }
  assert.ok(saved.savedAt, "стан записано після переходу кампаній");
  assert.deepEqual(saved.leadCampaigns[0].silentSteps, [2, 3, 5, 7]);
  assert.deepEqual(saved.warmupCampaigns[0].silentSteps, [2, 3, 5, 7]);
  assert.deepEqual(saved.pingSteps, [2, 4], "кроки «Сьогодні» — як їх збережено");
  assert.equal(saved.espTemplates?.length, 1, "шаблони пошти не загубились");
  assert.equal(saved.budgets?.warningThresholdPercent, 77, "і те, що читається після кампаній, — теж");
});
