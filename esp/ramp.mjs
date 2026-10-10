// ESP 13 — the ramp goes up only on a clean week.
//
// Checklist (P1): «Рампа з умовою — крок угору лише якщо за тиждень bounce до
// 2%, немає 5.7.x і є відповіді. Інакше етап стоїть, людині — сповіщення.»
//
// Once a week per sender — seven days after its stage last changed — the week
// is looked at: letters sent, bounces (any 5.7.x is a policy block and stops
// the ramp outright), replies. A clean week moves the stage one step up (the
// registry allows no more); anything else holds it, and the hold is written
// to the journal as `sender.ramp_held` with the reasons — what the alerts
// (ESP 8) tell a person. A held sender is looked at again a week later.

import { RAMP_LIMITS } from "./limits.mjs";

export const RAMP_WEEK_DAYS = 7;
export const MAX_BOUNCE_RATE = 0.02;

/** When this sender's stage was last set: its last rampStage change, or when it was added. */
function stageSince(sender) {
  const changes = (sender.history || []).filter((row) => row.type === "sender.updated" && (row.changed || []).includes("rampStage"));
  return new Date(changes.at(-1)?.at || sender.addedAt || 0);
}

function lastHold(entries, email) {
  return entries.filter((entry) => entry.type === "sender.ramp_held" && entry.data?.email === email).at(-1) || null;
}

/** The verdict on one sender's week. */
export function reviewRamp(sender, entries, { now = new Date() } = {}) {
  const email = sender.email;
  const stage = sender.rampStage;
  const nextStage = RAMP_LIMITS[RAMP_LIMITS.indexOf(stage) + 1] ?? null;
  const since = stageSince(sender);
  const hold = lastHold(entries, email);
  const lookedAt = new Date(Math.max(since.getTime(), hold ? new Date(hold.at).getTime() : 0));
  const due = now.getTime() - lookedAt.getTime() >= RAMP_WEEK_DAYS * 86_400_000;

  const weekStart = now.getTime() - RAMP_WEEK_DAYS * 86_400_000;
  const inWeek = (entry) => new Date(entry.at).getTime() >= weekStart;
  const sent = entries.filter((entry) => entry.type === "message.sent" && entry.data?.from === email && inWeek(entry)).length;
  const bounces = entries.filter((entry) => entry.type === "message.bounced" && entry.data?.sender === email && inWeek(entry));
  const replies = entries.filter((entry) => entry.type === "message.replied" && entry.data?.sender === email && inWeek(entry)).length;
  const policy = bounces.filter((entry) => /^5\.7\./.test(String(entry.data?.code || ""))).length;
  const bounceRate = sent ? bounces.length / sent : 0;

  const reasons = [];
  if (!sent) reasons.push("за тиждень не надіслано жодного листа");
  if (sent && bounceRate > MAX_BOUNCE_RATE) reasons.push(`bounce ${(bounceRate * 100).toFixed(1)}% — більше 2%`);
  if (policy) reasons.push(`${policy} × 5.7.x — блок за політикою отримувача`);
  if (sent && !replies) reasons.push("жодної відповіді за тиждень");
  return {
    email, stage, nextStage, due, since: lookedAt.toISOString(),
    stats: { sent, bounced: bounces.length, bounceRate, policyBlocks: policy, replies },
    eligible: Boolean(nextStage) && !reasons.length,
    reasons
  };
}

/**
 * Look at every active sender whose week is up: step it up or hold it.
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
    } else {
      await append({ type: "sender.ramp_held", actor, data: { email: sender.email, stage: review.stage, reasons: review.reasons, stats: review.stats } });
      results.push({ ...review, action: "held" });
    }
  }
  return results;
}
