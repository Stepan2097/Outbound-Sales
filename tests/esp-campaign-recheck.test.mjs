import assert from "node:assert/strict";
import test from "node:test";

import { campaignRecheck, needsRecheck } from "../esp/campaign-recheck.mjs";
import { campaignStore } from "../esp/campaigns.mjs";
import { checkLead } from "../esp/filters.mjs";

const lead = (email, verification) => ({ email, verification, source: "CRM: Casino brands", sourceDate: "2026-10-20", country: "Malta" });
const row = (id, email, verification, extra = {}) => ({ id, campaignId: "c1", email, lead: lead(email, verification), sender: "emil@trafpush.com", step: 0, status: "active", nextDueDate: "2026-11-05", lastSent: null, ...extra });

function store(rows) {
  let enrollments = rows;
  return campaignStore({ read: () => [], write: async () => {}, readEnrollments: () => enrollments, writeEnrollments: async (value) => { enrollments = value; }, templates: () => [] });
}

test("05.11 «відкидаємо тільки пошти в яких 80%+ впевнені що вони погані»: виходить лише адреса, якої сервер каже — немає; catch-all і «без відповіді» лишаються", async () => {
  const campaigns = store([
    row("1", "a@catchall.com", "catch_all"),
    row("2", "b@real.com", "unknown"),
    row("3", "c@gone.com", ""),
    row("4", "d@sure.com", "valid"),
    row("5", "e@catchall.com", "catch_all", { step: 1, lastSent: "2026-11-03T10:00:00Z" }),
    row("6", "f@real.com", "catch_all", { status: "stopped", reason: "catch_all" }),
    row("7", "g@quiet.com", "unknown", { status: "stopped", reason: "not_verified" }),
    row("8", "h@gone.com", "unknown", { status: "stopped", reason: "not_verified" })
  ]);
  const verdicts = { "b@real.com": "valid", "c@gone.com": "invalid", "f@real.com": "catch_all", "g@quiet.com": "unknown", "h@gone.com": "invalid" };
  const asked = [];
  const recheck = campaignRecheck({ campaigns, deep: () => async (email) => { asked.push(email); return { status: verdicts[email], reason: `сервер: ${verdicts[email]}` }; }, now: () => new Date("2026-11-05T09:00:00Z") });
  await recheck.start().done;

  assert.deepEqual(asked.sort(), ["b@real.com", "c@gone.com", "f@real.com", "g@quiet.com", "h@gone.com"], "a sure one, a catch-all still in and one who already had a letter are not asked");
  const by = Object.fromEntries(campaigns.enrollments().map((item) => [item.id, [item.status, item.reason ?? null, item.lead.verification]]));
  assert.deepEqual(by, {
    1: ["active", null, "catch_all"],
    2: ["active", null, "valid"],
    3: ["stopped", "invalid", "invalid"],
    4: ["active", null, "valid"],
    5: ["active", null, "catch_all"],
    6: ["active", null, "catch_all"],
    7: ["active", null, "unknown"],
    8: ["stopped", "invalid", "invalid"]
  });
  assert.deepEqual(recheck.status().counts, { valid: 1, invalid: 2, catch_all: 1, unknown: 1 });
  assert.deepEqual(campaigns.enrollments().filter(needsRecheck).map((item) => item.id), ["7"], "only «no answer» is worth asking again");
});

test("05.11: перевірка, зроблена деінде (через проксі), приходить готовими відповідями; кого в них немає — не чіпається", async () => {
  const campaigns = store([
    row("1", "a@mimecast.co", "unknown", { status: "stopped", reason: "not_verified" }),
    row("2", "b@mimecast.co", "unknown", { status: "stopped", reason: "not_verified" }),
    row("3", "c@other.co", "unknown", { status: "stopped", reason: "not_verified" })
  ]);
  const recheck = campaignRecheck({ campaigns, deep: () => { throw new Error("not asked"); } });
  await recheck.start({ verdicts: { "A@mimecast.co": { status: "valid", reason: "via proxy" }, "b@mimecast.co": { status: "invalid", reason: "550 5.1.1" } } }).done;
  assert.deepEqual(campaigns.enrollments().map((item) => [item.status, item.reason ?? null]), [["active", null], ["stopped", "invalid"], ["stopped", "not_verified"]]);
  assert.equal(recheck.status().error, null);
});

test("05.11: перший лист іде й на catch-all, і на неперевірену; не йде — лише на адресу, якої немає", async () => {
  const ctx = { exclusions: new Map(), countries: [], recontact: null, now: new Date("2026-11-05T09:00:00Z") };
  for (const status of ["valid", "catch_all", "unknown", ""]) assert.equal((await checkLead(lead("a@x.com", status), { ...ctx, step: 0 })).ok, true, status);
  assert.equal((await checkLead(lead("a@x.com", "invalid"), { ...ctx, step: 0 })).reason, "invalid");
});
