import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMessage, normalizeParticipant } from "../warmup/inbox.mjs";
import { personName } from "../warmup/people.mjs";
import { nameFromSeenLine, withoutSeenLines } from "../warmup/receipts.mjs";

// Власник 16.10: у CRM з'явився контакт «Ким переглянуто: Stanko Milutinovic о
// 23:25.» — рядок LinkedIn «хто переглянув», прочитаний як ім'я.

test("рядок «переглянуто» як ім'я — це людина в ньому; звичайне ім'я — без змін", () => {
  assert.equal(nameFromSeenLine("Ким переглянуто: Stanko Milutinovic о 23:25."), "Stanko Milutinovic");
  assert.equal(nameFromSeenLine("Seen by Jane Doe at 11:25 PM"), "Jane Doe");
  assert.equal(nameFromSeenLine("  Olena   Kovalenko "), "Olena Kovalenko");
  assert.equal(normalizeParticipant({ name: "Ким переглянуто: Stanko Milutinovic о 23:25.", slug: "stanko" }).name, "Stanko Milutinovic");
  assert.equal(personName({ name: "Ким переглянуто: Stanko Milutinovic о 23:25." }), "Stanko Milutinovic");
});

test("рядок «переглянуто» в тексті повідомлення прибирається, решта лишається", () => {
  const body = "Hi Mary - pls tell me what you have in mind? \n\nКим переглянуто: James Fleming о 19:46.";
  assert.equal(withoutSeenLines(body), "Hi Mary - pls tell me what you have in mind?");
  const message = normalizeMessage({ direction: "in", body }, { threadKey: "t", receivedAt: "2026-10-16T10:00:00Z" });
  assert.equal(message.body, "Hi Mary - pls tell me what you have in mind?");
  assert.equal(normalizeMessage({ direction: "in", body: "Ким переглянуто: James Fleming о 19:46." }, { threadKey: "t", receivedAt: "2026-10-16T10:00:00Z" }), null, "лише рядок «переглянуто» — не повідомлення");
});
