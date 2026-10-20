import assert from "node:assert/strict";
import test from "node:test";

import { handleLeadCampaignApi, leadCampaigns, normalizeLeadCampaign, pickCampaign, setLeadCampaignStore } from "../triage/lead-campaigns.mjs";

// Кампанії лідгенів (WorkSpace, «варіант А» Марка, 16.10): папки CRM + продукт + сценарій;
// з прогрівом (автозапити в друзі) не пов'язані.

test("людина в першій живій кампанії за порядком, у чиїй папці вона є; пауза не рахується", () => {
  const campaigns = [
    normalizeLeadCampaign({ id: "a", folderIds: ["f1"], state: "paused", order: 0 }),
    normalizeLeadCampaign({ id: "b", folderIds: ["f2", "f1"], order: 1 }),
    normalizeLeadCampaign({ id: "c", folderIds: ["f1"], order: 2 })
  ];
  assert.equal(pickCampaign(["f1"], campaigns)?.id, "b");
  assert.equal(pickCampaign(["f9"], campaigns), null);
});

test("кампанія не має полів прогріву: акаунтів, дня прогріву, межі людей", () => {
  const campaign = normalizeLeadCampaign({ name: "X", folderIds: ["f1"], accountIds: ["acc"], fromDay: 7, maxPeople: 200 });
  for (const field of ["accountIds", "fromDay", "maxPeople"]) assert.equal(field in campaign, false, field);
  assert.deepEqual(campaign.silentSteps, [2, 3, 5, 7], "п'ять повідомлень тому, хто мовчить: через 2, 3, 5 і 7 робочих днів (власник 20.10)");
});

test("API: створити, змінити, поставити на паузу, видалити; без папки чи з чужим продуктом — 400", async () => {
  let saved = [];
  setLeadCampaignStore({ read: () => saved, write: async (value) => { saved = value; } });
  const call = async (method, body, query = "") => {
    let answer;
    await handleLeadCampaignApi({
      request: { method }, response: {}, url: new URL(`http://x/api/lead-campaigns${query}`),
      readJson: async () => body, products: () => [{ id: "fb-training" }],
      sendJson: (_, status, payload) => { answer = { status, payload }; }
    });
    return answer;
  };
  assert.equal((await call("POST", { name: "A", folderIds: [] })).status, 400, "без папки");
  assert.equal((await call("POST", { name: "A", folderIds: ["f1"], productId: "black-affiliate" })).status, 400, "продукт не зі «Смислів»");
  const created = await call("POST", { name: "Meta ops", folderIds: ["f1"], productId: "fb-training", plan: { goal: "Дзвінок" }, silentSteps: [2, 4] });
  assert.equal(created.status, 201);
  const id = created.payload.campaign.id;
  assert.equal((await call("PATCH", { id, state: "paused" })).payload.campaign.state, "paused");
  assert.equal((await call("PATCH", { id, folderIds: [] })).status, 400, "остання папка не прибирається");
  assert.equal(leadCampaigns()[0].plan.goal, "Дзвінок");
  assert.equal((await call("DELETE", null, `?id=${id}`)).status, 200);
  assert.deepEqual(saved, []);
});
