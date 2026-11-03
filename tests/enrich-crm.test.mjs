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
  const contact = { id: "c1", company: "Apester", email: "", website: "", linkedin: "https://www.linkedin.com/in/gal", phone: "", custom_fields: { source: "csv" } };
  const { patch, added } = crmPatch(contact, { candidates, checks: [check("gal.shapira@apester.com", "valid"), check("gshapira@apester.com", "invalid", "такої пошти немає")] });
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
  const { patch } = crmPatch(contact, { candidates, checks: [check("old@apester.com", "invalid", "такої пошти немає"), check("gal.shapira@apester.com", "valid")] });
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
  assert.equal(crmPatch({ id: "c2", company: "Apester Ltd", website: "" }, { candidates: found }).patch.website, "https://apester.com");
  assert.equal(crmPatch({ id: "c3", website: "https://old.example" }, { candidates: found }).patch.website, undefined);
});

/**
 * Суддя 03.11 (таск 10b3bb63): «UMC» з Нової Зеландії, пошта @umc.co.nz —
 * пошук дав umc.org і newsdesk@umnews.org (церква) і їх записало в CRM.
 * Знайдене пишеться, лише коли домен — компанії ліда.
 */
test("the lead's known domain wins: another company's site and address are not written, and the card is told why", () => {
  const contact = { id: "sarah", company: "UMC", email: "sarah@umc.co.nz", website: "", custom_fields: {} };
  const found = [
    { type: "website", value: "https://umc.org", confidence: 86, source: "public web search" },
    { type: "email", value: "newsdesk@umnews.org", confidence: 50, source: "apify:contactFinder" }
  ];
  const { patch, added, skipped } = crmPatch(contact, { candidates: found, checks: [check("newsdesk@umnews.org", "valid")], company: "UMC" });
  assert.deepEqual(patch, {}, "nothing of the church goes into the CRM");
  assert.deepEqual(added, []);
  assert.deepEqual(skipped.map((row) => [row.field, row.value]), [["email", "newsdesk@umnews.org"], ["website", "https://umc.org"]]);
  assert.match(skipped[1].reason, /umc\.co\.nz/);
});

test("the same domain (or its subdomain) passes; a free mailbox is the person's and passes", () => {
  const contact = { id: "c5", company: "UMC", email: "sarah@umc.co.nz", website: "", custom_fields: {} };
  const found = [
    { type: "website", value: "https://www.umc.co.nz/about", confidence: 70 },
    { type: "email", value: "media@umc.co.nz", confidence: 60 },
    { type: "email", value: "sarah.h@gmail.com", confidence: 40 }
  ];
  const { patch, skipped } = crmPatch(contact, { candidates: found, checks: [check("media@umc.co.nz", "valid"), check("sarah.h@gmail.com", "valid")], company: "UMC" });
  assert.equal(patch.website, "https://www.umc.co.nz/about");
  assert.deepEqual(patch.custom_fields.emails.map((row) => row.email).sort(), ["media@umc.co.nz", "sarah.h@gmail.com"]);
  assert.deepEqual(skipped, []);
});

test("no known domain: a site goes in only when its name is the company's name; short acronyms and partial names do not", () => {
  const site = (value) => [{ type: "website", value, confidence: 86 }];
  assert.equal(crmPatch({ id: "a", website: "" }, { candidates: site("https://growingideas.net"), company: "growing ideas" }).patch.website, "https://growingideas.net");
  const bigMouth = crmPatch({ id: "b", website: "" }, { candidates: site("https://bigmouth.agency"), company: "big mouth advertising" });
  assert.equal(bigMouth.patch.website, undefined, "Big Mouth Marketing is not proven to be big mouth advertising");
  assert.equal(bigMouth.skipped[0].field, "website");
  assert.equal(crmPatch({ id: "c", website: "" }, { candidates: site("https://umc.org"), company: "UMC" }).patch.website, undefined, "three letters match too many companies");
});

test("no known domain: a work address goes in only on the accepted site's domain", () => {
  const found = [
    { type: "website", value: "https://growingideas.net", confidence: 86 },
    { type: "email", value: "seth@growingideas.net", confidence: 60 },
    { type: "email", value: "info@otherco.com", confidence: 60 }
  ];
  const { patch, skipped } = crmPatch({ id: "d", email: "", website: "", custom_fields: {} }, { candidates: found, checks: [check("seth@growingideas.net", "valid"), check("info@otherco.com", "valid")], company: "Growing Ideas LLC" });
  assert.equal(patch.email, "seth@growingideas.net");
  assert.deepEqual(Object.keys(patch.custom_fields.email_check), ["seth@growingideas.net"], "the other company's check is not kept either");
  assert.deepEqual(skipped.map((row) => row.value), ["info@otherco.com"]);
});

test("a work address the mail sweep removed as dead still names the company: Ronald's bigmouthadvertising.com rules out bigmouth.agency", () => {
  const ronald = { id: "ff89", company: "big mouth advertising", email: null, website: null, custom_fields: { removed_email: { email: "rkaminsky@bigmouthadvertising.com", reason: "домен заявляє, що не приймає пошту" } } };
  const { patch, skipped } = crmPatch(ronald, { candidates: [{ type: "website", value: "https://bigmouth.agency", confidence: 86 }], company: "big mouth advertising" });
  assert.deepEqual(patch, {});
  assert.match(skipped[0].reason, /bigmouthadvertising\.com/);
  const sarah = { id: "fb98", company: "UMC", email: null, website: null, custom_fields: { emails: [], removed_email: { email: "sarah@umc.co.nz" } } };
  assert.deepEqual(crmPatch(sarah, { candidates: [{ type: "website", value: "https://umc.org", confidence: 86 }, { type: "email", value: "newsdesk@umnews.org" }], checks: [check("newsdesk@umnews.org", "valid")], company: "UMC" }).patch, {});
});
