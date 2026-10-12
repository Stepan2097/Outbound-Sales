import assert from "node:assert/strict";
import test from "node:test";

import { contactEmails, crmPatch } from "../contacts/enrich-crm.mjs";

/**
 * Власник 12.10: знайдене збагаченням додається в CRM саме, але лише пошта, яку
 * підтвердив поштовий сервер; невдалі здогадки не показуються й не зберігаються;
 * адреса з CRM, що не пройшла, лишається з «!».
 */

const at = "2026-10-12T15:00:00.000Z";
const check = (email, status, reason = "") => ({ email, status, reason, checkedAt: at });
const candidates = [
  { type: "email", value: "gal.shapira@apester.com", confidence: 61, source: "business domain pattern" },
  { type: "email", value: "gshapira@apester.com", confidence: 48, source: "business domain pattern" },
  { type: "website", value: "https://apester.com", confidence: 82 },
  { type: "linkedin", value: "https://www.linkedin.com/in/gal-shapira-b9b361a0", confidence: 88 },
  { type: "phone", value: "+972 0000", confidence: 40 }
];

test("an empty CRM email gets the confirmed address; the failed guess goes nowhere; holes are filled, not overwritten", () => {
  const contact = { id: "c1", email: "", website: "", linkedin: "https://www.linkedin.com/in/gal", phone: "", custom_fields: { source: "csv" } };
  const { patch, added } = crmPatch(contact, { candidates, checks: [check("gal.shapira@apester.com", "valid"), check("gshapira@apester.com", "invalid", "такої скриньки немає")] });
  assert.equal(patch.email, "gal.shapira@apester.com");
  assert.equal(patch.website, "https://apester.com");
  assert.equal("linkedin" in patch, false, "the CRM already had one");
  assert.equal("phone" in patch, false, "not a confident source");
  assert.equal(patch.custom_fields.source, "csv", "other custom fields are kept");
  assert.deepEqual(Object.keys(patch.custom_fields.email_check), ["gal.shapira@apester.com"], "the failed guess is not remembered");
  assert.deepEqual(added.map((row) => row.field), ["email", "website"]);
});

test("a second confirmed address joins the list; the CRM's own failing address keeps its «!»", () => {
  const contact = { id: "c2", email: "old@apester.com", custom_fields: {} };
  const { patch } = crmPatch(contact, { candidates, checks: [check("old@apester.com", "invalid", "такої скриньки немає"), check("gal.shapira@apester.com", "valid")] });
  assert.equal("email" in patch, false, "the CRM's email is never replaced");
  assert.deepEqual(patch.custom_fields.emails.map((row) => row.email), ["gal.shapira@apester.com"]);
  const rows = contactEmails({ ...contact, ...patch });
  assert.deepEqual(rows.map((row) => [row.address, row.source, row.check.status]), [
    ["old@apester.com", "crm", "invalid"],
    ["gal.shapira@apester.com", "found", "valid"]
  ]);
});

test("nothing new, nothing written", () => {
  const contact = { id: "c3", email: "gal.shapira@apester.com", custom_fields: { email_check: { "gal.shapira@apester.com": { status: "valid", reason: "", checkedAt: at } } } };
  assert.deepEqual(crmPatch(contact, { checks: [check("gal.shapira@apester.com", "valid")] }).patch, {});
});

test("the Leads page and ESP 6 read the mail server's word from the CRM", async () => {
  const { leadFromContact } = await import("../esp/crm-leads.mjs");
  const lead = leadFromContact({ id: "c4", email: "Gal.Shapira@apester.com", custom_fields: { email_check: { "gal.shapira@apester.com": { status: "valid", checkedAt: at } } } });
  assert.equal(lead.verification, "valid");
  assert.equal(lead.verifiedAt, at);
  assert.equal(leadFromContact({ id: "c5", email: "x@y.com" }).verification, "", "not checked — not verified");
});

test("the company site found by the search goes into the base when the base has none, and never replaces one it has", () => {
  const found = [{ type: "website", value: "https://apester.com", confidence: 64, source: "public web search" }];
  assert.equal(crmPatch({ id: "c2", website: "" }, { candidates: found }).patch.website, "https://apester.com");
  assert.equal(crmPatch({ id: "c3", website: "https://old.example" }, { candidates: found }).patch.website, undefined);
});
