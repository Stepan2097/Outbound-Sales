import assert from "node:assert/strict";
import test from "node:test";

import { campaignStore } from "../esp/campaigns.mjs";
import { templateStore } from "../esp/templates.mjs";

/**
 * ESP-UI 1–2 (12.10): «Створити з нуля» opens the builder on an empty draft,
 * filled step by step — Sequence, Recipients, Sending options — and checked
 * when it is started, not when it is named. A letter written inside a
 * campaign belongs to it and stays out of the template library.
 */

function stores() {
  let templates = [];
  let campaigns = [];
  let enrollments = [];
  const tstore = templateStore({ read: () => templates, write: async (value) => { templates = value; } });
  const cstore = campaignStore({
    read: () => campaigns, write: async (value) => { campaigns = value; },
    readEnrollments: () => enrollments, writeEnrollments: async (value) => { enrollments = value; },
    templates: () => templates
  });
  return { tstore, cstore };
}

test("an empty draft is created, people come before mailboxes and get one when mailboxes are chosen", async () => {
  const { tstore, cstore } = stores();
  const draft = await cstore.create({ name: "Northwind pilot" });
  assert.deepEqual([draft.state, draft.steps, draft.senders], ["draft", [], []]);

  const added = await cstore.enroll(draft.id, [{ email: "olena@northwind.com" }, { email: "ivan@acme.com" }, { email: "jan@nordwind.de" }]);
  assert.equal(added.added.length, 3);
  assert.deepEqual(cstore.enrollmentsOf(draft.id).map((row) => row.sender), [null, null, null]);

  const letter = (await tstore.create({ name: "Лист 1", subject: "Hello", body: "Hi {{first_name|there}}", campaignId: draft.id })).template;
  assert.equal(letter.campaignId, draft.id, "the step's letter belongs to the campaign");
  await cstore.update(draft.id, { steps: [{ templateId: letter.id, delayDays: 0 }], senders: ["anna@advantage-mail.com", "bob@advantage-mail.com"] });
  const senders = cstore.enrollmentsOf(draft.id).map((row) => row.sender).sort();
  assert.deepEqual(senders, ["anna@advantage-mail.com", "anna@advantage-mail.com", "bob@advantage-mail.com"], "spread over the mailboxes, least-loaded first");

  const library = (await tstore.create({ name: "Перший дотик", subject: "Hello", body: "Hi" })).template;
  assert.equal("campaignId" in library, false, "«Зберегти як шаблон» is a library copy");
});

test("a draft cannot start without a letter or a mailbox, and says which is missing", async () => {
  const { tstore, cstore } = stores();
  const draft = await cstore.create({ name: "Empty" });
  await assert.rejects(cstore.setState(draft.id, "running"), (error) => error.code === "no_steps" && /Послідовності/.test(error.message));
  const letter = (await tstore.create({ subject: "Hello", body: "Hi", campaignId: draft.id })).template;
  await cstore.update(draft.id, { steps: [{ templateId: letter.id }] });
  await assert.rejects(cstore.setState(draft.id, "running"), (error) => error.code === "no_senders" && /Параметрах відправки/.test(error.message));
  await cstore.update(draft.id, { senders: ["anna@advantage-mail.com"] });
  assert.equal((await cstore.setState(draft.id, "running")).state, "running");
});

test("a running campaign still needs a letter and a mailbox: emptying them is refused", async () => {
  const { tstore, cstore } = stores();
  const letter = (await tstore.create({ subject: "Hello", body: "Hi" })).template;
  const campaign = await cstore.create({ name: "Live", steps: [{ templateId: letter.id }], senders: ["anna@advantage-mail.com"] });
  await cstore.setState(campaign.id, "running");
  await assert.rejects(cstore.update(campaign.id, { steps: [] }), (error) => error.code === "no_steps");
  await assert.rejects(cstore.update(campaign.id, { senders: [] }), (error) => error.code === "no_senders");
});

test("a campaign nothing went out from is deleted with its people; one that sent is only archived", async () => {
  const { tstore, cstore } = stores();
  const empty = await cstore.create({ name: "Draft" });
  await cstore.enroll(empty.id, [{ email: "olena@northwind.com" }]);
  await cstore.remove(empty.id);
  assert.equal(cstore.find(empty.id), null);
  assert.equal(cstore.enrollmentsOf(empty.id).length, 0, "its people go with it");

  const letter = (await tstore.create({ subject: "Hello", body: "Hi" })).template;
  const sent = await cstore.create({ name: "Sent", steps: [{ templateId: letter.id }], senders: ["anna@advantage-mail.com"] });
  await cstore.enroll(sent.id, [{ email: "ivan@acme.com" }]);
  const [row] = cstore.enrollmentsOf(sent.id);
  await cstore.saveEnrollment({ ...row, step: 1, lastSent: { at: new Date().toISOString() } });
  await assert.rejects(cstore.remove(sent.id), (error) => error.code === "has_sent");

  await cstore.setState(sent.id, "running");
  await assert.rejects(cstore.setArchived(sent.id, true), (error) => error.code === "running", "a running campaign is paused first");
  await cstore.setState(sent.id, "paused");
  assert.equal((await cstore.setArchived(sent.id, true)).archived, true);
  assert.equal((await cstore.setArchived(sent.id, false)).archived, false, "and it comes back as it was");
});
