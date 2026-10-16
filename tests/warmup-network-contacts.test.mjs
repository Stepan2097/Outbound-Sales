import assert from "node:assert/strict";
import test from "node:test";

import { adoptNetwork, networkFolderName } from "../warmup/network-contacts.mjs";

/**
 * Друзі LinkedIn-акаунтів, яких немає в CRM, — у папку «Друзі LinkedIn-акаунтів»
 * (власник 16.10). Хто вже є — лишається, де був; один друг двох акаунтів — один
 * контакт; не люди (LinkedIn Member, без імені) — ні.
 */

const people = [
  { slug: "known-person", name: "Known Person", headline: "CMO", connectedAt: "2026-09-01" },
  { slug: "new-person", name: "New Person", headline: "Head of Affiliates", connectedAt: "2026-10-14" },
  { slug: "nameless", name: "", headline: "" },
  { slug: "member", name: "LinkedIn Member", headline: "" }
];

test("друзі не з CRM стають контактами в окремій папці; хто вже є — ні; не люди — пропускаються", async () => {
  const made = [];
  const inCrm = new Set(["known-person"]);
  const result = await adoptNetwork({
    account: { login: "Chloe Stewart" },
    people,
    lookup: async (slug) => (inCrm.has(slug) ? "contact-1" : null),
    create: async (person, label, folder) => { made.push({ slug: person.slug, label, folder }); inCrm.add(person.slug); },
    folderId: async () => "folder-1",
    env: {}
  });
  assert.deepEqual(made, [{ slug: "new-person", label: "Chloe Stewart", folder: "folder-1" }]);
  assert.deepEqual({ ...result, lastError: undefined }, { checked: 2, inCrm: 1, added: 1, skipped: 2, failed: 0, lastError: undefined });

  // The same friend read on another account: one contact, not two.
  const again = await adoptNetwork({ account: "Clara", people: [people[1]], lookup: async (slug) => (inCrm.has(slug) ? "c" : null), create: async () => made.push("twice"), folderId: async () => "folder-1", env: {} });
  assert.equal(again.added, 0);
  assert.equal(made.length, 1);
});

test("вимикач INBOX_ADOPT_CONTACTS=0 вимикає й це; назва папки — NETWORK_CONTACTS_FOLDER", async () => {
  const result = await adoptNetwork({ account: "x", people, lookup: async () => null, create: async () => { throw new Error("must not"); }, folderId: async () => "f", env: { INBOX_ADOPT_CONTACTS: "0" } });
  assert.equal(result.off, true);
  assert.equal(networkFolderName({}), "Друзі LinkedIn-акаунтів");
  assert.equal(networkFolderName({ NETWORK_CONTACTS_FOLDER: "Друзі" }), "Друзі");
});

test("CRM не прийняла контакт — рахується як збій, решта йде далі", async () => {
  const result = await adoptNetwork({
    account: "x",
    people: [people[1], { slug: "third", name: "Third One" }],
    lookup: async () => null,
    create: async (person) => { if (person.slug === "third") throw new Error("CRM down"); },
    folderId: async () => "f",
    env: {}
  });
  assert.deepEqual([result.added, result.failed, result.lastError], [1, 1, "CRM down"]);
});
