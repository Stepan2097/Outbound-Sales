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

test("Марко 22.10 (таск a0c0820f): «Пропустити» на 3 дні знімає обов'язковість, потім картка нагадує; «Створити» повертає до людини", async () => {
  const { CAMPAIGN_SKIP_DAYS, campaignSkippedUntil, setCampaignSkipStore, skipCampaign } = await import("../triage/lead-campaigns.mjs");
  let saved = { expired: "2026-10-20T00:00:00.000Z", ancient: "2026-06-01T00:00:00.000Z" };
  setCampaignSkipStore({ read: () => saved, write: async (value) => { saved = value; } });
  const { until } = await skipCampaign({ contactId: "c7", now: new Date("2026-10-22T10:00:00Z") });
  assert.equal(CAMPAIGN_SKIP_DAYS, 3);
  assert.equal(until, "2026-10-25T10:00:00.000Z");
  assert.equal(campaignSkippedUntil("c7"), until);
  // Суддя 22.10: пропуск іншого контакта не стирає минулий пропуск цього — інакше зникло б «Нагадування».
  assert.equal(campaignSkippedUntil("expired"), "2026-10-20T00:00:00.000Z");
  assert.deepEqual(Object.keys(saved).sort(), ["c7", "expired"], "прибираються лише ті, що минули понад 90 днів тому");
  assert.match(today, /&& !skipActive\(detail\.campaignSkippedUntil\)\);/, "діючий пропуск знімає обов'язковість");
  assert.match(today, /Нагадування: кампанію пропускали до/);
  assert.match(today, /act\("campaign-create"\)/);
  assert.match(today, /act\("campaign-skip"\)/);
  const form = readFileSync(new URL("../app/screens/lead-campaigns.js", import.meta.url), "utf8");
  assert.match(form, /export function createCampaignFor\(\{ name, contactId, back \}\)/);
  assert.match(form, /api\("\/api\/lead-campaigns\/assign", \{ method: "POST", body: JSON\.stringify\(\{ contactId: returnTo\.contactId, campaignId: saved\.campaign\.id \}\) \}\)/);
  assert.match(form, /if \(returnTo\) goBack\(null\);\n    renderLeadCampaigns\(\);/, "«Скасувати» теж повертає — раніше, ніж перемальовується список");
});
