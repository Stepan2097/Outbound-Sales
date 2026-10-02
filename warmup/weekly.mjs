import { anty, today } from "./db.mjs";

export const WEEKLY_CONNECT_LIMIT = 60;

/** Seven UTC dates including today; restarting a run does not reset the account. */
export function connectWeek(todayIso = today()) {
  const end = new Date(`${todayIso}T00:00:00.000Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function weeklyAllowance(done = 0, todayIso = today()) {
  return { limit: WEEKLY_CONNECT_LIMIT, done, remaining: Math.max(0, WEEKLY_CONNECT_LIMIT - done), ...connectWeek(todayIso) };
}

/** Page reads: PostgREST can truncate a week's counters without an error. */
export async function weeklyConnectCounts(accountIds, todayIso = today()) {
  const ids = [...new Set(accountIds)];
  const counts = new Map(ids.map((id) => [id, 0]));
  const { start, end } = connectWeek(todayIso);
  const pageSize = 500;
  for (let batch = 0; batch < ids.length; batch += 100) {
    const wanted = ids.slice(batch, batch + 100);
    for (let offset = 0; ; offset += pageSize) {
      const rows = await anty.from("wl_day_actions").select("id,account_id,on_date,kind,done")
        .in("account_id", wanted).eq("kind", "connect").gte("on_date", start).lt("on_date", end)
        .order("id").limit(pageSize).offset(offset).rows();
      for (const row of rows) {
        if (counts.has(row.account_id) && row.kind === "connect" && row.on_date >= start && row.on_date < end) {
          counts.set(row.account_id, counts.get(row.account_id) + Math.max(0, Number(row.done) || 0));
        }
      }
      if (rows.length < pageSize) break;
    }
    // A real send reported outside its allowance is still a weekly send.
    // Normal events already have a day counter and must not be counted twice.
    for (let offset = 0; ; offset += pageSize) {
      const rows = await anty.from("wl_events").select("id,account_id,type,meta,created_at")
        .in("account_id", wanted).eq("type", "invite.sent")
        .gte("created_at", `${start}T00:00:00.000Z`).lt("created_at", `${end}T00:00:00.000Z`)
        .order("id").limit(pageSize).offset(offset).rows();
      for (const row of rows) {
        const date = row.created_at?.slice(0, 10);
        if (counts.has(row.account_id) && row.type === "invite.sent" && date >= start && date < end
          && (row.meta?.overQuota || row.meta?.duringPause)) counts.set(row.account_id, counts.get(row.account_id) + 1);
      }
      if (rows.length < pageSize) break;
    }
  }
  return counts;
}

export async function weeklyConnectAllowance(accountId, todayIso = today()) {
  return weeklyAllowance((await weeklyConnectCounts([accountId], todayIso)).get(accountId) ?? 0, todayIso);
}

/** Today's total ceiling after applying what remains of the weekly allowance. */
export function connectCeiling(dailyQuota, todayDone, weekDone) {
  return Math.min(dailyQuota, todayDone + Math.max(0, WEEKLY_CONNECT_LIMIT - weekDone));
}
