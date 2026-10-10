import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { espRouteRight, handleEspApi } from "../esp/api.mjs";
import { handleEspDataApi } from "../esp/data-api.mjs";
import { allEntries, append, useJournal } from "../esp/journal.mjs";
import { campaignReport, senderDailyReport, toCsv, variantKey } from "../esp/reports.mjs";
import { DEFAULT_RETENTION_DAYS, anonymize, anonymousId, dueForRetention, redactFor, retentionDays, runRetention } from "../esp/retention.mjs";
import { exclusions } from "../esp/filters.mjs";

/**
 * ESP 16 — reports from the journal (no opens, no clicks), and how long a
 * lead's data is kept.
 */

let dir;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "esp-reports-"));
  useJournal(join(dir, "esp-journal.jsonl"));
});
test.afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const at = (iso) => ({ at: iso });
function story() {
  const rows = [];
  const add = (type, contact, data, iso) => rows.push({ seq: rows.length + 1, type, contact, data, ...at(iso) });
  // Anna, campaign c1: three people; Boris, one.
  for (const [email, variant] of [["a@x.com", { group: "A", "subject.0": 1 }], ["b@x.com", { group: "B", "subject.0": 2 }], ["c@x.com", { group: "A", "subject.0": 1 }]]) {
    add("message.sending", email, { from: "anna@send.com", campaignId: "c1", step: 0, subject: variant.group === "A" ? "uk traffic" : "a question", variantIds: variant }, "2026-10-12T08:00:00Z");
    add("message.sent", email, { from: "anna@send.com", campaignId: "c1", step: 0 }, "2026-10-12T08:00:01Z");
  }
  add("message.sent", "a@x.com", { from: "anna@send.com", campaignId: "c1", step: 1 }, "2026-10-15T08:00:01Z");
  add("message.sent", "b@x.com", { from: "anna@send.com", campaignId: "c1", step: 1 }, "2026-10-15T08:00:02Z");
  add("message.replied", "a@x.com", { sender: "anna@send.com", campaignId: "c1", step: 1, gmailId: "g1", label: "neutral" }, "2026-10-15T10:00:00Z");
  add("reply.labelled", null, { gmailId: "g1", label: "positive" }, "2026-10-15T11:00:00Z");
  add("message.replied", "b@x.com", { sender: "anna@send.com", campaignId: "c1", step: 0, gmailId: "g2", label: "negative" }, "2026-10-13T10:00:00Z");
  add("message.bounced", "c@x.com", { sender: "anna@send.com", campaignId: "c1", step: 0, code: "5.1.1" }, "2026-10-12T08:05:00Z");
  add("message.sending", "d@y.com", { from: "boris@other.com", campaignId: "c1", step: 0, subject: "uk traffic", variantIds: { group: "A", "subject.0": 1 } }, "2026-10-12T09:00:00Z");
  add("message.sent", "d@y.com", { from: "boris@other.com", campaignId: "c1", step: 0 }, "2026-10-12T09:00:01Z");
  add("message.bounced", "d@y.com", { sender: "boris@other.com", campaignId: "c1", step: 0, code: "4.2.2" }, "2026-10-12T09:05:00Z");
  add("contact.unsubscribed", "d@y.com", { sender: "boris@other.com", campaignId: "c1", step: 0, via: "one-click" }, "2026-10-12T12:00:00Z");
  add("message.autoreplied", "a@x.com", { sender: "anna@send.com", campaignId: "c1", step: 0 }, "2026-10-12T08:10:00Z");
  return rows;
}

test("щоденний звіт по сендеру: перші листи й фолоуапи, bounce за кодами, відповіді, позитивні (з виправленою міткою), автовідповіді, відписки", () => {
  const { senders, domains } = senderDailyReport(story());
  const anna12 = senders.find((row) => row.sender === "anna@send.com" && row.day === "2026-10-12");
  assert.deepEqual([anna12.sent, anna12.firsts, anna12.followups, anna12.bounces, anna12.bounceRate, anna12.autoreplies], [3, 3, 0, 1, 33.3, 1]);
  assert.deepEqual(anna12.bounceCodes, { "5.1.1": 1 });
  const anna15 = senders.find((row) => row.sender === "anna@send.com" && row.day === "2026-10-15");
  assert.deepEqual([anna15.sent, anna15.followups, anna15.replies, anna15.positive], [2, 2, 1, 1], "людина змінила мітку на «позитивна» — звіт рахує її");
  const anna13 = senders.find((row) => row.day === "2026-10-13");
  assert.deepEqual([anna13.replies, anna13.positive], [1, 0]);
  const boris = senders.find((row) => row.sender === "boris@other.com");
  assert.deepEqual([boris.sent, boris.bounceCodes, boris.unsubscribes], [1, { "4.2.2": 1 }, 1]);
  const send12 = domains.find((row) => row.domain === "send.com" && row.day === "2026-10-12");
  assert.deepEqual([send12.senders, send12.sent], [1, 3]);
  assert.equal(senderDailyReport(story(), { from: "2026-10-14" }).senders.every((row) => row.day >= "2026-10-14"), true);
  for (const row of [...senders, ...domains]) {
    assert.equal(Object.keys(row).some((key) => /open|click/i.test(key)), false, "відкриттів і кліків у звіті немає й не буде");
  }
});

test("звіт по кампанії: частка відповідей і позитивних на людину; внесок кожного кроку; розбивка за темою, версією тексту й джерелом", () => {
  const sources = { "c1|a@x.com": "Apollo", "c1|b@x.com": "Apollo", "c1|c@x.com": "Clay", "c1|d@y.com": "Clay" };
  const [report] = campaignReport(story(), { campaigns: [{ id: "c1", name: "UK operators" }], sourceOf: (campaignId, email) => sources[`${campaignId}|${email}`] });
  assert.equal(report.name, "UK operators");
  assert.deepEqual([report.people, report.replied, report.positive, report.replyRate, report.positiveRate, report.bounced, report.unsubscribed], [4, 2, 1, 50, 25, 1, 1]);
  assert.deepEqual(report.steps.map((row) => [row.step, row.sent, row.replied, row.positive, row.shareOfReplies]), [[1, 4, 1, 0, 50], [2, 2, 1, 1, 50]], "другий лист приніс половину відповідей і єдину позитивну");
  assert.deepEqual(Object.fromEntries(report.bySubject.map((row) => [row.subject, [row.people, row.replied]])), { "uk traffic": [3, 1], "a question": [1, 1] });
  assert.deepEqual(Object.fromEntries(report.byVariant.map((row) => [row.variant, row.people])), { "group=A subject.0=1": 3, "group=B subject.0=2": 1 });
  assert.deepEqual(Object.fromEntries(report.bySource.map((row) => [row.source, [row.people, row.replied, row.positive]])), { Apollo: [2, 2, 1], Clay: [2, 0, 0] });
  assert.equal(variantKey({ body: 2, group: "B", empty: "" }), "body=2 group=B");
});

test("CSV для таблиць: заголовок, коди bounce в одній клітинці, лапки там, де треба", () => {
  const csv = toCsv([{ sender: "a@x.com", note: 'say "hi", ok', codes: { "5.1.1": 2, "4.2.2": 1 } }], ["sender", "note", "codes"]);
  assert.equal(csv, 'sender,note,codes\na@x.com,"say ""hi"", ok",5.1.1:2 4.2.2:1\n');
});

// ── строк зберігання ──────────────────────────────────────────────────────

const ENROLLED = (email, status, lastAt) => ({
  id: `e-${email.length}-${status}`, campaignId: "c1", email, status, sender: "anna@send.com", step: 2, enrolledAt: "2025-01-01T00:00:00Z",
  lastSent: lastAt ? { at: lastAt, messageId: "<m@x>", subject: "s" } : null, stoppedAt: null,
  lead: { email, name: "Ivan Petrov", company: "Acme", position: "CMO", country: "UK", timezone: "Europe/London", source: "Apollo", sourceDate: "2024-12-01" }
});

test("строк зберігання: неактивні (завершені чи зупинені) і без руху довше за строк — так; живі ланцюжки — ніколи", () => {
  const now = new Date("2026-10-10T00:00:00Z");
  const rows = [
    ENROLLED("old-done@x.com", "done", "2025-06-01T00:00:00Z"),
    ENROLLED("old-stopped@x.com", "stopped", "2025-06-01T00:00:00Z"),
    ENROLLED("fresh-done@x.com", "done", "2026-09-01T00:00:00Z"),
    ENROLLED("old-active@x.com", "active", "2025-06-01T00:00:00Z"),
    ENROLLED("old-paused@x.com", "paused", "2025-06-01T00:00:00Z"),
    { ...ENROLLED("x@x.com", "done", "2025-06-01T00:00:00Z"), email: anonymousId("x@x.com") }
  ];
  assert.deepEqual(dueForRetention(rows, { now, days: 365 }).map((row) => row.email), ["old-done@x.com", "old-stopped@x.com"]);
  assert.equal(retentionDays({}), DEFAULT_RETENTION_DAYS);
  assert.equal(retentionDays({ ESP_RETENTION_DAYS: "180" }), 180);
  assert.equal(retentionDays({ ESP_RETENTION_DAYS: "3" }), DEFAULT_RETENTION_DAYS, "менше 30 днів — помилка, не правило");
});

test("анонімізація: адреса — односторонній хеш, ім'я, компанія, посада й пояс зникають; країна й джерело лишаються для звітів", () => {
  const out = anonymize({ ...ENROLLED("Ivan@Acme.com", "stopped", "2025-06-01T00:00:00Z"), pausedBecause: "olga@acme.com" });
  assert.equal(out.email, anonymousId("ivan@acme.com"));
  assert.match(out.email, /^anon:[0-9a-f]{32}$/);
  assert.deepEqual(out.lead, { email: out.email, country: "UK", source: "Apollo", sourceDate: "2024-12-01" });
  assert.deepEqual(out.lastSent, { at: "2025-06-01T00:00:00Z" }, "тема й id листа теж ідуть");
  assert.ok(out.anonymizedAt);
  assert.equal(/ivan|olga|acme|petrov|cmo|london/i.test(JSON.stringify(out)), false, "ні цієї людини, ні колеги, через якого її зупинили");
});

test("прогін строку зберігання: анонімізує належне, пише рядок без адрес, вдруге за день не біжить; виключення лишаються", async () => {
  let rows = [ENROLLED("old@x.com", "done", "2025-06-01T00:00:00Z"), ENROLLED("live@x.com", "active", "2025-06-01T00:00:00Z")];
  const campaigns = { enrollments: () => rows, saveEnrollment: async (row) => { rows = rows.map((item) => (item.id === row.id ? row : item)); } };
  await append({ type: "contact.unsubscribed", contact: "old@x.com", data: { via: "reply" } });
  const now = new Date("2026-10-10T08:00:00Z");
  const first = await runRetention({ campaigns, now });
  assert.equal(first.anonymized, 1);
  assert.equal(rows[0].email, anonymousId("old@x.com"));
  assert.equal(rows[1].email, "live@x.com");
  const line = (await allEntries()).find((entry) => entry.type === "retention.anonymized");
  assert.deepEqual(line.data.ids, [anonymousId("old@x.com")]);
  assert.equal(JSON.stringify(line).includes("old@x.com"), false, "у журналі — хеш, не адреса");
  assert.equal((await runRetention({ campaigns, now })).skipped, true);
  assert.ok((await exclusions()).has("old@x.com"), "відписка лишається назавжди");
});

test("хронологія анонімізованої людини: що й коли — видно, її слова — ні", async () => {
  await append({ type: "message.replied", contact: "old@x.com", data: { sender: "anna@send.com", text: "Yes, call me on +44 7700 900123", subject: "Re: hi" } });
  await append({ type: "retention.anonymized", actor: "esp-retention", data: { count: 1, ids: [anonymousId("old@x.com")] } });
  let captured = null;
  await handleEspDataApi({
    request: { method: "GET" }, response: {}, url: new URL("http://x/api/esp/contacts/timeline?email=old@x.com"),
    sendJson: (_r, status, payload) => { captured = { status, payload }; }, readJson: async () => null,
    profile: { email: "admin@x.com", role: "admin" }
  });
  assert.equal(captured.payload.anonymized, true);
  const [event] = captured.payload.events;
  assert.equal(event.type, "message.replied");
  assert.equal(event.data.redacted, true);
  assert.equal(JSON.stringify(captured.payload).includes("7700"), false);
  assert.equal(redactFor({ type: "x", contact: "other@x.com", data: { text: "hi" } }, new Set()).data.text, "hi");
});

test("маршрути: звіти — команді, CSV — файлом; анонімізувати — лише адміністратор, і це в журналі дій", async () => {
  for (const row of story()) await append({ type: row.type, contact: row.contact, data: row.data });
  let rows = [ENROLLED("old@x.com", "done", "2025-06-01T00:00:00Z")];
  const esp = { campaigns: { list: () => [{ id: "c1", name: "UK operators" }], enrollments: () => rows, saveEnrollment: async (row) => { rows = [row]; } } };
  const call = async (method, path, role = "seller") => {
    let captured = null;
    const response = { writeHead: (status, headers) => { captured = { status, headers, csv: "" }; }, end: (body) => { captured.csv = body; } };
    await handleEspApi({
      request: { method, auth: { profile: { email: `${role}@x.com`, role } } }, response, url: new URL(`http://x/api/esp${path}`),
      sendJson: (_r, status, payload) => { captured = { status, payload }; }, readJson: async () => ({}), esp
    });
    return captured;
  };
  assert.deepEqual(
    [espRouteRight("GET", "/reports/senders"), espRouteRight("GET", "/reports/campaigns"), espRouteRight("GET", "/retention"), espRouteRight("POST", "/retention/run")],
    ["replies.read", "replies.read", "replies.read", "access.manage"]
  );
  const senders = await call("GET", "/reports/senders");
  assert.equal(senders.status, 200);
  assert.ok(senders.payload.senders.length > 0);
  const campaigns = await call("GET", "/reports/campaigns");
  assert.equal(campaigns.payload.campaigns[0].name, "UK operators");
  const csv = await call("GET", "/reports/senders?format=csv&by=domain");
  assert.match(csv.headers["Content-Type"], /text\/csv/);
  assert.match(csv.csv, /^﻿day,domain,sent/);
  assert.equal((await call("POST", "/retention/run")).status, 403);
  const preview = await call("GET", "/retention");
  assert.deepEqual([preview.payload.days, preview.payload.due], [365, 1]);
  const ran = await call("POST", "/retention/run", "admin");
  assert.equal(ran.payload.anonymized, 1);
  assert.ok((await allEntries()).some((entry) => entry.type === "admin.retention_run" && entry.actor === "admin@x.com"));
});
