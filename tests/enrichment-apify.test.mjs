import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Платний водоспад Apify — єдине місце в застосунку, де кнопка списує гроші,
 * і до 08.10 воно не мало жодного тесту. Причина була записана в сусідньому
 * файлі як «без шва в коді заглушку не поставити»: адреса `api.apify.com`
 * зашита в `runApifyActor`. Шва й не треба — модуль, підвантажений дочірньому
 * процесу через `NODE_OPTIONS=--import`, підміняє `globalThis.fetch` до того,
 * як server.mjs стартує, і код не знає, що його тестують.
 *
 * Перевіряється те, що коштує грошей або впливає на ліда: стеля акторів на
 * ліда, розбір відповіді актора в кандидатів і — найдорожче — що свіжий кеш
 * не дає запустити жодного платного актора вдруге.
 */

const STUB = fileURLToPath(new URL("./stub-network.mjs", import.meta.url));

// Актори названі так, щоб у логу їх не сплутати зі стандартними.
const CONTACT_ACTORS = {
  APIFY_PERSON_ENRICHMENT_ACTOR_ID: "test/person",
  APIFY_EMAIL_PHONE_FINDER_ACTOR_ID: "test/emailphone",
  APIFY_APOLLO_ACTOR_ID: "test/apollo",
  APIFY_ZOOMINFO_ACTOR_ID: "test/zoominfo"
};
const PEOPLE_ACTORS = {
  APIFY_COMPANY_PEOPLE_ACTOR_ID: "test/people",
  APIFY_SECONDARY_COMPANY_PEOPLE_ACTOR_ID: "test/people-2"
};
const CONTACT_IDS = new Set(Object.values(CONTACT_ACTORS));

const now = new Date().toISOString();

/** Лід, чиє публічне дослідження свіже: інакше збагачення пішло б у відкритий веб. */
function lead(extra = {}) {
  return {
    id: "lead-apify",
    name: "Ivan Teslenko",
    company: "Harbor Interactive",
    title: "Head of User Acquisition",
    website: "harborinteractive.example",
    linkedin: "https://www.linkedin.com/in/ivan-teslenko",
    status: "new",
    publicCompanyResearch: { checkedAt: now, url: "https://harborinteractive.example", domain: "harborinteractive.example", title: "Harbor", description: "Mobile games", source: "public_web_search", confidence: 70 },
    publicSocialResearch: { checkedAt: now, facebookUrl: "", facebookTitle: "", facebookSnippet: "", source: "public_web_search", confidence: 0 },
    publicAccountSignals: { checkedAt: now, signals: [] },
    ...extra
  };
}

async function startServer({ port, savedState, items = {}, env = {} }) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-apify-test-"));
  const statePath = join(directory, "state.json");
  const logPath = join(directory, "network.log");
  await writeFile(statePath, JSON.stringify(savedState), "utf8");
  await writeFile(logPath, "", "utf8");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${STUB}`,
      STUB_NETWORK_LOG: logPath,
      STUB_APIFY_ITEMS: JSON.stringify(items),
      PORT: String(port),
      STATE_FILE_PATH: statePath,
      AUTH_DEV_BYPASS: "1",
      WARMUP_SCHEDULER_DISABLED: "1",
      APIFY_API_TOKEN: "test-apify-token",
      APIFY_CONTACT_MAX_CHARGE_USD: "0.2",
      APIFY_MAX_CHARGE_USD: "1.5",
      ...CONTACT_ACTORS,
      ...PEOPLE_ACTORS,
      ...env
    },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break;
    } catch { /* ще піднімається */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    async enrich(body) {
      const response = await fetch(`${origin}/api/prospects/enrich`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      return { status: response.status, payload: await response.json() };
    },
    async saved() {
      return JSON.parse(await readFile(statePath, "utf8"));
    },
    /** Кого насправді викликали — і скільки разів. */
    async calls() {
      const lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
      return {
        all: lines,
        apify: lines.filter((line) => line.startsWith("apify ")).map((line) => line.slice(6)),
        contacts: lines.filter((line) => line.startsWith("apify ")).map((line) => line.split(" ")[1]).filter((actor) => CONTACT_IDS.has(actor)),
        unexpected: lines.filter((line) => line.startsWith("НЕОЧІКУВАНА"))
      };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test("водоспад зупиняється на стелі акторів на ліда, і кожен виклик несе свою межу витрат", async () => {
  // Жоден актор не віддає ні пошти, ні телефона: інакше водоспад спинився б
  // раніше сам, і стеля лишилась би неперевіреною.
  const items = Object.fromEntries(Object.values(CONTACT_ACTORS).map((actor) => [actor, [{ website: "harborinteractive.example" }]]));
  const server = await startServer({
    port: 43331,
    savedState: { version: 1, prospects: [lead()] },
    items,
    env: { APIFY_MAX_ACTORS_PER_LEAD: "2" }
  });
  try {
    const { status } = await server.enrich({ prospectId: "lead-apify", force: true });
    assert.equal(status, 200);
    const calls = await server.calls();
    assert.deepEqual(calls.unexpected, [], "тест не ходить у справжню мережу");
    assert.equal(calls.contacts.length, 2, `платних акторів по контактах мало бути два, а було: ${calls.contacts.join(", ")}`);

    const discovery = (await server.saved()).prospects[0].contactDiscovery;
    assert.equal(discovery.enrichmentBudget.mode, "cost_capped_waterfall");
    assert.equal(discovery.enrichmentBudget.cacheHit, false);
    // Кожен контактний виклик іде зі стелею, яку задали в налаштуваннях.
    const contactCharges = calls.apify.filter((line) => CONTACT_IDS.has(line.split(" ")[0])).map((line) => line.split("charge=")[1]);
    assert.deepEqual([...new Set(contactCharges)], ["0.2"]);
  } finally {
    await server.stop();
  }
});

test("те, що віддав актор, стає кандидатами — і жоден канал не відчиняється сам", async () => {
  const server = await startServer({
    port: 43332,
    savedState: { version: 1, prospects: [lead()] },
    items: {
      "test/person": [{
        fullName: "Ivan Teslenko",
        email: "ivan@harborinteractive.example",
        phone: "+1 512 555 0147",
        linkedin: "https://www.linkedin.com/in/ivan-teslenko",
        verified: true
      }]
    },
    env: { APIFY_MAX_ACTORS_PER_LEAD: "3" }
  });
  try {
    await server.enrich({ prospectId: "lead-apify", force: true });
    const prospect = (await server.saved()).prospects[0];
    const candidates = prospect.contactDiscovery.candidates;

    const email = candidates.find((item) => item.value === "ivan@harborinteractive.example");
    const phone = candidates.find((item) => item.type === "phone" && /0147/.test(item.value));
    assert.ok(email, `пошти з актора немає серед кандидатів: ${candidates.map((c) => c.type).join(", ")}`);
    assert.ok(phone, "телефона з актора немає серед кандидатів");
    assert.match(email.source, /^apify:/, "джерело кандидата каже, звідки він узявся");

    // Головне правило збагачення: платний актор не відчиняє канал сам.
    for (const candidate of [email, phone]) {
      assert.ok(["pending", "verification_required"].includes(candidate.approvalStatus),
        `${candidate.type} прийшов зі статусом ${candidate.approvalStatus}`);
    }
    assert.equal(prospect.contactDiscovery.scraperStatus, "apify_enriched");
    // І слід про витрати лишається на ліді, щоб наступний прогін знав про кеш.
    assert.ok(prospect.apifyContactEnrichment?.completedAt, "кеш платного збагачення не записався");
  } finally {
    await server.stop();
  }
});

test("свіжий кеш не дає запустити жодного платного актора по контактах удруге", async () => {
  const cached = lead({
    // Те, що залишив попередній платний прогін.
    apifyContactEnrichment: {
      completedAt: now,
      actorRuns: [{ source: "personEnrichment", status: "complete", chargeCeilingUsd: 0.2 }],
      directTypes: ["email"],
      candidateCount: 1
    },
    contactDiscovery: {
      completedAt: "2026-01-01T00:00:00.000Z",
      scraperStatus: "apify_enriched",
      scraperNote: "попередній прогін",
      candidates: [{ type: "email", value: "ivan@harborinteractive.example", status: "deliverable", confidence: 91, source: "apify:personEnrichment" }],
      warnings: []
    }
  });
  const items = Object.fromEntries(Object.values(CONTACT_ACTORS).map((actor) => [actor, [{ email: "нова@адреса.example" }]]));
  const server = await startServer({
    port: 43333,
    savedState: { version: 1, prospects: [cached] },
    items,
    env: { APIFY_ENRICHMENT_CACHE_DAYS: "30", APIFY_MAX_ACTORS_PER_LEAD: "3" }
  });
  try {
    // `force` обходить двадцятихвилинний кеш маршруту — але не платний кеш,
    // і це рівно та різниця, через яку рахунок не подвоюється.
    await server.enrich({ prospectId: "lead-apify", force: true });
    const calls = await server.calls();
    assert.deepEqual(calls.contacts, [], `платні актори по контактах не мали запускатись, а запустились: ${calls.contacts.join(", ")}`);

    const discovery = (await server.saved()).prospects[0].contactDiscovery;
    assert.equal(discovery.enrichmentBudget.cacheHit, true);
    assert.match(discovery.scraperNote, /Cached contact evidence reused/);
    // Нової адреси з акторів узятись не могло: їх не питали.
    assert.equal(discovery.candidates.some((item) => item.value === "нова@адреса.example"), false);
  } finally {
    await server.stop();
  }
});
