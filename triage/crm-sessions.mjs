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
    const beat = Date.parse(row.updated_at || row.session_start);
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
