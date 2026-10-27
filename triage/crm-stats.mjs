// «Статистика» — та сама, що в CRM (власник 23.10: «подивися як в срм зроблена
// статистика і таку статистику треба в оутбаунд»). CRM рахує її в базі —
// get_funnel_counts, get_deal_volumes, get_user_activity_breakdown,
// get_user_channel_details, get_user_daily_performance, — і Outbound кличе ті
// самі функції тієї самої бази, тож числа однакові на обох сторінках. Розбір
// відповідей функцій повторює CRM (A-plat-crm, src/app/(dashboard)/stats).
//
// Періоди — як у CRM: цей / минулий тиждень (з понеділка), цей / минулий місяць,
// або свої дати; порівняння — з попереднім періодом тієї самої довжини. Межі днів —
// за Europe/Warsaw, як підписано в CRM («Таймзона аналітики»).

import { workTime } from "./crm-sessions.mjs";

export const STATS_ZONE = "Europe/Warsaw";
export const PRESETS = ["this_week", "prev_week", "this_month", "prev_month"];

export const FUNNEL_STAGES = [
  ["new", "Новий"],
  ["in_progress", "В обробці"],
  ["linkedin_activity", "LinkedIn активність"],
  ["responded_or_other", "Відписав / інший статус"],
  ["booked_call", "Дзвінок"],
  ["deal_created", "Угода створена"],
  ["won", "Won"],
  ["lost", "Lost"]
];
const MAIN_FUNNEL = ["new", "in_progress", "linkedin_activity", "responded_or_other", "booked_call", "deal_created"];
const RESPONDED_OR_OTHER = ["responded", "qualification", "no_response", "not_interested", "not_icp", "bad_timing", "booked_call"];

const DAY_MS = 86_400_000;

/** The offset of the zone at this instant, in minutes east of UTC. */
function zoneOffset(ms, zone = STATS_ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - ms) / 60_000);
}

/** Midnight of a calendar day in the zone, as an instant. */
export function zoneMidnight(day, zone = STATS_ZONE) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  return guess - zoneOffset(guess, zone) * 60_000;
}

export function zoneDay(ms, zone = STATS_ZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

const addDays = (day, count) => new Date(Date.parse(`${day}T12:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);

/** { from, to } calendar days (inclusive) of a preset, or the given dates. */
export function statsRange({ preset = "this_week", from = "", to = "", now = Date.now() } = {}) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to) return { from, to, preset: null };
  const today = zoneDay(now);
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(today, -weekday);
  const monthStart = `${today.slice(0, 8)}01`;
  const nextMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const kind = PRESETS.includes(preset) ? preset : "this_week";
  if (kind === "prev_week") return { from: addDays(monday, -7), to: addDays(monday, -1), preset: kind };
  if (kind === "this_month") return { from: monthStart, to: addDays(nextMonth, -1), preset: kind };
  if (kind === "prev_month") {
    const prevStart = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10);
    return { from: prevStart, to: addDays(monthStart, -1), preset: kind };
  }
  return { from: monday, to: addDays(monday, 6), preset: "this_week" };
}

/** The instants a range covers, and the same length just before it. */
export function rangeInstants({ from, to }) {
  const start = zoneMidnight(from);
  const end = zoneMidnight(addDays(to, 1)) - 1;
  const length = end - start + 1;
  return {
    current: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    previous: { start: new Date(start - length).toISOString(), end: new Date(start - 1).toISOString() }
  };
}

export function percentChange(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

/** get_funnel_counts → the stages and the conversions between them, as CRM shows them. */
export function funnelFrom(counts = {}) {
  const status = counts.status_counts || {};
  const stage = {
    new: counts.total_contacts || 0,
    in_progress: status.in_progress || 0,
    linkedin_activity: counts.linkedin_activity_contacts || 0,
    responded_or_other: RESPONDED_OR_OTHER.reduce((sum, key) => sum + (status[key] || 0), 0),
    booked_call: status.booked_call || 0,
    deal_created: counts.deal_contacts || 0,
    won: counts.won || 0,
    lost: counts.lost || 0
  };
  const stages = FUNNEL_STAGES.map(([key, label]) => ({ key, label, count: stage[key] || 0 }));
  const transitions = MAIN_FUNNEL.slice(0, -1).map((fromKey, index) => {
    const toKey = MAIN_FUNNEL[index + 1];
    return { from: fromKey, to: toKey, count: stage[toKey] || 0, conversionRate: stage[fromKey] ? Math.round(((stage[toKey] || 0) / stage[fromKey]) * 100) : 0 };
  });
  return { stages, transitions, totalContacts: counts.total_contacts || 0, processedContacts: counts.processed_contacts || 0 };
}

const stageCount = (funnel, key) => funnel.stages.find((row) => row.key === key)?.count || 0;

export function kpisFrom(current, previous, revenue, prevRevenue) {
  const deals = stageCount(current, "deal_created");
  const won = stageCount(current, "won");
  const prevDeals = stageCount(previous, "deal_created");
  const prevWon = stageCount(previous, "won");
  const winRate = deals ? Math.round((won / deals) * 100) : 0;
  const prevWinRate = prevDeals ? Math.round((prevWon / prevDeals) * 100) : 0;
  return [
    { key: "new", label: "Нові контакти", value: current.totalContacts, delta: percentChange(current.totalContacts, previous.totalContacts) },
    { key: "processed", label: "Оброблено контактів", value: current.processedContacts, delta: percentChange(current.processedContacts, previous.processedContacts) },
    { key: "deals", label: "Угод створено", value: deals, delta: percentChange(deals, prevDeals) },
    { key: "won", label: "Угод Won", value: won, delta: percentChange(won, prevWon) },
    { key: "revenue", label: "Дохід Won", value: revenue, money: true, delta: percentChange(revenue, prevRevenue) },
    { key: "winRate", label: "Win rate", value: winRate, percent: true, delta: percentChange(winRate, prevWinRate) }
  ];
}

const CHANNEL_KEYS = ["sent_messages", "sent_people", "sent_first", "sent_second", "sent_third_plus", "replied_people", "replied_first_time", "replied_repeat", "replied_after_1", "replied_after_2", "replied_after_3_plus"];
const COUNT_KEYS = [
  ["emails_count", "emails_sent"], ["emails_replied", "emails_replied"], ["linkedin_count", "linkedin_sent"], ["linkedin_replied", "linkedin_replied"],
  ["whatsapp_count", "whatsapp_sent"], ["whatsapp_replied", "whatsapp_replied"], ["meetings_count", "meetings"], ["deals_created", "deals"],
  ["total_activities", "total"], ["notes_count", "notes"], ["calls_count", "calls"], ["incoming_count", "incoming"],
  ["meeting_activities", "meeting_activities"], ["booked_calls", "booked_calls"]
];

/** get_user_activity_breakdown + get_user_channel_details → a row per approved person, busiest first. */
export function teamFrom(profiles = [], breakdown = [], details = []) {
  const totals = new Map();
  for (const row of breakdown) {
    const sum = totals.get(row.user_id) || Object.fromEntries(COUNT_KEYS.map(([key]) => [key, 0]));
    for (const [key, column] of COUNT_KEYS) sum[key] += Number(row[column]) || 0;
    totals.set(row.user_id, sum);
  }
  const channels = new Map();
  for (const row of details) {
    const mine = channels.get(row.user_id) || {};
    mine[row.channel] = Object.fromEntries(CHANNEL_KEYS.map((key) => [key, Number(row[key]) || 0]));
    channels.set(row.user_id, mine);
  }
  return profiles.map((profile) => ({
    userId: profile.id,
    email: profile.email,
    ...(totals.get(profile.id) || Object.fromEntries(COUNT_KEYS.map(([key]) => [key, 0]))),
    channels: channels.get(profile.id) || {}
  })).sort((left, right) => right.total_activities - left.total_activities || String(left.email).localeCompare(String(right.email)));
}

/** Hours at work (CRM + Outbound, overlaps merged) and actions per hour, as CRM's tracker shows them. */
export function withTime(team, time) {
  const byUser = new Map(time.map((row) => [row.userId, row]));
  return team.map((row) => {
    const tracked = byUser.get(row.userId);
    const minutes = tracked?.minutes || 0;
    return { ...row, minutes, sessions: tracked?.sessions || 0, tabMinutes: tracked?.tabMinutes || 0, actions: tracked?.actions || 0, weekdayMinutes: tracked?.weekdays || [], actionsPerHour: minutes ? Math.round((row.total_activities / (minutes / 60)) * 10) / 10 : 0 };
  });
}

/** get_user_daily_performance → newest day first, then by person. */
export function dailyFrom(profiles = [], rows = []) {
  const emails = new Map(profiles.map((profile) => [profile.id, profile.email]));
  return rows.filter((row) => emails.has(row.user_id))
    .map((row) => ({ userId: row.user_id, email: emails.get(row.user_id), day: String(row.day).slice(0, 10), contactsAdded: Number(row.contacts_added) || 0, salesActivities: Number(row.sales_activities) || 0 }))
    .sort((left, right) => right.day.localeCompare(left.day) || String(left.email).localeCompare(String(right.email)));
}

/** The whole page, read from the CRM. `crm` — the REST client (warmup/db.mjs). */
export async function crmStats({ crm, preset, from, to, user = "all", now = Date.now(), workEntries = [] }) {
  const range = statsRange({ preset, from, to, now });
  const { current, previous } = rangeInstants(range);
  const who = /^[0-9a-f-]{36}$/i.test(String(user)) ? user : null;
  const rpc = (name, args) => crm.rpc(name, args).rows();
  const span = (r) => ({ p_start: r.start, p_end: r.end });
  const [funnelNow, funnelBefore, volumesNow, volumesBefore, breakdown, details, daily, profiles] = await Promise.all([
    rpc("get_funnel_counts", { ...span(current), p_user: who }),
    rpc("get_funnel_counts", { ...span(previous), p_user: who }),
    rpc("get_deal_volumes", { start_date: current.start, end_date: current.end }),
    rpc("get_deal_volumes", { start_date: previous.start, end_date: previous.end }),
    rpc("get_user_activity_breakdown", span(current)),
    rpc("get_user_channel_details", span(current)),
    rpc("get_user_daily_performance", span(current)),
    crm.from("profiles").select("id,email").eq("approval_status", "approved").rows()
  ]);
  // Working time (triage/crm-sessions.mjs, 27.10): CRM and Outbound tabs plus the
  // person's own actions — in CRM, its LinkedIn extension and Outbound — overlaps once.
  const idByEmail = new Map(profiles.map((profile) => [String(profile.email || "").toLowerCase(), profile.id]));
  const time = await workTime({ crm, start: current.start, end: current.end, workEntries, idByEmail, zone: STATS_ZONE, now });
  const funnel = funnelFrom(funnelNow[0] || {});
  const before = funnelFrom(funnelBefore[0] || {});
  const revenue = Number(volumesNow[0]?.won) || 0;
  const prevRevenue = Number(volumesBefore[0]?.won) || 0;
  const won = stageCount(funnel, "won");
  return {
    range: { ...range, zone: STATS_ZONE },
    user: who || "all",
    people: profiles.map((profile) => ({ id: profile.id, email: profile.email })).sort((left, right) => String(left.email).localeCompare(String(right.email))),
    kpis: kpisFrom(funnel, before, revenue, prevRevenue),
    funnel,
    deals: { won, lost: stageCount(funnel, "lost"), revenue, average: won ? revenue / won : 0 },
    team: withTime(teamFrom(profiles, breakdown, details), time),
    daily: dailyFrom(profiles, daily)
  };
}
