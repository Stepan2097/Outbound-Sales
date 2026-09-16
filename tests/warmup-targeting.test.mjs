import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_STRATEGY } from "../warmup/strategy.mjs";
import { queueQuery } from "../warmup/db.mjs";
import {
  DEFAULT_LEAD_STATUS, buildForecast, describeTargeting, normalizeFilters, normalizeTargeting, peakConnect
} from "../warmup/targeting.mjs";

/** The environment an installation that never got past the pinned folder has. */
function withEnv(values, body) {
  const keys = ["WARMUP_CRM_SUPABASE_URL", "WARMUP_CRM_SERVICE_ROLE_KEY", "WARMUP_CRM_LEADS_FOLDER_ID", "WARMUP_CRM_LEADS_OWNER_ID"];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    body();
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

const CONFIGURED = {
  WARMUP_CRM_SUPABASE_URL: "https://crm.example.co",
  WARMUP_CRM_SERVICE_ROLE_KEY: "service-role-key"
};

test("a folder of twenty-two thousand reads as a thousand days, not as a folder you can run", () => {
  const forecast = buildForecast({ matching: 22088, alreadyApproached: 88, perDayNow: 11, perDayAtPeak: 22, accountsChosen: 4 });
  assert.equal(forecast.remaining, 22000);
  assert.equal(forecast.daysToFinish, 1000);
  assert.equal(forecast.reachedThisMonth, 660, "a month at peak is 30 days of peak, and no more");
  assert.equal(forecast.perDayNow, 11, "today is its own number: half the accounts are not warm yet");
});

test("a month cannot reach more people than are left", () => {
  const forecast = buildForecast({ matching: 40, alreadyApproached: 15, perDayNow: 22, perDayAtPeak: 22, accountsChosen: 4 });
  assert.equal(forecast.remaining, 25);
  assert.equal(forecast.reachedThisMonth, 25, "finishing early is not a bigger month");
  assert.equal(forecast.daysToFinish, 2, "a part day is still a day of work");
});

test("no account chosen is no forecast of days, not a forecast of infinity", () => {
  const forecast = buildForecast({ matching: 500, alreadyApproached: 0, perDayNow: 0, perDayAtPeak: 0, accountsChosen: 0 });
  assert.equal(forecast.daysToFinish, null);
  assert.equal(forecast.reachedThisMonth, 0);
  assert.equal(forecast.remaining, 500);
});

test("more people approached than the filters now match leaves nothing remaining, not less than nothing", () => {
  // Narrowing the filters after a month of work is exactly how this happens.
  const forecast = buildForecast({ matching: 10, alreadyApproached: 40, perDayNow: 6, perDayAtPeak: 6, accountsChosen: 1 });
  assert.equal(forecast.remaining, 0);
  assert.equal(forecast.daysToFinish, 0);
  assert.equal(forecast.reachedThisMonth, 0);
});

test("an account's peak is the most it will ever be dealt in a day, not the top of the range", () => {
  for (let index = 0; index < 20; index += 1) {
    const peak = peakConnect(DEFAULT_STRATEGY, `account-${index}`);
    assert.ok(peak >= 5 && peak <= 6, `drew ${peak}, outside the strategy's own 5–6 ceiling`);
  }
  assert.equal(
    peakConnect(DEFAULT_STRATEGY, "account-a"),
    peakConnect(DEFAULT_STRATEGY, "account-a"),
    "a figure that moved on refresh would leave nobody knowing the ceiling"
  );
});

test("a strategy that never allows a request has a peak of zero, which is not a ceiling of unlimited", () => {
  const lookOnly = { phases: [{ fromDay: 1, toDay: 14, quotas: { profile_view: [3, 5] } }] };
  assert.equal(peakConnect(lookOnly, "account-a"), 0);
  assert.equal(buildForecast({ matching: 100, alreadyApproached: 0, perDayNow: 0, perDayAtPeak: 0, accountsChosen: 2 }).daysToFinish, null);
});

test("nothing saved falls back to the folder the deployment was pinned to", () => {
  withEnv({ ...CONFIGURED, WARMUP_CRM_LEADS_FOLDER_ID: "folder-1", WARMUP_CRM_LEADS_OWNER_ID: "owner-1" }, () => {
    const targeting = normalizeTargeting(null);
    assert.equal(targeting.folderId, "folder-1");
    assert.equal(targeting.filters.ownerId, "owner-1");
    assert.equal(targeting.filters.leadStatus, DEFAULT_LEAD_STATUS);
    assert.deepEqual(targeting.accountIds, []);
    assert.equal(targeting.updatedAt, null);
  });
});

test("nothing saved and nothing pinned is a folder of null, which the panel can ask about", () => {
  withEnv(CONFIGURED, () => {
    assert.equal(describeTargeting(normalizeTargeting(null)).folderId, null);
    assert.equal(describeTargeting(normalizeTargeting(null)).folderName, null);
  });
});

test("a saved selection stands as it was saved, environment or no environment", () => {
  withEnv({ ...CONFIGURED, WARMUP_CRM_LEADS_FOLDER_ID: "folder-1", WARMUP_CRM_LEADS_OWNER_ID: "owner-1" }, () => {
    const targeting = normalizeTargeting({
      folderId: "folder-2",
      folderName: "media buyers",
      // Cleared on purpose: an empty box is "every status", and snapping it
      // back to "new" would quietly answer a question nobody asked.
      filters: { country: " Ukraine ", position: "", leadStatus: "", ownerId: "" },
      accountIds: ["a", "a", " b ", ""],
      updatedAt: "2026-09-16T09:00:00.000Z"
    });
    assert.equal(targeting.folderId, "folder-2");
    assert.equal(targeting.filters.country, "Ukraine");
    assert.equal(targeting.filters.leadStatus, "");
    assert.equal(targeting.filters.ownerId, "");
    assert.deepEqual(targeting.accountIds, ["a", "b"], "the same account twice is still one account");
  });
});

test("the four filters are always four strings, whatever arrived", () => {
  assert.deepEqual(normalizeFilters(), { country: "", position: "", leadStatus: "", ownerId: "" });
  assert.deepEqual(normalizeFilters({ country: 42, position: null, leadStatus: ["new"], ownerId: undefined }),
    { country: "", position: "", leadStatus: "", ownerId: "" });
});

test("a blank filter narrows nothing and a position filter is a contains", () => {
  const params = (filters) => queueQuery("id", { folderId: "folder-1", filters: normalizeFilters(filters) }).params.toString();

  assert.equal(params({}), "select=id&folder_id=eq.folder-1", "an empty box must not become a filter for the empty string");
  // Values go through unquoted and a space arrives as `+`, which is what
  // PostgREST reads it as — quoting the value is what breaks the match.
  assert.equal(
    params({ country: "United States", position: "head of growth", leadStatus: "new", ownerId: "owner-1" }),
    "select=id&folder_id=eq.folder-1&lead_status=eq.new&owner_id=eq.owner-1&country=ilike.United+States&position=ilike.*head+of+growth*"
  );
});
