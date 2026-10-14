import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { contactWork, dayActivity, dayOf, logWork, recentDays, useWorkLog, workEntries, workUsers } from "../triage/work-log.mjs";

/**
 * «По днях» (власник 12.10): за день — кому я написав і хто відповів; хто
 * писав — логін платформи; цифри по кожному працівнику.
 */

const OLENA = { email: "Olena@Advantage-Agency.co", name: "Олена", role: "user" };
const PAVLO = { email: "pavlo@advantage-agency.co", name: "Павло", role: "admin" };
const at = (iso) => ({ now: new Date(iso) });

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "work-log-"));
  const path = join(dir, "work-log.jsonl");
  useWorkLog(path);
  t.after(async () => { useWorkLog(null); await rm(dir, { recursive: true, force: true }); });
  return path;
}

test("each line says which login did it, and survives a restart", async (t) => {
  const path = await setup(t);
  await logWork(OLENA, { action: "wrote", channel: "linkedin", contactId: "c1", name: "Gal", accountId: "acc-1", accountName: "Profile 48" }, at("2026-10-12T08:00:00Z"));
  await logWork(OLENA, { action: "made_up" });
  const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1, "an unknown action is not written");
  assert.equal(lines[0].user, "olena@advantage-agency.co");
  assert.equal(lines[0].accountName, "Profile 48");
  useWorkLog(path);
  assert.equal((await workEntries()).length, 1, "read back from the file");
});

test("a Kyiv day: who was written to, through what, by whom — and every login's numbers", async (t) => {
  await setup(t);
  // 21:30 UTC on the 11th is 00:30 on the 12th in Kyiv.
  await logWork(OLENA, { action: "viewed", contactId: "c1" }, at("2026-10-11T21:30:00Z"));
  await logWork(OLENA, { action: "viewed", contactId: "c1" }, at("2026-10-12T07:00:00Z"));
  await logWork(OLENA, { action: "wrote", channel: "linkedin", contactId: "c1", accountName: "Profile 48" }, at("2026-10-12T08:00:00Z"));
  await logWork(OLENA, { action: "wrote", channel: "email", contactId: "c1", email: "gal@apester.com", mailbox: "anna@advantage-mail.com" }, at("2026-10-12T08:05:00Z"));
  await logWork(OLENA, { action: "invalid", contactId: "c2" }, at("2026-10-12T09:00:00Z"));
  await logWork(PAVLO, { action: "invited", channel: "linkedin", contactId: "c3", accountName: "Profile 47" }, at("2026-10-12T10:00:00Z"));
  await logWork(PAVLO, { action: "wrote", channel: "email", email: "x@y.com" }, at("2026-10-11T10:00:00Z"));
  const entries = await workEntries();
  assert.equal(dayOf("2026-10-11T21:30:00Z"), "2026-10-12");

  const mine = dayActivity(entries, { date: "2026-10-12", user: "olena@advantage-agency.co" });
  assert.deepEqual(mine.contacts.map((item) => item.key), ["id:c1"], "one person, written twice — once on the list");
  assert.deepEqual(mine.contacts[0].actions.map((row) => row.channel), ["linkedin", "email"]);
  assert.equal(mine.total.viewed, 1, "a card opened twice in a day is one view");
  assert.equal(mine.total.wroteLinkedin, 1);
  assert.equal(mine.total.wroteEmail, 1);
  assert.equal(mine.total.invalid, 1);
  assert.equal(mine.total.contacts, 1);

  const team = dayActivity(entries, { date: "2026-10-12", user: "all" });
  assert.deepEqual(team.users.map((row) => [row.user, row.counts.contacts]), [["olena@advantage-agency.co", 1], ["pavlo@advantage-agency.co", 1]]);
  assert.equal(team.contacts.length, 2);

  const strip = recentDays(entries, { user: "all", until: "2026-10-12", days: 3 });
  assert.deepEqual(strip, [{ date: "2026-10-12", contacts: 2 }, { date: "2026-10-11", contacts: 1 }, { date: "2026-10-10", contacts: 0 }]);
  assert.deepEqual(workUsers(entries).map((row) => row.name), ["Олена", "Павло"]);
  assert.equal(contactWork(entries, { contactId: "c1" }).length, 4, "the dialog shows everything anybody did to the person");
  assert.equal(contactWork(entries, { emails: ["X@Y.com"] }).length, 1, "a letter-only person is found by address");
});

test("смуга днів: обраний день посередині, по 7 з боків; дні після сьогодні позначені", async () => {
  const { daysAround } = await import("../triage/work-log.mjs");
  const strip = daysAround([], { date: "2026-10-10", today: "2026-10-14" });
  assert.equal(strip.length, 15);
  assert.equal(strip[7].date, "2026-10-10", "посередині — обраний");
  const list = strip.slice().reverse();
  assert.equal(list[7].date, "2026-10-10", "і в порядку, як їх малює сторінка");
  assert.deepEqual(list.filter((day) => day.future).map((day) => day.date), ["2026-10-15", "2026-10-16", "2026-10-17"]);
});
