import assert from "node:assert/strict";
import test from "node:test";

import {
  allowanceReason, byOrder, claimCapacity, claimCutoff, claimTtlHours, migrateCampaigns, moveTo, nextOrder,
  normalizeCampaign, progressApproximate, progressFrom, renumber, runningFor, targetingOf
} from "../warmup/campaigns.mjs";

/** The environment a deployment has before anybody has saved a thing. */
function withEnv(values, body) {
  const keys = [
    "WARMUP_CRM_SUPABASE_URL", "WARMUP_CRM_SERVICE_ROLE_KEY",
    "WARMUP_CRM_LEADS_FOLDER_ID", "WARMUP_CRM_LEADS_OWNER_ID", "CLAIM_TTL_HOURS"
  ];
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

const SAVED_TARGETING = {
  folderId: "folder-1",
  folderName: "media buyers",
  filters: { country: "Ukraine", position: "media buyer", leadStatus: "new", ownerId: "owner-1" },
  accountIds: ["account-a", "account-b"],
  updatedAt: "2026-09-16T09:00:00.000Z"
};

// ── the migration ─────────────────────────────────────────────────────────

test("a saved targeting becomes one running campaign named after its folder", () => {
  withEnv(CONFIGURED, () => {
    const { campaigns, migrated } = migrateCampaigns(null, SAVED_TARGETING);
    assert.equal(migrated, true);
    assert.equal(campaigns.length, 1);
    const [campaign] = campaigns;
    assert.equal(campaign.name, "media buyers");
    assert.equal(campaign.folderId, "folder-1");
    assert.equal(campaign.state, "running", "a migration that quietly stopped the work is a week of sending nobody notices is missing");
    assert.deepEqual(campaign.filters, SAVED_TARGETING.filters);
    assert.deepEqual(campaign.accountIds, ["account-a", "account-b"]);
    assert.equal(campaign.createdAt, SAVED_TARGETING.updatedAt, "the campaign is as old as the selection it came from");
    assert.ok(campaign.id, "a campaign without an id cannot be edited or deleted");
  });
});

test("the migration reads the old key and never rewrites it", () => {
  withEnv(CONFIGURED, () => {
    const before = JSON.stringify(SAVED_TARGETING);
    migrateCampaigns(null, SAVED_TARGETING);
    assert.equal(JSON.stringify(SAVED_TARGETING), before, "a rollback to Phase 1 has to find its targeting exactly as it left it");
  });
});

test("a list already saved is taken as saved, in order, and migrates nothing", () => {
  withEnv(CONFIGURED, () => {
    const { campaigns, migrated } = migrateCampaigns(
      [{ id: "second", name: "Second", folderId: "f", order: 2 }, { id: "first", name: "First", folderId: "f", order: 1 }],
      SAVED_TARGETING
    );
    assert.equal(migrated, false, "a saved list must not be overwritten by a targeting somebody abandoned");
    assert.deepEqual(campaigns.map((campaign) => campaign.id), ["first", "second"]);
  });
});

test("an empty list is a list, not a missing one", () => {
  withEnv(CONFIGURED, () => {
    // Deleting the last campaign must not bring the migrated one back.
    const { campaigns, migrated } = migrateCampaigns([], SAVED_TARGETING);
    assert.deepEqual(campaigns, []);
    assert.equal(migrated, false);
  });
});

test("nothing saved and nothing pinned is no campaign at all, not an empty one", () => {
  withEnv(CONFIGURED, () => {
    assert.deepEqual(migrateCampaigns(null, null), { campaigns: [], migrated: false });
  });
});

test("a deployment pinned to a folder by environment opens on that folder", () => {
  withEnv({ ...CONFIGURED, WARMUP_CRM_LEADS_FOLDER_ID: "folder-env", WARMUP_CRM_LEADS_OWNER_ID: "owner-env" }, () => {
    const { campaigns } = migrateCampaigns(null, null);
    assert.equal(campaigns.length, 1);
    assert.equal(campaigns[0].folderId, "folder-env");
    assert.equal(campaigns[0].filters.ownerId, "owner-env");
  });
});

// ── the shape ─────────────────────────────────────────────────────────────

test("a campaign is normalized into something the rest of the code can trust", () => {
  const campaign = normalizeCampaign({
    name: "  Media buyers  ",
    folderId: " folder-1 ",
    accountIds: ["a", "a", " b ", ""],
    state: "flying",
    filters: { country: 42 }
  });
  assert.equal(campaign.name, "Media buyers");
  assert.equal(campaign.folderId, "folder-1");
  assert.deepEqual(campaign.accountIds, ["a", "b"], "the same account twice is still one account");
  assert.equal(campaign.state, "draft", "an unknown state is the safe one, not the one that starts sending");
  assert.deepEqual(campaign.filters, { country: "", position: "", leadStatus: "", ownerId: "" });
  assert.equal(campaign.productId, null);
});

test("a campaign hands the folder queries exactly what targeting used to", () => {
  const campaign = normalizeCampaign({ name: "x", folderId: "folder-1", filters: { country: "Ukraine" }, accountIds: ["a"] });
  const targeting = targetingOf(campaign);
  assert.equal(targeting.folderId, "folder-1");
  assert.equal(targeting.filters.country, "Ukraine");
  assert.deepEqual(targeting.accountIds, ["a"]);
});

// ── order ─────────────────────────────────────────────────────────────────

test("a new campaign goes last, and order survives a campaign being deleted", () => {
  const campaigns = [
    normalizeCampaign({ id: "a", name: "A", folderId: "f", order: 0 }),
    normalizeCampaign({ id: "b", name: "B", folderId: "f", order: 3 })
  ];
  assert.equal(nextOrder(campaigns), 4);
  assert.equal(nextOrder([]), 0);
  assert.equal(nextOrder(campaigns.filter((campaign) => campaign.id !== "b")), 1);
});

test("an account's quota is offered to its campaigns in the order a seller put them in", () => {
  const campaigns = [
    normalizeCampaign({ id: "third", name: "Third", folderId: "f", order: 9, state: "running", accountIds: ["a"] }),
    normalizeCampaign({ id: "first", name: "First", folderId: "f", order: 1, state: "running", accountIds: ["a"] }),
    normalizeCampaign({ id: "draft", name: "Draft", folderId: "f", order: 0, state: "draft", accountIds: ["a"] }),
    normalizeCampaign({ id: "paused", name: "Paused", folderId: "f", order: 2, state: "paused", accountIds: ["a"] }),
    normalizeCampaign({ id: "elsewhere", name: "Elsewhere", folderId: "f", order: 3, state: "running", accountIds: ["b"] }),
    normalizeCampaign({ id: "nofolder", name: "No folder", folderId: "", order: 4, state: "running", accountIds: ["a"] })
  ];
  assert.deepEqual(runningFor(campaigns, "a").map((campaign) => campaign.id), ["first", "third"],
    "only running campaigns, only this account's, and the first in order gets the quota");
});

/** Three campaigns, first to third, the way a seller would have made them. */
function three() {
  return [
    normalizeCampaign({ id: "first", name: "Перша", folderId: "f", order: 0, createdAt: "2026-09-16T09:00:00.000Z" }),
    normalizeCampaign({ id: "second", name: "Друга", folderId: "f", order: 1, createdAt: "2026-09-16T10:00:00.000Z" }),
    normalizeCampaign({ id: "third", name: "Третя", folderId: "f", order: 2, createdAt: "2026-09-16T11:00:00.000Z" })
  ];
}

const places = (campaigns) => campaigns.slice().sort(byOrder).map((campaign) => `${campaign.id}#${campaign.order}`);

test("moving the second campaign to the front actually makes it first", () => {
  const moved = moveTo(three(), "second", 0);
  assert.deepEqual(places(moved), ["second#0", "first#1", "third#2"]);
  assert.equal(runningFor(moved.map((campaign) => ({ ...campaign, state: "running", accountIds: ["a"] })), "a")[0].id,
    "second", "the first campaign in order is the one that takes the account's quota — that is what reordering is for");
});

test("writing one campaign's number without moving the rest would have left a tie, and no longer can", () => {
  // The bug this test exists for: order 0 set on the second campaign left two
  // campaigns at 0, and the tie-break by age kept the older one in front — so
  // "put this one first" did not put it first.
  const moved = moveTo(three(), "second", 0);
  const numbers = moved.map((campaign) => campaign.order).sort((left, right) => left - right);
  assert.deepEqual(numbers, [0, 1, 2], "positions must be a dense 0..n-1 with nothing sharing a place");
  assert.equal(new Set(numbers).size, numbers.length);
});

test("a campaign can be moved to the end, and past the end is the end", () => {
  assert.deepEqual(places(moveTo(three(), "first", 2)), ["second#0", "third#1", "first#2"]);
  assert.deepEqual(places(moveTo(three(), "first", 99)), ["second#0", "third#1", "first#2"],
    "a control that overshoots should land, not fail");
  assert.deepEqual(places(moveTo(three(), "third", -5)), ["third#0", "first#1", "second#2"]);
});

test("moving a campaign leaves the others in the order they were in", () => {
  assert.deepEqual(places(moveTo(three(), "third", 1)), ["first#0", "third#1", "second#2"]);
  assert.deepEqual(places(moveTo(three(), "second", 1)), ["first#0", "second#1", "third#2"],
    "moving a campaign to where it already is changes nothing");
});

test("moving a campaign that is not there renumbers the rest rather than throwing", () => {
  assert.deepEqual(places(moveTo(three(), "deleted-a-moment-ago", 0)), ["first#0", "second#1", "third#2"]);
});

test("a gap left by a delete is closed, so the next move lands where it was aimed", () => {
  const afterDelete = three().filter((campaign) => campaign.id !== "second");
  assert.deepEqual(places(renumber(afterDelete)), ["first#0", "third#1"], "0 and 2 would make position 1 mean two things");
  assert.deepEqual(places(renumber([])), []);
});

test("renumbering sorts by order first, and only then by age", () => {
  const scrambled = [
    normalizeCampaign({ id: "late", name: "Late", folderId: "f", order: 5, createdAt: "2026-09-16T09:00:00.000Z" }),
    normalizeCampaign({ id: "early", name: "Early", folderId: "f", order: 1, createdAt: "2026-09-16T11:00:00.000Z" })
  ];
  assert.deepEqual(places(renumber(scrambled)), ["early#0", "late#1"]);
});

test("two campaigns saved in the same instant still have a fixed order", () => {
  const same = { order: 0, createdAt: "2026-09-16T09:00:00.000Z" };
  const older = normalizeCampaign({ id: "older", name: "Older", folderId: "f", ...same });
  const newer = normalizeCampaign({ id: "newer", name: "Newer", folderId: "f", order: 0, createdAt: "2026-09-16T10:00:00.000Z" });
  assert.ok(byOrder(older, newer) < 0, "a tie on order is broken by age, not by whatever the array happened to hold");
});

// ── claiming ──────────────────────────────────────────────────────────────

test("claiming is capped by what is left of today, and what is already queued counts", () => {
  assert.equal(claimCapacity({ quota: 6, spent: 0, queued: 0 }), 6);
  assert.equal(claimCapacity({ quota: 6, spent: 2, queued: 0 }), 4, "what was already sent today is gone");
  assert.equal(claimCapacity({ quota: 6, spent: 2, queued: 3 }), 1, "a claim is an allocation, and it counts against the day");
  assert.equal(claimCapacity({ quota: 6, spent: 0, queued: 6 }), 0, "clicking claim twice must not allocate twelve to an account that can send six");
  assert.equal(claimCapacity({ quota: 6, spent: 5, queued: 5 }), 0, "never below zero, whatever the counters say");
  assert.equal(claimCapacity({ quota: 6, spent: 0, queued: 0, limit: 2 }), 2, "an explicit limit narrows, it never widens");
  assert.equal(claimCapacity({ quota: 2, spent: 0, queued: 0, limit: 50 }), 2, "a limit cannot talk the warm-up into more than its day");
  assert.equal(claimCapacity({ quota: 0, spent: 0, queued: 0 }), 0, "no quota today is no claim today");
});

test("every way of having nothing to claim says which it is, in words", () => {
  assert.equal(
    allowanceReason({ day: 2, totalDays: 14, quota: 0, spent: 0, queued: 0, startsDay: 4 }),
    "Day 2 of 14 — connection requests start on day 4",
    "the ordinary state of every new account for three days, and it must not read as a fault"
  );
  assert.equal(
    allowanceReason({ day: 2, totalDays: 14, quota: 0, spent: 0, queued: 0, startsDay: null }),
    "Day 2 of 14 — no connection requests are planned for today"
  );
  assert.equal(
    allowanceReason({ day: 11, totalDays: 14, quota: 5, spent: 5, queued: 0 }),
    "Day 11 of 14 — today's 5 connection requests are already spent"
  );
  assert.equal(
    allowanceReason({ day: 11, totalDays: 14, quota: 5, spent: 0, queued: 5 }),
    "5 already claimed and today allows 5 — work through the queue first"
  );
  assert.equal(
    allowanceReason({ day: 15, totalDays: 14, quota: 0, spent: 0, queued: 0, startsDay: null }),
    "The warm-up is finished — day 15 of 14"
  );
  assert.equal(
    allowanceReason({ day: 11, totalDays: 14, quota: 5, spent: 1, queued: 1 }), null,
    "room left is no reason at all — the panel shows the list instead"
  );
});

// ── the claim's lifetime ──────────────────────────────────────────────────

test("a claim is let go after twenty hours: longer than a session, shorter than a day", () => {
  withEnv(CONFIGURED, () => {
    assert.equal(claimTtlHours(), 20);
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    assert.equal(claimCutoff(now), "2026-09-15T16:00:00.000Z");
  });
});

test("a nonsense TTL falls back to twenty hours rather than releasing everything", () => {
  for (const value of ["0", "-5", "not a number", ""]) {
    withEnv({ ...CONFIGURED, CLAIM_TTL_HOURS: value }, () => {
      assert.equal(claimTtlHours(), 20, `CLAIM_TTL_HOURS=${JSON.stringify(value)} must not mean "release on sight"`);
    });
  }
  withEnv({ ...CONFIGURED, CLAIM_TTL_HOURS: "4" }, () => assert.equal(claimTtlHours(), 4));
});

// ── progress ──────────────────────────────────────────────────────────────

test("progress separates what is claimed from what was sent and what came back", () => {
  const rows = [
    { status: "queued", created_at: "2026-09-16T08:00:00Z" },
    { status: "queued", created_at: "2026-09-15T08:00:00Z" },
    { status: "pending", created_at: "2026-09-16T09:00:00Z" },
    { status: "connected", created_at: "2026-09-14T09:00:00Z" },
    { status: "declined", created_at: "2026-09-13T09:00:00Z" },
    { status: "withdrawn", created_at: "2026-09-12T09:00:00Z" }
  ];
  const progress = progressFrom(rows, { todayIso: "2026-09-16", sentToday: 3 });
  assert.equal(progress.queued, 2);
  assert.equal(progress.sent, 4, "pending and everything beyond it was sent");
  assert.equal(progress.replied, 1, "only connected is an answer");
  assert.equal(progress.claimedToday, 1, "yesterday's claim is not today's work");
  assert.equal(progress.sentToday, 3, "taken from the day counter, because a row claimed yesterday and sent today carries yesterday's stamp");
});

test("two campaigns on the same folder sharing an account count each other's work, and say so", () => {
  const one = normalizeCampaign({ id: "one", name: "One", folderId: "f1", accountIds: ["a", "b"] });
  const twin = normalizeCampaign({ id: "twin", name: "Twin", folderId: "f1", accountIds: ["b"] });
  const elsewhere = normalizeCampaign({ id: "far", name: "Far", folderId: "f2", accountIds: ["a", "b"] });
  const alone = normalizeCampaign({ id: "alone", name: "Alone", folderId: "f1", accountIds: ["c"] });

  const all = [one, twin, elsewhere, alone];
  assert.equal(progressApproximate(one, all), true);
  assert.equal(progressApproximate(twin, all), true);
  assert.equal(progressApproximate(elsewhere, all), false, "the same accounts on a different folder never see each other's rows");
  assert.equal(progressApproximate(alone, all), false, "the same folder with different accounts is not a double count");
  assert.equal(progressApproximate(one, [one]), false, "a campaign does not over-count against itself");
});
