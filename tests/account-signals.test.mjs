import assert from "node:assert/strict";
import test from "node:test";

import { acceptSignals, collectSignals, postsToSignals, productKind, researchSignals, signalBrief } from "../triage/account-signals.mjs";

const NOW = new Date("2026-11-03T12:00:00Z");

test("the search follows the campaign's product: iGaming asks for licences, brands and affiliate hiring — never IDFA or AppsFlyer", () => {
  assert.equal(productKind({ product: "Media buying for casino operators" }), "igaming");
  assert.equal(productKind({ company: "Betflag S.p.a." }), "igaming");
  assert.equal(productKind({ company: "Acme Studio", industry: "Mobile game studio" }), "mobile");
  assert.equal(productKind({ company: "Northwind" }), "generic");
  const brief = signalBrief({ company: "Betflag", domain: "betflag.it", person: "Anna", title: "CMO", kind: "igaming", now: NOW });
  assert.match(brief, /licen/i);
  assert.match(brief, /affiliate manager/);
  assert.match(brief, /SiGMA/);
  assert.match(brief, /2026-08-05/, "the window starts 90 days back");
  assert.doesNotMatch(brief, /IDFA|AppsFlyer/);
});

test("a finding stays only with a page the search returned and a date within 90 days", () => {
  const found = new Set(["https://news.example/betflag-licence", "https://jobs.example/affiliate"]);
  const kept = acceptSignals([
    { title: "New MGA licence", url: "https://news.example/betflag-licence/", date: "2026-10-20", type: "licence", fact: "Got an MGA licence." },
    { title: "Hiring", url: "https://jobs.example/affiliate", date: "2026-06-01", type: "hiring" },
    { title: "Invented", url: "https://made.up/page", date: "2026-10-30", type: "deal" },
    { title: "No date", url: "https://news.example/betflag-licence", type: "other" },
    { title: "Future", url: "https://jobs.example/affiliate", date: "2027-01-01", type: "hiring" }
  ], { foundUrls: found, now: NOW });
  assert.deepEqual(kept.map((row) => [row.title, row.published_at.slice(0, 10), row.signal_type]), [["New MGA licence", "2026-10-20", "partnership_or_licensing"]]);
  assert.equal(kept[0].url, "https://news.example/betflag-licence");
});

test("LinkedIn posts become dated, linked signals; old ones and empty ones are left out", () => {
  const items = [
    { linkedinUrl: "https://www.linkedin.com/posts/betflag_a", content: "We launched BetFlagLive in Potenza", postedAt: { date: "2026-08-25T12:46:24Z" } },
    { linkedinUrl: "https://www.linkedin.com/posts/betflag_b", content: "Old news", postedAt: { date: "2026-03-01T00:00:00Z" } },
    { linkedinUrl: "https://www.linkedin.com/posts/betflag_c", content: "", postedAt: { date: "2026-10-01T00:00:00Z" } }
  ];
  const rows = postsToSignals(items, { kind: "person", now: NOW });
  assert.deepEqual(rows.map((row) => [row.signal_type, row.published_at.slice(0, 10), row.publisher]), [["person_post", "2026-08-25", "linkedin.com"]]);
});

test("Claude's search: only the URLs it actually visited count, and the cost is the tokens plus the searches", async () => {
  const bodies = [];
  const post = async (body) => {
    bodies.push(body);
    return {
      stop_reason: "end_turn",
      usage: { input_tokens: 20000, output_tokens: 400, server_tool_use: { web_search_requests: 3 } },
      content: [
        { type: "server_tool_use", name: "web_search", input: { query: "Betflag licence" } },
        { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://news.example/b1", title: "x" }] },
        { type: "text", text: '{"signals":[{"title":"Licence","url":"https://news.example/b1","date":"2026-10-01","type":"licence","fact":"f"},{"title":"Fake","url":"https://nowhere.example","date":"2026-10-02","type":"deal"}]}' }
      ]
    };
  };
  const out = await researchSignals({ post, company: "Betflag", product: "casino", now: NOW });
  assert.equal(bodies[0].model, "claude-haiku-5-5");
  assert.equal(bodies[0].tools[0].type, "web_search_20250305");
  assert.deepEqual(out.results.map((row) => row.title), ["Licence"]);
  assert.deepEqual(out.queries, ["Betflag licence"]);
  assert.equal(out.costUsd, Number((20000 * 0.1 / 1e6 + 400 * 0.5 / 1e6 + 0.03).toFixed(4)));
});

test("all sources together: a failed one is said in the gaps, the others still count", async () => {
  const post = async () => ({ stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: '{"signals":[]}' }] });
  const run = async (_actor, input) => {
    if (input.targetUrls[0].includes("/in/")) throw new Error("rate limited");
    const items = [{ linkedinUrl: "https://www.linkedin.com/posts/co_1", content: "New brand launched", postedAt: { date: "2026-10-10T10:00:00Z" } }];
    Object.defineProperty(items, "run", { value: { costUsd: 0.002 } });
    return items;
  };
  const out = await collectSignals({ post, run, company: "Betflag", person: "Anna", companyLinkedin: "https://www.linkedin.com/company/betflag", personLinkedin: "https://www.linkedin.com/in/anna", now: NOW });
  assert.equal(out.company.length, 1);
  assert.equal(out.person.length, 0);
  assert.ok(out.gaps.some((row) => /Пости людини в LinkedIn не прочиталися: rate limited/.test(row)));
  assert.ok(out.searched.some((row) => /пости компанії в LinkedIn/.test(row)));
  assert.equal(out.costUsd, 0.002);

  const none = await collectSignals({ company: "Betflag", now: NOW });
  assert.deepEqual(none.gaps, ["Вебпошук не підключено (немає ANTHROPIC_API_KEY).", "Apify не підключено — пости LinkedIn не читали."]);
});
