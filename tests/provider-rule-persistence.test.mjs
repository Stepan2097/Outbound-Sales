import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSavedState } from "./saved-state.mjs";
import { listeningOrigin } from "./server-origin.mjs";

// Правило вибору провайдера — це не зручність, а межа приватності: воно каже,
// чи можна відправляти дані ліда до моделі, що вчиться на запитах, і до такої,
// що їх зберігає. «Скидається при кожному рестарті» означало б, що людина
// вмикає «нульове зберігання», а наступний деплой (тут кожен пуш у main — це
// деплой) тихо повертає типове правило без нього. Причин було дві: ключа
// providerRule не було ні в записі стану, ні в його читанні, і сам маршрут
// оновлення не викликав запис — тож навіть дописаний ключ лягав би на диск лише
// при якійсь іншій дії.
//
// Тут сервер запускається двічі на одному файлі стану: рестарт справжній, а не
// симульований перечитуванням файлу.

const DEFAULT_RULE = {
  policy: "approved_providers_only",
  allowProviderFallbacks: true,
  requireNoTraining: true,
  requireZeroRetention: false
};

async function boot({ statePath }) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: "0",
      STATE_FILE_PATH: statePath,
      AUTH_DEV_BYPASS: "1",
      WARMUP_SCHEDULER_DISABLED: "1"
    },
    stdio: ["ignore", "pipe", "ignore"]
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  const origin = await listeningOrigin(child);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) break;
    } catch {
      // Ще піднімається.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    async rule() {
      const response = await fetch(`${origin}/api/state`);
      return (await response.json()).providerRule;
    },
    async update(body) {
      const response = await fetch(`${origin}/api/provider-rule/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      return { status: response.status, payload: await response.json() };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
  };
}

async function workspace(saved = null) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-provider-rule-test-"));
  const statePath = join(directory, "state.json");
  if (saved) await writeFile(statePath, JSON.stringify(saved), "utf8");
  return { directory, statePath, saved: async () => await readSavedState(statePath) };
}

test("правило, яке людина змінила, лежить на диску ще до відповіді і переживає рестарт", async () => {
  const space = await workspace();
  const strict = { policy: "lowest_cost", allowProviderFallbacks: false, requireNoTraining: false, requireZeroRetention: true };
  let server = await boot({ statePath: space.statePath });
  try {
    const { status } = await server.update(strict);
    assert.equal(status, 200);

    // Файл читається одразу після відповіді, без жодного іншого запису між
    // ними: саме з нього сервер підніметься після деплою.
    assert.deepEqual((await space.saved()).providerRule, strict, "правило не дійшло до файлу стану");

    await server.stop();
    server = await boot({ statePath: space.statePath });
    assert.deepEqual(await server.rule(), strict, "після рестарту повернулось типове правило");
  } finally {
    await server.stop();
    await rm(space.directory, { recursive: true, force: true });
  }
});

test("файл стану без правила — від до цього виправлення — лишає типове", async () => {
  const space = await workspace({ version: 1, prospects: [], interactions: [] });
  const server = await boot({ statePath: space.statePath });
  try {
    assert.deepEqual(await server.rule(), DEFAULT_RULE);
  } finally {
    await server.stop();
    await rm(space.directory, { recursive: true, force: true });
  }
});

test("зіпсоване збережене правило не стирає типове там, де воно не розібралось", async () => {
  const garbage = await workspace({ version: 1, prospects: [], interactions: [], providerRule: "oops" });
  const partial = await workspace({
    version: 1,
    prospects: [],
    interactions: [],
    // Політика не рядок і булеві не булеві: кожне поле відновлюється саме, а
    // те, що розібралось (нульове зберігання), — лишається.
    providerRule: { policy: 5, allowProviderFallbacks: "yes", requireNoTraining: "no", requireZeroRetention: true }
  });
  const first = await boot({ statePath: garbage.statePath });
  const second = await boot({ statePath: partial.statePath });
  try {
    assert.deepEqual(await first.rule(), DEFAULT_RULE);
    assert.deepEqual(await second.rule(), { ...DEFAULT_RULE, requireZeroRetention: true });
  } finally {
    await first.stop();
    await second.stop();
    await rm(garbage.directory, { recursive: true, force: true });
    await rm(partial.directory, { recursive: true, force: true });
  }
});
