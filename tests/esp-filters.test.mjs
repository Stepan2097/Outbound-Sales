import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleEspDataApi } from "../esp/data-api.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { parseLeadLines } from "../esp/campaigns.mjs";
import {
  DEFAULT_EXCLUDED_COUNTRIES, addExclusion, checkLead, countryCode, excludedCountries, exclusions, filterContext, forgetMx,
  mailOnGoogle, refusedAtEnrolment, setExcludedCountries
} from "../esp/filters.mjs";
import { adminLog } from "../esp/access.mjs";

/**
 * ESP 6 — the checks every letter passes before it goes: the global exclusions,
 * a verification no older than 30 days, the pilot filters (no catch-all, no role
 * addresses, no Apple mail, Google MX only), the country filter, and a source.
 */

let dir;
const NOW = new Date("2026-10-10T09:00:00Z");
const GOOGLE = { resolveMx: async (domain) => (domain === "outlook-co.com" ? [{ exchange: "mail.protection.outlook.com" }] : [{ exchange: "aspmx.l.google.com" }, { exchange: "alt1.aspmx.l.google.com" }]) };

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "esp-filters-"));
  useJournal(join(dir, "esp-journal.jsonl"));
  forgetMx();
});
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const GOOD = {
  email: "olena@northwind.co.uk", name: "Olena", company: "Northwind", country: "United Kingdom",
  source: "Apollo export", sourceDate: "2026-10-01", verification: "valid", verifiedAt: "2026-10-05"
};
const check = async (lead, extra = {}) => checkLead({ ...GOOD, ...lead }, { ...await filterContext({ dns: GOOGLE, now: NOW }), dns: GOOGLE, now: NOW, ...extra });

test("лід із джерелом, свіжою перевіркою, країною й поштою на Google — йде", async () => {
  assert.deepEqual(await check({}), { ok: true, reason: null, detail: "", permanent: false, needsRecheck: false });
});

test("глобальні виключення — назавжди: відписки й 5.x.x bounce із журналу самі, ручні — за категоріями, і цілий домен", async () => {
  await append({ type: "contact.unsubscribed", contact: "olena@northwind.co.uk", data: { via: "one-click" } });
  let verdict = await check({});
  assert.equal(verdict.reason, "unsubscribed");
  assert.equal(verdict.permanent, true);

  await append({ type: "message.bounced", contact: "gone@northwind.co.uk", data: { code: "5.1.1" } });
  await append({ type: "message.bounced", contact: "soft@northwind.co.uk", data: { code: "4.2.2" } });
  assert.equal((await check({ email: "gone@northwind.co.uk" })).reason, "hard_bounce");
  assert.equal((await check({ email: "soft@northwind.co.uk" })).ok, true, "4.x.x — не назавжди");

  for (const [key, category] of [["no@x-corp.com", "no"], ["angry@x-corp.com", "complaint"], ["@client-co.com", "client"], ["boss@partner.io", "partner"]]) {
    await addExclusion({ key, category, note: "з відповіді" }, "ira@advantage-agency.co");
  }
  assert.equal((await check({ email: "no@x-corp.com" })).reason, "no");
  assert.equal((await check({ email: "angry@x-corp.com" })).reason, "complaint");
  verdict = await check({ email: "anyone@client-co.com" });
  assert.equal(verdict.reason, "client");
  assert.match(verdict.detail, /увесь домен @client-co\.com/);
  assert.equal(await addExclusion({ key: "NO@x-corp.com", category: "client" }, "a"), null, "додати двічі — це перший раз");
  await assert.rejects(() => addExclusion({ key: "not an address", category: "no" }, "a"), /адреса/);
  await assert.rejects(() => addExclusion({ key: "x@y.co", category: "bored" }, "a"), /Причина/);
  assert.equal((await exclusions()).get("no@x-corp.com").actor, "ira@advantage-agency.co");
});

test("верифікація: лише «valid» і не старша 30 днів; інакше лід чекає й позначається на повторну перевірку", async () => {
  assert.equal((await check({ verifiedAt: "2026-09-10" })).ok, true, "рівно 30 днів — ще можна");
  const stale = await check({ verifiedAt: "2026-09-09" });
  assert.deepEqual([stale.reason, stale.needsRecheck, stale.permanent], ["verification_stale", true, false]);
  assert.match(stale.detail, /31 дн/);
  const none = await check({ verification: "", verifiedAt: "" });
  assert.deepEqual([none.reason, none.needsRecheck], ["not_verified", true]);
  assert.equal((await check({ verification: "unknown" })).reason, "not_verified");
  assert.deepEqual([(await check({ verification: "invalid" })).reason, (await check({ verification: "invalid" })).permanent], ["invalid", true]);
});

test("фільтри пілоту: без catch-all, без службових адрес, без пошти Apple, лише MX на Google", async () => {
  assert.equal((await check({ verification: "catch_all" })).reason, "catch_all");
  assert.equal((await check({ verification: "accept_all" })).reason, "catch_all");
  for (const local of ["abuse", "postmaster", "admin", "info", "noreply", "sales"]) {
    const verdict = await check({ email: `${local}@northwind.co.uk` });
    assert.deepEqual([verdict.reason, verdict.permanent], ["role_address", true], local);
  }
  assert.equal((await check({ email: "info+uk@northwind.co.uk" })).reason, "role_address", "з тегом після + — теж");
  for (const domain of ["icloud.com", "me.com", "mac.com"]) assert.equal((await check({ email: `olena@${domain}` })).reason, "blocked_domain");
  const outlook = await check({ email: "olena@outlook-co.com" });
  assert.deepEqual([outlook.reason, outlook.permanent], ["not_google_mx", true]);
});

test("MX: Google — так; інше — ні; DNS без відповіді — «невідомо», і таке не запам'ятовується", async () => {
  let asked = 0;
  const flaky = { resolveMx: async () => { asked += 1; throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" }); } };
  assert.equal(await mailOnGoogle("northwind.co.uk", { dns: flaky }), null);
  assert.equal(await mailOnGoogle("northwind.co.uk", { dns: flaky }), null);
  assert.equal(asked, 2, "невдачу не закешовано");
  assert.equal((await check({}, { dns: flaky })).reason, "mx_unknown");
  assert.equal(await mailOnGoogle("nowhere.example", { dns: { resolveMx: async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); } } }), false);
  assert.equal(await mailOnGoogle("mixed.example", { dns: { resolveMx: async () => [{ exchange: "aspmx.l.google.com" }, { exchange: "mx.other.net" }] } }), false, "змішані MX — не Google");
  let calls = 0;
  const counted = { resolveMx: async () => { calls += 1; return [{ exchange: "smtp.google.com" }]; } };
  await mailOnGoogle("cached.example", { dns: counted });
  await mailOnGoogle("cached.example", { dns: counted });
  assert.equal(calls, 1, "відповідь DNS тримається добу");
});

test("країни: зараз Німеччина; невідома країна не йде; домен .de теж ловиться; список міняє адміністратор, і це в журналі дій", async () => {
  assert.deepEqual(await excludedCountries(), DEFAULT_EXCLUDED_COUNTRIES);
  for (const country of ["Germany", "Deutschland", "DE", "німеччина"]) assert.equal((await check({ country })).reason, "country_excluded", country);
  assert.equal((await check({ email: "hans@firma.de", country: "United Kingdom" })).reason, "country_excluded", "домен .de");
  const unknown = await check({ country: "" });
  assert.deepEqual([unknown.reason, unknown.permanent], ["country_unknown", false]);
  assert.equal((await check({ country: "Poland" })).ok, true);

  await setExcludedCountries(["Germany", "Poland", "AT"], "stepan@advantage-agency.co");
  assert.deepEqual(await excludedCountries(), ["AT", "DE", "PL"]);
  assert.equal((await check({ country: "Polska" })).reason, "country_excluded");
  assert.equal(await setExcludedCountries("DE, PL, AT", "x"), null, "той самий список — без рядка");
  assert.equal((await adminLog())[0].type, "filters.countries");
  assert.equal(countryCode("United Kingdom"), "UK");
});

test("джерело обов'язкове: без джерела чи дати отримання лист не йде", async () => {
  assert.equal((await check({ source: "" })).reason, "no_source");
  assert.equal((await check({ sourceDate: "" })).reason, "no_source");
  assert.equal((await check({ sourceDate: "вчора" })).reason, "no_source");
});

test("правило 90 днів (ESP 13) у тій самій перевірці: лише для першого листа", async () => {
  await append({ type: "message.sent", contact: "olena@northwind.co.uk", data: { from: "anna@x.com" } });
  const ctx = await filterContext({ dns: GOOGLE, now: new Date() });
  const first = await checkLead(GOOD, { ...ctx, step: 0 });
  assert.equal(first.reason, "contacted_recently");
  assert.equal(refusedAtEnrolment(first), true);
  assert.equal((await checkLead(GOOD, { ...ctx, step: 1 })).ok, true, "фолоуап — це та сама розмова");
  await append({ type: "message.replied", contact: "olena@northwind.co.uk", data: {} });
  const replied = await checkLead(GOOD, { ...await filterContext({ dns: GOOGLE }), step: 0 });
  assert.deepEqual([replied.reason, replied.permanent], ["replied_before", true]);
});

test("при додаванні в кампанію відмовляють лише остаточні причини; решта чекає даних", () => {
  assert.equal(refusedAtEnrolment({ ok: false, reason: "client", permanent: true }), true);
  assert.equal(refusedAtEnrolment({ ok: false, reason: "no_source", permanent: false }), false);
  assert.equal(refusedAtEnrolment({ ok: false, reason: "verification_stale", permanent: false, needsRecheck: true }), false);
  assert.equal(refusedAtEnrolment({ ok: true }), false);
});

test("список людей читається з заголовком у будь-якому порядку — з джерелом, датою й верифікацією; без заголовка — за порядком", () => {
  const withHeader = parseLeadLines("Source;Email;Country;Verified At;Status;Source Date;Name\nApollo;olena@northwind.co.uk;UK;2026-10-05;valid;2026-10-01;Olena");
  assert.deepEqual([withHeader.leads[0].email, withHeader.leads[0].source, withHeader.leads[0].verification, withHeader.leads[0].verifiedAt, withHeader.leads[0].sourceDate],
    ["olena@northwind.co.uk", "Apollo", "valid", "2026-10-05", "2026-10-01"]);
  const plain = parseLeadLines("olena@northwind.co.uk, Olena, Northwind, UK, Europe/London, Apollo, 2026-10-01, valid, 2026-10-05");
  assert.deepEqual([plain.leads[0].source, plain.leads[0].verifiedAt], ["Apollo", "2026-10-05"]);
  assert.equal(parseLeadLines("olena@northwind.co.uk, Olena").leads[0].source, "", "старий формат працює — просто без джерела");
});

async function route({ method = "GET", path, body = null, role = "admin" }) {
  let captured = null;
  await handleEspDataApi({
    request: { method }, response: {}, url: new URL(`http://x${path}`),
    sendJson: (_response, status, payload) => { captured = { status, payload }; },
    readJson: async () => body, profile: { email: role === "admin" ? "stepan@advantage-agency.co" : "ira@advantage-agency.co", role }, dns: GOOGLE
  });
  return captured;
}

test("маршрути: виключити може кожен, хто бачить відповіді; країни — адміністратор; перевірка списку каже, хто піде, хто ні, хто чекає", async () => {
  const added = await route({ method: "POST", path: "/api/esp/exclusions", body: { key: "no@x-corp.com", category: "no" }, role: "seller" });
  assert.equal(added.status, 201);
  assert.equal(added.payload.event.actor, "ira@advantage-agency.co");
  assert.equal((await route({ method: "POST", path: "/api/esp/filters/countries", body: { countries: ["PL"] }, role: "seller" })).status, 403);
  assert.equal((await route({ method: "POST", path: "/api/esp/filters/countries", body: { countries: ["DE", "PL"] } })).payload.countries.join(), "DE,PL");
  const view = await route({ path: "/api/esp/filters", role: "seller" });
  assert.deepEqual(view.payload.countries, ["DE", "PL"]);
  assert.equal(view.payload.exclusions[0].key, "no@x-corp.com");
  assert.equal(view.payload.canSetCountries, false);

  const text = [
    "email,name,country,source,source_date,verification,verified_at",
    "olena@northwind.co.uk,Olena,UK,Apollo,2026-10-01,valid," + new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10),
    "no@x-corp.com,No,UK,Apollo,2026-10-01,valid,2026-10-05",
    "hans@firma.com,Hans,Germany,Apollo,2026-10-01,valid,2026-10-05",
    "fresh@northwind.co.uk,Fresh,UK,,,valid,2026-10-05",
    "old@northwind.co.uk,Old,UK,Apollo,2026-08-01,valid,2026-08-01"
  ].join("\n");
  const checked = await route({ method: "POST", path: "/api/esp/leads/check", body: { text }, role: "seller" });
  assert.deepEqual(checked.payload.results.map((row) => [row.email, row.reason ?? "ok", row.refused]), [
    ["olena@northwind.co.uk", "ok", false],
    ["no@x-corp.com", "no", true],
    ["hans@firma.com", "country_excluded", true],
    ["fresh@northwind.co.uk", "no_source", false],
    ["old@northwind.co.uk", "verification_stale", false]
  ]);
  assert.deepEqual(checked.payload.counts, { ok: 1, refused: 2, waiting: 2 });
  assert.equal((await allEntries()).filter((row) => row.type.startsWith("message.")).length, 0, "перевірка нічого не надсилає й не пише");
});
