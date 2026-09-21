import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const port = 43255;
const origin = `http://127.0.0.1:${port}`;

/**
 * A stand-in for OpenRouter that keeps what it was asked.
 *
 * The prompt is the product here: what decides whether a seller gets a
 * Ukrainian first touch grown out of the research, or an English template, is
 * entirely what this request body carries. So the test asserts on the request,
 * not only on the answer.
 */
function startFakeOpenRouter(answer) {
  const chatRequests = [];
  const server = createServer((request, response) => {
    if (request.url.endsWith("/models")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        data: [
          { id: "anthropic/claude-haiku-4.5", name: "Anthropic: Claude Haiku 4.5", context_length: 200000, pricing: { prompt: "0.000001", completion: "0.000005" } },
          { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } }
        ]
      }));
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      chatRequests.push(JSON.parse(body || "{}"));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: 900, completion_tokens: 300 }
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, chatRequests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// What a model would answer: Ukrainian, a question rather than a pitch.
const MODEL_ANSWER = {
  recommendedChannel: "linkedin",
  qualificationRationale: "Відповідність не підтверджена, перший дотик — питання.",
  messages: [
    { channel: "linkedin_invite", body: "Мартo, побачив вашу роль в Fleetify. Пишу без приводу: цікавить, хто у вас відповідає за залучення користувачів." },
    { channel: "linkedin_follow_up", body: "Дякую, що прийняли. Питання одне: ви самі ведете UA для двох тайтлів, чи це вже окрема команда?" },
    { channel: "email", subject: "коротке питання про fleetify", body: "Мартo, пишу холодно. Ззовні здається, що UA у вас на двох тайтлах — так і є, чи я читаю це неправильно?" },
    { channel: "telegram", body: "Мартo, одне питання: UA у Fleetify зараз на вас?" },
    { channel: "sms", body: "Мартo, одне питання про UA у Fleetify." },
    { channel: "whatsapp", body: "Мартo, одне питання про UA у Fleetify." },
    { channel: "call", body: "Мартo, дзвоню холодно і коротко: UA у Fleetify зараз на вас?" }
  ],
  linkedinVariations: [
    { label: "connection invite", channel: "linkedin", body: "Мартo, пишу через Fleetify — одне питання про UA." },
    { label: "contextual", channel: "linkedin", body: "Мартo, ззовні виглядає, що UA у вас на двох тайтлах." }
  ],
  actions: [{ type: "linkedin_invite_sent", label: "Надіслати запит", due: "today", priority: "high" }]
};

// A lead that arrives already researched: the two web-research timestamps are
// fresh, so the server reuses them instead of reaching the public web, which is
// what keeps this test hermetic.
const now = new Date().toISOString();
const RESEARCHED_LEAD = {
  name: "Marta Kovalenko",
  company: "Fleetify",
  title: "Head of User Acquisition",
  location: "Poland",
  website: "fleetify.example",
  linkedin: "https://linkedin.com/in/marta",
  email: "marta@fleetify.example",
  telegram: "@marta_ua",
  publicCompanyResearch: { checkedAt: now, url: "https://fleetify.example", domain: "fleetify.example", title: "Fleetify", description: "Mobile studio" },
  publicSocialResearch: { checkedAt: now },
  publicAccountSignals: { checkedAt: now, results: [] },
  clientProfile: {
    description: "Марта веде залучення користувачів у Fleetify.",
    person: "Marta Kovalenko, Head of User Acquisition.",
    company: "Fleetify — мобільна студія.",
    whatMatters: ["вартість залучення"],
    approaches: [
      { angle: "Зайти через задачу посади", opener: "Ви Head of UA — зазвичай болить вартість залучення.", why: "Здогад, названий здогадом", risk: "Може прозвучати шаблонно", channel: "linkedin" },
      { angle: "Спитати прямо, без приводу", opener: "Пишу холодно і без приводу.", why: "Не вдає знайомства", risk: "Відповідь може бути «ні»", channel: "linkedin" }
    ],
    questions: [],
    avoid: [],
    unknowns: [],
    openerLanguage: "uk",
    generatedAt: now,
    modelUsed: "локально, без моделі"
  }
};

test("the panel writes the three channels in the seller's language, even when product fit is held", async () => {
  const { server: provider, chatRequests, url: providerUrl } = await startFakeOpenRouter(MODEL_ANSWER);
  const directory = await mkdtemp(join(tmpdir(), "outbound-messages-test-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE_PATH: join(directory, "state.json"),
      AUTH_DEV_BYPASS: "1",
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_BASE_URL: providerUrl,
      WARMUP_CRM_SUPABASE_URL: "",
      WARMUP_CRM_SERVICE_ROLE_KEY: "",
      SUPABASE_URL: "",
      SUPABASE_API_KEY: ""
    },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));

  try {
    await waitForHealth();
    await waitForProvider();

    const imported = await postJson("/api/prospects/import", { prospects: [RESEARCHED_LEAD] });
    const prospectId = imported.prospects.find((item) => item.name === "Marta Kovalenko").id;

    const prepared = await postJson("/api/prospects/prepare", {
      prospectId,
      language: "uk",
      approachIndex: 1,
      useIntelligenceAi: false
    });

    // 1. The model was asked at all. Before this change a lead whose product fit
    //    was unconfirmed never reached it — the seller got an English template.
    assert.ok(chatRequests.length >= 1, "the writer must reach the model");
    const chat = chatRequests.at(-1);
    const system = chat.messages.find((message) => message.role === "system").content;
    const payload = JSON.parse(chat.messages.find((message) => message.role === "user").content);

    // 2. The language is an instruction, not a hope.
    assert.match(system, /Ukrainian/, "the system message names the language");
    assert.equal(payload.language, "uk");

    // 3. The research this workspace already paid for is in the prompt.
    assert.equal(payload.clientProfile.description, RESEARCHED_LEAD.clientProfile.description);
    assert.equal(payload.approach.angle, "Спитати прямо, без приводу", "the chosen approach, not the first one");
    assert.ok(payload.company, "company facts travel with the prompt");

    // The channels this person HAS, not the channels a human has already
    // cleared for sending. Approval happens after research, so gating the
    // writer on it told the model to skip the two channels this tab exists for.
    assert.deepEqual([...payload.person.reachableBy].sort(), ["email", "linkedin", "telegram"]);
    // Approval is reported separately and is not the writer's business: the
    // two channels that need a human click are absent from it, LinkedIn is not.
    assert.ok(!payload.person.approvedForSending.includes("email"));
    assert.ok(!payload.person.approvedForSending.includes("telegram"));
    assert.ok(payload.person.approvedForSending.includes("linkedin"));
    const instruction = payload.instruction;
    assert.match(instruction, /Write real copy for LinkedIn, email and Telegram/);
    assert.doesNotMatch(instruction, /Write only into channels/, "the writer is never told to skip a channel");

    // 4. The hold is a constraint on the writing, not a refusal to write.
    assert.ok(payload.fitHold, "an unconfirmed fit is stated to the model");
    assert.ok(payload.fitHold.unverified.length, "and it says what exactly is unverified");
    assert.ok(payload.productCopyRules.some((rule) => /FIT IS NOT CONFIRMED/.test(rule)), "no pitch is allowed");
    assert.ok(payload.productCopyRules.some((rule) => /300 characters/.test(rule)), "channel limits come from the shared rules");

    // 5. What came back is what the seller sees.
    const prospect = prepared.prospects.find((item) => item.id === prospectId);
    const body = (channel) => prospect.outreach.messages.find((message) => message.channel === channel)?.body || "";
    assert.match(body("linkedin_invite"), /Fleetify/);
    assert.match(body("email"), /холодно/);
    assert.match(body("telegram"), /UA у Fleetify/);
    assert.equal(prospect.outreach.language, "uk");
    assert.equal(prospect.outreach.usedApproach, "Спитати прямо, без приводу");
    assert.ok(prospect.outreach.fitHold, "the hold travels to the screen so it can be explained");

    // 6. Writing under a hold does not mean the lead is cleared to be contacted.
    assert.equal(prospect.status, "review");

    // 7. Telegram from the CRM card becomes a candidate a seller can approve.
    //    Without it the channel was locked with nothing to click, forever.
    const telegram = prospect.contactDiscovery.candidates.find((candidate) => candidate.type === "telegram" && candidate.value === "@marta_ua");
    assert.ok(telegram, "the CRM username is a contact candidate");
    assert.equal(telegram.approvalStatus, "pending", "it is approvable rather than stuck on verification");

    const approved = await postJson("/api/prospects/contacts/approval", {
      prospectId,
      type: "telegram",
      value: "@marta_ua",
      decision: "approved"
    });
    const after = approved.prospects.find((item) => item.id === prospectId);
    assert.equal(
      after.contactDiscovery.candidates.find((candidate) => candidate.value === "@marta_ua").approvalStatus,
      "approved"
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * A lead somebody decided not to contact is not a lead to write a clever first
 * line for. The fit guard used to be one thing; splitting it is only worth
 * anything if the decided half still stops before the model.
 */
test("an account parked by a policy decision is not written for at all", async () => {
  const { server: provider, chatRequests, url: providerUrl } = await startFakeOpenRouter(MODEL_ANSWER);
  const directory = await mkdtemp(join(tmpdir(), "outbound-parked-test-"));
  const parkedPort = port + 1;
  const parkedOrigin = `http://127.0.0.1:${parkedPort}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(parkedPort),
      STATE_FILE_PATH: join(directory, "state.json"),
      AUTH_DEV_BYPASS: "1",
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_BASE_URL: providerUrl,
      WARMUP_CRM_SUPABASE_URL: "",
      WARMUP_CRM_SERVICE_ROLE_KEY: "",
      SUPABASE_URL: "",
      SUPABASE_API_KEY: ""
    },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  const post = async (path, body) => {
    const response = await fetch(`${parkedOrigin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) assert.fail(`${path} answered ${response.status}: ${await response.text()}`);
    return response.json();
  };

  try {
    await waitForHealth(parkedOrigin);
    await waitForProvider(parkedOrigin);

    const imported = await post("/api/prospects/import", {
      prospects: [{ ...RESEARCHED_LEAD, name: "Ihor Parked", policyDecision: { status: "parked" } }]
    });
    const prospectId = imported.prospects.find((item) => item.name === "Ihor Parked").id;
    const before = chatRequests.length;

    const prepared = await post("/api/prospects/prepare", { prospectId, language: "uk", useIntelligenceAi: false });
    assert.equal(chatRequests.length, before, "a parked account never reaches the model");

    const prospect = prepared.prospects.find((item) => item.id === prospectId);
    assert.equal(prospect.outreach.fitHold.writing, false, "the panel is told this hold is a decision, not a gap");
    assert.equal(prospect.status, "review");
    assert.ok(
      prospect.outreach.messages.every((message) => message.hold),
      "every channel carries the hold flag, so the screen shows an explanation rather than copyable instructions"
    );
    assert.ok(prospect.outreach.messages.every((message) => !message.written));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Under a hold the template bodies are instructions to a seller. A channel the
 * model skipped must come back empty rather than quietly keeping one.
 */
test("a channel the model skips is left empty under a hold, not filled with the English template", async () => {
  const partial = { ...MODEL_ANSWER, messages: [MODEL_ANSWER.messages[0]] };
  const { server: provider, url: providerUrl } = await startFakeOpenRouter(partial);
  const directory = await mkdtemp(join(tmpdir(), "outbound-partial-test-"));
  const partialPort = port + 2;
  const partialOrigin = `http://127.0.0.1:${partialPort}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(partialPort),
      STATE_FILE_PATH: join(directory, "state.json"),
      AUTH_DEV_BYPASS: "1",
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_BASE_URL: providerUrl,
      WARMUP_CRM_SUPABASE_URL: "",
      WARMUP_CRM_SERVICE_ROLE_KEY: "",
      SUPABASE_URL: "",
      SUPABASE_API_KEY: ""
    },
    stdio: "ignore"
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));
  const post = async (path, body) => {
    const response = await fetch(`${partialOrigin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) assert.fail(`${path} answered ${response.status}: ${await response.text()}`);
    return response.json();
  };

  try {
    await waitForHealth(partialOrigin);
    await waitForProvider(partialOrigin);
    const imported = await post("/api/prospects/import", { prospects: [RESEARCHED_LEAD] });
    const prospectId = imported.prospects.find((item) => item.name === "Marta Kovalenko").id;
    const prepared = await post("/api/prospects/prepare", { prospectId, language: "uk", useIntelligenceAi: false });
    const prospect = prepared.prospects.find((item) => item.id === prospectId);

    assert.deepEqual(prospect.outreach.messages.map((message) => message.channel), ["linkedin_invite"]);
    assert.ok(prospect.outreach.messages.every((message) => message.written));
    assert.ok(
      !prospect.outreach.messages.some((message) => /Do not send yet|research hold/i.test(message.body || "")),
      "no English hold instruction survives as a draft"
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
    provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function postJson(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) assert.fail(`${path} answered ${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitForHealth(base = origin) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not start.");
}

/** The boot tests the provider; the writer only calls it once it is healthy. */
async function waitForProvider(base = origin) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await fetch(`${base}/api/state`).then((response) => response.json());
    if (state.providerHealth?.status === "healthy") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Fake OpenRouter never became healthy.");
}
