import { isHoliday } from "./holidays.mjs";
import { buildLetter, messageIdFor } from "./letter.mjs";
import { COUNTING_ZONE, SENDER_DAILY_CAP, localTime, seeded, sendDecision, sendLedger, senderDailyLimit } from "./limits.mjs";
import { DOMAIN_LABEL } from "./registry.mjs";
import { replySubject } from "./thread.mjs";

/**
 * Прогрів пошт — the mailbox warm-up, between our own Workspace mailboxes and
 * nothing outside: no warm-up service, no network of strangers' inboxes.
 *
 * A mailbox someone pressed «Старт» on writes to the other running mailboxes
 * on a schedule — two letters on its first day, two more each day after, up to
 * twenty — inside the working day, with the same 12–40 minute gaps as cold
 * mail. About a third of the letters are answered, in the same thread, an hour
 * or two later; replies are on top of the day's plan, never on top of ESP 4. On the receiving side a letter of ours that Gmail put in Spam
 * is moved to the Inbox and marked Important: that is the signal a mailbox
 * provider learns from. The volume grows with the days the mailbox has run.
 *
 * What it must never do:
 * - go past the limits of ESP 4. Its letters are `warmup.sending` in the same
 *   journal, and `sendLedger` counts them with the cold ones, so warm-up and
 *   campaigns together stay within one sender's and one domain's day.
 * - leak into the cold-mail screens. Its events are `warmup.*` with no contact:
 *   campaigns, reports, the Unibox and a person's timeline read `message.*`
 *   and `contact.*` and never see them; the inbox reader skips a letter whose
 *   Message-ID is one of ours (esp/inbound.mjs).
 * - send while sending is locked. It runs only where the connector may really
 *   send (`ESP_LIVE_SEND=1`), or on the stub during the acceptance cycle; the
 *   page says which.
 *
 * Everything is derived from the journal: who is running since when, how many
 * went today, what arrived, what was taken out of Spam, which replies are owed.
 */

export const WARMUP_START = 2;
export const WARMUP_STEP = 2;
export const WARMUP_MAX = 20;
export const REPLY_PERCENT = 35;
export const REPLY_DELAY_MINUTES = { min: 25, max: 140 };
export const BACKOFF_MINUTES = 30;
// Warm-up runs on our days: Kyiv working hours, Ukrainian holidays off.
const OUR_SIDE = { timezone: COUNTING_ZONE, country: "Ukraine" };
/**
 * When warm-up letters go: 08:00–22:00 Kyiv on working days (owner 13.10:
 * «почати прогрів сьогодні», at six in the evening). These are our own
 * mailboxes writing to each other — people answer mail in the evening too —
 * so the cold-mail window (08–17 in the recipient's zone) is not theirs.
 */
export const WARMUP_WINDOW = { startHour: 8, endHour: 22 };

export const DEFAULT_PLAN = { start: WARMUP_START, step: WARMUP_STEP, max: WARMUP_MAX };
// What a plan may be: at least one letter, never past a sender's daily cap.
export const PLAN_BOUNDS = { start: [1, SENDER_DAILY_CAP], step: [0, 10], max: [1, SENDER_DAILY_CAP] };

/** A plan checked and made whole, or a message saying what is wrong with it. */
export function cleanPlan(input = {}) {
  const plan = {};
  for (const [key, [min, max]] of Object.entries(PLAN_BOUNDS)) {
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      return { error: `${{ start: "Старт", step: "Приріст", max: "Межа" }[key]} — ціле число від ${min} до ${max}.` };
    }
    plan[key] = value;
  }
  if (plan.max < plan.start) return { error: "Межа не може бути меншою за старт." };
  return { plan };
}

/**
 * The warm-up's plan now: the last one an administrator saved on the page
 * (`warmup.plan`), or the server's defaults (`ESP_WARMUP_START`, `_STEP`,
 * `_MAX`), or 2 / +2 / 20. A fresh domain is ramped slower by saving a smaller
 * start and step — no code, no deploy.
 */
export function warmupPlan(entries = [], env = process.env) {
  const saved = [...entries].reverse().find((entry) => entry.type === "warmup.plan");
  if (saved) return { ...cleanPlan(saved.data).plan, savedAt: saved.at, by: saved.actor || "" };
  const fromEnv = cleanPlan({ start: env.ESP_WARMUP_START ?? WARMUP_START, step: env.ESP_WARMUP_STEP ?? WARMUP_STEP, max: env.ESP_WARMUP_MAX ?? WARMUP_MAX });
  return fromEnv.plan || { ...DEFAULT_PLAN };
}

/** How many letters a mailbox sends on its `day`-th day of warm-up (first day = 1). */
export function planFor(day, plan = DEFAULT_PLAN) {
  if (!(day > 0)) return 0;
  return Math.min(plan.max, plan.start + plan.step * (day - 1));
}

const dayOf = (iso) => localTime(new Date(iso), COUNTING_ZONE).date;

/** A day the warm-up works: Monday to Friday in Kyiv, not a Ukrainian public holiday. */
function workingDay(date) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5 && !isHoliday("Ukraine", date);
}

function addDays(date, days) {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Per mailbox, what the journal says about its warm-up: running or not, since
 * when, which day it is on (working days it ran, in Kyiv dates — a pause or a
 * weekend does not move the plan on), today's letters, and the totals the page
 * shows.
 */
export function warmupLedger(entries, { now = new Date(), plan = warmupPlan(entries) } = {}) {
  const today = dayOf(now.toISOString());
  const rows = new Map();
  const row = (email) => {
    const key = String(email || "").toLowerCase();
    if (!rows.has(key)) {
      rows.set(key, {
        email: key, running: false, startedAt: null, pausedAt: null, by: "", activeDays: new Set(),
        sentToday: 0, firstsToday: 0, repliesToday: 0, sent: 0, repliesReceived: 0, repliesSent: 0,
        received: 0, rescued: 0, landedInSpam: 0, failedToday: 0, lastError: null
      });
    }
    return rows.get(key);
  };
  const failed = new Set(entries.filter((entry) => entry.type === "warmup.failed").map((entry) => entry.data?.sendingSeq));
  const sendingBySeq = new Map();
  const byMessageId = new Map();
  const pendingReplies = [];
  for (const entry of entries) {
    const data = entry.data || {};
    if (entry.type === "warmup.started" || entry.type === "warmup.paused") {
      const target = row(data.mailbox);
      if (entry.type === "warmup.started" && !target.running) {
        target.running = true;
        target.since = entry.at;
        if (!target.startedAt) target.startedAt = entry.at;
        target.by = entry.actor || "";
      } else if (entry.type === "warmup.paused" && target.running) {
        for (let date = dayOf(target.since); date <= dayOf(entry.at); date = addDays(date, 1)) target.activeDays.add(date);
        target.running = false;
        target.pausedAt = entry.at;
        target.by = entry.actor || "";
      }
    } else if (entry.type === "warmup.sending") {
      sendingBySeq.set(entry.seq, entry);
      if (data.messageId) byMessageId.set(data.messageId, entry);
      if (failed.has(entry.seq)) continue;
      const target = row(data.from);
      target.sent += 1;
      if (data.kind === "reply") {
        target.repliesSent += 1;
        // Attributed after the loop: the reply names the letter by the
        // Message-ID Gmail gave it, which is known only from warmup.sent(_id).
        pendingReplies.push(data.inReplyTo);
      }
      if (dayOf(entry.at) === today) {
        target.sentToday += 1;
        if (data.kind === "reply") target.repliesToday += 1; else target.firstsToday += 1;
      }
    } else if (entry.type === "warmup.failed") {
      const sending = sendingBySeq.get(data.sendingSeq);
      if (sending) {
        const target = row(sending.data.from);
        if (dayOf(entry.at) === today) target.failedToday += 1;
        target.lastError = { at: entry.at, error: data.error || "", code: data.code || null };
      }
    } else if ((entry.type === "warmup.sent" || entry.type === "warmup.sent_id") && data.messageId) {
      const sending = sendingBySeq.get(data.sendingSeq);
      if (sending) byMessageId.set(data.messageId, sending);
    } else if (entry.type === "warmup.received") {
      row(data.mailbox).received += 1;
      if (data.inSpam) row(data.from).landedInSpam += 1;
    } else if (entry.type === "warmup.rescued") {
      row(data.mailbox).rescued += 1;
    }
  }
  for (const id of pendingReplies) {
    const original = byMessageId.get(id);
    if (original) row(original.data.from).repliesReceived += 1;
  }
  for (const target of rows.values()) {
    if (target.running) for (let date = dayOf(target.since); date <= today; date = addDays(date, 1)) target.activeDays.add(date);
    // Working days only: the warm-up does not write at weekends, so a weekend
    // must not move its plan on.
    const worked = [...target.activeDays].filter((date) => date <= today && workingDay(date));
    target.day = worked.length;
    target.plannedToday = target.running ? planFor(target.day, plan) : 0;
  }
  return { today, rows };
}

/** The page's table: every registered, non-retired sender, warm-up or not. */
export function warmupView(entries, { senders = [], domains = [], now = new Date(), mode = {} } = {}) {
  const { rows } = warmupLedger(entries, { now });
  const ledger = sendLedger(entries, { now });
  const domainState = new Map(domains.map((domain) => [domain.domain, domain.status]));
  // By domain A→Z, inside each the addresses A→Z (owner 14.10). Which mailboxes
  // warm first is the pass's own order (`runWarmupTick`), not the table's.
  return senders.filter((sender) => sender.effectiveStatus !== "retired")
    .sort((left, right) => String(left.domain).localeCompare(String(right.domain)) || left.email.localeCompare(right.email)).map((sender) => {
    const mine = rows.get(sender.email) || { running: false, day: 0, plannedToday: 0, sentToday: 0, firstsToday: 0, repliesToday: 0, sent: 0, repliesReceived: 0, repliesSent: 0, received: 0, rescued: 0, landedInSpam: 0, failedToday: 0, lastError: null, startedAt: null, pausedAt: null, by: "" };
    const domainStatus = domainState.get(sender.domain) || null;
    const blocked = sender.status !== "active" ? (sender.status === "paused" ? "пошта на паузі" : "пошту виведено")
      : !["aging", "ramp", "active"].includes(domainStatus) ? `домен у стані «${DOMAIN_LABEL[domainStatus] || domainStatus || "немає"}»` : null;
    const limit = senderDailyLimit(sender);
    const coldToday = ledger.senders.get(sender.email)?.cold || 0;
    return {
      email: sender.email, domain: sender.domain, domainStatus, person: sender.person || sender.displayName || "", role: sender.role || null, tags: sender.tags || [],
      status: blocked ? "blocked" : mine.running ? "running" : mine.startedAt ? "paused" : "never",
      blocked, day: mine.day, plannedToday: mine.plannedToday, planOfDay: mine.plannedToday,
      sentToday: mine.sentToday, firstsToday: mine.firstsToday, repliesToday: mine.repliesToday, coldToday, limit,
      sent: mine.sent, repliesReceived: mine.repliesReceived, repliesSent: mine.repliesSent, received: mine.received,
      rescued: mine.rescued, landedInSpam: mine.landedInSpam, failedToday: mine.failedToday, lastError: mine.lastError,
      startedAt: mine.startedAt, pausedAt: mine.pausedAt, by: mine.by
    };
  });
}

/** Can warm-up actually send here, and if not, what to tell the page. */
export function warmupMode({ describe = {}, sequenceOn = false, env = process.env } = {}) {
  if (env.ESP_WARMUP === "off") return { runs: false, mode: "off", text: "Прогрів вимкнено на цьому сервері (ESP_WARMUP=off): «Старт» лише запам'ятовується." };
  if (describe.mode === "stub") {
    return sequenceOn
      ? { runs: true, mode: "stub_cycle", text: "Заглушка замість Gmail, тестовий цикл (ESP_SEQUENCE=on): прогрів «шле» й «виймає зі спаму» в заглушці, у мережу нічого не йде." }
      : { runs: false, mode: "stub", text: "Пошту ще не підключено — працює заглушка. Прогрів почнеться, коли пошту підключать («Пошти» → «Додати пошту» → «Увійти через Google») і ввімкнуть справжню відправку (ESP_LIVE_SEND=1). «Старт» уже можна натиснути — пошта стане в чергу." };
  }
  if (!describe.liveSend) return { runs: false, mode: "locked", text: "Gmail підключено, але справжня відправка вимкнена (ESP_LIVE_SEND). Прогрів почнеться, щойно її ввімкнуть; «Старт» уже запам'ятовується." };
  return { runs: true, mode: "live", text: "" };
}

// ── the letters ───────────────────────────────────────────────────────────

const OPENERS = ["Hi {to},", "Hey {to},", "Hello {to},", "Morning {to},", "{to},"];
const SUBJECTS = [
  "Quick question about next week", "Notes from today", "Following up on the deck", "Re-scheduling Thursday",
  "Numbers for October", "Lunch on Friday?", "The partner list", "Two small things", "Before the call",
  "Thoughts on the new landing", "Can you take a look?", "Update on the GEO tests", "Invoice question",
  "Plan for the next sprint", "That article you mentioned", "Coffee next week", "Draft for review", "Small favour"
];
const BODIES = [
  "Do you have ten minutes tomorrow to go over the plan? I'd like to settle the order of the next steps before Monday.",
  "I went through the notes from our last call and put the open points into one list. Could you check whether I missed anything?",
  "The numbers for last week look steadier than I expected. I'll send the full breakdown once the weekend data is in.",
  "Thursday doesn't work for me any more — would Friday morning suit you instead? Any time before noon is fine.",
  "I've updated the draft with your comments. The middle section still feels long; let me know if you'd cut anything.",
  "Quick one: which version of the partner list are we using now? I have two and they don't quite match.",
  "Are you around for a short call this afternoon? Nothing urgent, I just want to hear your take before I reply to them.",
  "I read the article you sent — the part about onboarding was the most useful. Worth sharing with the team, I think.",
  "Could you send me the latest figures when you have a moment? I need them for the summary I'm writing.",
  "The new landing page is live on staging. Have a look when you can and tell me what feels off.",
  "We agreed to revisit the budget at the end of the month. Shall we put thirty minutes in the calendar for that?",
  "I'm putting together the plan for the next two weeks. Is there anything on your side I should block time for?"
];
const REPLIES = [
  "Thanks — that works for me. Let's do it.", "Got it, I'll take a look this afternoon and come back to you.",
  "Sounds good. Friday morning is fine, say 10:30?", "Yes, I saw it. Two small comments, I'll leave them in the doc.",
  "Thanks for the update, that's helpful.", "Sure, I can do ten minutes tomorrow after lunch.",
  "Agreed. I'll send the figures by end of day.", "Makes sense — go ahead with that version.",
  "Will do. Thanks for flagging it.", "Good point, let's add it to the agenda."
];
const CLOSERS = ["Thanks,", "Best,", "Cheers,", "Talk soon,", ""];

/**
 * The name a mailbox greets and signs with: its own — the name on the Google
 * account (`displayName`), else its address before the @. Never `person`:
 * that is who on the team looks after the mailbox, and with one person
 * connecting all of them every letter said «Hi Pavlo» and signed «Pavlo» (13.10).
 */
const ownName = (sender) => {
  const name = String(sender.displayName || "").trim();
  return name && !name.includes("@") ? name : "";
};
const firstName = (sender) => {
  const word = (ownName(sender) || sender.email.split("@")[0].replace(/\d+/g, "")).split(/[\s._-]+/).find(Boolean) || sender.email.split("@")[0];
  return word.replace(/^./, (char) => char.toUpperCase());
};

/** A first letter from one of our mailboxes to another: picked, not generated, and different every time. */
export function warmupLetter({ from, to, seed, date = new Date(), written = null }) {
  const pick = (list, salt) => list[seeded(`${seed}|${salt}`, 0, list.length - 1)];
  const subject = written?.subject || pick(SUBJECTS, "subject");
  const closer = pick(CLOSERS, "closer");
  const body = written?.body || `${pick(OPENERS, "open").replace("{to}", firstName(to))}\n\n${pick(BODIES, "body")}${closer ? `\n\n${closer}` : ""}`;
  const messageId = messageIdFor(from.email);
  const raw = buildLetter({ from: { email: from.email, name: ownName(from) }, to: { email: to.email, name: ownName(to) }, subject, body, signature: firstName(from), date, messageId });
  return { raw, subject, text: `${body}\n\n${firstName(from)}`, messageId };
}

/** The answer to a warm-up letter, in its thread. */
export function warmupReply({ from, to, original, seed, date = new Date(), written = null }) {
  const body = written?.body || `${seeded(`${seed}|hi`, 0, 1) ? `Hi ${firstName(to)},\n\n` : ""}${REPLIES[seeded(`${seed}|reply`, 0, REPLIES.length - 1)]}`;
  const messageId = messageIdFor(from.email);
  const subject = replySubject(original.subject || "");
  const raw = buildLetter({
    from: { email: from.email, name: ownName(from) }, to: { email: to.email, name: ownName(to) },
    subject, body, signature: firstName(from), date, messageId,
    headers: { "In-Reply-To": original.messageId, References: original.messageId }
  });
  return { raw, subject, text: `${body}\n\n${firstName(from)}`, messageId };
}

// ── one pass ──────────────────────────────────────────────────────────────

/**
 * One pass of the warm-up: (1) every running mailbox reads what our mailboxes
 * sent it — a letter in Spam goes to the Inbox, marked Important; (2) replies
 * that are due go out; (3) each running mailbox under today's plan sends one
 * letter to another, if its limits and the clock allow. One letter per mailbox
 * per pass, so a minute's tick spreads the day the way the cold mail does.
 *
 * `journal` — { allEntries, append }; `senders` — the registry's; `gate` — the
 * sender gate (its `purpose: "warmup"` rule); `connector` — lettersFrom and
 * setLabels.
 */
/**
 * Each letter written by the connected model (owner 13.10: «генеруй кожен лист
 * моделлю»), when the server has one: `writer({ kind, from, to, original,
 * recent })` → `{ subject, body }`. A writer that fails or takes too long
 * costs nothing — the letter is made from the built-in pieces, as before.
 */
async function written(writer, request) {
  if (!writer) return null;
  try {
    const answer = await Promise.race([writer(request), new Promise((resolve) => setTimeout(() => resolve(null), 30_000).unref?.())]);
    const subject = String(answer?.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 120);
    const body = String(answer?.body || "").replace(/\r/g, "").trim().slice(0, 1500);
    if (!body || (request.kind === "first" && !subject)) return null;
    // Plain text only, nothing that reads like marketing.
    if (/https?:\/\/|<\/?[a-z][^>]*>/i.test(body)) return null;
    return { subject, body };
  } catch {
    return null;
  }
}

export async function runWarmupTick({ journal, senders, connector, gate, now = new Date(), replyPercent = REPLY_PERCENT, writer = null }) {
  const summary = { received: 0, rescued: 0, replied: 0, sent: 0, skipped: [], errors: [] };
  const entries = await journal.allEntries();
  const { rows } = warmupLedger(entries, { now });
  // Running, and allowed to: an active mailbox on a domain that is ageing,
  // ramping or active (the gate's warm-up rule, `canWarm`). One on a paused or
  // reserve domain, or paused itself, waits without writing a failure a minute.
  const allowed = (sender) => sender.status === "active" && (sender.effectiveStatus === "active" || (sender.effectiveStatus === "held" && sender.heldBy === "aging"));
  // Mailboxes for campaigns go first in every pass (owner 13.10: «вони в першу
  // чергу прогріваються») — when limits bite, theirs are the letters that go.
  const priority = (sender) => (sender.role === "cold" ? 0 : sender.role === "warmup" ? 2 : 1);
  const live = senders.filter((sender) => rows.get(sender.email)?.running && allowed(sender))
    .sort((left, right) => priority(left) - priority(right));
  if (!live.length) return summary;
  const ours = senders.map((sender) => sender.email);
  // Our letters by Message-ID — the one we wrote and the one Gmail really gave
  // them (it replaces ours); letters sent before that was recorded are looked
  // up once, a few dozen a pass.
  const sendingBySeq = new Map(entries.filter((entry) => entry.type === "warmup.sending").map((entry) => [entry.seq, entry]));
  const realIds = new Map();
  for (const entry of entries) {
    if ((entry.type === "warmup.sent" || entry.type === "warmup.sent_id") && entry.data?.messageId) realIds.set(entry.data.sendingSeq, entry.data.messageId);
  }
  const unknown = entries.filter((entry) => entry.type === "warmup.sent" && entry.data?.gmailId && !realIds.has(entry.data.sendingSeq)
    && now.getTime() - new Date(entry.at).getTime() < 4 * 86_400_000).slice(-40);
  for (const entry of unknown) {
    const sending = sendingBySeq.get(entry.data.sendingSeq);
    if (!sending || !connector.messageIdOf) continue;
    try {
      const messageId = await connector.messageIdOf(sending.data.from, entry.data.gmailId);
      if (!messageId) continue;
      await journal.append({ type: "warmup.sent_id", actor: "esp-warmup", data: { sendingSeq: entry.data.sendingSeq, messageId } });
      realIds.set(entry.data.sendingSeq, messageId);
    } catch (error) {
      summary.errors.push({ mailbox: sending.data.from, stage: "message_id", error: error.message });
    }
  }
  const sentById = new Map();
  for (const entry of sendingBySeq.values()) {
    if (entry.data?.messageId) sentById.set(entry.data.messageId, entry);
    if (realIds.has(entry.seq)) sentById.set(realIds.get(entry.seq), entry);
  }
  const seen = new Set(entries.filter((entry) => entry.type === "warmup.received").map((entry) => `${entry.data.mailbox}|${entry.data.gmailId}`));
  const rescued = new Set(entries.filter((entry) => entry.type === "warmup.rescued").map((entry) => `${entry.data.mailbox}|${entry.data.gmailId}`));

  // (1) What arrived, and out of Spam.
  let noScopeSaid = entries.some((entry) => entry.type === "warmup.rescue_refused" && dayOf(entry.at) === dayOf(now.toISOString()));
  for (const mailbox of live) {
    let letters = [];
    try {
      letters = await connector.lettersFrom(mailbox.email, ours);
    } catch (error) {
      summary.errors.push({ mailbox: mailbox.email, stage: "read", error: error.message });
      continue;
    }
    for (const letter of letters) {
      if (!sentById.has(letter.messageId)) continue;
      const key = `${mailbox.email}|${letter.id}`;
      const inSpam = letter.labels.includes("SPAM");
      if (!seen.has(key)) {
        await journal.append({ type: "warmup.received", actor: "esp-warmup", data: {
          mailbox: mailbox.email, from: letter.from, gmailId: letter.id, threadId: letter.threadId, messageId: letter.messageId,
          subject: letter.subject, inSpam, kind: sentById.get(letter.messageId).data.kind
        } });
        seen.add(key);
        summary.received += 1;
      }
      if (inSpam && !rescued.has(key)) {
        try {
          await connector.setLabels(mailbox.email, letter.id, { add: ["INBOX", "IMPORTANT"], remove: ["SPAM"] });
          await journal.append({ type: "warmup.rescued", actor: "esp-warmup", data: { mailbox: mailbox.email, from: letter.from, gmailId: letter.id } });
          rescued.add(key);
          summary.rescued += 1;
        } catch (error) {
          summary.errors.push({ mailbox: mailbox.email, stage: "rescue", error: error.message, code: error.code || null });
          // Said on the page: the owner has a scope to add, nothing else is wrong.
          if (error.code === "no_modify_scope" && !noScopeSaid) {
            noScopeSaid = true;
            await journal.append({ type: "warmup.rescue_refused", actor: "esp-warmup", data: { mailbox: mailbox.email, code: error.code, error: error.message } });
          }
        }
      }
    }
  }

  // (1b) Every letter from our mailboxes still in Spam, of the last month —
  // the warm-up's, a cold one between colleagues, one sent before its id was
  // known — goes to the Inbox, marked Important (owner 15.10: «витягуй
  // абсолютно всі листи зі спаму»).
  for (const mailbox of live) {
    let spam = [];
    try {
      spam = await connector.lettersFrom(mailbox.email, ours, { inSpam: true, newerThanDays: 30 });
    } catch (error) {
      summary.errors.push({ mailbox: mailbox.email, stage: "spam", error: error.message });
      continue;
    }
    for (const letter of spam) {
      const key = `${mailbox.email}|${letter.id}`;
      if (rescued.has(key) || !letter.labels.includes("SPAM")) continue;
      try {
        await connector.setLabels(mailbox.email, letter.id, { add: ["INBOX", "IMPORTANT"], remove: ["SPAM"] });
        await journal.append({ type: "warmup.rescued", actor: "esp-warmup", data: { mailbox: mailbox.email, from: letter.from, gmailId: letter.id, ...(sentById.has(letter.messageId) ? {} : { other: true }) } });
        rescued.add(key);
        summary.rescued += 1;
      } catch (error) {
        summary.errors.push({ mailbox: mailbox.email, stage: "rescue", error: error.message, code: error.code || null });
        break;
      }
    }
  }

  const fresh = await journal.allEntries();
  let ledger = sendLedger(fresh, { now });
  const usedThisPass = new Set();
  const send = async (from, to, letter, data) => {
    const sending = await journal.append({ type: "warmup.sending", actor: "esp-warmup", data: { from: from.email, to: to.email, subject: letter.subject, text: letter.text, messageId: letter.messageId, ...data } });
    try {
      const result = await gate.send(from.email, letter.raw, { purpose: "warmup", ...(data.threadId ? { threadId: data.threadId } : {}) });
      const realId = connector.messageIdOf ? await connector.messageIdOf(from.email, result.id).catch(() => null) : null;
      await journal.append({ type: "warmup.sent", actor: "esp-warmup", data: { sendingSeq: sending.seq, gmailId: result.id, threadId: result.threadId, stub: Boolean(result.stub), ...(realId ? { messageId: realId } : {}) } });
      usedThisPass.add(from.email);
      ledger = sendLedger(await journal.allEntries(), { now });
      return true;
    } catch (error) {
      await journal.append({ type: "warmup.failed", actor: "esp-warmup", data: { sendingSeq: sending.seq, error: String(error.message || error).slice(0, 300), code: error.code || null } });
      summary.errors.push({ mailbox: from.email, stage: "send", error: error.message, code: error.code || null });
      return false;
    }
  };
  // The plan counts first letters; a reply goes when it is due — still inside
  // ESP 4's limits and gaps, which `sendDecision` keeps.
  const mayWrite = (sender, kind = "first") => {
    const plan = rows.get(sender.email);
    const today = warmupLedger(fresh, { now }).rows.get(sender.email)?.firstsToday || 0;
    if (usedThisPass.has(sender.email)) return { ok: false, reason: "one_per_pass" };
    // After a refusal the mailbox rests half an hour, not one failure line per pass.
    const error = plan?.lastError;
    if (error && now.getTime() - new Date(error.at).getTime() < BACKOFF_MINUTES * 60_000) return { ok: false, reason: "backoff" };
    if (kind === "first" && today >= (plan?.plannedToday || 0)) return { ok: false, reason: "plan_done" };
    return sendDecision({ sender, recipient: OUR_SIDE, ledger, now, window: WARMUP_WINDOW, purpose: "warmup" });
  };

  // (2) Replies that are due: a third of the first letters, an hour or two after they arrived.
  const answered = new Set(fresh.filter((entry) => entry.type === "warmup.sending" && entry.data?.kind === "reply").map((entry) => entry.data.inReplyTo));
  const failedSeqs = new Set(fresh.filter((entry) => entry.type === "warmup.failed").map((entry) => entry.data?.sendingSeq));
  for (const received of fresh.filter((entry) => entry.type === "warmup.received" && entry.data?.kind !== "reply")) {
    const { mailbox, messageId } = received.data;
    if (answered.has(messageId) || seeded(`${messageId}|answer`, 1, 100) > replyPercent) continue;
    const dueAt = new Date(new Date(received.at).getTime() + seeded(`${messageId}|delay`, REPLY_DELAY_MINUTES.min, REPLY_DELAY_MINUTES.max) * 60_000);
    if (now < dueAt) continue;
    const from = live.find((sender) => sender.email === mailbox);
    const original = sentById.get(messageId);
    const to = senders.find((sender) => sender.email === original?.data.from);
    if (!from || !to || failedSeqs.has(original.seq)) continue;
    const decision = mayWrite(from, "reply");
    if (!decision.ok) { summary.skipped.push({ mailbox: from.email, kind: "reply", reason: decision.reason }); continue; }
    const text = await written(writer, { kind: "reply", from: { email: from.email, name: firstName(from) }, to: { email: to.email, name: firstName(to) }, original: { subject: original.data.subject, text: original.data.text } });
    const letter = warmupReply({ from, to, original: { ...original.data, messageId }, seed: messageId, date: now, written: text });
    if (await send(from, to, letter, { kind: "reply", inReplyTo: messageId, threadId: received.data.threadId, writtenBy: text ? "model" : "template" })) {
      answered.add(messageId);
      summary.replied += 1;
    }
  }

  // (3) First letters, one per mailbox. The partner: whoever of ours has had
  // the fewest warm-up letters today (so 25 @gmail.com mailboxes do not all pile
  // onto the one on our own domain), among those another domain first, and
  // among equals a seeded pick — spread like chance, the same on a re-run.
  const today = dayOf(now.toISOString());
  const inbound = new Map();
  for (const entry of await journal.allEntries()) {
    if (entry.type === "warmup.sending" && dayOf(entry.at) === today) inbound.set(entry.data?.to, (inbound.get(entry.data?.to) || 0) + 1);
  }
  for (const from of live) {
    const partners = live.filter((sender) => sender.email !== from.email);
    if (!partners.length) { summary.skipped.push({ mailbox: from.email, kind: "first", reason: "no_partner" }); continue; }
    const decision = mayWrite(from);
    if (!decision.ok) { summary.skipped.push({ mailbox: from.email, kind: "first", reason: decision.reason }); continue; }
    // A mailbox for campaigns is written to first, up to twice its own plan a
    // day (at least 4) — the helpers warm it; past that, everyone shares.
    const cap = (sender) => Math.max(4, 2 * (rows.get(sender.email)?.plannedToday || WARMUP_START));
    const coldRoom = partners.filter((sender) => sender.role === "cold" && (inbound.get(sender.email) || 0) < cap(sender));
    const base = coldRoom.length ? coldRoom : partners;
    const fewest = Math.min(...base.map((sender) => inbound.get(sender.email) || 0));
    const least = base.filter((sender) => (inbound.get(sender.email) || 0) === fewest);
    const others = least.filter((sender) => sender.domain !== from.domain);
    const pool = others.length ? others : least;
    const count = warmupLedger(await journal.allEntries(), { now }).rows.get(from.email)?.sent || 0;
    const to = pool[seeded(`${from.email}|${count}|partner`, 0, pool.length - 1)];
    inbound.set(to.email, (inbound.get(to.email) || 0) + 1);
    // The model sees the last subjects between these two, so a thread of
    // letters between colleagues does not repeat itself.
    const recent = fresh.filter((entry) => entry.type === "warmup.sending" && entry.data?.kind === "first" && [entry.data.from, entry.data.to].includes(from.email) && [entry.data.from, entry.data.to].includes(to.email)).slice(-6).map((entry) => entry.data.subject);
    const text = await written(writer, { kind: "first", from: { email: from.email, name: firstName(from) }, to: { email: to.email, name: firstName(to) }, recent });
    const letter = warmupLetter({ from, to, seed: `${from.email}|${count}|${now.toISOString().slice(0, 10)}`, date: now, written: text });
    if (await send(from, to, letter, { kind: "first", writtenBy: text ? "model" : "template" })) summary.sent += 1;
  }
  return summary;
}

/** The last things the warm-up did, for the page's log. */
/**
 * Mailboxes somebody took off the warm-up page («Прибрати з прогріву», 13.10):
 * the last of `warmup.removed` / `warmup.restored` per mailbox. They are not
 * listed and do not run; «Повернути» brings one back, paused.
 */
export function removedFromWarmup(entries) {
  const removed = new Set();
  for (const entry of entries) {
    if (entry.type === "warmup.removed") removed.add(entry.data?.mailbox);
    if (entry.type === "warmup.restored") removed.delete(entry.data?.mailbox);
  }
  return removed;
}

export function warmupLog(entries, { limit = 30 } = {}) {
  const words = {
    "warmup.started": (data) => `${data.mailbox}: прогрів запущено`,
    "warmup.paused": (data) => `${data.mailbox}: прогрів на паузі`,
    "warmup.sending": (data) => `${data.from} → ${data.to}: ${data.kind === "reply" ? "відповідь" : "лист"} «${data.subject}»`,
    "warmup.failed": (data) => `не пішло: ${data.error}`,
    "warmup.received": (data) => `${data.mailbox} отримала від ${data.from}${data.inSpam ? " — у спамі" : ""}`,
    "warmup.rescued": (data) => `${data.mailbox}: ${data.other ? "інший лист" : "лист прогріву"} від ${data.from} вийнято зі спаму, позначено важливим`,
    "warmup.rescue_refused": (data) => `${data.mailbox}: Google не дав змінити мітки — немає scope gmail.modify`,
    "warmup.plan": (data) => `план прогріву: старт ${data.start}, +${data.step} щодня, до ${data.max}`,
    "warmup.removed": (data) => `${data.mailbox}: прибрано з прогріву`,
    "warmup.restored": (data) => `${data.mailbox}: повернуто в прогрів`
  };
  return entries.filter((entry) => words[entry.type]).slice(-limit).reverse().map((entry) => ({
    at: entry.at, type: entry.type, actor: entry.actor || "", text: words[entry.type](entry.data || {})
  }));
}
