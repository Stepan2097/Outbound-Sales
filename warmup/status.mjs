import { currentDay, totalDays } from "./strategy.mjs";

/**
 * One word for "what state is this account in".
 *
 * Health (what a human saw in the browser) and the run (what the schedule says)
 * are two facts; this folds them, in a fixed order of urgency, into the one word
 * the operator scans the list by. A blocked account that is also paused is
 * "blocked": the pause is a consequence, and the operator needs the cause.
 */

export const HEALTH_VALUES = ["ok", "needs_login", "captcha", "blocked"];

export const HEALTH_LABEL = {
  ok: "OK",
  needs_login: "Needs login",
  captcha: "Captcha",
  blocked: "Blocked"
};

export function isHealth(value) {
  return typeof value === "string" && HEALTH_VALUES.includes(value);
}

export const DERIVED_STATUSES = ["excluded", "blocked", "needs_attention", "paused", "warming", "finished", "off"];

export function deriveStatus(account, run, todayIso) {
  if (!account) return "off";
  if (account.status === "excluded") return "excluded";
  if (account.health === "blocked") return "blocked";
  if (account.health === "needs_login" || account.health === "captcha") return "needs_attention";
  // A warm-up with nowhere to run: the profile it was linked to is gone, or it
  // was never linked. Somebody has to fix that before the schedule means anything.
  if (!account.profile_remote_id) return "needs_attention";

  if (!run || run.state === "stopped") return "off";
  if (run.paused_until && run.paused_until >= todayIso) return "paused";
  // A run whose last day has passed is finished whether or not anything marked
  // it completed, so the list and the detail page agree.
  // The day comes from the `todayIso` this was called with, not from the wall
  // clock. Same number in production — `today()` is UTC and `currentDay`
  // reckons in UTC midnights — but a caller that pins the day now gets the day
  // it pinned. Reading the clock here while honouring the argument two lines
  // up is how a test passes for a month and then turns red on a morning when
  // nobody changed anything.
  // A missing day falls back to the clock rather than to `new Date(undefined)`,
  // which is an Invalid Date and would make `day` NaN — every status silently
  // "warming".
  const asOf = todayIso ? new Date(todayIso) : new Date();
  const day = currentDay(new Date(run.started_at), run.paused_days ?? 0, asOf);
  if (run.state === "completed" || day > totalDays(run.strategy_snapshot)) return "finished";
  return "warming";
}
