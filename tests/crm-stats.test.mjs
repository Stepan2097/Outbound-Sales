import assert from "node:assert/strict";
import test from "node:test";

import { dailyFrom, funnelFrom, kpisFrom, rangeInstants, statsRange, teamFrom } from "../triage/crm-stats.mjs";

// «Статистика» як у CRM (23.10): ті самі функції бази, той самий розбір.

test("періоди: тиждень з понеділка, місяць, попередні; свої дати; межі — за Варшавою", () => {
  const now = Date.parse("2026-10-23T10:00:00Z"); // п'ятниця
  assert.deepEqual(statsRange({ preset: "this_week", now }), { from: "2026-10-19", to: "2026-10-25", preset: "this_week" });
  assert.deepEqual(statsRange({ preset: "prev_week", now }), { from: "2026-10-12", to: "2026-10-18", preset: "prev_week" });
  assert.deepEqual(statsRange({ preset: "this_month", now }), { from: "2026-10-01", to: "2026-10-31", preset: "this_month" });
  assert.deepEqual(statsRange({ preset: "prev_month", now }), { from: "2026-09-01", to: "2026-09-30", preset: "prev_month" });
  assert.deepEqual(statsRange({ from: "2026-10-01", to: "2026-10-05", now }), { from: "2026-10-01", to: "2026-10-05", preset: null });
  const { current, previous } = rangeInstants({ from: "2026-10-19", to: "2026-10-25" });
  assert.equal(current.start, "2026-10-18T22:00:00.000Z", "північ у Варшаві (CEST)");
  assert.equal(current.end, "2026-10-25T22:59:59.999Z", "25.10 — перехід на зимовий час");
  assert.equal(Date.parse(previous.end) + 1, Date.parse(current.start));
});

test("воронка й показники — як у CRM", () => {
  const funnel = funnelFrom({ total_contacts: 15, processed_contacts: 12, linkedin_activity_contacts: 8, deal_contacts: 4, won: 1, lost: 0, status_counts: { new: 10, in_progress: 3, responded: 5, booked_call: 2 } });
  const stage = Object.fromEntries(funnel.stages.map((row) => [row.key, row.count]));
  assert.deepEqual(stage, { new: 15, in_progress: 3, linkedin_activity: 8, responded_or_other: 7, booked_call: 2, deal_created: 4, won: 1, lost: 0 });
  assert.equal(funnel.transitions.find((row) => row.to === "responded_or_other").conversionRate, 88);
  const kpis = kpisFrom(funnel, funnelFrom({ total_contacts: 10, processed_contacts: 12, deal_contacts: 2, won: 1 }), 5000, 0);
  assert.deepEqual(kpis.map((row) => [row.key, row.value, row.delta]), [["new", 15, 50], ["processed", 12, 0], ["deals", 4, 100], ["won", 1, 0], ["revenue", 5000, 100], ["winRate", 25, -50]]);
});

test("команда й дні: лише підтверджені люди, найзавантаженіші зверху, новіші дні зверху", () => {
  const people = [{ id: "a", email: "a@x" }, { id: "b", email: "b@x" }];
  const team = teamFrom(people, [{ user_id: "b", weekday_index: 0, linkedin_sent: 5, total: 7 }, { user_id: "b", weekday_index: 1, linkedin_sent: 1, total: 1 }, { user_id: "z", total: 99 }], [{ user_id: "b", channel: "linkedin", sent_people: 4 }]);
  assert.deepEqual(team.map((row) => [row.email, row.linkedin_count, row.total_activities]), [["b@x", 6, 8], ["a@x", 0, 0]]);
  assert.equal(team[0].channels.linkedin.sent_people, 4);
  assert.deepEqual(dailyFrom(people, [{ user_id: "a", day: "2026-10-22", contacts_added: 2 }, { user_id: "a", day: "2026-10-23", sales_activities: 3 }, { user_id: "z", day: "2026-10-23" }]).map((row) => row.day), ["2026-10-23", "2026-10-22"]);
});
