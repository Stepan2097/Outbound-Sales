import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyAlerts } from "../esp/alerts.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { COMPARE_MIN_SENT, HEATWAVE_LOOKUP, compareSenders, dnsChanges, heatwaveChecker, readHeatwavePage, runDailyMonitor } from "../esp/monitor.mjs";
import { addDomain, checkDomain, registry, setDomainStatus, setSenderStatus } from "../esp/registry.mjs";

/**
 * ESP 15 — comparing a campaign's senders, the daily blocklists and the DNS
 * watch. What is found goes through ESP 8's `applyAlerts`, so the pauses and
 * the one-a-day message are the same as for every other alarm.
 */

let dir;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "esp-monitor-"));
  useJournal(join(dir, "esp-journal.jsonl"));
});
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// Heatwave is read over HTTP; the tests never go to the network.
const CLEAN_HEATWAVE = async () => ({ status: "clean" });

const RUNNING = [{ id: "c1", name: "UK operators", state: "running" }];
const sent = (from, to, campaignId = "c1") => ({ type: "message.sent", contact: to, data: { from, campaignId } });
const replied = (to, campaignId = "c1", sender = undefined) => ({ type: "message.replied", contact: to, data: { campaignId, ...(sender ? { sender } : {}) } });

test("порівняння сендерів: 0 відповідей на 80+ листів, коли напарнику в тій самій кампанії відповідають — прапорець і пауза", () => {
  const entries = [];
  for (let at = 0; at < 85; at += 1) entries.push(sent("anna@a.com", `a${at}@x.com`));
  for (let at = 0; at < 40; at += 1) entries.push(sent("boris@a.com", `b${at}@x.com`));
  entries.push(replied("b3@x.com"));
  const [action] = compareSenders({ entries, campaigns: RUNNING });
  assert.equal(action.kind, "pause_sender");
  assert.equal(action.email, "anna@a.com");
  assert.equal(action.code, "no_replies_vs_partner");
  assert.match(action.reason, /0 відповідей на 85 листів .*boris@a\.com/);
  assert.equal(compareSenders({ entries, campaigns: RUNNING }).length, 1, "напарник із відповіддю не позначається");
});

test("порівняння сендерів не спрацьовує: менше 80 листів, ніхто в кампанії не отримує відповідей, кампанія не йде", () => {
  const few = [];
  for (let at = 0; at < COMPARE_MIN_SENT - 1; at += 1) few.push(sent("anna@a.com", `a${at}@x.com`));
  few.push(sent("boris@a.com", "b@x.com"), replied("b@x.com"));
  assert.deepEqual(compareSenders({ entries: few, campaigns: RUNNING }), []);

  const quiet = [];
  for (let at = 0; at < 90; at += 1) quiet.push(sent("anna@a.com", `a${at}@x.com`), sent("boris@a.com", `b${at}@x.com`));
  assert.deepEqual(compareSenders({ entries: quiet, campaigns: RUNNING }), [], "тиха кампанія — це кампанія, а не сендер");

  const other = [];
  for (let at = 0; at < 90; at += 1) other.push(sent("anna@a.com", `a${at}@x.com`));
  other.push(sent("boris@a.com", "b@x.com", "c2"), replied("b@x.com", "c2"));
  assert.deepEqual(compareSenders({ entries: other, campaigns: [...RUNNING, { id: "c2", name: "Other", state: "running" }] }), [], "напарник з іншої кампанії — не напарник");
  const paused = [];
  for (let at = 0; at < 90; at += 1) paused.push(sent("anna@a.com", `a${at}@x.com`));
  paused.push(sent("boris@a.com", "b@x.com"), replied("b@x.com"));
  assert.deepEqual(compareSenders({ entries: paused, campaigns: [{ ...RUNNING[0], state: "paused" }] }), []);
});

test("відповідь без сендера в записі приписується тому, хто писав цій людині в цій кампанії", () => {
  const entries = [];
  for (let at = 0; at < 90; at += 1) entries.push(sent("anna@a.com", `a${at}@x.com`));
  entries.push(sent("boris@a.com", "b@x.com"), replied("a5@x.com"));
  assert.deepEqual(compareSenders({ entries, campaigns: RUNNING }), [], "у Anna є відповідь — нікого не ставимо на паузу");
});

test("DNS: зниклий і змінений запис — зміна; DKIM порівнюється, лише коли відомий селектор", () => {
  const before = { mx: ["aspmx.l.google.com"], spf: "v=spf1 include:_spf.google.com ~all", dmarc: "v=DMARC1; p=none", dkim: "v=DKIM1; p=AAA", dkimSelector: "google" };
  assert.deepEqual(dnsChanges(before, { ...before }), []);
  const changes = dnsChanges(before, { ...before, spf: null, dmarc: "v=DMARC1; p=reject" });
  assert.deepEqual(changes.map((row) => [row.field, row.change]), [["spf", "missing"], ["dmarc", "changed"]]);
  assert.deepEqual(dnsChanges(before, { ...before, dkim: null, dkimSelector: null }), [], "без селектора DKIM не дивимось");
  assert.deepEqual(dnsChanges(before, { ...before, mx: ["alt1.aspmx.l.google.com", "aspmx.l.google.com"].reverse() }).map((row) => row.field), ["mx"]);
});

function fakeDns(world) {
  const nx = () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); };
  return {
    resolveMx: async (name) => world.mx[name] ?? nx(),
    resolveTxt: async (name) => world.txt[name] ?? nx(),
    resolve4: async (name) => (world.listed.includes(name) ? ["127.0.0.2"] : nx())
  };
}

test("щоденний монітор: перший прогін — знімок; наступного дня зниклий SPF — тривога без паузи; лістинг у SURBL — пауза домену", async () => {
  await addDomain({ domain: "send.example.com", status: "ramp" }, "a");
  const world = {
    mx: { "send.example.com": [{ exchange: "aspmx.l.google.com" }], "advantage-agency.co": [{ exchange: "aspmx.l.google.com" }] },
    txt: { "send.example.com": [["v=spf1 include:_spf.google.com ~all"]], "_dmarc.send.example.com": [["v=DMARC1; p=quarantine"]],
      "advantage-agency.co": [["v=spf1 include:_spf.google.com ~all"]] },
    listed: []
  };
  const dns = fakeDns(world);
  const env = { ESP_MONITOR_DOMAINS: "advantage-agency.co" };
  const day1 = new Date("2026-10-10T07:00:00Z");
  const first = await runDailyMonitor({ now: day1, dns, env, heatwave: CLEAN_HEATWAVE });
  assert.equal(first.skipped, false);
  assert.deepEqual(first.actions, [], "перший знімок — нічого порівнювати");
  assert.deepEqual(first.domains.map((row) => row.domain), ["send.example.com", "advantage-agency.co"]);
  assert.equal((await runDailyMonitor({ now: day1, dns, env, heatwave: CLEAN_HEATWAVE })).skipped, true, "двічі за день — ні");

  delete world.txt["send.example.com"];
  world.listed = ["send.example.com.multi.surbl.org"];
  const second = await runDailyMonitor({ now: new Date("2026-10-11T07:00:00Z"), dns, env, force: true, heatwave: CLEAN_HEATWAVE });
  const kinds = second.actions.map((row) => [row.kind, row.code, row.domain]);
  assert.deepEqual(kinds, [["pause_domain", "blocklisted", "send.example.com"], ["alert", "dns_changed", "send.example.com"]]);
  assert.match(second.actions[1].reason, /SPF зник/);

  const applied = await applyAlerts({
    actions: second.actions, entries: await allEntries(),
    setSenderStatus: async () => null, pauseCampaign: async () => null, setDomainStatus, append
  });
  assert.equal(applied.length, 2);
  const [domain] = (await registry()).domains;
  assert.equal(domain.status, "paused");
  assert.match(domain.history.at(-1).reason, /у блоклисті: surbl/);
  const alerts = (await allEntries()).filter((entry) => entry.type === "esp.alert");
  assert.deepEqual(alerts.map((entry) => entry.data.title), ["Домен send.example.com на паузі", "Тривога: send.example.com"]);
  assert.equal((await applyAlerts({ actions: second.actions, entries: await allEntries(), setSenderStatus: async () => null, pauseCampaign: async () => null, setDomainStatus, append })).length, 0, "тривога — раз на добу");
});

test("домен компанії поза реєстром: лістинг — лише тривога (паузити нічого), а знімки DNS — свої", async () => {
  const world = { mx: { "advantage-agency.co": [{ exchange: "aspmx.l.google.com" }] }, txt: { "advantage-agency.co": [["v=spf1 ~all"]] }, listed: ["advantage-agency.co.multi.surbl.org"] };
  const result = await runDailyMonitor({ now: new Date("2026-10-10T07:00:00Z"), dns: fakeDns(world), env: { ESP_MONITOR_DOMAINS: "advantage-agency.co" }, heatwave: CLEAN_HEATWAVE });
  assert.deepEqual(result.actions.map((row) => [row.kind, row.domain]), [["alert", "advantage-agency.co"]]);
  assert.ok((await allEntries()).some((entry) => entry.type === "esp.monitor.domain" && entry.data.domain === "advantage-agency.co"));
});

test("Spamhaus без ключа DQS — «не перевірено», а не «чисто»; виведений домен не дивимось", async () => {
  await addDomain({ domain: "old.example.com", status: "ramp" }, "a");
  await setDomainStatus({ domain: "old.example.com", status: "retired", reason: "спалений" }, "a");
  const result = await runDailyMonitor({ now: new Date("2026-10-10T07:00:00Z"), dns: fakeDns({ mx: {}, txt: {}, listed: [] }), env: { ESP_MONITOR_DOMAINS: "" }, heatwave: CLEAN_HEATWAVE });
  assert.deepEqual(result.domains, []);
  await addDomain({ domain: "live.example.com", status: "active" }, "a");
  await checkDomain({ domain: "live.example.com" }, "a", fakeDns({ mx: {}, txt: {}, listed: [] }), {});
  const live = (await registry()).domains.find((row) => row.domain === "live.example.com");
  assert.equal(live.checks.blocklists.spamhausDbl.status, "not_checked");
});

test("сендер, поставлений на паузу порівнянням, зупиняється в реєстрі з кодом", async () => {
  await addDomain({ domain: "a.com", status: "ramp" }, "a");
  const { addSender } = await import("../esp/registry.mjs");
  await addSender({ email: "anna@a.com" }, "a");
  const entries = [];
  for (let at = 0; at < 85; at += 1) entries.push(sent("anna@a.com", `a${at}@x.com`));
  entries.push(sent("boris@a.com", "b@x.com"), replied("b@x.com"));
  const actions = compareSenders({ entries, campaigns: RUNNING });
  await applyAlerts({ actions, entries: [], setSenderStatus, pauseCampaign: async () => null, append });
  const [sender] = (await registry()).senders;
  assert.equal(sender.status, "paused");
  assert.equal(sender.history.at(-1).code, "no_replies_vs_partner");
});

// ── Validity Heatwave ─────────────────────────────────────────────────────

// The pieces of lookup.validity.tools that carry the verdict, as served on 10.10.2026.
const HEATWAVE_LISTED = `<div class="d-flex"><span class="status-pill sm status-listed"><i class="bi bi-exclamation-octagon-fill" aria-hidden="true"></i> Listed</span>
  <span class="status-pill sm status-prewarming">Pre-warming</span></div>
  <div class="stat-label" style="font-size:.7rem;color:#7D7E7E">Classification</div>
  <div style="color:#3730A3;font-weight:700"><i class="bi bi-hourglass-split" aria-hidden="true"></i> Pre-warming</div>`;
const HEATWAVE_CLEAR = `<div class="card p-4"><span class="status-pill status-clear"><i class="bi bi-check-circle-fill" aria-hidden="true"></i> Not currently listed</span></div>
  <p>Heatwave found 5 listed domains with names similar to example.</p>
  <table><tr><td>examplemail.co</td><td><span class="status-pill sm status-listed">Listed</span></td></tr></table>`;

test("Heatwave: «Listed» — у блоклисті; «Not currently listed» — чисто, навіть коли нижче є схожі домени у списку; інша сторінка — «не перевірено»", () => {
  assert.deepEqual(readHeatwavePage(HEATWAVE_LISTED), { status: "listed", classification: "Pre-warming" });
  assert.deepEqual(readHeatwavePage(HEATWAVE_CLEAR), { status: "clean" });
  assert.equal(readHeatwavePage("<html>Service temporarily unavailable</html>").status, "not_checked");
});

test("Heatwave питається публічним пошуком Validity; помилка, таймаут чи 5xx — «не перевірено», а не «чисто»", async () => {
  const asked = [];
  const page = (body, status = 200) => async (url) => { asked.push(url); return { ok: status < 400, status, text: async () => body }; };
  assert.equal((await heatwaveChecker({}, page(HEATWAVE_LISTED))("send.example.com")).status, "listed");
  assert.equal(asked[0], `${HEATWAVE_LOOKUP}?domain=send.example.com`);
  assert.equal((await heatwaveChecker({}, page(HEATWAVE_CLEAR, 503))("a.com")).status, "not_checked");
  assert.equal((await heatwaveChecker({}, async () => { throw new Error("ECONNRESET"); })("a.com")).status, "not_checked");
  assert.equal((await heatwaveChecker({ ESP_HEATWAVE: "off" }, page(HEATWAVE_LISTED))("a.com")).status, "not_checked");
});

test("домен реєстру в Heatwave — пауза домену й тривога, як за будь-яким іншим блоклистом", async () => {
  await addDomain({ domain: "send.example.com", status: "active" }, "a");
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => (url.includes("send.example.com") ? HEATWAVE_LISTED : HEATWAVE_CLEAR) });
  const result = await runDailyMonitor({
    now: new Date("2026-10-10T07:00:00Z"), dns: fakeDns({ mx: {}, txt: {}, listed: [] }), env: { ESP_MONITOR_DOMAINS: "advantage-agency.co" },
    heatwave: heatwaveChecker({}, fetchImpl)
  });
  assert.deepEqual(result.actions.map((row) => [row.kind, row.domain, row.code]), [["pause_domain", "send.example.com", "blocklisted"]]);
  assert.match(result.actions[0].reason, /heatwave/);
  await applyAlerts({ actions: result.actions, entries: [], setSenderStatus, setDomainStatus, pauseCampaign: async () => null, append });
  assert.equal((await registry()).domains.find((row) => row.domain === "send.example.com").status, "paused");
  assert.ok((await allEntries()).some((entry) => entry.type === "esp.alert" && entry.data?.domain === "send.example.com"));
});
