// ESP 13 — the ramp: one step up a day while the mailbox sends clean.
//
// Checklist (P1) was «крок угору лише якщо за тиждень bounce до 2%, немає 5.7.x
// і є відповіді», a week at a time. Owner 05.11: «кожного дня піднімають і
// давай на 3 до 25». So once a day — the first look after midnight in Europe,
// before the day's letters — a mailbox that has sent on a day since its last
// step, with bounces at most 2% (or fewer than three) and no 5.7.x over the last seven days, goes one
// step up (5 → 8 → … → 25). Replies are no longer asked for: a day is too short
// for them. Anything else holds the stage; the hold is written to the journal
// as `sender.ramp_held` with the reasons, once — the same hold is not
// written again every day.

import { COUNTING_ZONE, RAMP_LIMITS, localTime, rampStageOf } from "./limits.mjs";

export const RAMP_WINDOW_DAYS = 7;
export const MAX_BOUNCE_RATE = 0.02;
// On a few dozen letters one bounce is already «7%»: a step is held for bounces
// only from the third one in the week — the auto-pause's «3 на 100» (05.11).
export const MIN_BOUNCES_TO_HOLD = 3;

/** When this sender's stage was last set: its last rampStage change, or when it was added. */
function stageSince(sender) {
  const changes = (sender.history || []).filter((row) => row.type === "sender.updated" && (row.changed || []).includes("rampStage"));
  return new Date(changes.at(-1)?.at || sender.addedAt || 0);
}

function lastHold(entries, email) {
  return entries.filter((entry) => entry.type === "sender.ramp_held" && entry.data?.email === email).at(-1) || null;
}

const dayOf = (date) => localTime(date, COUNTING_ZONE).date;

/** The verdict on one sender's day. */
export function reviewRamp(sender, entries, { now = new Date() } = {}) {
  const email = sender.email;
  const stage = rampStageOf(sender.rampStage);
  const nextStage = RAMP_LIMITS[RAMP_LIMITS.indexOf(stage) + 1] ?? null;
  const since = stageSince(sender);
  const hold = lastHold(entries, email);
  const lookedAt = new Date(Math.max(since.getTime(), hold ? new Date(hold.at).getTime() : 0));
  // Due on any day after the last step; a hold only says why, it does not put the
  // next look off — a mailbox held this morning steps up once its reason is gone.
  const today = dayOf(now);
  const due = dayOf(since) < today;

  const windowStart = now.getTime() - RAMP_WINDOW_DAYS * 86_400_000;
  const at = (entry) => new Date(entry.at).getTime();
  const sentEntries = entries.filter((entry) => entry.type === "message.sent" && entry.data?.from === email && at(entry) >= windowStart);
  const sent = sentEntries.length;
  // The days of sending since the last step, today not yet: a step is earned by a day that is over.
  const sentSince = sentEntries.filter((entry) => at(entry) >= since.getTime() && dayOf(new Date(entry.at)) < today).length;
  // Only permanent bounces (5.x.x) — a 4.x.x is a delay the server retries, as in the alerts (ESP 8).
  const bounces = entries.filter((entry) => entry.type === "message.bounced" && /^5\./.test(String(entry.data?.code || "")) && entry.data?.sender === email && at(entry) >= windowStart);
  const replies = entries.filter((entry) => entry.type === "message.replied" && entry.data?.sender === email && at(entry) >= windowStart).length;
  const policy = bounces.filter((entry) => /^5\.7\./.test(String(entry.data?.code || ""))).length;
  const bounceRate = sent ? bounces.length / sent : 0;

  const reasons = [];
  if (!sentSince) reasons.push("з останнього кроку не надіслано жодного листа");
  if (sent && bounceRate > MAX_BOUNCE_RATE && bounces.length >= MIN_BOUNCES_TO_HOLD) reasons.push(`bounce ${(bounceRate * 100).toFixed(1)}% за 7 днів — більше 2%`);
  if (policy) reasons.push(`${policy} × 5.7.x — блок за політикою отримувача`);
  return {
    email, stage, nextStage, due, since: lookedAt.toISOString(),
    stats: { sent, sentSince, bounced: bounces.length, bounceRate, policyBlocks: policy, replies },
    eligible: Boolean(nextStage) && !reasons.length,
    reasons,
    sameHold: Boolean(hold) && hold.data?.stage === stage && JSON.stringify(hold.data?.reasons || []) === JSON.stringify(reasons)
  };
}

/**
 * Look at every active sender whose day is up: step it up or hold it.
 * `updateSender` and `append` are the registry's and the journal's (ESP 9).
 */
export async function applyRampReviews({ senders, entries, now = new Date(), updateSender, append, actor = "esp-ramp" }) {
  const results = [];
  for (const sender of senders) {
    if (sender.effectiveStatus !== "active") continue;
    const review = reviewRamp(sender, entries, { now });
    if (!review.due || !review.nextStage) continue;
    if (review.eligible) {
      await updateSender({ email: sender.email, rampStage: review.nextStage }, actor);
      results.push({ ...review, action: "stepped_up" });
    } else if (!review.sameHold) {
      await append({ type: "sender.ramp_held", actor, data: { email: sender.email, stage: review.stage, reasons: review.reasons, stats: review.stats } });
      results.push({ ...review, action: "held" });
    }
  }
  return results;
}
