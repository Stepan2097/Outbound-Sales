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

test("04.11 «перепровір і ті адреси в яких не впевнений прибери з кампаній»: перевірена знову лишається, решта виходить із причиною", async () => {
  const campaigns = store([
    row("1", "a@catchall.com", "catch_all"),
    row("2", "b@real.com", "unknown"),
    row("3", "c@gone.com", ""),
    row("4", "d@sure.com", "valid"),
    row("5", "e@catchall.com", "catch_all", { step: 1, lastSent: "2026-11-03T10:00:00Z" }),
    row("6", "f@real.com", "catch_all", { status: "stopped", reason: "catch_all" }),
    row("7", "g@quiet.com", "unknown")
  ]);
  const verdicts = { "a@catchall.com": "catch_all", "b@real.com": "valid", "c@gone.com": "invalid", "f@real.com": "valid", "g@quiet.com": "unknown" };
  const asked = [];
  const recheck = campaignRecheck({ campaigns, deep: () => async (email) => { asked.push(email); return { status: verdicts[email], reason: `сервер: ${verdicts[email]}` }; }, now: () => new Date("2026-11-05T09:00:00Z") });
  await recheck.start().done;

  assert.deepEqual(asked.sort(), ["a@catchall.com", "b@real.com", "c@gone.com", "f@real.com", "g@quiet.com"], "a sure one and one who already had a letter are not asked");
  const by = Object.fromEntries(campaigns.enrollments().map((item) => [item.id, [item.status, item.reason ?? null, item.lead.verification]]));
  assert.deepEqual(by, {
    1: ["stopped", "catch_all", "catch_all"],
    2: ["active", null, "valid"],
    3: ["stopped", "invalid", "invalid"],
    4: ["active", null, "valid"],
    5: ["active", null, "catch_all"],
    6: ["active", null, "valid"],
    7: ["stopped", "not_verified", "unknown"]
  });
  assert.deepEqual(recheck.status().counts, { valid: 2, invalid: 1, catch_all: 1, unknown: 1 });
  assert.equal(recheck.status().running, false);
  assert.deepEqual(campaigns.enrollments().filter(needsRecheck).map((item) => item.id).sort(), ["1", "3", "7"], "a second run asks again only those it set aside");
});

test("04.11: перший лист — лише на адресу, яку сервер підтвердив; наступний іде тому, хто перший отримав без bounce", async () => {
  const ctx = { exclusions: new Map(), countries: [], recontact: null, now: new Date("2026-11-05T09:00:00Z") };
  assert.equal((await checkLead(lead("a@x.com", "valid"), { ...ctx, step: 0 })).ok, true);
  const catchAll = await checkLead(lead("a@x.com", "catch_all"), { ...ctx, step: 0 });
  assert.deepEqual([catchAll.ok, catchAll.reason, catchAll.permanent], [false, "catch_all", true]);
  const unknown = await checkLead(lead("a@x.com", "unknown"), { ...ctx, step: 0 });
  assert.deepEqual([unknown.ok, unknown.reason, unknown.permanent], [false, "not_verified", true]);
  assert.equal((await checkLead(lead("a@x.com", "catch_all"), { ...ctx, step: 1 })).ok, true);
});
