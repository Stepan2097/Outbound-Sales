import { currentLabels } from "./replies.mjs";

/**
 * ESP 16 — the reports, from the journal alone.
 *
 * Checklist («Дані і звітність», P1):
 * - «Щоденний звіт по сендеру і домену — відправлені, bounce за кодами,
 *   відповіді, позитивні, відписки. Без відкриттів і кліків.»
 * - «Звіт по кампанії, версії тексту, темі, кроку, джерелу ліда — частка
 *   відповідей і позитивних. Внесок кожного кроку — щоб вирішити, чи потрібен
 *   третій лист.»
 *
 * There are no opens and no clicks here, and there never will be: the letters
 * carry no pixel and no rewritten link (ESP 2), so any such number would be
 * invented. What is counted is what the journal knows for certain — a letter
 * Gmail accepted, a reply that arrived, a bounce with its code, an unsubscribe.
 *
 * Rates are per person, not per letter: «replied» means this person answered
 * at some point in the chain, and a reply is credited to the step whose letter
 * it answered (`data.step` on the reply, as ESP 7 records it). That is the
 * number that says whether a third letter earns its place.
 */

const day = (iso) => String(iso || "").slice(0, 10);
const inc = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/** The label a reply carries now: the rule's first, or a person's correction. */
function labelOf(entry, labels) {
  return entry.data?.gmailId ? labels.get(entry.data.gmailId)?.label ?? entry.data?.label ?? null : entry.data?.label ?? null;
}

function emptyRow() {
  return { sent: 0, firsts: 0, followups: 0, bounces: 0, bounceCodes: {}, replies: 0, positive: 0, autoreplies: 0, unsubscribes: 0 };
}

/**
 * Per day, per sender and per domain: sent (first letters and follow-ups),
 * bounces by code, replies, positive replies, auto-replies, unsubscribes.
 * `from` / `to` are dates (YYYY-MM-DD), inclusive.
 */
export function senderDailyReport(entries, { from = "", to = "" } = {}) {
  const labels = currentLabels(entries);
  const rows = new Map();
  const row = (date, sender) => {
    const key = `${date}|${sender}`;
    if (!rows.has(key)) rows.set(key, { day: date, sender, domain: sender.split("@")[1] || "", ...emptyRow() });
    return rows.get(key);
  };
  for (const entry of entries) {
    const date = day(entry.at);
    if ((from && date < from) || (to && date > to)) continue;
    const data = entry.data || {};
    if (entry.type === "message.sent" && data.from) {
      const target = row(date, data.from);
      target.sent += 1;
      if (Number(data.step) > 0) target.followups += 1; else target.firsts += 1;
    } else if (entry.type === "message.bounced" && data.sender) {
      const target = row(date, data.sender);
      target.bounces += 1;
      const code = String(data.code || "невідомо");
      target.bounceCodes[code] = (target.bounceCodes[code] || 0) + 1;
    } else if (entry.type === "message.replied" && data.sender) {
      const target = row(date, data.sender);
      target.replies += 1;
      if (labelOf(entry, labels) === "positive") target.positive += 1;
    } else if (entry.type === "message.autoreplied" && data.sender) {
      row(date, data.sender).autoreplies += 1;
    } else if (entry.type === "contact.unsubscribed" && data.sender) {
      row(date, data.sender).unsubscribes += 1;
    }
  }
  const senders = [...rows.values()].sort((left, right) => right.day.localeCompare(left.day) || left.sender.localeCompare(right.sender));

  const byDomain = new Map();
  for (const item of senders) {
    const key = `${item.day}|${item.domain}`;
    if (!byDomain.has(key)) byDomain.set(key, { day: item.day, domain: item.domain, senders: 0, ...emptyRow() });
    const target = byDomain.get(key);
    target.senders += 1;
    for (const field of ["sent", "firsts", "followups", "bounces", "replies", "positive", "autoreplies", "unsubscribes"]) target[field] += item[field];
    for (const [code, count] of Object.entries(item.bounceCodes)) target.bounceCodes[code] = (target.bounceCodes[code] || 0) + count;
  }
  const domains = [...byDomain.values()].sort((left, right) => right.day.localeCompare(left.day) || left.domain.localeCompare(right.domain));
  for (const item of [...senders, ...domains]) item.bounceRate = rate(item.bounces, item.sent);
  return { senders, domains };
}

/**
 * Per campaign: people written to, who replied, who replied positively — and
 * the same split by step, by subject of the first letter, by text version
 * (the A/B group and the variant ids ESP 12 records) and by the lead's source.
 * `sourceOf(campaignId, email)` gives a lead's source (from the enrolments).
 */
export function campaignReport(entries, { campaigns = [], sourceOf = () => "" } = {}) {
  const labels = currentLabels(entries);
  const names = new Map(campaigns.map((campaign) => [campaign.id, campaign.name]));
  const firstLetter = new Map();
  const people = new Map();
  const stepSent = new Map();
  for (const entry of entries) {
    const data = entry.data || {};
    if (entry.type === "message.sending" && data.campaignId && Number(data.step || 0) === 0 && !firstLetter.has(`${data.campaignId}|${entry.contact}`)) {
      firstLetter.set(`${data.campaignId}|${entry.contact}`, { subject: data.subject || "", variant: variantKey(data.variantIds) });
    }
    if (entry.type === "message.sent" && data.campaignId) {
      const key = `${data.campaignId}|${entry.contact}`;
      if (!people.has(key)) people.set(key, { campaignId: data.campaignId, email: entry.contact, replied: false, positive: false, replyStep: null, unsubscribed: false, bounced: false });
      inc(stepSent, `${data.campaignId}|${Number(data.step || 0)}`);
    }
  }
  for (const entry of entries) {
    const data = entry.data || {};
    const person = data.campaignId ? people.get(`${data.campaignId}|${entry.contact}`) : null;
    if (!person) continue;
    if (entry.type === "message.replied" && !person.replied) {
      person.replied = true;
      person.replyStep = Number(data.step || 0);
      person.positive = labelOf(entry, labels) === "positive";
    } else if (entry.type === "message.replied" && labelOf(entry, labels) === "positive") {
      person.positive = true;
    } else if (entry.type === "contact.unsubscribed") person.unsubscribed = true;
    else if (entry.type === "message.bounced" && /^5\./.test(String(data.code || ""))) person.bounced = true;
  }

  const tally = () => ({ people: 0, replied: 0, positive: 0, unsubscribed: 0, bounced: 0 });
  const add = (bucket, person) => {
    bucket.people += 1;
    if (person.replied) bucket.replied += 1;
    if (person.positive) bucket.positive += 1;
    if (person.unsubscribed) bucket.unsubscribed += 1;
    if (person.bounced) bucket.bounced += 1;
  };
  const finish = (bucket) => ({ ...bucket, replyRate: rate(bucket.replied, bucket.people), positiveRate: rate(bucket.positive, bucket.people) });

  const result = new Map();
  for (const person of people.values()) {
    if (!result.has(person.campaignId)) {
      result.set(person.campaignId, { campaignId: person.campaignId, name: names.get(person.campaignId) || person.campaignId, total: tally(), bySubject: new Map(), byVariant: new Map(), bySource: new Map(), byStep: new Map() });
    }
    const campaign = result.get(person.campaignId);
    add(campaign.total, person);
    const first = firstLetter.get(`${person.campaignId}|${person.email}`) || { subject: "", variant: "" };
    for (const [map, key] of [[campaign.bySubject, first.subject || "—"], [campaign.byVariant, first.variant || "—"], [campaign.bySource, sourceOf(person.campaignId, person.email) || "невідомо"]]) {
      if (!map.has(key)) map.set(key, tally());
      add(map.get(key), person);
    }
    if (person.replied) {
      if (!campaign.byStep.has(person.replyStep)) campaign.byStep.set(person.replyStep, { replied: 0, positive: 0 });
      const step = campaign.byStep.get(person.replyStep);
      step.replied += 1;
      if (person.positive) step.positive += 1;
    }
  }

  return [...result.values()].map((campaign) => {
    const steps = [...new Set([...[...stepSent.keys()].filter((key) => key.startsWith(`${campaign.campaignId}|`)).map((key) => Number(key.split("|")[1])), ...campaign.byStep.keys()])].sort((left, right) => left - right);
    return {
      campaignId: campaign.campaignId,
      name: campaign.name,
      ...finish(campaign.total),
      // What each letter of the chain brought: replies to it, and its share of all replies.
      steps: steps.map((step) => {
        const got = campaign.byStep.get(step) || { replied: 0, positive: 0 };
        return { step: step + 1, sent: stepSent.get(`${campaign.campaignId}|${step}`) || 0, replied: got.replied, positive: got.positive, shareOfReplies: rate(got.replied, campaign.total.replied), replyRate: rate(got.replied, stepSent.get(`${campaign.campaignId}|${step}`) || 0) };
      }),
      bySubject: [...campaign.bySubject].map(([subject, bucket]) => ({ subject, ...finish(bucket) })),
      byVariant: [...campaign.byVariant].map(([variant, bucket]) => ({ variant, ...finish(bucket) })),
      bySource: [...campaign.bySource].map(([source, bucket]) => ({ source, ...finish(bucket) }))
    };
  });
}

/** A text version as one readable key: the A/B group and the variant ids of the subject and body. */
export function variantKey(variantIds) {
  if (!variantIds || typeof variantIds !== "object") return "";
  return Object.entries(variantIds).filter(([, value]) => value !== null && value !== undefined && value !== "")
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(" ");
}

/** A report as CSV — for a spreadsheet, as Snov's «Export CSV». */
export function toCsv(rows, columns) {
  const cell = (value) => {
    const text = value && typeof value === "object" ? Object.entries(value).map(([key, count]) => `${key}:${count}`).join(" ") : String(value ?? "");
    return /[",\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\n") + "\n";
}
