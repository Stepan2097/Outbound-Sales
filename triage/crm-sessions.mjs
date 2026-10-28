// Час роботи — один на CRM і Outbound (власник 23.10: «години з срм і порталу
// оутбаунд мають синхронізуватися а не додаватися»).
//
// CRM пише час відрізками в user_session_time: відкрита сесія живе, поки її
// продовжують «серцебиття» (updated_at), і закінчується не пізніше останнього
// серцебиття + 2 хвилини. Outbound тепер продовжує ту саму відкриту сесію
// людини (її id в Outbound і в CRM той самий), а коли сесії немає — відкриває
// нову. Дві вкладки — CRM і Outbound — це одна сесія, а не дві, і статистика
// обох складає відрізки, що перекриваються, в один. Логіка — з CRM
// (A-plat-crm: src/app/api/extension/time/route.ts, stats/activityActions.ts).

export const HEARTBEAT_GRACE_MS = 2 * 60 * 1000;
const WEEKDAYS = ["понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота", "неділя"];

/** One beat from an open Outbound tab: extend the person's open session, or open one. */
export async function sessionBeat({ crm, userId, now = Date.now() }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(userId || ""))) return { ok: false };
  const nowIso = new Date(now).toISOString();
  const open = await crm.from("user_session_time").select("id,session_start,updated_at").eq("user_id", userId).isNull("session_end")
    .order("session_start", { ascending: false }).limit(1).maybeSingle();
  if (open?.id) {
    const beatMs = Date.parse(open.updated_at || open.session_start);
    if (Number.isFinite(beatMs) && now - beatMs <= HEARTBEAT_GRACE_MS) {
      await crm.from("user_session_time").update({ updated_at: nowIso }).eq("id", open.id).rows();
      return { ok: true, sessionId: open.id, reused: true };
    }
    // Stale: it ended with its last beat (plus the grace), as CRM closes it.
    const endMs = Math.min((Number.isFinite(beatMs) ? beatMs : Date.parse(open.session_start)) + HEARTBEAT_GRACE_MS, now);
    await crm.from("user_session_time").update({ session_end: new Date(endMs).toISOString() }).eq("id", open.id).rows();
  }
  const [made] = await crm.from("user_session_time").insert({ user_id: userId, session_start: nowIso, updated_at: nowIso }).select("id").rows();
  return { ok: true, sessionId: made?.id || null, reused: false };
}

/** The sessions that touch a range — paged, as CRM reads them. */
export async function sessionsInRange({ crm, start, end }) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await crm.from("user_session_time").select("user_id,session_start,session_end,updated_at")
      .lt("session_start", end).or(`session_end.gte.${start},session_end.is.null`)
      .order("session_start").order("id").limit(1000).offset(offset).rows();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

/** Per person: the session intervals inside the range, cut at the last beat + grace, overlaps merged. */
export function mergedIntervals(sessions, { start, end, now = Date.now() }) {
  const rangeStart = Date.parse(start);
  const rangeEnd = Date.parse(end);
  const byUser = new Map();
  for (const row of sessions) {
    if (!row?.user_id) continue;
    const startRaw = Date.parse(row.session_start);
    let beat = Date.parse(row.updated_at || row.session_start);
    // A session closed at a day boundary and touched after it (27.10: 84 hours
    // for one person, evenings till midnight for another): its last beat was
    // overwritten and is not known — the tab counts for its first moments only,
    // the person's actions (workTime) carry the rest.
    if (row.session_end && Number.isFinite(beat) && beat > Date.parse(row.session_end) + 60_000) beat = startRaw;
    const cap = (Number.isFinite(beat) ? beat : startRaw) + HEARTBEAT_GRACE_MS;
    const closed = row.session_end ? Date.parse(row.session_end) : now;
    let from = startRaw;
    let to = Math.min(closed, cap, now);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    if (Number.isFinite(rangeStart)) from = Math.max(from, rangeStart);
    if (Number.isFinite(rangeEnd)) to = Math.min(to, rangeEnd);
    if (to <= from) continue;
    byUser.set(row.user_id, [...(byUser.get(row.user_id) || []), { from, to }]);
  }
  const merged = new Map();
  for (const [userId, intervals] of byUser) {
    const out = [];
    for (const interval of intervals.sort((left, right) => left.from - right.from)) {
      const last = out.at(-1);
      if (last && interval.from <= last.to) last.to = Math.max(last.to, interval.to);
      else out.push({ ...interval });
    }
    merged.set(userId, out);
  }
  return merged;
}

const weekdayInZone = (ms, zone) => (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short" }).format(new Date(ms))) + 7) % 7;

/** Tracked minutes per person (and per weekday, by the zone), and how many sessions. */
export function sessionStats(merged, { zone = "Europe/Warsaw" } = {}) {
  return [...merged].map(([userId, intervals]) => {
    const weekday = [0, 0, 0, 0, 0, 0, 0];
    let total = 0;
    for (const { from, to } of intervals) {
      total += Math.round((to - from) / 60_000);
      for (let cursor = from; cursor < to;) {
        const hour = new Date(cursor);
        hour.setUTCMinutes(0, 0, 0);
        const next = Math.min(hour.getTime() + 3_600_000, to);
        weekday[weekdayInZone(cursor, zone)] += Math.max(0, Math.round((next - cursor) / 60_000));
        cursor = next;
      }
    }
    return { userId, sessions: intervals.length, minutes: total, weekdays: WEEKDAYS.map((label, index) => ({ label, minutes: weekday[index] })) };
  });
}

/** When each person was last at work — in CRM or in Outbound: the newest beat of their sessions. */
export async function lastActive({ crm, since = new Date(Date.now() - 400 * 86_400_000).toISOString() }) {
  const rows = await crm.from("user_session_time").select("user_id,session_start,updated_at,session_end")
    .gte("session_start", since).order("session_start", { ascending: false }).limit(1000).rows();
  const latest = new Map();
  for (const row of rows) {
    const at = [row.updated_at, row.session_end, row.session_start].filter(Boolean).sort().at(-1);
    if (at && (!latest.has(row.user_id) || at > latest.get(row.user_id))) latest.set(row.user_id, at);
  }
  return latest;
}

// ── Робочий час: вкладки + дії (власник 27.10: «так, рахуй і за діями зроби
// максимально точний підрахунок часу») ─────────────────────────────────────
//
// Вкладка рахується, поки вона на екрані й людина нею користується (CRM і —
// з 27.10 — Outbound шлють серцебиття лише після руху миші чи клавіші за
// останні 3 хв). Але лідген більшість дня працює в LinkedIn, де жодної нашої
// вкладки немає. Тому до вкладок додаються дії людини — із журналу CRM
// (розширення LinkedIn, угоди, задачі), нотатки й повідомлення CRM, зміни
// статусів, журнал Outbound (переглянув, написав, відповів, збагатив…). Дія —
// це щонайменше хвилина роботи перед нею; дії, між якими ≤ 60 хв, — одна
// безперервна робота. Відправлене агентом (origin outbound) роботою людини не є.
// Час — об'єднання вкладок і дій: що перекривається, рахується раз.

// Година (28.10): лідген зберігає контакти пачками кожні 30–45 хв, а між ними працює в LinkedIn —
// з межею 15 хв робочий день 09–20 рахувався як 3 год.
export const ACTION_GAP_MS = 60 * 60_000;
export const ACTION_LEAD_MS = 2 * 60_000;
export const ACTION_TAIL_MS = 60_000;

/** Action moments → work intervals: each action stands for a little work around it; close ones join. */
export function actionIntervals(moments) {
  const sorted = [...moments].filter(Number.isFinite).sort((left, right) => left - right);
  const out = [];
  for (const at of sorted) {
    const last = out.at(-1);
    if (last && at - last.lastAt <= ACTION_GAP_MS) {
      last.to = at + ACTION_TAIL_MS;
      last.lastAt = at;
    } else {
      out.push({ from: at - ACTION_LEAD_MS, to: at + ACTION_TAIL_MS, lastAt: at });
    }
  }
  return out.map(({ from, to }) => ({ from, to }));
}

/** Union of interval lists, cut to the range. */
export function unionIntervals(lists, { start, end } = {}) {
  const from = Date.parse(start);
  const to = Date.parse(end);
  const all = lists.flat().map((row) => ({ from: Number.isFinite(from) ? Math.max(row.from, from) : row.from, to: Number.isFinite(to) ? Math.min(row.to, to) : row.to }))
    .filter((row) => row.to > row.from).sort((left, right) => left.from - right.from);
  const out = [];
  for (const row of all) {
    const last = out.at(-1);
    if (last && row.from <= last.to) last.to = Math.max(last.to, row.to);
    else out.push({ ...row });
  }
  return out;
}

async function paged(build) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await build().limit(1000).offset(offset).rows();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

/** Every action of every person in the range, as moments by CRM user id. */
export async function actionMoments({ crm, start, end, workEntries = [], idByEmail = new Map() }) {
  const [log, activities, statuses] = await Promise.all([
    paged(() => crm.from("user_activity_log").select("user_id,created_at").gte("created_at", start).lt("created_at", end).order("created_at").order("id")),
    paged(() => crm.from("activities").select("user_id,created_at,origin").gte("created_at", start).lt("created_at", end).notNull("user_id").order("created_at").order("id")),
    paged(() => crm.from("contact_status_history").select("changed_by,changed_at").gte("changed_at", start).lt("changed_at", end).notNull("changed_by").order("changed_at").order("id"))
  ]);
  const moments = new Map();
  const add = (userId, at) => {
    const ms = Date.parse(at);
    if (!userId || !Number.isFinite(ms)) return;
    if (!moments.has(userId)) moments.set(userId, []);
    moments.get(userId).push(ms);
  };
  for (const row of log) add(row.user_id, row.created_at);
  // What the agent sent on a person's account is not the person's work.
  for (const row of activities) if (row.origin !== "outbound") add(row.user_id, row.created_at);
  for (const row of statuses) add(row.changed_by, row.changed_at);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  for (const row of workEntries) {
    const ms = Date.parse(row.at);
    if (ms >= startMs && ms < endMs) add(idByEmail.get(String(row.user || "").toLowerCase()), row.at);
  }
  return moments;
}

/** Working time per person: tabs (CRM + Outbound) and actions, overlaps once. Minutes, blocks, per weekday. */
export async function workTime({ crm, start, end, workEntries = [], idByEmail = new Map(), zone = "Europe/Warsaw", now = Date.now() }) {
  const [sessions, moments] = await Promise.all([
    sessionsInRange({ crm, start, end }),
    actionMoments({ crm, start, end, workEntries, idByEmail })
  ]);
  const tabs = mergedIntervals(sessions, { start, end, now });
  const users = new Set([...tabs.keys(), ...moments.keys()]);
  const merged = new Map();
  for (const userId of users) {
    merged.set(userId, unionIntervals([tabs.get(userId) || [], actionIntervals(moments.get(userId) || [])], { start, end: new Date(Math.min(Date.parse(end), now)).toISOString() }));
  }
  const stats = sessionStats(merged, { zone });
  for (const row of stats) {
    row.tabMinutes = Math.round((tabs.get(row.userId) || []).reduce((sum, item) => sum + (item.to - item.from), 0) / 60_000);
    row.actions = (moments.get(row.userId) || []).length;
  }
  return stats;
}
