import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { pathTracks } from "../app/screens/work-path.js";
import { addSendsToDays, dayActivity, daysAround, linkedinSends, withLinkedinSends } from "../triage/work-log.mjs";

/**
 * Шлях людини і справжні повідомлення LinkedIn у «По днях» (власник 15.10:
 * «де буде показуватися ті люди яким я щойно написав і весь шлях»; «логіка
 * сторінки по днях слабо пропрацьована»).
 */

test("шлях LinkedIn: запит → прийняв → перше повідомлення → відповідь, і що далі", () => {
  const dialog = {
    work: [{ action: "invited", at: "2026-10-08T09:00:00Z" }],
    linkedin: { entries: [
      { kind: "invite", event: "invite.sent", at: "2026-10-08T10:00:00Z" },
      { kind: "invite", event: "invite.accepted", at: "2026-10-09T10:00:00Z" },
      { direction: "out", body: "Hi", at: "2026-10-10T09:00:00Z" }
    ] }
  };
  const [linkedin] = pathTracks(dialog);
  assert.deepEqual(linkedin.steps.map((step) => [step.label, step.state]), [
    ["Запит у друзі надіслано", "done"], ["Прийняв запит", "done"], ["Перше повідомлення", "done"], ["Відповідь", "now"], ["Повторне повідомлення", "next"]
  ]);
  assert.equal(linkedin.steps.at(-1).at, "2026-10-11T09:00:00.000Z", "повтор — наступного дня після нашого повідомлення");

  dialog.linkedin.entries.push({ direction: "in", body: "Sure", at: "2026-10-10T12:00:00Z" });
  const [answered] = pathTracks(dialog);
  assert.deepEqual(answered.steps.slice(-2).map((step) => [step.label, step.state]), [["Відповів", "done"], ["Відповісти йому", "now"]]);
});

test("запит ще в черзі — так і сказано; пошта — окремою доріжкою, недоставлений лист позначено", () => {
  const [queued] = pathTracks({ work: [{ action: "invited", at: "2026-10-14T09:00:00Z" }], linkedin: { entries: [] } });
  assert.deepEqual(queued.steps.map((step) => [step.label, step.state]), [["Запит у друзі в черзі акаунта", "done"], ["Прийняв запит", "now"]]);
  const tracks = pathTracks({ email: [{ email: "a@b.co", events: [{ type: "message.sent", at: "2026-10-14T09:00:00Z" }, { type: "message.bounced", at: "2026-10-14T09:05:00Z" }] }] });
  assert.equal(tracks[0].channel, "email");
  assert.equal(tracks[0].steps[1].bad, true);
  assert.deepEqual(pathTracks({}), []);
});

const events = [
  { account_id: "acc", created_at: "2026-10-14T07:40:00Z", meta: { threadKey: "t1", crmContactId: "c1", participant: { name: "Liam" }, sentAt: "2026-10-14T07:33:00Z", sentAtIso: true } },
  { account_id: "acc", created_at: "2026-10-14T08:00:00Z", meta: { threadKey: "t2", participant: { name: "Переглянути профіль Asaf" } } }
];
const accounts = new Map([["acc", "gulajpole"]]);

test("справжні повідомлення LinkedIn: на день відправки; хто поставив у черзу — тому, інакше «з LinkedIn-акаунта»", () => {
  const entries = [{ at: "2026-10-13T15:00:00Z", user: "pavlo@x.co", userName: "Pavlo", action: "wrote", channel: "linkedin", contactId: "c1" }];
  const sends = linkedinSends(events, { accounts, entries });
  assert.deepEqual(sends.map((send) => [send.key, send.at, send.userName, send.name]), [
    ["id:c1", "2026-10-14T07:33:00Z", "Pavlo", "Liam"],
    ["thread:acc:t2", "2026-10-14T08:00:00Z", "з LinkedIn-акаунта", "Asaf"]
  ]);
  const team = withLinkedinSends(dayActivity(entries, { date: "2026-10-14", user: "all" }), sends, { date: "2026-10-14" });
  assert.equal(team.contacts.length, 2);
  assert.equal(team.total.contacts, 2);
  const days = addSendsToDays(daysAround(entries, { date: "2026-10-14", today: "2026-10-14" }), sends, entries);
  assert.equal(days.find((day) => day.date === "2026-10-14").contacts, 2);
  assert.equal(days.find((day) => day.date === "2026-10-13").contacts, 1, "день, коли поставили в чергу, — з логу");
});

test("проводка: адміністратор відкриває «Уся команда»; Головна показує «Щойно написали» з кнопкою «Шлях»", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /const user = !admin \|\| wanted === "me" \? viewer : wanted \|\| "all";/);
  const home = await readFile(new URL("../app/screens/home-triage.js", import.meta.url), "utf8");
  assert.match(home, /\/api\/work\/day\?user=me/);
  assert.match(home, /Щойно написали сьогодні/);
  assert.match(home, /openWorkContact\(key\)/);
  const work = await readFile(new URL("../app/screens/work.js", import.meta.url), "utf8");
  assert.match(work, /export function openWorkContact/);
  assert.match(work, /<h4>Шлях<\/h4>/);
});
