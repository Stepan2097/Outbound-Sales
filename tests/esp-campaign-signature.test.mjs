import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleEspApi } from "../esp/api.mjs";
import { useJournal } from "../esp/journal.mjs";
import { addDomain, addSender } from "../esp/registry.mjs";

/**
 * ab0fdf9c, round 2: the preview of a Stelemind campaign is signed Stelemind
 * whatever the workspace says, and a campaign signature left without a name —
 * as its form allows — signs with the mailbox's name instead of failing.
 */

test("ab0fdf9c: preview of a campaign with its own signature and no name — the mailbox's name, the campaign's company, no ADvantage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "esp-sig-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "trafboost.com" }, "test");
  await addSender({ email: "elena@trafboost.com", displayName: "Elena Weber", rampStage: 5 }, "test");

  const campaigns = [{ id: "stelemind", name: "Stelemind", signature: { name: "", company: "Stelemind", site: "stelemind.com" } }, { id: "ops", name: "Оператори" }];
  const esp = {
    signature: { read: () => ({ name: "Pavlo", title: "Partnerships", company: "ADvantage", site: "advantage.agency" }) },
    campaigns: { find: (id) => campaigns.find((row) => row.id === id) || null },
    templates: { get: () => null },
    unsubscribe: { secret: "test-unsubscribe-secret-0123456789" }
  };
  const preview = async (campaignId) => {
    let answer = null;
    await handleEspApi({
      request: { method: "POST", auth: { profile: { role: "admin", email: "a@b.c" } } }, response: {}, url: new URL("http://x/api/esp/preview"),
      sendJson: (_r, status, payload) => { answer = { status, payload }; },
      readJson: async () => ({ subject: "A question", body: "Hi {{first_name}}, a question.", lead: { email: "jo@agency.co.uk", name: "Jo Smith", company: "Agency" }, mailbox: "elena@trafboost.com", campaignId }),
      esp
    });
    return answer;
  };
  const own = await preview("stelemind");
  assert.equal(own.payload.ok, true, own.payload.error);
  const ownText = JSON.stringify(own.payload);
  assert.match(ownText, /Elena Weber\\nStelemind\\nstelemind\.com/);
  assert.doesNotMatch(ownText, /ADvantage|advantage\.agency|Partnerships/);
  const ops = await preview("ops");
  assert.match(JSON.stringify(ops.payload), /Pavlo\\nPartnerships\\nADvantage\\nadvantage\.agency/, "a campaign without its own signature — the workspace's, as before");
});
