import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";

import { buildReport, campaignReport, campaignReplies, handleCampaignReportApi, labelReplies, needsAiLabel, setLabel, setReportStores } from "../triage/campaign-report.mjs";

// Звіт LinkedIn-кампаній (етап 6/6, таск 011c66da): кваліфіковані відповіді на 100
// написаних, мітки відповідей (AI, людина змінює). Заглушка грає обидві бази.

const rows = {};
let stub;
let previousEnv;
let nextId = 0;

function columnValue(row, column) {
  if (!column.includes("->>")) return row[column];
  const [outer, key] = column.split("->>");
  const value = row[outer]?.[key];
  return value === null || value === undefined ? value : String(value);
}

function listValues(list) {
  return list.replace(/^\(|\)$/g, "").split(",").map((value) => value.replace(/^"|"$/g, ""));
}

function matches(row, params) {
  for (const [column, expression] of params.entries()) {
    if (["select", "limit", "offset", "order"].includes(column)) continue;
    const value = columnValue(row, column);
    if (expression.startsWith("eq.") && String(value) !== expression.slice(3)) return false;
    if (expression.startsWith("in.(") && !listValues(expression.slice(3)).includes(String(value))) return false;
    if (expression.startsWith("gte.") && !(String(value) >= expression.slice(4))) return false;
  }
  return true;
}

function ordered(found, params) {
  const [column, direction] = (params.get("order") || "").split(".");
  const sorted = column ? found.slice().sort((a, b) => String(a[column] ?? "").localeCompare(String(b[column] ?? "")) * (direction === "desc" ? -1 : 1)) : found;
  return sorted.slice(0, params.has("limit") ? Number(params.get("limit")) : Infinity);
}

test.before(async () => {
  stub = createServer((request, response) => {
    const [route, query] = request.url.split("?");
    const table = route.replace("/rest/v1/", "");
    const params = new URLSearchParams(query || "");
    const found = (rows[table] ?? []).filter((row) => matches(row, params));
    const answer = (payload, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET") return answer(ordered(found, params));
    let payload = "";
    request.on("data", (chunk) => { payload += chunk; });
    request.on("end", () => {
      const sent = payload ? JSON.parse(payload) : null;
      if (request.method === "POST") {
        const at = new Date(Date.now() + ++nextId).toISOString();
        const made = (Array.isArray(sent) ? sent : [sent]).map((value) => ({ id: `row-${++nextId}`, created_at: at, ...value }));
        rows[table] = [...(rows[table] ?? []), ...made];
        return answer(made, 201);
      }
      return answer(found.map((row) => Object.assign(row, sent)));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  previousEnv = { ...process.env };
  const address = `http://127.0.0.1:${stub.address().port}`;
  Object.assign(process.env, {
    ANTY_SUPABASE_URL: address, ANTY_SERVICE_ROLE_KEY: "stub", WARMUP_CRM_SUPABASE_URL: address, WARMUP_CRM_SERVICE_ROLE_KEY: "stub"
  });
});

test.after(async () => {
  for (const name of ["ANTY_SUPABASE_URL", "ANTY_SERVICE_ROLE_KEY", "WARMUP_CRM_SUPABASE_URL", "WARMUP_CRM_SERVICE_ROLE_KEY"]) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
  await new Promise((resolve) => stub.close(resolve));
});

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
let labels = {};

function message(direction, body, minutesAgo, contactId, threadKey = `t-${contactId}`) {
  return {
    id: `m-${++nextId}`, account_id: "acc-1", type: direction === "in" ? "message.in" : "message.out", created_at: ago(minutesAgo),
    meta: { threadKey, crmContactId: contactId, body, sentAt: ago(minutesAgo + 1), participant: { name: contactId, slug: contactId } }
  };
}
const invited = (contactId, campaignId) => ({ id: `e-${++nextId}`, account_id: "acc-1", type: "invite.requested", created_at: ago(500), meta: { campaignId, crmContactId: contactId, outreachId: `o-${contactId}` } });

test.beforeEach(() => {
  for (const table of Object.keys(rows)) delete rows[table];
  labels = {};
  setReportStores({
    labels: { read: () => labels, write: async (value) => { labels = value; } },
    campaigns: () => [{ id: "camp-a", name: "Підхід А", state: "running" }, { id: "camp-b", name: "Підхід Б", state: "running" }]
  });
  rows.wl_accounts = [{ id: "acc-1", label: "Chloe", login: "chloe@example.com", status: "warming", health: "ok" }];
  rows.wl_events = [
    // А: четверо в кампанії, трьом написали, двоє відповіли; один лише прийняв запит.
    invited("a1", "camp-a"), invited("a2", "camp-a"), invited("a3", "camp-a"), invited("a4", "camp-a"),
    message("out", "Hi a1", 300, "a1"), message("in", "Interesting, we run FB teams — tell me more", 200, "a1"),
    message("out", "Hi a2", 300, "a2"), message("in", "Not interested", 200, "a2"),
    message("out", "Hi a3", 300, "a3"),
    // Б: двоє, одному написали, він відповів.
    invited("b1", "camp-b"), invited("b2", "camp-b"),
    message("out", "Hi b1", 300, "b1"), message("in", "I only buy traffic on CPA", 100, "b1"),
    // Чужий тред без кампанії — у звіт не потрапляє.
    message("out", "Hi x", 300, "x1"), message("in", "hello", 100, "x1")
  ];
  rows.wl_outreach = [{ crm_contact_id: "a4", status: "accepted" }, { crm_contact_id: "a1", status: "connected" }];
  rows.contacts = [
    { id: "a1", name: "Lead A1", company: "Casino", position: "Head of UA", lead_status: "booked_call" },
    { id: "a2", name: "Lead A2", company: "Shop", position: "CEO", lead_status: "not_interested" },
    { id: "a3", name: "Lead A3", lead_status: "in_progress" }, { id: "a4", name: "Lead A4", lead_status: "new" },
    { id: "b1", name: "Lead B1", lead_status: "responded" }, { id: "b2", name: "Lead B2", lead_status: "new" }
  ];
  rows.deal_contacts = [];
});

const byId = (report) => Object.fromEntries(report.campaigns.map((campaign) => [campaign.id, campaign]));

async function settled() {
  for (let index = 0; index < 100; index += 1) {
    const { job } = await campaignReport();
    if (!job?.running) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("AI-розмітка не завершилась");
}

test("buildReport: написали, прийняли, відповіли, кваліфіковані на 100 написаних, дзвінки", () => {
  const people = [
    { campaignId: "c", outCount: 2, inCount: 1, label: "qualified", leadStatus: "booked_call" },
    { campaignId: "c", outCount: 1, inCount: 1, label: "refusal" },
    { campaignId: "c", outCount: 1, inCount: 0 },
    { campaignId: "c", outCount: 0, inCount: 0, outreachStatus: "accepted" },
    { campaignId: "c", outCount: 0, inCount: 0, outreachStatus: "pending", hasDeal: true }
  ];
  const [row] = buildReport([{ id: "c", name: "C" }], people);
  assert.deepEqual(
    { people: row.people, written: row.written, accepted: row.accepted, replied: row.replied, qualified: row.qualified, per100: row.qualifiedPer100, calls: row.calls, unlabeled: row.unlabeled },
    { people: 5, written: 3, accepted: 4, replied: 2, qualified: 1, per100: 33.3, calls: 2, unlabeled: 0 }
  );
  assert.equal(buildReport([{ id: "empty" }], people)[0].qualifiedPer100, null, "нікому не написали — ділити нема на що");
});

test("кампанії поруч з бази; AI ставить мітки, людина змінює одним кліком — звіт перераховується", async () => {
  let report = byId(await campaignReport());
  assert.deepEqual(
    [report["camp-a"].people, report["camp-a"].written, report["camp-a"].accepted, report["camp-a"].replied, report["camp-a"].qualified, report["camp-a"].calls, report["camp-a"].unlabeled],
    [4, 3, 4, 2, 0, 1, 2]
  );
  assert.deepEqual([report["camp-b"].people, report["camp-b"].written, report["camp-b"].replied], [2, 1, 1]);

  const seen = [];
  await labelReplies({
    classify: async ({ person, messages }) => {
      seen.push(person.contactId);
      const last = messages.filter((item) => item.direction === "in").at(-1)?.body || "";
      return { label: /tell me more/.test(last) ? "qualified" : /CPA/.test(last) ? "traffic_only" : "refusal" };
    }
  });
  const job = await settled();
  assert.deepEqual(seen.sort(), ["a1", "a2", "b1"], "AI бачить лише відповіді людей кампаній");
  assert.equal(job.failed, 0);
  report = byId(await campaignReport());
  assert.equal(report["camp-a"].qualified, 1);
  assert.equal(report["camp-a"].qualifiedPer100, 33.3);
  assert.equal(report["camp-b"].byLabel.traffic_only, 1);
  assert.equal(report["camp-b"].qualifiedPer100, 0);

  // Лідген не згоден з AI: b1 — кваліфікована.
  const answer = {};
  await handleCampaignReportApi({
    request: { method: "POST" }, response: {}, url: new URL("http://x/api/campaign-report/label"),
    readJson: async () => ({ contactId: "b1", label: "qualified" }), sendJson: (_, status, payload) => Object.assign(answer, { status, payload })
  });
  assert.equal(answer.status, 200);
  assert.equal(labels.b1.by, "human");
  report = byId(await campaignReport());
  assert.equal(report["camp-b"].qualified, 1);
  assert.equal(report["camp-b"].qualifiedPer100, 100, "звіт перерахувався після мітки людини");

  const replies = await campaignReplies("camp-b");
  assert.deepEqual(replies.map((item) => [item.contactId, item.label, item.labelBy, item.reply]), [["b1", "qualified", "human", "I only buy traffic on CPA"]]);

  // Повторний прохід AI: мітку людини не чіпає, свої — лише якщо прийшла нова відповідь.
  rows.wl_events.push(message("in", "Actually, not now", 10, "a2"));
  const again = [];
  await labelReplies({ classify: async ({ person }) => { again.push(person.contactId); return { label: "other" }; } });
  await settled();
  assert.deepEqual(again, ["a2"], "лише a2: у нього нова відповідь після мітки AI");
  assert.equal(labels.b1.label, "qualified");
});

test("needsAiLabel: без відповіді — ні; мітка людини — ніколи; мітка AI — лише після нової відповіді", () => {
  assert.equal(needsAiLabel({ inCount: 0 }), false);
  assert.equal(needsAiLabel({ inCount: 1 }), true);
  assert.equal(needsAiLabel({ inCount: 1, label: "refusal", labelBy: "human", labelBasis: "x", lastInboundAt: "y" }), false);
  assert.equal(needsAiLabel({ inCount: 1, label: "refusal", labelBy: "ai", labelBasis: "x", lastInboundAt: "x" }), false);
  assert.equal(needsAiLabel({ inCount: 1, label: "refusal", labelBy: "ai", labelBasis: "x", lastInboundAt: "y" }), true);
});

test("невідома мітка — 400, нічого не записано", async () => {
  await assert.rejects(setLabel({ contactId: "a1", label: "maybe" }), /Невідома мітка/);
  const answer = {};
  await handleCampaignReportApi({
    request: { method: "POST" }, response: {}, url: new URL("http://x/api/campaign-report/label"),
    readJson: async () => ({ contactId: "a1", label: "maybe" }), sendJson: (_, status, payload) => Object.assign(answer, { status, payload })
  });
  assert.equal(answer.status, 400);
  assert.deepEqual(labels, {});
});

test("звіти ESP не зачеплені: свій блок над ними, без маршрутів /api/esp", () => {
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('id="campaignReportRoot"') < html.indexOf('id="reportsTop"'), "блок кампаній — над звітами ESP");
  const screen = readFileSync(new URL("../app/screens/campaign-report.js", import.meta.url), "utf8");
  assert.doesNotMatch(screen, /\/api\/esp/);
  assert.doesNotMatch(screen, /reportsTop/, "не рендерить у корінь звітів ESP");
});
