import assert from "node:assert/strict";
import test from "node:test";

import {
  autoFeedFor, autoFeedLine, campaignStateNote, inviteAttentionText, queueAfterFailedClaim, queueAnswerIsCurrent
} from "../app/warmup-view.js";
import { loadMain } from "./app-main-excerpt.mjs";

/**
 * The places in `app/main.js` that call the warm-up screens' decisions.
 *
 * `tests/warmup-view.test.mjs` holds the decisions themselves to their word;
 * this holds `main.js` to using them. Each call site here was once the bug:
 * the queue card said what another campaign was doing, a slow answer for the
 * campaign somebody clicked away from landed on the new one, «Редагувати» on
 * another campaign left the queue and the pool loaded for the old one, a failed
 * claim wiped the card, and the campaign's note promised the campaign's first
 * day rather than each account's. Put any of them back and a test here fails.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

// ── the queue card ──────────────────────────────────────────────────────────

const CARD = [
  "uaPlural", "escapeHtml", "escapeAttr", "WARMUP_DEFAULT_FROM_DAY", "warmupCount", "warmupLeadLink",
  "warmupQueueState", "warmupQueueRowHtml", "warmupAutoFeedHtml", "warmupQueueWaitingHtml", "warmupQueueAccountHtml"
];

test("the queue card says what the campaign on screen is doing, and nothing about another that ticks the account", () => {
  const feedA = { campaignId: "camp-a", running: true, ticked: true, on: true, day: 9, connectsLeft: 3 };
  const warmupState = {
    profiles: [{ account: { id: "acc-1" }, name: "Chloe Stewart", day: 9, connections: { quota: 4, today: 1 } }],
    // The cache is keyed by account: this is what campaign A's queue answer left.
    queues: { "acc-1": { rows: [], reason: "", waiting: [], autoFeed: feedA, error: "", unavailable: "" } },
    queueBusy: {}
  };
  const card = loadMain(CARD, { warmupState, autoFeedFor, autoFeedLine, inviteAttentionText });
  const html = card.get("warmupQueueAccountHtml");

  const underA = html("acc-1", "camp-a");
  assert.match(underA, /warmup-queue-feed/);
  assert.ok(underA.includes(card.get("escapeHtml")(autoFeedLine(feedA, 7).text)));

  const underB = html("acc-1", "camp-b");
  assert.doesNotMatch(underB, /warmup-queue-feed/, "«Черга · B» must not say what A is doing");
});

// ── loading a queue ─────────────────────────────────────────────────────────

function queueLoader(selectedCampaignId) {
  const asked = [];
  const answers = [];
  const warmupState = { selectedCampaignId, queues: {} };
  const loader = loadMain(["loadWarmupQueue"], {
    warmupState,
    queueAnswerIsCurrent,
    warmupApi: (path) => {
      asked.push(path);
      const answer = deferred();
      answers.push(answer);
      return answer.promise;
    }
  });
  return { warmupState, asked, answers, load: loader.get("loadWarmupQueue") };
}

test("a queue answer lands when it is for the campaign still on screen", async () => {
  const { warmupState, asked, answers, load } = queueLoader("camp-a");
  const loading = load("acc-1");
  assert.deepEqual(asked, ["/queue?accountId=acc-1&campaignId=camp-a"]);
  answers[0].resolve({ queue: [], waiting: [{ outreachId: "o-1" }], autoFeed: { campaignId: "camp-a" } });
  await loading;
  assert.deepEqual(warmupState.queues["acc-1"].waiting, [{ outreachId: "o-1" }]);
  assert.equal(warmupState.queues["acc-1"].autoFeed.campaignId, "camp-a");
});

test("a queue answer for a campaign somebody clicked away from does not land on the new one", async () => {
  const { warmupState, answers, load } = queueLoader("camp-a");
  const late = load("acc-1");
  // Campaign B is picked, and its answer is already on screen.
  warmupState.selectedCampaignId = "camp-b";
  const shownForB = { rows: [], waiting: [{ outreachId: "o-b" }], autoFeed: { campaignId: "camp-b" } };
  warmupState.queues["acc-1"] = shownForB;

  answers[0].resolve({ queue: [], waiting: [{ outreachId: "o-a" }], autoFeed: { campaignId: "camp-a" } });
  await late;
  assert.equal(warmupState.queues["acc-1"], shownForB, "A's answer arrived late and was dropped");

  // A failure that arrives late is dropped the same way.
  warmupState.selectedCampaignId = "camp-a";
  const failing = load("acc-1");
  warmupState.selectedCampaignId = "camp-b";
  answers[1].reject(Object.assign(new Error("Paused until 2026-09-27"), { status: 409 }));
  await failing;
  assert.equal(warmupState.queues["acc-1"], shownForB);
});

// ── «Редагувати» on another campaign ────────────────────────────────────────

test("opening the form on another campaign reloads the queue and the pool for it; on the same one it does not", async () => {
  const loads = [];
  const warmupState = { selectedCampaignId: "camp-a", formOpen: false, formCampaignId: null, campaignNotice: "" };
  const form = loadMain(["openWarmupCampaignForm"], {
    warmupState,
    document: { getElementById: () => null },
    renderWarmupCampaigns: () => {},
    renderWarmupProfiles: () => {},
    renderWarmupQueue: () => {},
    loadWarmupQueues: async () => { loads.push(`queues:${warmupState.selectedCampaignId}`); },
    loadWarmupLeads: async () => { loads.push(`leads:${warmupState.selectedCampaignId}`); }
  });
  const open = form.get("openWarmupCampaignForm");

  open("camp-b");
  await settle();
  assert.equal(warmupState.selectedCampaignId, "camp-b");
  assert.deepEqual(loads.sort(), ["leads:camp-b", "queues:camp-b"]);

  open("camp-b");
  open(null);
  await settle();
  assert.equal(loads.length, 2, "nothing moved, so nothing is read again");
});

// ── «Закріпити зараз» ────────────────────────────────────────────────────────

test("a claim that fails keeps the card's auto-feed line and who is waiting", async () => {
  const existing = {
    rows: [{ outreachId: "o-1" }],
    reason: "",
    waiting: [{ outreachId: "o-2", fromFolder: true }],
    autoFeed: { campaignId: "camp-a", running: true, ticked: true, on: false, blocked: "Paused until 2026-09-27" },
    error: "",
    unavailable: ""
  };
  const warmupState = { queues: { "acc-1": existing }, queueBusy: {} };
  const claim = loadMain(["claimWarmupQueue"], {
    warmupState,
    queueAfterFailedClaim,
    renderWarmupQueue: () => {},
    loadWarmupCampaigns: async () => {},
    warmupApi: async () => { throw Object.assign(new Error("Paused until 2026-09-27"), { status: 409 }); }
  });

  await claim.get("claimWarmupQueue")("acc-1");
  const after = warmupState.queues["acc-1"];
  assert.equal(after.error, "Paused until 2026-09-27");
  assert.deepEqual(after.autoFeed, existing.autoFeed, "the line that explains the refusal stays");
  assert.deepEqual(after.waiting, existing.waiting);
  assert.deepEqual(after.rows, existing.rows);
  assert.equal(warmupState.queueBusy["acc-1"], false);
});

// ── the campaign's note ─────────────────────────────────────────────────────

test("the campaign detail shows the state note only when there is one to say", () => {
  const render = (campaign) => {
    const host = { innerHTML: "" };
    const warmupState = { campaigns: [campaign], campaignsReady: true, selectedCampaignId: campaign.id, formOpen: false, campaignNotice: "" };
    const detail = loadMain(["escapeHtml", "WARMUP_DEFAULT_FROM_DAY", "renderWarmupCampaignDetail"], {
      warmupState,
      campaignStateNote,
      document: { getElementById: (id) => (id === "warmupCampaignDetail" ? host : null) },
      warmupSelectedCampaign: () => campaign,
      warmupFormDirty: () => false,
      warmupForecastHtml: () => ({ tone: "", html: "" }),
      warmupTickedAccountsLine: () => "",
      refreshIcons: () => {}
    });
    detail.get("renderWarmupCampaignDetail")();
    return host.innerHTML;
  };

  const draft = render({ id: "camp-a", name: "A", state: "draft", fromDay: 9, accountIds: [] });
  assert.ok(draft.includes(campaignStateNote({ state: "draft" })), draft);
  const running = render({ id: "camp-b", name: "B", state: "running", fromDay: 9, accountIds: [] });
  assert.ok(!running.includes("warmup-campaign-state-note"), "a running campaign's pill says it all");
});

