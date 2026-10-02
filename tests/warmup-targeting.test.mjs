import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_STRATEGY, dailyQuota } from "../warmup/strategy.mjs";
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

test("an account's forecast respects both working-mode rate and the weekly ceiling", () => {
  // The warm-up's own peak is 5–6 a day and lasts four days; working mode is
  // 10–15 a day and lasts the rest of the account's life. The forecast used to
  // be the first, which made every "days to finish" twice what it will be.
  for (let index = 0; index < 20; index += 1) {
    const peak = peakConnect(DEFAULT_STRATEGY, `account-${index}`);
    assert.equal(peak, 8, "a sustained rate is bounded by 60 requests in 7 days");

    // An ordinary day, not the lucky one: the month's draws averaged and rounded down.
    let sum = 0;
    for (let day = 15; day < 45; day += 1) sum += dailyQuota(DEFAULT_STRATEGY, `account-${index}`, day, "connect");
    assert.equal(peak, Math.min(Math.floor(sum / 30), Math.floor(60 / 7)));
  }
  assert.equal(
    peakConnect(DEFAULT_STRATEGY, "account-a"),
    peakConnect(DEFAULT_STRATEGY, "account-a"),
    "a figure that moved on refresh would leave nobody knowing the pace"
  );

  // A run frozen before working mode existed forecasts the same pace: it gets
  // the working mode in code, and so does its forecast.
  const legacy = { phases: DEFAULT_STRATEGY.phases };
  assert.equal(peakConnect(legacy, "account-a"), peakConnect(DEFAULT_STRATEGY, "account-a"));
});

test("a strategy that never allows a request has a peak of zero, which is not a ceiling of unlimited", () => {
  // Its own working mode, without requests: with none at all it would fall
  // back to the one in code, which sends.
  const lookOnly = {
    phases: [{ fromDay: 1, toDay: 14, quotas: { profile_view: [3, 5] } }],
    workingMode: { quotas: { profile_view: [3, 5] } }
  };
  assert.equal(peakConnect(lookOnly, "account-a"), 0);
  assert.equal(peakConnect({ phases: [] }, "account-a"), 0, "and no phases at all is no strategy");
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

  // The profile link is always there: it is not one of the four boxes, it is
  // what a LinkedIn queue is made of — a contact with none is nowhere the agent
  // can click Connect.
  const profileLink = "linkedin=ilike.*linkedin.com%2Fin%2F*";
  assert.equal(params({}), `select=id&folder_id=eq.folder-1&${profileLink}`, "an empty box must not become a filter for the empty string");
  // Values go through unquoted and a space arrives as `+`, which is what
  // PostgREST reads it as — quoting the value is what breaks the match.
  assert.equal(
    params({ country: "United States", position: "head of growth", leadStatus: "new", ownerId: "owner-1" }),
    `select=id&folder_id=eq.folder-1&${profileLink}&lead_status=eq.new&owner_id=eq.owner-1&country=ilike.United+States&position=ilike.*head+of+growth*`
  );
});
