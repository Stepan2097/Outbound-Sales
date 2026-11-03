/**
 * Робочі сигнали про компанію й людину для картки ліда (таск 92abd9df, 03.11.2026).
 *
 * Було: DuckDuckGo довгими запитами в лапках під мобільні студії (IDFA,
 * AppsFlyer) — 0 сигналів у 37 досьє. Тепер — вебпошук Claude через наявний
 * ANTHROPIC_API_KEY (рішення: без нового постачальника; дешева модель і кілька
 * пошуків на компанію). Що шукати, залежить від продукту кампанії: для iGaming —
 * ліцензії, нові бренди, виходи на ринки, вакансії affiliate manager і media
 * buyer, конференції; без IDFA й AppsFlyer.
 *
 * Модель лише знаходить; вирішує код: сигнал лишається, тільки коли його
 * посилання справді прийшло з пошуку (не вигадане), дата є і вона в межах
 * 90 днів, не в майбутньому.
 */

export const SIGNAL_WINDOW_DAYS = 90;
export const SIGNAL_MODEL = "claude-haiku-5-5";
// $ за мільйон токенів (вхід/вихід) і за один пошук — для звіту про ціну.
const PRICES = { "claude-haiku-5-5": [0.1, 0.5], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20] };
const SEARCH_PRICE = 0.01;
const MAX_SEARCHES = 5;

const IGAMING = /casino|igaming|i-gaming|gambl|\bbet|sportsbook|bookmaker|slot|poker|lotto|lottery|bingo|jackpot|operator|казино|беттінг|гемблінг|affiliate/i;
const MOBILE = /mobile game|game studio|apps? studio|publisher|idfa|appsflyer|in-app|ігор|студі/i;

/** What kind of company the campaign's product sells to: iGaming operators, mobile apps, or anybody. */
export function productKind({ product = "", company = "", industry = "" } = {}) {
  const text = `${product} ${industry} ${company}`;
  if (IGAMING.test(text)) return "igaming";
  if (MOBILE.test(text)) return "mobile";
  return "generic";
}

const LOOK_FOR = {
  igaming: [
    "new or renewed gambling licences (MGA, UKGC, Curaçao/CGA, Anjouan, state regulators)",
    "new casino or sportsbook brands, relaunches, entry into new countries or markets",
    "job openings for affiliate manager, media buyer, user acquisition, CMO or marketing roles",
    "talks, panels or stands at iGaming conferences (SiGMA, ICE, iGB, SBC, Affiliate World)",
    "partnerships, platform or provider deals, acquisitions, funding"
  ],
  mobile: [
    "new app or game launches and major updates",
    "job openings for user acquisition, growth or monetization roles",
    "partnerships, acquisitions, funding",
    "talks at industry conferences"
  ],
  generic: [
    "product launches and announcements",
    "job openings in marketing, growth or sales",
    "partnerships, acquisitions, funding",
    "talks at industry conferences"
  ]
};

/** The brief the model searches by — what a seller wants to know before a call. */
export function signalBrief({ company, domain = "", person = "", title = "", kind = "generic", now = new Date() }) {
  const since = new Date(now.getTime() - SIGNAL_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const who = [company, domain && `(${domain})`].filter(Boolean).join(" ");
  return [
    `Find what happened at ${who} between ${since} and ${now.toISOString().slice(0, 10)}.`,
    `Look for: ${LOOK_FOR[kind].join("; ")}.`,
    person ? `Also anything public by or about ${person}${title ? `, ${title}` : ""} at this company in that period: interviews, talks, posts, quotes.` : "",
    "Use short searches (company name plus one topic word), not long quoted phrases. Prefer news sites, regulators, job boards and the company's own site.",
    "Only report a finding when the page you found shows it and you can tell its date. Skip anything older than the start date or about a different company with a similar name.",
    'Answer with JSON only: {"signals":[{"title":"short headline","url":"the page you found it on","date":"YYYY-MM-DD","type":"licence|brand_or_market|hiring|event|deal|person|other","fact":"one sentence, what happened"}]}. An empty list is a valid answer.'
  ].filter(Boolean).join("\n");
}

function jsonFrom(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function normalUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

const TYPE_TO_SIGNAL = {
  licence: "partnership_or_licensing", brand_or_market: "product_or_title", hiring: "hiring",
  event: "person_or_leadership", deal: "corporate_transaction", person: "person_or_leadership", other: "company_development"
};

/**
 * Keep what can be shown with a straight face: a page that search returned,
 * a real date within the window. Shaped like the dossier's old results so the
 * rest of the app (drafts, scoring, the company card) reads them unchanged.
 */
export function acceptSignals(rows, { foundUrls, now = new Date() }) {
  const from = now.getTime() - SIGNAL_WINDOW_DAYS * 86_400_000;
  const seen = new Set();
  const kept = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = normalUrl(row?.url);
    if (!url || seen.has(url) || !foundUrls.has(url)) continue;
    const at = Date.parse(`${String(row.date || "").slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(at) || at < from || at > now.getTime() + 86_400_000) continue;
    seen.add(url);
    let publisher = "";
    try { publisher = new URL(url).hostname.replace(/^www\./, ""); } catch { /* checked above */ }
    kept.push({
      source_id: `signal-${Buffer.from(url).toString("base64url").slice(-10)}`,
      title: String(row.title || row.fact || "").trim().slice(0, 200),
      url,
      publisher,
      snippet: String(row.fact || "").trim().slice(0, 520),
      signal_type: TYPE_TO_SIGNAL[row.type] || "company_development",
      published_at: new Date(at).toISOString(),
      retrieved_at: now.toISOString(),
      date_status: "dated",
      confidence: 72,
      claim_type: "public_source_claim"
    });
  }
  return kept.sort((left, right) => right.published_at.localeCompare(left.published_at)).slice(0, 12);
}

/** Every URL the search actually returned in this response, and the queries it ran. */
function searchTrail(content) {
  const urls = new Set();
  const queries = [];
  for (const block of content || []) {
    if (block.type === "server_tool_use" && block.name === "web_search" && block.input?.query) queries.push(String(block.input.query));
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) if (result?.url) urls.add(normalUrl(result.url));
    }
    for (const citation of block.citations || []) if (citation?.url) urls.add(normalUrl(citation.url));
  }
  return { urls, queries };
}

/**
 * One company, searched by Claude. `post(body)` sends a Messages API request
 * and returns the parsed response — the server's own client, so the key, the
 * timeout and the spend log stay where they are.
 */
export async function researchSignals({ post, company, domain = "", person = "", title = "", product = "", industry = "", model = SIGNAL_MODEL, now = new Date() }) {
  const kind = productKind({ product, company, industry });
  const brief = signalBrief({ company, domain, person, title, kind, now });
  const messages = [{ role: "user", content: brief }];
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }];
  const usage = { input: 0, output: 0, searches: 0 };
  const content = [];
  let response;
  // The server-side search loop may pause; it resumes from the trailing tool use.
  for (let round = 0; round < 3; round += 1) {
    response = await post({ model, max_tokens: 6000, output_config: { effort: "low" }, tools, messages });
    usage.input += Number(response.usage?.input_tokens || 0);
    usage.output += Number(response.usage?.output_tokens || 0);
    usage.searches += Number(response.usage?.server_tool_use?.web_search_requests || 0);
    content.push(...(response.content || []));
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }
  const { urls, queries } = searchTrail(content);
  const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const answer = response?.stop_reason === "refusal" ? null : jsonFrom(text);
  const results = acceptSignals(answer?.signals, { foundUrls: urls, now });
  const [inPrice, outPrice] = PRICES[model] || [0, 0];
  const costUsd = Number(((usage.input * inPrice + usage.output * outPrice) / 1e6 + usage.searches * SEARCH_PRICE).toFixed(4));
  const proposed = Array.isArray(answer?.signals) ? answer.signals.length : 0;
  return {
    checkedAt: now.toISOString(),
    windowDays: SIGNAL_WINDOW_DAYS,
    source: "claude_web_search",
    kind,
    queries: queries.length ? queries : [brief.split("\n")[1]],
    results,
    gaps: results.length ? [] : [proposed
      ? `Пошук приніс ${proposed} знахідок, але жодна не має дати за ${SIGNAL_WINDOW_DAYS} днів і сторінки, яку пошук справді показав.`
      : `За ${SIGNAL_WINDOW_DAYS} днів у відкритих джерелах про компанію нічого не знайшлося.`],
    usage,
    costUsd
  };
}

/**
 * Posts from LinkedIn (Apify, «harvestapi/linkedin-company-posts», no cookies) as
 * signals: an operator's own page is where launches, licences, events and
 * hiring show up first, dated and linked. `kind` — whose posts: the company's
 * or the person's.
 */
export function postsToSignals(items, { kind = "company", now = new Date() } = {}) {
  const from = now.getTime() - SIGNAL_WINDOW_DAYS * 86_400_000;
  const kept = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const url = normalUrl(item?.linkedinUrl || item?.url || item?.shareLinkedinUrl);
    const at = Date.parse(item?.postedAt?.date || item?.postedAt || item?.date || "");
    const text = String(item?.content || item?.text || "").replace(/\s+/g, " ").trim();
    if (!url || seen.has(url) || !text || !Number.isFinite(at) || at < from || at > now.getTime() + 86_400_000) continue;
    seen.add(url);
    kept.push({
      source_id: `post-${Buffer.from(url).toString("base64url").slice(-10)}`,
      title: text.length > 110 ? `${text.slice(0, 107).replace(/\s+\S*$/, "")}…` : text,
      url,
      publisher: "linkedin.com",
      snippet: text.slice(0, 520),
      signal_type: kind === "person" ? "person_post" : "company_post",
      published_at: new Date(at).toISOString(),
      retrieved_at: now.toISOString(),
      date_status: "dated",
      confidence: 80,
      claim_type: "public_source_claim"
    });
  }
  return kept.sort((left, right) => right.published_at.localeCompare(left.published_at)).slice(0, 8);
}

export const LINKEDIN_POSTS_ACTOR = "harvestapi/linkedin-company-posts";

/**
 * Everything for one lead, from whichever sources are wired: the web (Claude),
 * the company's LinkedIn posts and the person's. A source that fails is said
 * in `gaps`, the others still count. `run(actor, input)` is the server's Apify
 * runner (items with `.run.costUsd`); `post(body)` its Messages API call.
 */
export async function collectSignals({ post = null, run = null, company, domain = "", person = "", title = "", companyLinkedin = "", personLinkedin = "", product = "", industry = "", now = new Date() }) {
  const searched = [];
  const gaps = [];
  let costUsd = 0;
  // Таск 10b3bb63 (суддя 03.11): «скільки пішло» — токени Claude й запуски Apify окремо.
  const spend = { tokens: 0, searches: 0, aiUsd: 0, apifyUsd: 0, apifyRuns: 0 };
  const web = post ? researchSignals({ post, company, domain, person, title, product, industry, now }).catch((error) => ({ failed: error.message })) : null;
  const posts = (url, kind) => (run && url ? run(LINKEDIN_POSTS_ACTOR, { targetUrls: [url], maxPosts: 10, postedLimit: "3months" }).then(
    (items) => ({ results: postsToSignals(items, { kind, now }), costUsd: Number(items?.run?.costUsd || 0) }),
    (error) => ({ failed: error.message })
  ) : null);
  const [webOut, companyOut, personOut] = await Promise.all([web, posts(companyLinkedin, "company"), posts(personLinkedin, "person")]);
  const company_ = [];
  const person_ = [];
  if (webOut) {
    if (webOut.failed) gaps.push(`Вебпошук не вдався: ${webOut.failed}`);
    else {
      company_.push(...webOut.results);
      searched.push(`вебпошук: ${webOut.queries.join("; ")}`);
      costUsd += webOut.costUsd;
      spend.tokens += Number(webOut.usage?.input || 0) + Number(webOut.usage?.output || 0);
      spend.searches += Number(webOut.usage?.searches || 0);
      spend.aiUsd += webOut.costUsd;
      if (!webOut.results.length) gaps.push(...webOut.gaps);
    }
  } else gaps.push("Вебпошук не підключено (немає ANTHROPIC_API_KEY).");
  if (companyOut) {
    if (companyOut.failed) gaps.push(`Пости компанії в LinkedIn не прочиталися: ${companyOut.failed}`);
    else {
      company_.push(...companyOut.results);
      searched.push(`пости компанії в LinkedIn (${companyLinkedin}) за 3 місяці`);
      costUsd += companyOut.costUsd;
      spend.apifyUsd += companyOut.costUsd;
      spend.apifyRuns += 1;
      if (!companyOut.results.length) gaps.push("Компанія за 3 місяці нічого не публікувала в LinkedIn.");
    }
  } else gaps.push(run ? "Сторінки компанії в LinkedIn немає — її пости не читали." : "Apify не підключено — пости LinkedIn не читали.");
  if (personOut) {
    if (personOut.failed) gaps.push(`Пости людини в LinkedIn не прочиталися: ${personOut.failed}`);
    else {
      person_.push(...personOut.results);
      searched.push(`пости ${person || "людини"} в LinkedIn за 3 місяці`);
      costUsd += personOut.costUsd;
      spend.apifyUsd += personOut.costUsd;
      spend.apifyRuns += 1;
      if (!personOut.results.length) gaps.push(`${person || "Людина"} за 3 місяці нічого не публікувала в LinkedIn.`);
    }
  } else if (run && person) gaps.push("Профілю людини в LinkedIn немає — її пости не читали.");
  const unique = (rows) => [...new Map(rows.map((row) => [row.url, row])).values()].sort((left, right) => right.published_at.localeCompare(left.published_at));
  return {
    checkedAt: now.toISOString(),
    windowDays: SIGNAL_WINDOW_DAYS,
    kind: webOut?.kind || productKind({ product, company, industry }),
    company: unique(company_).slice(0, 15),
    person: unique(person_).slice(0, 8),
    searched,
    gaps,
    costUsd: Number(costUsd.toFixed(4)),
    spend: { ...spend, aiUsd: Number(spend.aiUsd.toFixed(4)), apifyUsd: Number(spend.apifyUsd.toFixed(4)) }
  };
}
