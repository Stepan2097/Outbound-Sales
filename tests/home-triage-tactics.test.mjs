import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { draftsPromptPayload, normalizeDrafts, buildFallbackDrafts } from "../contacts/drafts.mjs";
import { AUTO_TACTIC, TACTICS, tacticData, tacticForPrompt, tacticOptions } from "../triage/tactics.mjs";

/**
 * Головна (власник 15.10): лист пишеться після того, як зібрано всі дані, і на
 * їхній основі; тактику листа можна вибрати — десять варіантів і «Сама вибере».
 * Тактика, для якої немає даних, недоступна з причиною: новина без новини —
 * вигадана подія.
 */

const research = {
  company: { summary: "Sportsbook in Brazil", products: ["Receba.bet"], apps: [], news: [{ title: "Receba launches casino", date: "2026-09-30" }], headquarters: "São Paulo" },
  linkedin: { friendOf: ["Chloe Stewart"], pendingWith: [] }
};
const product = { brief: { proof: "CPA down 32% for a LATAM operator", firstStep: "a two-week test on one GEO" } };

test("десять тактик, у кожної своя причина писати й своя умова", () => {
  assert.equal(TACTICS.length, 10);
  assert.equal(new Set(TACTICS.map((tactic) => tactic.id)).size, 10);
  for (const tactic of TACTICS) assert.ok(tactic.label && tactic.hint && tactic.instruction.length > 60, tactic.id);
});

test("що можна для цієї людини, а що ні — і чому", () => {
  const rich = tacticOptions(tacticData({ contact: { position: "CMO", country: "Brazil" }, research, product, event: "SiGMA World" }));
  assert.ok(rich.every((option) => option.available), JSON.stringify(rich.filter((option) => !option.available)));
  const bare = Object.fromEntries(tacticOptions(tacticData({ contact: {}, research: {}, product: {} })).map((option) => [option.id, option]));
  assert.equal(bare.question.available, true, "одне питання можна завжди");
  assert.equal(bare.news.available, false);
  assert.match(bare.news.why, /новин/);
  assert.match(bare.conference.why, /конференція/);
  assert.match(bare.linkedin.why, /друзях/);
});

test("вибрана тактика йде в промпт; неможлива — падає на «Сама вибере» з лише можливими", () => {
  const data = tacticData({ contact: { position: "CMO" }, research, product, event: "SiGMA World, Rome" });
  const conference = tacticForPrompt("conference", data);
  assert.equal(conference.id, "conference");
  assert.match(conference.instruction, /SiGMA World, Rome/);
  const noNews = tacticForPrompt("news", tacticData({ contact: {}, research: {}, product: {} }));
  assert.equal(noNews.id, AUTO_TACTIC);
  assert.ok(noNews.tactics.every((tactic) => tactic.id !== "news"));
  assert.ok(noNews.tactics.some((tactic) => tactic.id === "question"));
});

test("модель отримує зібрані дані й тактику; «Сама вибере» — каже, яку взяла", () => {
  const tactic = tacticForPrompt(AUTO_TACTIC, tacticData({ contact: {}, research, product }));
  const payload = draftsPromptPayload({ contact: { name: "Rodrigo", company: "Receba.bet" }, product: {}, language: "en", research, tactic });
  assert.deepEqual(payload.research.company.news[0].title, "Receba launches casino");
  assert.ok(payload.tactics.length > 3);
  assert.ok(payload.requiredJsonShape.tacticUsed);
  assert.match(payload.instruction, /research/);
  const plain = draftsPromptPayload({ contact: { name: "Rodrigo" }, product: {}, language: "en" });
  assert.equal(plain.research, undefined, "без даних — як раніше");
  const fallback = buildFallbackDrafts({ contact: {}, product: {} });
  assert.equal(normalizeDrafts({ tacticUsed: "news" }, fallback).tacticUsed, "news");
  assert.equal(normalizeDrafts({}, fallback).tacticUsed, undefined);
});

test("проводка: сервер готує наперед і пише лист останнім; картка показує підготовку й тактику", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /void prepareAhead\(/);
  assert.match(server, /url\.pathname === "\/api\/triage\/prepare"/);
  // The drafts step runs after emails, enrichment and the company.
  const pipeline = server.slice(server.indexOf("job.promise = prepSlot"), server.indexOf("function trimContactDrafts"));
  assert.ok(pipeline.indexOf('step("company"') < pipeline.indexOf('step("drafts"'));
  assert.ok(pipeline.indexOf('step("enrich"') < pipeline.indexOf('step("drafts"'));
  const page = await readFile(new URL("../app/screens/home-triage.js", import.meta.url), "utf8");
  assert.match(page, /data-triage="tactic"/);
  assert.match(page, /Усі контакти бази/);
  assert.match(page, /function watchPrep/);
  assert.doesNotMatch(page, /async function afterOpen/);
});
