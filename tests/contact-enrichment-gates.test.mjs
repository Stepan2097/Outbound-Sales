import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Збагачення — єдине місце в застосунку, де натискання кнопки коштує грошей:
// за ним стоять платні актори Apify. Тому воно має два запобіжники, і обидва
// перевіряються тут.
//
// Перший — кеш: те, що знайшли хвилину тому, не шукається вдруге, поки людина
// не попросила прямо («Перешукати»). Другий — схвалення: знайдений телефон чи
// пошта не стають каналом, доки продавець не підтвердив саме цей контакт, і
// підтвердити не можна те, під чим немає жодного доказу верифікації.
//
// Платну гілку водоспаду тут не перевіряємо: адреса api.apify.com зашита в
// коді, тож тест на неї або ходив би в мережу за гроші, або вимагав шва в
// коді — це окреме рішення, не тест. Нижче лише те, що можна довести без
// мережі: обидва запобіжники й те, що каже застосунок, коли Apify не
// налаштований.

async function startServer({ port, savedState = null, env = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "outbound-enrich-gates-test-"));
  const statePath = join(directory, "state.json");
  if (savedState) await writeFile(statePath, JSON.stringify(savedState), "utf8");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE_PATH: statePath,
      AUTH_DEV_BYPASS: "1",
      WARMUP_SCHEDULER_DISABLED: "1",
      ...env
    },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  const origin = `http://127.0.0.1:${port}`;
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
    origin,
    async savedState() {
      return JSON.parse(await readFile(statePath, "utf8"));
    },
    async post(path, body) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
      return { status: response.status, payload: await response.json() };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

const now = new Date().toISOString();

/**
 * Лід, у якого публічне дослідження компанії свіже. Це не декорація: без
 * нього збагачення пішло б у відкритий веб, і тест залежав би від мережі.
 */
function researchedLead(overrides = {}) {
  return {
    id: "lead-enrich",
    name: "Ivan Teslenko",
    company: "Harbor Interactive",
    title: "Head of User Acquisition",
    website: "harborinteractive.example",
    linkedin: "https://www.linkedin.com/in/ivan-teslenko",
    status: "new",
    publicCompanyResearch: {
      checkedAt: now,
      url: "https://harborinteractive.example",
      domain: "harborinteractive.example",
      title: "Harbor Interactive",
      description: "Mobile games studio",
      source: "public_web_search",
      confidence: 70
    },
    publicSocialResearch: { checkedAt: now, facebookUrl: "", facebookTitle: "", facebookSnippet: "", source: "public_web_search", confidence: 0 },
    publicAccountSignals: { checkedAt: now, signals: [] },
    ...overrides
  };
}

function candidatesOf(payload) {
  return payload.prospects.find((item) => item.id === "lead-enrich").contactDiscovery.candidates;
}

test("збагачення, зроблене хвилину тому, не шукається вдруге — а «перешукати» шукає", async () => {
  const lead = researchedLead({
    contactDiscovery: {
      completedAt: now,
      scraperStatus: "apify_enriched",
      scraperNote: "попередній прогін",
      candidates: [{ type: "email", value: "ivan@harborinteractive.example", status: "deliverable", confidence: 88, source: "previous-run" }],
      warnings: []
    }
  });
  const server = await startServer({ port: 43326, savedState: { version: 1, prospects: [lead], interactions: [] } });
  try {
    const reused = await server.post("/api/prospects/enrich", { prospectId: "lead-enrich" });
    assert.equal(reused.status, 200);
    // Нічого не перезаписано: і нотатка попереднього прогону на місці, і
    // журнал прямо каже, що взяли з кешу, а не шукали.
    const discovery = reused.payload.prospects.find((item) => item.id === "lead-enrich").contactDiscovery;
    assert.equal(discovery.scraperNote, "попередній прогін");
    assert.ok(reused.payload.events.some((event) => /reused from the saved research cache/.test(event.text)));

    const refreshed = await server.post("/api/prospects/enrich", { prospectId: "lead-enrich", force: true });
    assert.equal(refreshed.status, 200);
    const afterForce = refreshed.payload.prospects.find((item) => item.id === "lead-enrich");
    assert.notEqual(afterForce.contactDiscovery.scraperNote, "попередній прогін");
    assert.ok(refreshed.payload.events.some((event) => /contact discovery refreshed/.test(event.text)));
    // Прогін лишає рядок в історії дослідження людини.
    const saved = await server.savedState();
    const history = saved.prospects.find((item) => item.id === "lead-enrich").researchHistory || [];
    assert.ok(history.some((record) => record.stage === "contact_enriched"));
  } finally {
    await server.stop();
  }
});

test("без налаштованого Apify застосунок каже, чого бракує, і не вигадує прямих контактів", async () => {
  const server = await startServer({ port: 43327, savedState: { version: 1, prospects: [researchedLead()], interactions: [] } });
  try {
    const { status, payload } = await server.post("/api/prospects/enrich", { prospectId: "lead-enrich", force: true });
    assert.equal(status, 200);
    const discovery = payload.prospects.find((item) => item.id === "lead-enrich").contactDiscovery;
    // Статус і нотатка називають саме те, чого бракує — токена й акторів.
    assert.ok(["mock_public_search", "public_web_discovery"].includes(discovery.scraperStatus), `несподіваний статус ${discovery.scraperStatus}`);
    assert.match(discovery.scraperNote, /Apify/);

    // Жоден прямий канал не з'являється схваленим сам собою.
    for (const candidate of candidatesOf(payload)) {
      if (!["email", "phone", "sms", "whatsapp", "whatsapp_link", "telegram", "telegram_link"].includes(candidate.type)) continue;
      assert.ok(
        ["pending", "verification_required"].includes(candidate.approvalStatus),
        `${candidate.type} ${candidate.value} прийшов зі статусом ${candidate.approvalStatus}`
      );
    }
  } finally {
    await server.stop();
  }
});

test("схвалити контакт можна лише з доказом верифікації, і рішення пишеться на кандидата", async () => {
  const lead = researchedLead({
    contactDiscovery: {
      completedAt: now,
      scraperStatus: "apify_enriched",
      scraperNote: "прогін",
      candidates: [
        { type: "email", value: "ivan@harborinteractive.example", status: "deliverable", confidence: 91, source: "fullenrich" },
        { type: "email", value: "guess@harborinteractive.example", status: "pattern_guess", confidence: 30, source: "pattern" }
      ],
      warnings: []
    }
  });
  const server = await startServer({ port: 43328, savedState: { version: 1, prospects: [lead], interactions: [] } });
  try {
    // Вгадана адреса доказів не має, тож схваленню не підлягає — і відмова
    // каже, чого саме бракує.
    const guessed = await server.post("/api/prospects/contacts/approval", {
      prospectId: "lead-enrich",
      type: "email",
      value: "guess@harborinteractive.example",
      decision: "approved"
    });
    assert.equal(guessed.status, 409);
    assert.match(guessed.payload.error, /верифікац/i);

    // Рішення без вибору контакту — теж не рішення.
    const noDecision = await server.post("/api/prospects/contacts/approval", {
      prospectId: "lead-enrich",
      type: "email",
      value: "ivan@harborinteractive.example",
      decision: "maybe"
    });
    assert.equal(noDecision.status, 400);

    const approved = await server.post("/api/prospects/contacts/approval", {
      prospectId: "lead-enrich",
      type: "email",
      value: "ivan@harborinteractive.example",
      decision: "approved"
    });
    assert.equal(approved.status, 200);
    const candidate = candidatesOf(approved.payload).find((item) => item.value === "ivan@harborinteractive.example");
    assert.equal(candidate.approvalStatus, "approved");
    assert.ok(candidate.approvedAt, "немає часу схвалення");
    assert.ok(candidate.approvedBy, "немає того, хто схвалив");
    // Вгадана адреса лишається під замком: схвалення одного контакту не
    // відчиняє решту.
    assert.equal(candidatesOf(approved.payload).find((item) => item.value === "guess@harborinteractive.example").approvalStatus, "verification_required");

    // Схвалення переживає перезапуск — інакше продавець підтверджував би той
    // самий контакт після кожного деплою.
    const saved = await server.savedState();
    const savedCandidate = saved.prospects
      .find((item) => item.id === "lead-enrich")
      .contactDiscovery.candidates.find((item) => item.value === "ivan@harborinteractive.example");
    assert.equal(savedCandidate.approvalStatus, "approved");
  } finally {
    await server.stop();
  }
});
