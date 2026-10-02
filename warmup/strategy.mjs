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

/**
 * The most connection requests any account may send in a day, whatever a
 * strategy says.
 *
 * A ceiling in code rather than a number in a row, because rows are edited and
 * snapshots outlive the code that wrote them: a strategy saved before this
 * existed, or one typed straight into the table, must not be able to send the
 * twenty-first. `validateStrategy` refuses a range above it, and `dailyQuota`
 * clamps to it anyway, so every quota check — the agent's, the seller's "I sent
 * it by hand", the panel's "record one" — is refused past it by the same number.
 */
export const CONNECT_HARD_MAX = 20;

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
  ],
  /**
   * What an account does once the last phase is behind it.
   *
   * The warm-up is the way in, not the job: an account that stopped sending on
   * day 15 was an account warmed for nothing. So past the last phase the plan
   * does not end, it settles — the same views and likes as the last phase, so
   * the account keeps looking like a person, and 10–15 requests a day, drawn
   * per account and day like every other figure. The ask was "at most 15–20,
   * preferably 10–15": the preferred range is what gets drawn, and twenty is
   * the hard ceiling above — never a target.
   */
  workingMode: {
    label: "Working mode",
    quotas: { profile_view: [10, 12], like: [2, 3], connect: [10, 15] },
    connectionNote: { maxWords: 3, allowLinks: false },
    rules: [
      "Working mode: 10–15 connection requests a day, never more than 20.",
      "A short note of 2–3 words is allowed on a request — never a link.",
      "No bulk actions of any kind."
    ]
  }
};

export function totalDays(strategy) {
  return (strategy?.phases || []).reduce((max, phase) => Math.max(max, phase.toDay), 0);
}

/**
 * The working mode a strategy settles into after its last phase.
 *
 * A strategy that carries none falls back to the one in code, and that is the
 * point rather than a convenience: every run started before working mode
 * existed froze a snapshot without it, and so did the default row in
 * `wl_strategies`, which is written once and never again. Without the fallback
 * each of those accounts would stop sending on day 15 until somebody restarted
 * it — from day 1. A snapshot with no phases at all is not a strategy, and gets
 * no working mode to go with it.
 */
export function workingModeOf(strategy) {
  if (!strategy?.phases?.length) return null;
  const own = strategy.workingMode;
  return own && typeof own === "object" && own.quotas && typeof own.quotas === "object"
    ? own
    : DEFAULT_STRATEGY.workingMode;
}

/** Past the last phase, with a working mode to be in. */
export function inWorkingMode(strategy, day) {
  return day > totalDays(strategy) && Boolean(workingModeOf(strategy));
}

/**
 * Whether this day has a plan at all: one of the phases, or working mode after
 * them. The scheduler and the semaphore both ask this, and must get one answer.
 */
export function hasPlanOn(strategy, day) {
  return day <= totalDays(strategy) || inWorkingMode(strategy, day);
}

export function phaseForDay(strategy, day) {
  const phase = (strategy?.phases || []).find((item) => day >= item.fromDay && day <= item.toDay);
  if (phase) return phase;
  return inWorkingMode(strategy, day) ? workingModeOf(strategy) : null;
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
  const drawn = high <= low ? Math.max(0, low) : low + (seedHash(`${accountId}:${day}:${kind}`) % (high - low + 1));
  // Clamped here, where every quota check reads it, rather than trusted to the
  // validation a snapshot may have been saved without.
  return kind === "connect" ? Math.min(drawn, CONNECT_HARD_MAX) : drawn;
}

/**
 * The day's plan. `working` is past the last phase and still sending;
 * `finished` is past it with nothing to fall back on, which only a snapshot
 * with no phases can be.
 */
export function planForDay(strategy, accountId, day) {
  const phase = phaseForDay(strategy, day);
  const quotas = {};
  for (const kind of ACTION_KINDS) quotas[kind] = dailyQuota(strategy, accountId, day, kind);
  const working = inWorkingMode(strategy, day);
  return {
    day,
    phase,
    quotas,
    connectionNote: phase?.connectionNote ?? false,
    rules: phase?.rules || [],
    working,
    finished: !hasPlanOn(strategy, day)
  };
}

// ── the note on a connection request ───────────────────────────────────────
//
// A phase says whether a request may carry a note: `false` for none, or
// `{ maxWords, allowLinks }` for a short one. The rule is applied when a
// request is handed to the agent, by the phase of the day it goes out — not
// when a seller queues it, because a request queued on day 3 leaves on day 4
// at the earliest, and the rule that matters is the one in force when LinkedIn
// sees it. Queueing therefore stays permissive, and the decision is made once,
// here, for the agent's list and for the record of what was sent.
//
// A note the rule does not allow is dropped and the request goes bare. It is
// never held back for its note: days 4–10 allow no note at all and every day
// after allows three words, so a request held until its note fits would, for
// almost every note a seller writes, wait for ever — and a bare request is
// exactly what the plan prescribes for those days. This is not the case
// `no_note` in `invites.mjs` is about: that is the browser failing to attach a
// note the portal did hand over, which is still a stop for a human.

/**
 * Words as a person counts them: whatever stands between spaces, and between
 * the commas, semicolons, slashes and bars people join words with when they
 * leave the space out — "Привіт,радий,знайомству" is three words, not one.
 * NFKC first, so the full-width comma an East Asian keyboard types is a comma.
 *
 * A piece with no letter or digit in it is not a word: the dash in «Радий
 * знайомству — Олег» stands between spaces, and counting it dropped a
 * three-word note as four.
 *
 * A dash that joins two words is not a separator: "IT-компанія" is one word,
 * and so is the rare «Привіт—Марто» typed without spaces.
 */
export function noteWordCount(note) {
  return String(note ?? "").normalize("NFKC").split(/[\s,;\/|，]+/u)
    .filter((piece) => /[\p{L}\p{N}]/u.test(piece)).length;
}

/**
 * Top-level domains written in Cyrillic, which the Latin rule in `noteHasLink`
 * cannot see: «adv.укр» and «сайт.рф» are links. A list rather than "any two
 * letters": «м.Київ», «вул.Шевченка» and «тис.грн» are everyday Ukrainian typed
 * without a space, and none of them is one. Punycode (`xn--p1ai`) needs no
 * entry — it is Latin letters, and the Latin rule already reads it. Exported
 * so the parity test can hold the form's copy of the list to this one.
 */
export const CYRILLIC_TLD = /^(?:укр|рф|бел|срб|мкд|қаз|рус|орг|ком|онлайн|сайт)(?![\p{L}\p{N}])/u;

/**
 * Whether a note carries anything that reads as a link: a scheme (`https://`),
 * `www.`, or a bare domain such as `example.com`, `bit.ly/x`, `adv.укр` or the
 * domain half of an email address. Bare domains are the point — "no links" is
 * about what LinkedIn and the person read as one, and nobody types the
 * `https://`.
 *
 * A bare domain is two labels joined by a dot, the second starting with at
 * least two Latin letters or being a Cyrillic top-level domain; the first may
 * be in any script (`пошта.com`). That catches "Node.js" and a missing space in
 * "Hi.Thanks" too; dropping a three-word note by mistake costs less than a link
 * sent from a young account, and the form says so while the note is being
 * typed. NFKC first and the ideographic dots made plain, so `ａｄａｃｔｉｏｎ．com`
 * and `adaction。com` are the domain they display as. A dot spelled out
 * ("adaction dot com") is not caught; nothing a person reads as a word is.
 *
 * Split and walked rather than matched with one pattern: the pattern that
 * says this in a line backtracks quadratically on a long run of letters, and
 * the note is whatever the request body carried.
 *
 * `app/main.js` has a copy (`inviteNoteHasLink`), and
 * `tests/warmup-note-parity.test.mjs` runs both over the same cases.
 */
export function noteHasLink(note) {
  const text = String(note ?? "").normalize("NFKC").toLowerCase().replace(/[。｡．]/g, ".");
  if (text.includes("://") || /(?:^|[^a-z0-9-])www\./.test(text)) return true;
  return text.split(/[^\p{L}\p{N}.-]+/u).some((chunk) => {
    const labels = chunk.split(".");
    return labels.some((label, index) => index > 0 && labels[index - 1] !== ""
      && (/^[a-z]{2,}(?![a-z0-9])/.test(label) || CYRILLIC_TLD.test(label)));
  });
}

/** The note rule in force on this day of this strategy — `false` when there is no plan. */
export function noteRuleOn(strategy, day) {
  return phaseForDay(strategy, day)?.connectionNote ?? false;
}

/**
 * The note a request may carry under a rule: `{ note, dropped }`.
 *
 * `note` is the text to send, or `null` to send the request bare. `dropped` is
 * why a note that existed did not survive — `"notes_off"`, `"too_many_words"`
 * or `"has_link"` — and `null` when nothing was dropped, including when there
 * was no note to begin with. A rule of `true` allows any note; anything else
 * that is not an object allows none, so a rule nobody understood errs on the
 * side of sending nothing a person did not clear.
 */
export function noteUnderRule(note, rule) {
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) return { note: null, dropped: null };
  if (rule === true) return { note: text, dropped: null };
  if (!rule || typeof rule !== "object") return { note: null, dropped: "notes_off" };
  if (Number.isInteger(rule.maxWords) && rule.maxWords >= 0 && noteWordCount(text) > rule.maxWords) {
    return { note: null, dropped: "too_many_words" };
  }
  if (rule.allowLinks !== true && noteHasLink(text)) return { note: null, dropped: "has_link" };
  return { note: text, dropped: null };
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

// ── the pause after a warning ──────────────────────────────────────────────
//
// A warning stops everything for the strategy's `pauseDays`: the rest of the
// day it came in on, and that many whole dates after it. `paused_until` is the
// last of them, and the pause holds while today is on or before it. The whole
// dates are taken out of the count the moment the warning is written — the
// warning day itself is not, because the account worked on it — so nothing
// has to happen when the pause runs out for the count to be right. That is the
// point: the pause ends by itself, whichever route or poll happens to notice
// first, and there is no second write that could count those days again.

/** An ISO date `days` after another, in UTC like `currentDay`. */
function isoPlusDays(iso, days) {
  const at = new Date(`${iso}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Whole dates from one ISO date to another. */
function datesBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00.000Z`) - Date.parse(`${fromIso}T00:00:00.000Z`)) / 86400000);
}

/**
 * Whether a pause holds on this date. The run's `state` is not asked: a run a
 * warning left `paused` is running again the day after `paused_until`, whether
 * or not anything has written that down yet.
 */
export function pausedOn(run, todayIso) {
  return Boolean(run?.paused_until && run.paused_until >= todayIso);
}

/**
 * The dates a run has sat out, as of `todayIso`: `paused_days`, plus the
 * stall when there is one.
 *
 * The stall is the dates after `paused_until` on which the row still read
 * `paused` — nothing took the account, so nothing wrote the pause down as
 * over (`settlePause`). They were not worked, and a count that took them as
 * progress sent the account on to a heavier phase it never did the days for.
 * That is not hypothetical: before the pause ended by itself, a warned
 * account stalled for good, and the first poll after the fix would otherwise
 * have woken each one weeks on — often straight into working mode and a full
 * folder top-up. Counted this way it comes back on the day after its warning
 * day however long it stood.
 *
 * Today is never part of the stall: the account can still be taken today.
 * Every reader asks this rather than `paused_days`, and the write that ends
 * the pause stores exactly this number — so whichever route writes it, and
 * whenever, the day does not move.
 */
export function pausedDaysOn(run, todayIso) {
  const recorded = Math.max(0, Number(run?.paused_days) || 0);
  if (run?.state !== "paused" || !run.paused_until || !todayIso || run.paused_until >= todayIso) return recorded;
  return recorded + Math.max(0, datesBetween(run.paused_until, todayIso) - 1);
}

/**
 * The day a run is on at `now`, with the stall counted as paused — see
 * `pausedDaysOn`. The date is read off the same instant as the day, so a
 * caller that pins its clock gets one answer.
 */
export function dayOfRun(run, now = new Date()) {
  return currentDay(new Date(run.started_at), pausedDaysOn(run, now.toISOString().slice(0, 10)), now);
}

/**
 * What a warning today does to this run.
 *
 * A fresh pause takes `pauseDays` dates out of the count. A warning while one
 * already holds — the agent reporting a block page on every invitation it
 * tries, or the button pressed twice — only takes the dates it adds past the
 * pause already standing, which on the same day is none. Counting each report
 * as a pause of its own would put a flagged account back a week for one bad
 * morning.
 */
export function warningPause(run, todayIso, pauseDays) {
  const length = Number.isInteger(pauseDays) && pauseDays >= 0 ? pauseDays : DEFAULT_STRATEGY.pauseDays;
  const fresh = isoPlusDays(todayIso, length);
  const holding = pausedOn(run, todayIso);
  const pausedUntil = holding && run.paused_until > fresh ? run.paused_until : fresh;
  const added = holding ? Math.max(0, datesBetween(run.paused_until, pausedUntil)) : length;
  // From the dates already sat out, stall included: a warning on a run nobody
  // took since its last pause must not hand those dates back to the count.
  return { pausedUntil, pausedDays: pausedDaysOn(run, todayIso) + added, added, extended: holding };
}

/**
 * How many of the paused dates a resume today hands back to the count.
 *
 * They were all taken when the warning came in, so resuming early has to
 * return the ones the account will now be working on — today and every date
 * to `paused_until`. Left in, a resume the next morning put the account a day
 * behind where it stopped, and one on the warning day itself two. Never more
 * than one pause's length, because the warning day was never taken; never
 * more than was taken at all. A resume after the pause has run out returns
 * nothing: the dates it covered really were paused.
 */
export function resumeCredit(run, todayIso, pauseDays) {
  if (!pausedOn(run, todayIso)) return 0;
  const length = Number.isInteger(pauseDays) && pauseDays >= 0 ? pauseDays : DEFAULT_STRATEGY.pauseDays;
  const ahead = datesBetween(todayIso, run.paused_until) + 1;
  return Math.max(0, Math.min(ahead, length, run.paused_days ?? 0));
}

/**
 * The day a run is on, for a screen.
 *
 * During a pause the count stands still at the day the account was warned on,
 * which is the day it will be on the last paused date — `currentDay` read then
 * rather than now. Read now, it showed the paused dates already taken out: a
 * warning on day 8 put "day 6" on screen straight away, as though the account
 * had been sent back.
 */
export function runDay(run, now = new Date()) {
  const asOf = pausedOn(run, now.toISOString().slice(0, 10)) ? new Date(`${run.paused_until}T00:00:00.000Z`) : now;
  return dayOfRun(run, asOf);
}

/** What is wrong with one block of quotas, prefixed with where it is. */
function quotasProblem(quotas, where) {
  for (const [kind, range] of Object.entries(quotas || {})) {
    if (!ACTION_KINDS.includes(kind)) return `${where}: невідома дія "${kind}"`;
    const [low, high] = range || [];
    if (!Number.isInteger(low) || !Number.isInteger(high) || low < 0 || high < low) {
      return `${where}: діапазон «${ACTION_LABEL[kind]}» некоректний`;
    }
    if (kind === "connect" && high > CONNECT_HARD_MAX) {
      return `${where}: більше ${CONNECT_HARD_MAX} запитів на контакт на день не можна`;
    }
  }
  return null;
}

/**
 * What is wrong with a note rule, prefixed with where it is. Checked because
 * `noteUnderRule` enforces only what it can read: a `maxWords` of "3" is no
 * word limit at all, and a strategy that meant three words would send three
 * hundred characters.
 */
function noteRuleProblem(rule, where) {
  if (rule === undefined || rule === null || typeof rule === "boolean") return null;
  const valid = typeof rule === "object" && !Array.isArray(rule)
    && (rule.maxWords === undefined || (Number.isInteger(rule.maxWords) && rule.maxWords >= 1))
    && (rule.allowLinks === undefined || typeof rule.allowLinks === "boolean");
  return valid ? null : `${where}: правило записки має бути false або { maxWords, allowLinks } із цілим числом слів`;
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

    const problem = quotasProblem(phase.quotas, `Фаза ${index + 1}`)
      || noteRuleProblem(phase.connectionNote, `Фаза ${index + 1}`);
    if (problem) return problem;
  }
  // Absent is allowed and means the working mode in code — see `workingModeOf`.
  if (input.workingMode !== undefined && input.workingMode !== null) {
    const working = input.workingMode;
    if (typeof working !== "object" || Array.isArray(working) || !working.quotas || typeof working.quotas !== "object") {
      return "Робочому режиму потрібні квоти";
    }
    const problem = quotasProblem(working.quotas, "Робочий режим")
      || noteRuleProblem(working.connectionNote, "Робочий режим");
    if (problem) return problem;
  }
  if (input.pauseDays !== undefined && (!Number.isInteger(input.pauseDays) || input.pauseDays < 0)) {
    return "Тривалість паузи має бути цілим числом днів";
  }
  return null;
}
