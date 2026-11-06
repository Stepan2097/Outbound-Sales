import { resolveMx } from "node:dns/promises";

import { recentContactBlocks } from "./company.mjs";
import { allEntries, append, contactKey, erasureKey } from "./journal.mjs";

/**
 * The checks every letter passes before it goes (ESP 6).
 *
 * Checklist, «Перевірки перед відправкою», P0:
 *
 * - **Global exclusions, before every letter** — not only when a list is
 *   loaded. Unsubscribes, a «no», hard bounces, complaints, clients and partners
 *   are excluded for good. An exclusion is an address or a whole domain
 *   (`@client.com`), written once and never lifted (`exclusion.added` in the
 *   journal), and the journal's own unsubscribes and 5.x.x bounces count without
 *   anybody having to copy them over.
 * - **Verification no older than 30 days** — otherwise the lead does not go and
 *   is marked for re-checking (`needsRecheck`).
 * - **Pilot filters** — no catch-all, no role addresses (abuse@, postmaster@,
 *   admin@…), no @icloud.com (nor Apple's other domains), only recipients whose
 *   mail is on Google (their domain's MX).
 * - **Country filter** — a configurable list of excluded countries; now Germany.
 *   A lead whose country is not known does not go either: the filter cannot say
 *   it is not one of them. The list's changes are journal lines with their author.
 * - **The lead's source is required** — no source and date it was obtained, no letter.
 *
 * `checkLead` answers `{ ok, reason, detail, permanent, needsRecheck }` with the
 * first reason found. An exclusion's reason is its category (`unsubscribed`,
 * `hard_bounce`, `no`, `complaint`, `client`, `partner`). `permanent` means the
 * lead never goes (an exclusion, a role address, a country); otherwise fixing
 * the data — a source, a fresh verification — lets it through.
 *
 * At enrolment only what will never change is refused (and the 90-day rule);
 * the rest is enrolled and waits — the chain checks again before every letter
 * and marks it for re-checking (`enrollment.recheck`).
 */

export const VERIFICATION_MAX_DAYS = 30;
export const DEFAULT_EXCLUDED_COUNTRIES = ["DE"];
export const EXCLUSION_CATEGORIES = {
  unsubscribed: "відписався",
  no: "сказав «ні»",
  hard_bounce: "hard bounce",
  complaint: "скарга",
  client: "клієнт",
  partner: "партнер"
};

/** The first part of an address that is a mailbox for a function, not a person. */
export const ROLE_LOCAL_PARTS = new Set([
  "abuse", "postmaster", "admin", "administrator", "hostmaster", "webmaster", "root", "noc", "security",
  "info", "support", "help", "sales", "marketing", "contact", "office", "hello", "team", "billing",
  "accounts", "accounting", "finance", "hr", "jobs", "careers", "press", "media", "legal", "privacy",
  "compliance", "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "newsletter", "enquiries", "inquiries"
]);

/** Apple's consumer mail. */
export const BLOCKED_RECIPIENT_DOMAINS = new Set(["icloud.com", "me.com", "mac.com"]);

/** What a «Google mail» MX looks like: aspmx.l.google.com, alt1.aspmx.l.google.com, smtp.google.com, googlemail. */
const GOOGLE_MX = /(^|\.)(google\.com|googlemail\.com)\.?$/i;

/** Country names and codes that mean the same country. Only those the filter is asked about need to be here. */
const COUNTRY_ALIASES = {
  DE: ["de", "deu", "germany", "deutschland", "німеччина", "германия"],
  PL: ["pl", "pol", "poland", "polska", "польща", "польша"],
  AT: ["at", "aut", "austria", "österreich", "osterreich", "австрія", "австрия"],
  DK: ["dk", "dnk", "denmark", "danmark", "данія", "дания"],
  CZ: ["cz", "cze", "czechia", "czech republic", "česko", "чехія", "чехия"],
  ES: ["es", "esp", "spain", "españa", "espana", "іспанія", "испания"],
  IT: ["it", "ita", "italy", "italia", "італія", "италия"],
  NL: ["nl", "nld", "netherlands", "the netherlands", "nederland", "holland", "нідерланди", "нидерланды"],
  CA: ["ca", "can", "canada", "канада"],
  UK: ["uk", "gb", "gbr", "united kingdom", "great britain", "england", "scotland", "wales", "британія", "великобританія"],
  US: ["us", "usa", "united states", "united states of america", "сша"],
  UA: ["ua", "ukr", "ukraine", "україна", "украина"]
};
const COUNTRY_TLD = { DE: "de", PL: "pl", AT: "at", DK: "dk", CZ: "cz", ES: "es", IT: "it", NL: "nl", CA: "ca", UK: "uk", UA: "ua" };

/** A country as a code from the list above, or the cleaned text when it is not one of them, or "" when unknown. */
export function countryCode(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  for (const [code, names] of Object.entries(COUNTRY_ALIASES)) if (names.includes(text)) return code;
  return text.toUpperCase();
}

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/** An exclusion key: an address, or `@domain` for a whole company. */
export function exclusionKey(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (/^@[a-z0-9.-]+\.[a-z]{2,63}$/.test(text)) return text;
  return contactKey(text);
}

/**
 * The global exclusion list, from the journal: added ones, plus every
 * unsubscribe and hard bounce the journal already holds — those need nobody to
 * copy them across, and must not wait for anybody to.
 */
export async function exclusions(entries = null) {
  const list = new Map();
  for (const entry of entries ?? await allEntries()) {
    if (entry.type === "exclusion.added") {
      const key = entry.data?.key;
      if (key && !list.has(key)) list.set(key, { key, category: entry.data.category, note: entry.data.note || "", at: entry.at, actor: entry.actor });
    } else if (entry.type === "contact.unsubscribed" && entry.contact && !list.has(entry.contact)) {
      list.set(entry.contact, { key: entry.contact, category: "unsubscribed", note: entry.data?.via || "", at: entry.at, actor: entry.actor });
    } else if (entry.type === "message.bounced" && entry.contact && /^5\./.test(String(entry.data?.code || "")) && !list.has(entry.contact)) {
      list.set(entry.contact, { key: entry.contact, category: "hard_bounce", note: entry.data.code, at: entry.at, actor: entry.actor });
    } else if (entry.type === "contact.erased" && entry.data?.key && !list.has(entry.data.key)) {
      // ESP 17: a person who asked to be forgotten stays out — by the hash of their address.
      list.set(entry.data.key, { key: entry.data.key, category: "erased", note: "видалено на прохання людини", at: entry.at, actor: entry.actor });
    }
  }
  return list;
}

/** Add somebody (or a whole domain) to the exclusions — for good. Adding twice is the first time. */
export async function addExclusion({ key, category, note = "" }, actor) {
  const clean = exclusionKey(key);
  if (!clean) throw fail("Виключення — адреса (ivan@acme.com) або цілий домен (@acme.com).");
  if (!EXCLUSION_CATEGORIES[category]) throw fail(`Причина виключення — одна з: ${Object.values(EXCLUSION_CATEGORIES).join(", ")}.`);
  if ((await exclusions()).has(clean)) return null;
  return append({ type: "exclusion.added", actor, contact: clean.startsWith("@") ? null : clean, data: { key: clean, category, note: String(note).slice(0, 300) } });
}

/** The excluded countries now: the newest `filters.countries` line, else Germany. */
export async function excludedCountries(entries = null) {
  let found = null;
  for (const entry of entries ?? await allEntries()) if (entry.type === "filters.countries") found = entry.data.countries;
  return Array.isArray(found) ? found : DEFAULT_EXCLUDED_COUNTRIES;
}

export async function setExcludedCountries(countries, actor) {
  const list = [...new Set((Array.isArray(countries) ? countries : String(countries ?? "").split(/[,;\s]+/))
    .map((value) => countryCode(value)).filter(Boolean))].sort();
  const now = await excludedCountries();
  if (list.join() === [...now].sort().join()) return null;
  return append({ type: "filters.countries", actor, data: { countries: list } });
}

const mxCache = new Map();
const MX_TTL_MS = 24 * 60 * 60 * 1000;

/** For tests, which change what DNS answers between cases. */
export function forgetMx() {
  mxCache.clear();
}

/** Whether a domain's mail goes to Google: `true`, `false`, or `null` when DNS gave no answer. */
export async function mailOnGoogle(domain, { dns = { resolveMx }, now = Date.now() } = {}) {
  const key = String(domain || "").toLowerCase();
  const held = mxCache.get(key);
  if (held && now - held.at < MX_TTL_MS) return held.value;
  let value;
  try {
    const rows = await dns.resolveMx(key);
    value = rows.length ? rows.every((row) => GOOGLE_MX.test(String(row.exchange || ""))) : false;
  } catch (error) {
    value = ["ENOTFOUND", "ENODATA"].includes(error?.code) ? false : null;
  }
  // A DNS that did not answer is asked again next time, not remembered as «no».
  if (value !== null) mxCache.set(key, { value, at: now });
  return value;
}

// Words a company name shares with half the industry — «Gaming» in a name says nothing about the domain.
const GENERIC_COMPANY_WORDS = new Set([
  "the", "and", "group", "limited", "ltd", "inc", "llc", "gmbh", "plc", "entertainment", "gaming", "games", "casino",
  "international", "technologies", "technology", "media", "online", "bet", "hotel", "resort", "partners", "digital"
]);
const plain = (value) => String(value ?? "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * An address that belongs to somebody else: its first part has none of the
 * person's names and its domain none of the company's. 06.11: 14 of 18 hard
 * bounces were such (Adam Davis · PokerStars at liam.ashton@beatport.com) — an
 * import shuffled the emails, and what did not bounce reached the wrong person.
 * `null` when there is no name or no company to compare with.
 */
export function foreignAddress(lead) {
  const email = contactKey(lead?.email);
  if (!email) return null;
  const [local, domain] = email.split("@");
  const names = [lead.name, lead.firstName, lead.lastName].flatMap((value) => plain(value).split(" ")).filter((word) => word.length >= 3);
  const company = plain(lead.company);
  const words = company.split(" ").filter((word) => word.length >= 3 && !GENERIC_COMPANY_WORDS.has(word));
  if (!names.length || !words.length) return null;
  const person = local.replace(/[^a-z0-9]/g, "");
  if (names.some((word) => person.includes(word))) return false;
  const site = plain(domain.split(".").slice(0, -1).join(" ")).replace(/ /g, "");
  const joined = company.replace(/ /g, "");
  return !(words.some((word) => site.includes(word)) || site.includes(joined) || (site.length >= 4 && joined.includes(site)));
}

const dayMs = 24 * 60 * 60 * 1000;
const validDate = (value) => /^\d{4}-\d{2}-\d{2}/.test(String(value ?? "")) && !Number.isNaN(Date.parse(value));

/**
 * One lead, against everything. `context` carries what is read once per pass:
 * the exclusions, the excluded countries and DNS.
 */
export async function checkLead(lead, { exclusions: excluded, countries, recontact = null, dns, now = new Date(), step = 0 } = {}) {
  const email = contactKey(lead?.email);
  const no = (reason, detail = "", extra = {}) => ({ ok: false, reason, detail, permanent: false, needsRecheck: false, ...extra });
  if (!email) return no("not_an_email", "", { permanent: true });
  const [local, domain] = email.split("@");

  const list = excluded ?? await exclusions();
  const hit = list.get(email) || list.get(`@${domain}`) || list.get(erasureKey(email));
  if (hit) return no(hit.category, `у виключеннях: ${EXCLUSION_CATEGORIES[hit.category] || SKIP_REASON_LABEL[hit.category] || hit.category}${hit.key.startsWith("@") ? ` (увесь домен ${hit.key})` : ""}`, { permanent: true, excluded: true });

  // ESP 13's rule, checked with the rest: somebody who once answered is not put
  // into a sequence again, and somebody written to in the last 90 days without an
  // answer waits. Only for a first letter — a follow-up is the conversation itself.
  const again = step === 0 && recontact ? recontact(email) : null;
  if (again) return no(again, again === "replied_before" ? "колись відповідав — не в нову розсилку" : "писали менше 90 днів тому", { permanent: again === "replied_before" });

  if (!String(lead.source ?? "").trim() || !validDate(lead.sourceDate)) {
    return no("no_source", "без джерела й дати, коли людину отримано, лист не йде");
  }

  const banned = countries ?? await excludedCountries();
  const code = countryCode(lead.country);
  const tld = domain.split(".").at(-1);
  const byTld = banned.find((country) => COUNTRY_TLD[country] && COUNTRY_TLD[country] === tld);
  if (byTld) return no("country_excluded", byTld, { permanent: true });
  // Unknown country (owner 03.11): written to in European working hours; the domain's TLD above still catches an excluded country.
  if (banned.includes(code)) return no("country_excluded", code, { permanent: true });

  // Owner 03.11: «мені треба розіслати на всіх крім Microsoft» — service
  // addresses and mail outside Google go too (Microsoft is left out where
  // people are picked). 05.11: «відкидаємо тільки пошти в яких 80%+ впевнені
  // що вони погані» — catch-all and unchecked ones go too. What stays:
  // the exclusions, the 90 days, the source, excluded countries, blocked
  // domains and an address the check found does not exist.
  if (BLOCKED_RECIPIENT_DOMAINS.has(domain)) return no("blocked_domain", domain, { permanent: true });
  const status = String(lead.verification ?? "").trim().toLowerCase();
  if (status === "invalid") return no("invalid", "", { permanent: true });
  if (foreignAddress(lead)) return no("foreign_address", `${email} — ні ім'я, ні компанія (${lead.company}) не збігаються з поштою`, { permanent: true });

  return { ok: true, reason: null, detail: "", permanent: false, needsRecheck: false };
}

/** What is read once for a whole pass, so a hundred leads do not fold the journal a hundred times. */
export async function filterContext({ entries = null, dns, now = new Date() } = {}) {
  const all = entries ?? await allEntries();
  return { exclusions: await exclusions(all), countries: await excludedCountries(all), recontact: recentContactBlocks(all, { now }), dns, now };
}

/** Words for each reason, for the screen and the journal. */
export const SKIP_REASON_LABEL = {
  unsubscribed: "відписався — у виключеннях",
  no: "сказав «ні» — у виключеннях",
  hard_bounce: "hard bounce — у виключеннях",
  complaint: "скарга — у виключеннях",
  client: "клієнт — у виключеннях",
  partner: "партнер — у виключеннях",
  erased: "видалено на прохання людини — у виключеннях",
  no_source: "немає джерела й дати",
  country_excluded: "країна в списку виключених",
  country_unknown: "країна невідома",
  role_address: "службова адреса",
  blocked_domain: "домен Apple (icloud.com)",
  catch_all: "catch-all домен",
  invalid: "адреса недійсна",
  foreign_address: "пошта чужа — не збігається ні з ім'ям, ні з компанією",
  not_verified: "не перевірена — на повторну перевірку",
  verification_stale: "перевірка старша 30 днів — на повторну перевірку",
  mx_unknown: "DNS не відповів",
  not_google_mx: "пошта не на Google",
  not_an_email: "не адреса",
  replied_before: "колись відповідав",
  contacted_recently: "писали менше 90 днів тому"
};

/** Whether a verdict keeps somebody out of a campaign at enrolment, not only out of the next letter. */
export function refusedAtEnrolment(verdict) {
  return Boolean(verdict && !verdict.ok && (verdict.permanent || verdict.reason === "contacted_recently"));
}

/** The real checks, as the server wires them (`esp.filters`); tests pass their own DNS. */
export function defaultFilters({ dns } = {}) {
  return {
    context: (entries, now) => filterContext({ entries: entries ?? null, dns, now }),
    check: checkLead
  };
}
