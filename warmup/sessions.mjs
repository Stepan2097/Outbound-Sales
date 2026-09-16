/**
 * A session: one stretch of the profile being open.
 *
 * Nobody types these in. Sync opens one when Anty reports the profile running
 * and closes it when that stops; the agent opens and closes its own. So a
 * session answers "when was this account in, for how long, and what did it do".
 */

/** Whole minutes; null while the session is still open. */
export function durationMin(startedAt, endedAt) {
  if (!endedAt) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 60000));
}

export function describeSession(row) {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMin: durationMin(row.started_at, row.ended_at),
    source: row.source,
    runningOn: row.running_on,
    actions: row.actions || {},
    note: row.note
  };
}

/**
 * Anty stamps last_launched_at with SQLite's datetime('now'): UTC, but written
 * as 'YYYY-MM-DD HH:MM:SS' with no zone. Parsed as-is that reads as local time
 * and puts every session start hours off. Anything that does not parse returns
 * null so the caller can fall back to now — a session that starts at sync time
 * is a little short; one at an invented time is wrong.
 */
export function antyTimestampToIso(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw);
  const ms = Date.parse(naive ? `${raw.replace(" ", "T")}Z` : raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
