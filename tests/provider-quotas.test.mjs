import assert from "node:assert/strict";
import test from "node:test";

import { available, folderTones, pickByProvider, providerBreakdown } from "../esp/provider-quotas.mjs";

// Власник 02.11: «при виборі в кампанії я міг вписати наприклад 10 пошт гугл 1 яхо тощо».

const lead = (email, provider, extra = {}) => ({ email, provider, verification: "", campaigns: [], excluded: null, ...extra });

const ROWS = [
  lead("a@g.com", "google", { verification: "unknown" }),
  lead("b@g.com", "google", { verification: "valid" }),
  lead("c@g.com", "google", { verification: "catch_all" }),
  lead("d@g.com", "google", { verification: "invalid" }),
  lead("e@g.com", "google", { campaigns: [{ campaignId: "x" }] }),
  lead("f@y.com", "yahoo", { verification: "valid" }),
  lead("g@y.com", "yahoo", { excluded: { category: "unsubscribed" } }),
  lead("h@n.com", ""),
  lead("i@none.com", "none")
];

test("розбивка: скільки ще можна додати з кожного провайдера — без тих, хто в кампанії, у виключеннях чи з адресою «немає»", () => {
  const split = Object.fromEntries(providerBreakdown(ROWS).map((row) => [row.key, [row.total, row.available, row.valid]]));
  assert.deepEqual(split, { google: [5, 3, 1], yahoo: [2, 1, 1], unchecked: [1, 1, 0], none: [1, 0, 0] });
  assert.equal(available(ROWS[3]), false);
});

test("квоти: з кожного провайдера — скільки вписано, першими перевірені «є»; відмовлених пропускає й каже чому", async () => {
  const { picked, short } = await pickByProvider(ROWS, { google: 2, yahoo: 1, unchecked: 0 }, {
    accept: async (row) => (row.email === "c@g.com" ? "catch-all" : true)
  });
  assert.deepEqual(picked.map((row) => row.email), ["b@g.com", "a@g.com", "f@y.com"]);
  assert.deepEqual(short, {});
  const again = await pickByProvider(ROWS, { google: 5, yahoo: "2" }, { accept: async (row) => (row.provider === "yahoo" ? "пошта не на Google" : true) });
  assert.deepEqual(again.short, { google: { missing: 2, passed: {} }, yahoo: { missing: 2, passed: { "пошта не на Google": 1 } } });
});

test("точки перевірки — для всієї папки й для кожного провайдера, а не лише сторінки (02.11)", () => {
  const rows = [{ email: "a@g.com", provider: "google", tone: "valid" }, { email: "b@g.com", provider: "google", tone: "invalid" }, { email: "c@y.com", provider: "yahoo", tone: "risky" }, { email: "d@n.com", provider: "", tone: "none" }];
  assert.deepEqual(folderTones(rows), { valid: 1, risky: 1, invalid: 1, unknown: 0, none: 1 });
  assert.deepEqual(providerBreakdown(rows).find((row) => row.key === "google").tones, { valid: 1, risky: 0, invalid: 1, unknown: 0, none: 0 });
});
