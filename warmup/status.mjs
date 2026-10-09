import { dayOfRun, inWorkingMode, totalDays } from "./strategy.mjs";

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

export const DERIVED_STATUSES = ["excluded", "blocked", "needs_attention", "limited", "paused", "warming", "working", "finished", "off"];

/**
 * Why a pause holds, read from the warning that started it.
 *
 * `invite_limit` is LinkedIn refusing new invitations for the week — on
 * 09.10.2026 Chloe and gulajpole, whose accounts were also sending from outside
 * this system. The operator saw «На паузі» and asked how, since nobody had
 * paused them: the cause is the thing to show, the pause is only what we do
 * about it. Anything else is a warning in general.
 */
const INVITE_LIMIT = /invitation limit|too many invitations|ліміт\S* (?:на )?запрошен|тижнев\S* ліміт|запрошення не було надіслано|лимит\S* приглашени/i;

export function pauseCause(note) {
  return typeof note === "string" && INVITE_LIMIT.test(note) ? "invite_limit" : "warning";
}

export function deriveStatus(account, run, todayIso, cause = null) {
  if (!account) return "off";
  if (account.status === "excluded") return "excluded";
  if (account.health === "blocked") return "blocked";
  if (account.health === "needs_login" || account.health === "captcha") return "needs_attention";
  // A warm-up with nowhere to run: the profile it was linked to is gone, or it
  // was never linked. Somebody has to fix that before the schedule means anything.
  if (!account.profile_remote_id) return "needs_attention";

  if (!run || run.state === "stopped") return "off";
  if (run.paused_until && run.paused_until >= todayIso) return cause === "invite_limit" ? "limited" : "paused";
  // A run whose last day has passed is working (or, with nothing to fall back
  // on, finished) whether or not anything marked it, so the list and the
  // detail page agree.
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
  const day = dayOfRun(run, asOf);
  if (run.state === "completed") return "finished";
  // Past the last phase is working mode — still sending, at the working rate —
  // and only a snapshot with nothing to fall back on is finished.
  if (inWorkingMode(run.strategy_snapshot, day)) return "working";
  if (day > totalDays(run.strategy_snapshot)) return "finished";
  return "warming";
}
