import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { useJournal } from "../esp/journal.mjs";
import { warmupView } from "../esp/mail-warmup.mjs";
import { addDomain, addSender, isDisconnected, lostAccess, registry, setDomainStatus, setSenderStatus } from "../esp/registry.mjs";

// Owner 03.11: vlad.advantage@gmail.com lost its Google access on its own (the
// gate paused it, «not_connected») and vanished from «Прогрів пошт» as if
// somebody had pressed «Відключити». It must stay there, asking to sign in again.
test("a mailbox that lost its Google access stays in the warm-up with «перепідключіть»; one a person disconnected is gone", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "esp-lost-"));
  useJournal(join(dir, "journal.jsonl"));
  t.after(async () => { useJournal(null); await rm(dir, { recursive: true, force: true }); });
  await addDomain({ domain: "gmail.com" }, "test");
  await setDomainStatus({ domain: "gmail.com", status: "ramp" }, "test");
  await addSender({ email: "vlad@gmail.com" }, "owner@advantage.agency");
  await addSender({ email: "gone@gmail.com" }, "owner@advantage.agency");
  await setSenderStatus({ email: "vlad@gmail.com", status: "paused", reason: "Пошту не підключено", code: "not_connected" }, "esp-gate");
  await setSenderStatus({ email: "gone@gmail.com", status: "paused", reason: "Пошту відключено від платформи", code: "not_connected" }, "owner@advantage.agency");
  const { senders, domains } = await registry();
  const vlad = senders.find((row) => row.email === "vlad@gmail.com");
  const gone = senders.find((row) => row.email === "gone@gmail.com");
  assert.deepEqual([isDisconnected(vlad), lostAccess(vlad)], [false, true]);
  assert.deepEqual([isDisconnected(gone), lostAccess(gone)], [true, false]);
  const rows = warmupView([], { senders: senders.filter((row) => !isDisconnected(row)), domains });
  assert.deepEqual(rows.map((row) => row.email), ["vlad@gmail.com"]);
  assert.equal(rows[0].status, "blocked");
  assert.match(rows[0].blocked, /відключилася від платформи — перепідключіть/);
});
