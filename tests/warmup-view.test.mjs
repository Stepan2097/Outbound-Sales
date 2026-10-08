import assert from "node:assert/strict";
import test from "node:test";

import {
  autoFeedFor, autoFeedLine, campaignFeedStart, campaignStateNote, inviteAttentionText, queueAnswerIsCurrent
} from "../app/warmup-view.js";

/**
 * The warm-up screens' decisions, without a browser.
 *
 * Each of these was a bug on screen: a card under one campaign saying what
 * another was doing, and a queue answer for a campaign somebody had already
 * clicked away from landing on the new one.
 */

test("a card shows the auto-feed of the campaign on screen, and nothing about another", () => {
  const queue = { rows: [], autoFeed: { campaignId: "camp-a", running: false, fromDay: 7 } };
  assert.equal(autoFeedFor(queue, "camp-a"), queue.autoFeed);
  // Campaign B ticks the same account; the cache still holds A's answer.
  assert.equal(autoFeedFor(queue, "camp-b"), null, "«Черга · B» must not say what A is doing");
  assert.equal(autoFeedFor(queue, ""), null);
  assert.equal(autoFeedFor(null, "camp-a"), null);
  assert.equal(autoFeedFor({ rows: [] }, "camp-a"), null);
});

test("a queue answer for a campaign somebody clicked away from is dropped", () => {
  assert.equal(queueAnswerIsCurrent("camp-a", "camp-a"), true);
  assert.equal(queueAnswerIsCurrent("camp-a", "camp-b"), false);
  assert.equal(queueAnswerIsCurrent("", null), true, "nothing selected then and now is the same nothing");
});

test("a parked invitation says it needs a person, and what to do", () => {
  const parked = inviteAttentionText({ status: "waiting", parked: true });
  assert.match(parked, /^Потребує уваги.*перекинь на інший акаунт або скасуй/);
  // Parked on the first block page, so it must not say it took two.
  assert.doesNotMatch(parked, /двічі/);
  assert.equal(inviteAttentionText({ status: "waiting", parked: false }), "");
  assert.equal(inviteAttentionText({ status: "pending", parked: true }), "", "a sent request needs nobody");
  assert.equal(inviteAttentionText(null), "");
});

test("the campaign row says the folder feeds from the account's warm-up day, not the campaign's", () => {
  // «з 7-го дня» alone read as the campaign's first day: launched on day-2
  // accounts, it queued nobody for five days and looked broken.
  assert.equal(campaignFeedStart({ state: "running", fromDay: 9 }, 7).text, "автопідбір з 9-го дня прогріву");
  assert.equal(campaignFeedStart({ state: "running" }, 7).text, "автопідбір з 7-го дня прогріву", "the default day when none is saved");
  assert.match(campaignFeedStart({ state: "paused", fromDay: 4 }, 7).text, /з 4-го дня прогріву, після запуску/);
  assert.match(campaignFeedStart({ state: "draft" }, 7).text, /після запуску/);
  assert.equal(campaignFeedStart({ state: "done", fromDay: 7 }, 7), null, "a finished campaign promises nothing");
});

test("only a draft gets a note beyond its pill", () => {
  assert.match(campaignStateNote({ state: "draft" }), /запусти/);
  for (const state of ["running", "paused", "done", "archived"]) assert.equal(campaignStateNote({ state }), "");
});

test("a campaign ranked below another on the account is not said to be working its folder", () => {
  const feed = { campaignId: "camp-b", running: true, ticked: true, blocked: null, on: true, day: 9, fromDay: 7, connectsLeft: 3 };

  const alone = autoFeedLine({ ...feed, ahead: [] }, 7);
  assert.equal(alone.tone, "is-live");
  assert.equal(alone.text, "Автопідбір: ще 3 сьогодні");

  const behind = autoFeedLine({ ...feed, ahead: [{ id: "camp-a", name: "Команда" }] }, 7);
  assert.equal(behind.tone, "is-muted");
  assert.doesNotMatch(behind.text, /ще \d+ сьогодні/, "a folder that never moves is not said to be working");
  assert.equal(behind.text, "Спершу бере кампанія «Команда»");
  const two = autoFeedLine({ ...feed, ahead: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, 7);
  assert.equal(two.text, "Спершу бере кампанії «A», «B»");

  // A server from before `ahead` reads as nobody ahead.
  assert.equal(autoFeedLine(feed, 7).tone, "is-live");
  assert.equal(autoFeedLine({ ...feed, on: false, day: 5 }, 7).text, "Автопідбір з 7-го дня (зараз 5-й)");
  assert.equal(autoFeedLine({ ...feed, running: false }, 7).text, "Кампанія не запущена");
  assert.equal(autoFeedLine({ ...feed, ticked: false }, 7).text, "Акаунт не в кампанії");
  assert.equal(autoFeedLine(null, 7), null);
});
