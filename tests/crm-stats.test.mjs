import assert from "node:assert/strict";
import test from "node:test";

import { dailyFrom, funnelFrom, kpisFrom, rangeInstants, statsRange, teamFrom, workFunnel, workFunnelFrom } from "../triage/crm-stats.mjs";

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

/** Tables as arrays; eq/in/gte/lte/notNull filter, the rest pass. */
function fakeDb(tables) {
  return {
    configured: () => true,
    from(table) {
      const filters = [];
      let offset = 0;
      const self = {
        select: () => self, order: () => self, limit: () => self,
        offset: (value) => { offset = value; return self; },
        eq: (column, value) => { filters.push((row) => row[column] === value); return self; },
        in: (column, values) => { filters.push((row) => values.includes(row[column])); return self; },
        gte: (column, value) => { filters.push((row) => row[column] >= value); return self; },
        lt: (column, value) => { filters.push((row) => row[column] < value); return self; },
        notNull: (column) => { filters.push((row) => row[column] != null); return self; },
        async rows() { return offset ? [] : (tables[table] || []).filter((row) => filters.every((keep) => keep(row))); }
      };
      return self;
    }
  };
}

test("воронка роботи (30.10): що зроблено за період — люди на кожному кроці, відсоток лише де крок не більший", async () => {
  const start = "2026-10-26T00:00:00Z";
  const end = "2026-11-01T23:59:59Z";
  const at = "2026-10-28T12:00:00Z";
  const before = "2026-10-20T12:00:00Z";
  const anty = fakeDb({ wl_events: [
    { id: 1, account_id: "acc-b", type: "invite.sent", meta: { crmContactId: "c1" }, created_at: at },
    { id: 2, account_id: "acc-b", type: "invite.sent", meta: { crmContactId: "c2" }, created_at: at },
    { id: 3, account_id: "acc-x", type: "invite.sent", meta: { crmContactId: "c3" }, created_at: at },
    { id: 4, account_id: "acc-b", type: "invite.accepted", meta: { crmContactId: "c1" }, created_at: at },
    { id: 5, account_id: "acc-b", type: "invite.sent", meta: { crmContactId: "c9" }, created_at: before }
  ] });
  const crm = fakeDb({
    activities: [
      ...["p1", "p2", "p3", "p4"].map((contact_id, index) => ({ id: index, contact_id, user_id: "bohdan", type: "linkedin", direction: "outgoing", created_at: at })),
      { id: 10, contact_id: "p1", user_id: "bohdan", type: "linkedin", direction: "outgoing", created_at: at },
      { id: 11, contact_id: "p5", user_id: null, type: "linkedin", direction: "outgoing", created_at: at },
      { id: 12, contact_id: "p1", user_id: null, type: "linkedin", direction: "incoming", created_at: at },
      { id: 13, contact_id: "p1", user_id: null, type: "linkedin", direction: "incoming", created_at: at },
      { id: 14, contact_id: "p6", user_id: null, type: "linkedin", direction: "incoming", created_at: at },
      { id: 15, contact_id: "p7", user_id: "lilia", type: "note", direction: "outgoing", created_at: at }
    ],
    contacts: [{ id: "p1", owner_id: "owner" }, { id: "p6", owner_id: "bohdan" }],
    contact_status_history: [{ id: 1, contact_id: "p1", new_status: "booked_call", changed_by: "bohdan", changed_at: at }],
    deals: [{ id: "d1", owner_id: "bohdan", created_at: at }, { id: "d2", owner_id: "lilia", created_at: before }]
  });
  const inboxLabels = {
    "acc-b|t1": { label: "qualified", by: "ai", basis: `2|${at}`, at },
    "acc-b|t2": { label: "qualified", by: "ai", basis: `1|${before}`, at },
    "acc-x|t3": { label: "refusal", by: "ai", basis: `1|${at}`, at }
  };
  const counts = (steps) => Object.fromEntries(steps.map((step) => [step.key, step.count]));
  const all = await workFunnel({ crm, anty, start, end, accountLeadgens: { "acc-b": "bohdan" }, inboxLabels });
  assert.deepEqual(counts(all), { invited: 3, accepted: 1, wrote: 5, replied: 2, qualified: 1, booked_call: 1, deal: 1 });
  assert.deepEqual(all.map((step) => step.rate), [null, 33, null, 40, 50, 100, 100], "«Написали» більше за «Прийняли» — без відсотка");
  const bohdan = await workFunnel({ crm, anty, start, end, who: "bohdan", accountLeadgens: { "acc-b": "bohdan" }, inboxLabels });
  assert.deepEqual(counts(bohdan), { invited: 2, accepted: 1, wrote: 4, replied: 2, qualified: 1, booked_call: 1, deal: 1 }, "відповідь — того, хто писав, інакше власника контакту");
  assert.equal(workFunnelFrom({}).length, 7);
});
