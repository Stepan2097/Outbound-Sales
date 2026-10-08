import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listeningOrigin } from "./server-origin.mjs";

// «Збагатити» на ліді, якого ще не шукали в соцмережах, падало 500-кою:
// normalizeProspect зберігає відсутнє дослідження як `null`, а
// publicCandidatesFromResearch(…, socialResearch = {}) мав значення за
// замовчуванням, яке на `null` не діє. Падало саме там, де дослідження свіже —
// на шляху «візьми з кешу», бо повний пошук сам записує publicSocialResearch
// і `null` зникає. Тобто лід, у якого компанію вже досліджено, а людину ще ні,
// був єдиним, кого не можна було збагатити.
//
// Мережу тест не чіпає: свіже дослідження означає «з кешу», і охоронець
// записує в журнал будь-яку спробу вийти за межі localhost. Порожній журнал —
// частина перевірки, бо код ковтає мережеві помилки й без нього «пішов у веб»
// виглядало б як успіх.

const GUARD = `
import fs from "node:fs";
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const raw = typeof input === "string" ? input : input?.url ?? String(input);
  let host = "";
  try { host = new URL(raw).hostname; } catch { /* відносна адреса */ }
  if (host && host !== "127.0.0.1" && host !== "localhost") {
    fs.appendFileSync(process.env.GUARD_LOG, raw.split("?")[0] + "\\n");
    return Promise.reject(new Error("тест не ходить у мережу: " + host));
  }
  return realFetch(input, init);
};
`;

async function startServer({ savedState }) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-enrich-test-"));
  const statePath = join(directory, "state.json");
  const guardPath = join(directory, "guard.mjs");
  const guardLog = join(directory, "guard.log");
  await writeFile(statePath, JSON.stringify(savedState), "utf8");
  await writeFile(guardPath, GUARD, "utf8");
  await writeFile(guardLog, "", "utf8");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${guardPath}`,
      GUARD_LOG: guardLog,
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
    async enrich(prospectId) {
      const response = await fetch(`${origin}/api/prospects/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prospectId })
      });
      return { status: response.status, payload: await response.json() };
    },
    async outsideCalls() {
      return (await readFile(guardLog, "utf8")).split("\n").filter(Boolean);
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

const now = new Date().toISOString();

const freshCompany = {
  checkedAt: now,
  url: "https://harborinteractive.example",
  domain: "harborinteractive.example",
  title: "Harbor Interactive",
  description: "Mobile games studio",
  source: "public_web_search",
  confidence: 70
};

function lead(extra = {}) {
  return {
    id: "lead-social",
    name: "Ivan Teslenko",
    company: "Harbor Interactive",
    title: "Head of User Acquisition",
    website: "harborinteractive.example",
    linkedin: "https://www.linkedin.com/in/ivan-teslenko",
    status: "new",
    publicAccountSignals: { checkedAt: now, results: [], gaps: [] },
    ...extra
  };
}

function candidateTypes(payload, id) {
  const prospect = payload.prospects.find((item) => item.id === id);
  return (prospect.contactDiscovery?.candidates || []).map((candidate) => candidate.type);
}

test("лід з досліджуваною компанією, але без дослідження соцмереж, збагачується", async () => {
  // Жодного publicSocialResearch у збереженому ліді: так виглядає людина,
  // якої ще не шукали, — після завантаження це `null`.
  const server = await startServer({
    savedState: { version: 1, prospects: [lead({ publicCompanyResearch: freshCompany })], interactions: [] }
  });
  try {
    const { status, payload } = await server.enrich("lead-social");
    assert.equal(status, 200, `збагачення впало: ${JSON.stringify(payload).slice(0, 200)}`);
    const types = candidateTypes(payload, "lead-social");
    // Те, що вже знали про компанію, лишилось кандидатом із кешу…
    assert.ok(types.includes("website"), `сайт компанії з кешу зник: ${types}`);
    // …а вигадувати збіг у Facebook там, де не шукали, ніхто не став.
    assert.ok(!types.includes("facebook_match"));
    assert.deepEqual(await server.outsideCalls(), [], "кеш-шлях пішов у відкритий веб");
  } finally {
    await server.stop();
  }
});

test("дзеркальний випадок: соцмережі досліджено, компанії — ні", async () => {
  const server = await startServer({
    savedState: {
      version: 1,
      prospects: [lead({
        publicSocialResearch: {
          checkedAt: now,
          facebookUrl: "https://www.facebook.com/ivan.teslenko.ua",
          facebookTitle: "Ivan Teslenko",
          facebookSnippet: "UA at Harbor Interactive",
          source: "public_web_search",
          confidence: 54
        }
      })],
      interactions: []
    }
  });
  try {
    const { status, payload } = await server.enrich("lead-social");
    assert.equal(status, 200, `збагачення впало: ${JSON.stringify(payload).slice(0, 200)}`);
    assert.ok(candidateTypes(payload, "lead-social").includes("facebook_match"));
    assert.deepEqual(await server.outsideCalls(), [], "кеш-шлях пішов у відкритий веб");
  } finally {
    await server.stop();
  }
});
