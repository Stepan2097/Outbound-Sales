import { allEntries, append } from "./journal.mjs";
import { blocklists as checkBlocklists, checkDomain, registry } from "./registry.mjs";

/**
 * ESP 15 — the monitoring a person would otherwise have to remember to do.
 *
 * Checklist («Автопаузи і тривоги», P1):
 * - «Порівняння сендерів кампанії — 0 відповідей на 80–100 листів при живому
 *   напарнику → прапорець і пауза.»
 * - «Блоклисти щодня — Spamhaus DBL (потрібен ключ DQS), SURBL, Validity
 *   Heatwave — для всіх холодних доменів і advantage-agency.co. Будь-який
 *   лістинг → пауза домену, тривога.»
 * - «Монітор DNS — SPF, DKIM, DMARC, MX кожного домену: зникло чи змінилось →
 *   тривога.»
 *
 * Everything here *finds*; what is done about it goes through ESP 8's
 * `applyAlerts` — the same pause, the same `esp.alert` line, the same one-a-day
 * message to a person — so the team has one place where alarms come from.
 * Actions: `pause_sender` (as ESP 8's), `pause_domain`, and `alert` (an alarm
 * with nothing paused — a DNS record that changed may be somebody's deliberate
 * edit, and pausing on it would be guessing).
 *
 * The daily part (`runDailyMonitor`) is journalled: each domain's DNS and
 * blocklists as `domain.checked` (the same line the registry shows), and the
 * run itself as `esp.monitor`, so a second run the same day is skipped and the
 * screen can say when the last one was.
 */

export const COMPARE_MIN_SENT = 80;

/** Domains watched besides the registry's: the company's own, whose reputation every cold domain borrows. */
export function watchedExtraDomains(env = process.env) {
  return String(env.ESP_MONITOR_DOMAINS ?? "advantage-agency.co").split(/[,\s]+/).map((value) => value.trim().toLowerCase()).filter(Boolean);
}

/**
 * Two senders on one campaign, one of them answered and the other not at all
 * after 80+ letters: the silent one's letters are not arriving. Compared per
 * campaign, because a campaign's people are one audience — a quiet sender on a
 * quiet campaign is the campaign, not the sender.
 */
export function compareSenders({ entries, campaigns, minSent = COMPARE_MIN_SENT }) {
  const actions = [];
  const sentBy = new Map();
  const ownerOf = new Map();
  for (const entry of entries) {
    if (entry.type !== "message.sent" || !entry.data?.campaignId) continue;
    const key = `${entry.data.campaignId}|${entry.data.from}`;
    sentBy.set(key, (sentBy.get(key) || 0) + 1);
    ownerOf.set(`${entry.data.campaignId}|${entry.contact}`, entry.data.from);
  }
  const repliesBy = new Map();
  for (const entry of entries) {
    if (entry.type !== "message.replied") continue;
    const campaignId = entry.data?.campaignId;
    const sender = entry.data?.sender || (campaignId ? ownerOf.get(`${campaignId}|${entry.contact}`) : null);
    if (!campaignId || !sender) continue;
    const key = `${campaignId}|${sender}`;
    repliesBy.set(key, (repliesBy.get(key) || 0) + 1);
  }
  for (const campaign of campaigns) {
    if (campaign.state !== "running") continue;
    const senders = [...new Set([...sentBy.keys()].filter((key) => key.startsWith(`${campaign.id}|`)).map((key) => key.split("|")[1]))];
    const answered = senders.filter((sender) => (repliesBy.get(`${campaign.id}|${sender}`) || 0) > 0);
    if (!answered.length) continue;
    for (const sender of senders) {
      const sent = sentBy.get(`${campaign.id}|${sender}`) || 0;
      if (sent < minSent || (repliesBy.get(`${campaign.id}|${sender}`) || 0) > 0) continue;
      const partner = answered[0];
      actions.push({
        kind: "pause_sender", email: sender, code: "no_replies_vs_partner",
        key: `sender:${sender}:no_replies_vs_partner:${campaign.id}`,
        reason: `0 відповідей на ${sent} листів у кампанії «${campaign.name}», а ${partner} там же отримує відповіді (${repliesBy.get(`${campaign.id}|${partner}`)}) — схоже, листи цієї скриньки не доходять`
      });
    }
  }
  return actions;
}

const DNS_FIELDS = ["mx", "spf", "dmarc", "dkim"];

function dnsValue(checks, field) {
  const value = checks?.[field];
  if (value === null || value === undefined || value === false) return null;
  return Array.isArray(value) ? [...value].sort().join(" ") : String(value);
}

/** What changed between two DNS snapshots of a domain: a record that vanished, appeared differently, or never was. */
export function dnsChanges(before, after) {
  const changes = [];
  for (const field of DNS_FIELDS) {
    if (field === "dkim" && !after?.dkimSelector) continue;
    const was = dnsValue(before, field);
    const now = dnsValue(after, field);
    if (was && !now) changes.push({ field, change: "missing", was });
    else if (was && now && was !== now) changes.push({ field, change: "changed", was, now });
  }
  return changes;
}

/**
 * Validity Heatwave — the blocklist of domains built by synthetic warming. Its
 * DNS zone (`bl.validity.tools`) answers only Validity's partners, but the
 * public lookup does not: `lookup.validity.tools/?domain=` says «Listed» or
 * «Not currently listed» for the exact domain, and robots.txt allows it. A few
 * domains once a day is what a person checking by hand would load.
 *
 * Read from the page: the first status pill is the verdict for the domain asked
 * (`status-listed` / `status-clear`); the related-domains table below comes
 * after it. A page without that pill — Validity changed it, or answered with an
 * error — is «не перевірено», never «чисто».
 */
export const HEATWAVE_LOOKUP = "https://lookup.validity.tools/";

export function readHeatwavePage(html) {
  const pill = /class="status-pill[^"]*\bstatus-(listed|clear)\b/.exec(String(html || ""));
  if (!pill) return { status: "not_checked", why: "сторінка Validity Heatwave не дала вердикту" };
  if (pill[1] === "clear") return { status: "clean" };
  const classification = /Classification<\/div>\s*<div[^>]*>(?:\s*<i[^>]*><\/i>)?\s*([^<]{1,60})</.exec(html)?.[1]?.trim() || "";
  return { status: "listed", ...(classification ? { classification } : {}) };
}

export function heatwaveChecker(env = process.env, fetchImpl = globalThis.fetch) {
  return async (domain) => {
    if (env.ESP_HEATWAVE === "off") return { status: "not_checked", why: "перевірку Heatwave вимкнено (ESP_HEATWAVE=off)" };
    try {
      const response = await fetchImpl(`${HEATWAVE_LOOKUP}?domain=${encodeURIComponent(domain)}`, {
        headers: { "User-Agent": "advantage-outbound-monitor (daily check of own sending domains)" },
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) return { status: "not_checked", why: `Validity Heatwave відповів ${response.status}` };
      return readHeatwavePage(await response.text());
    } catch (error) {
      return { status: "not_checked", why: `Validity Heatwave недоступний: ${error?.name === "TimeoutError" ? "немає відповіді за 20 с" : error?.message || "помилка мережі"}` };
    }
  };
}

/**
 * The once-a-day pass: every non-retired domain in the registry plus the
 * company's own — DNS (compared with the last snapshot) and blocklists. Returns
 * the actions for `applyAlerts`. A second call the same day (UTC) does nothing
 * unless `force`.
 */
export async function runDailyMonitor({
  now = new Date(), force = false, env = process.env, dns, heatwave = heatwaveChecker(env), actor = "esp-monitor"
} = {}) {
  const entries = await allEntries();
  const today = now.toISOString().slice(0, 10);
  const ranToday = entries.some((entry) => entry.type === "esp.monitor" && String(entry.at).startsWith(today));
  if (ranToday && !force) return { skipped: true, actions: [], domains: [] };

  const { domains } = await registry();
  const watched = [
    ...domains.filter((domain) => domain.status !== "retired").map((domain) => ({ domain: domain.domain, registered: true, previous: domain.checks, selector: domain.checks?.dkimSelector || "" })),
    ...watchedExtraDomains(env).filter((name) => !domains.some((domain) => domain.domain === name)).map((name) => ({ domain: name, registered: false, previous: lastExtraSnapshot(entries, name), selector: "" }))
  ];

  const actions = [];
  const report = [];
  for (const item of watched) {
    let checks;
    if (item.registered) {
      checks = await checkDomain({ domain: item.domain, dkimSelector: item.selector }, actor, dns, env);
    } else {
      // Not in the registry, so not something to pause — but its DNS and
      // listings are watched all the same, and kept as their own line.
      const lists = await checkBlocklists(item.domain, dns, env);
      checks = await snapshotOf(item.domain, dns, lists);
      await append({ type: "esp.monitor.domain", actor, data: { domain: item.domain, checks } });
    }
    checks.blocklists = { ...(checks.blocklists || {}), heatwave: await heatwave(item.domain) };

    const listed = Object.entries(checks.blocklists || {}).filter(([name, result]) => name !== "listed" && result?.status === "listed").map(([name]) => name);
    if (listed.length) {
      actions.push({
        kind: item.registered ? "pause_domain" : "alert", domain: item.domain, code: "blocklisted",
        key: `domain:${item.domain}:blocklisted:${listed.join(",")}`,
        reason: `${item.domain} у блоклисті: ${listed.join(", ")}${item.registered ? " — домен на паузі" : ""}`
      });
    }
    const changes = item.previous ? dnsChanges(item.previous, checks) : [];
    if (changes.length) {
      actions.push({
        kind: "alert", domain: item.domain, code: "dns_changed",
        key: `domain:${item.domain}:dns:${changes.map((row) => `${row.field}-${row.change}`).join(",")}:${today}`,
        reason: `DNS ${item.domain}: ${changes.map((row) => row.change === "missing" ? `${row.field.toUpperCase()} зник (було: ${row.was})` : `${row.field.toUpperCase()} змінився (було: ${row.was}; тепер: ${row.now})`).join("; ")}`
      });
    }
    report.push({ domain: item.domain, registered: item.registered, listed, changes });
  }
  await append({ type: "esp.monitor", actor, data: { day: today, domains: report.map((row) => row.domain), alarms: actions.length } });
  return { skipped: false, actions, domains: report };
}

function lastExtraSnapshot(entries, domain) {
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    if (entries[at].type === "esp.monitor.domain" && entries[at].data?.domain === domain) return entries[at].data.checks;
  }
  return null;
}

async function snapshotOf(domain, dns, lists) {
  const { resolveMx, resolveTxt } = dns || await import("node:dns/promises");
  const txt = async (name) => { try { return (await resolveTxt(name)).map((parts) => parts.join("")); } catch { return []; } };
  const [mx, root, dmarc] = await Promise.all([
    resolveMx(domain).then((rows) => rows.map((row) => row.exchange)).catch(() => []), txt(domain), txt(`_dmarc.${domain}`)
  ]);
  return {
    mx: mx.length ? mx : null,
    spf: root.find((line) => /^v=spf1\b/i.test(line)) || null,
    dmarc: dmarc.find((line) => /^v=DMARC1\b/i.test(line)) || null,
    dkimSelector: null, dkim: null, blocklists: lists
  };
}
