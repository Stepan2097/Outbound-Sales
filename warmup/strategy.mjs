/**
 * A warm-up strategy: the schedule, as editable data.
 *
 * A strategy is a row, not code, and a run keeps a snapshot of the strategy it
 * started under — so editing one never rewrites what an account part-way
 * through was working to.
 */

export const ACTION_KINDS = ["profile_view", "like", "connect", "post_comment", "follow"];

export const ACTION_LABEL = {
  profile_view: "Profile views",
  like: "Likes",
  connect: "Connection requests",
  post_comment: "Comments",
  follow: "Follows"
};

/** The strategy the product ships with. */
export const DEFAULT_STRATEGY = {
  name: "Standard 14-day warm-up",
  description: "Views first, then likes, then requests. Notes only in the last phase.",
  isDefault: true,
  pauseDays: 2,
  phases: [
    {
      fromDay: 1, toDay: 3, label: "Look, do not touch",
      quotas: { profile_view: [3, 5] },
      connectionNote: false,
      rules: [
        "Profile views only, 3–5 a day. No more.",
        "No connection requests, no likes, no messages.",
        "Fill the profile to 100%: photo, banner, experience, education, skills, summary."
      ]
    },
    {
      fromDay: 4, toDay: 6, label: "First contact",
      quotas: { profile_view: [5, 7], like: [1, 2], connect: [1, 2] },
      connectionNote: false,
      rules: [
        "Likes on feed posts only, 1–2 a day.",
        "Requests only to your own team or verified contacts. No notes."
      ]
    },
    {
      fromDay: 7, toDay: 10, label: "Into the niche",
      quotas: { profile_view: [7, 10], like: [2, 2], connect: [3, 4] },
      connectionNote: false,
      rules: [
        "Requests to people in your niche, but not competitors. No notes.",
        "No bulk actions of any kind."
      ]
    },
    {
      fromDay: 11, toDay: 14, label: "Opening up",
      quotas: { profile_view: [10, 12], like: [2, 3], connect: [5, 6] },
      connectionNote: { maxWords: 3, allowLinks: false },
      rules: ["A short note of 2–3 words is allowed on a request — never a link."]
    }
  ]
};

export function totalDays(strategy) {
  return (strategy?.phases || []).reduce((max, phase) => Math.max(max, phase.toDay), 0);
}

export function phaseForDay(strategy, day) {
  return (strategy?.phases || []).find((phase) => day >= phase.fromDay && day <= phase.toDay) || null;
}

function seedHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/**
 * Today's figure for one action, drawn from the phase range but seeded on the
 * account and the day. Every account doing exactly five views a day is itself a
 * pattern, and a figure that changed on refresh would leave nobody knowing what
 * today's plan was.
 */
export function dailyQuota(strategy, accountId, day, kind) {
  const range = phaseForDay(strategy, day)?.quotas?.[kind];
  if (!range) return 0;
  const [low, high] = range;
  if (high <= low) return Math.max(0, low);
  return low + (seedHash(`${accountId}:${day}:${kind}`) % (high - low + 1));
}

export function planForDay(strategy, accountId, day) {
  const phase = phaseForDay(strategy, day);
  const quotas = {};
  for (const kind of ACTION_KINDS) quotas[kind] = dailyQuota(strategy, accountId, day, kind);
  return {
    day,
    phase,
    quotas,
    connectionNote: phase?.connectionNote ?? false,
    rules: phase?.rules || [],
    finished: day > totalDays(strategy)
  };
}

/**
 * Which day an account is on. Paused days are dead time, not progress —
 * returning from a pause into a heavier phase is how a flagged account gets
 * restricted outright.
 */
export function currentDay(startedAt, pausedDays, now = new Date()) {
  const atMidnight = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const elapsed = Math.floor((atMidnight(now) - atMidnight(startedAt)) / 86400000);
  return Math.max(1, elapsed + 1 - Math.max(0, pausedDays));
}

/** Reject a strategy that cannot be run, with a reason an operator can act on. */
export function validateStrategy(input = {}) {
  if (typeof input.name !== "string" || !input.name.trim()) return "Стратегії потрібна назва";
  if (!Array.isArray(input.phases) || input.phases.length === 0) return "Додай хоча б одну фазу";

  let previousEnd = 0;
  for (const [index, phase] of input.phases.entries()) {
    if (!Number.isInteger(phase.fromDay) || !Number.isInteger(phase.toDay)) return `Фаза ${index + 1}: дні мають бути цілими числами`;
    if (phase.fromDay < 1 || phase.toDay < phase.fromDay) return `Фаза ${index + 1}: діапазон днів іде навпаки`;
    // Gaps are rejected rather than silently treated as rest days: a day with no
    // phase would quietly forbid every action, which reads as a broken app.
    if (phase.fromDay !== previousEnd + 1) return `Фаза ${index + 1} має починатися з дня ${previousEnd + 1}`;
    previousEnd = phase.toDay;

    for (const [kind, range] of Object.entries(phase.quotas || {})) {
      if (!ACTION_KINDS.includes(kind)) return `Фаза ${index + 1}: невідома дія "${kind}"`;
      const [low, high] = range || [];
      if (!Number.isInteger(low) || !Number.isInteger(high) || low < 0 || high < low) {
        return `Фаза ${index + 1}: діапазон «${ACTION_LABEL[kind]}» некоректний`;
      }
    }
  }
  if (input.pauseDays !== undefined && (!Number.isInteger(input.pauseDays) || input.pauseDays < 0)) {
    return "Тривалість паузи має бути цілим числом днів";
  }
  return null;
}
