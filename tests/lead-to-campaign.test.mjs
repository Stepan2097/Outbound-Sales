import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assignToCampaign, setLeadCampaignStore } from "../triage/lead-campaigns.mjs";

/**
 * Лід з LinkedIn без кампанії (Марко 20.10, таск 207ffbc1, варіант К1): перед відповіддю його
 * обов'язково відносять до кампанії (людина додається в папку CRM кампанії) або «Не лід».
 */

const today = readFileSync(new URL("../app/screens/today.js", import.meta.url), "utf8");
const api = readFileSync(new URL("../triage/today.mjs", import.meta.url), "utf8");

test("«Надіслати» недоступне, доки лід без кампанії; кампанії на паузі теж у списку", () => {
  assert.match(today, /function canSend\(\) \{\n  return !today\.sending && Boolean\(today\.text\.trim\(\)\) && !needsCampaign\(\);/);
  assert.match(today, /\$\{canSend\(\) \? "" : "disabled"\}/);
  assert.match(today, /sendButton\.disabled = !canSend\(\)/);
  assert.match(today, /entry\.state === "paused" \? " \(на паузі\)" : ""/);
  assert.match(api, /campaignAny: item\.campaign \|\| \(contactId \? await anyCampaignOf\(contactId\)/);
});

test("після вибору — людина в кампанії, звірка й нова чернетка; «Не лід» — статус «Не ICP»", () => {
  assert.match(today, /api\("\/api\/lead-campaigns\/assign", \{ method: "POST"/);
  assert.match(today, /await api\("\/api\/today\/refresh"/);
  assert.match(today, /void writeDraft\(true\);/);
  assert.match(today, /status: "not_icp", exitReason: today\.data\?\.defaultExit\?\.not_icp \|\| "not_icp"/);
});

test("віднести можна лише до наявної кампанії з папкою", async () => {
  setLeadCampaignStore({ read: () => [{ id: "c1", name: "Без папки", folderIds: [] }], write: async () => {} });
  await assert.rejects(assignToCampaign({ contactId: "1", campaignId: "nope" }), /Цієї кампанії вже немає/);
  await assert.rejects(assignToCampaign({ contactId: "1", campaignId: "c1" }), /немає папки CRM/);
});
