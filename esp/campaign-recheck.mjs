// Перевірка адрес кампаній ще раз (власник 04.11): «перепровір і ті адреси в
// яких не впевнений прибери з кампаній».
//
// Who: everybody still waiting for the first letter whose address was not
// found real — catch-all, «не перевірено», or no check at all — and those the
// first-letter filter already set aside for that. Each is asked of its mail
// server again (the same check as the folders'); a mailbox the server knows
// goes back to the campaign, anything else leaves it, with the reason. Those
// who already had a letter stay: it did not bounce.

const UNSURE_REASONS = new Set(["not_verified", "catch_all", "invalid"]);

/** Waiting for the first letter, and not known to be a real mailbox. */
export function needsRecheck(row) {
  if (row.lastSent || row.step > 0) return false;
  if (row.status === "active") return String(row.lead?.verification || "").toLowerCase() !== "valid";
  return row.status === "stopped" && UNSURE_REASONS.has(row.reason);
}

/**
 * `campaigns` — the campaign store (enrollments(), saveEnrollments());
 * `deep` — the mailbox check, `(email) → { status, reason }`.
 */
export function campaignRecheck({ campaigns, deep, now = () => new Date(), concurrency = 8, batch = 50 }) {
  let run = null;

  async function go(current) {
    const verifier = deep();
    const rows = campaigns.enrollments().filter(needsRecheck);
    current.total = rows.length;
    const results = new Map();
    const flush = async () => {
      if (!results.size) return;
      const done = new Map(results);
      results.clear();
      // Saved over what is there now: a letter sent or a stop made meanwhile wins.
      await campaigns.saveEnrollments(campaigns.enrollments().flatMap((row) => {
        const found = done.get(row.id);
        if (!found || !needsRecheck(row)) return [];
        const lead = { ...row.lead, verification: found.status, verifiedAt: found.at, verificationReason: found.reason };
        if (found.status === "valid") return [{ ...row, lead, status: "active", reason: null, stoppedAt: null }];
        const reason = found.status === "catch_all" ? "catch_all" : found.status === "invalid" ? "invalid" : "not_verified";
        return [{ ...row, lead, status: "stopped", reason, detail: found.reason, stoppedAt: found.at }];
      }));
    };
    let next = 0;
    const worker = async () => {
      while (next < rows.length && !current.stopped) {
        const row = rows[next++];
        let found;
        try {
          found = verifier ? await verifier(row.email) : { status: "unknown", reason: "перевірку адрес не підключено" };
        } catch (error) {
          found = { status: "unknown", reason: error.message };
        }
        const status = ["valid", "invalid", "catch_all"].includes(found.status) ? found.status : "unknown";
        current.counts[status] += 1;
        current.checked += 1;
        results.set(row.id, { status, reason: String(found.reason || ""), at: now().toISOString() });
        if (results.size >= batch) await flush();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
    await flush();
  }

  return {
    status: () => run,
    start() {
      if (run?.running) return run;
      const current = { running: true, stopped: false, startedAt: now().toISOString(), total: 0, checked: 0, counts: { valid: 0, invalid: 0, catch_all: 0, unknown: 0 }, error: null };
      run = current;
      const done = go(current)
        .catch((error) => { current.error = error.message; })
        .finally(() => { current.running = false; current.finishedAt = now().toISOString(); });
      Object.defineProperty(current, "done", { value: done, enumerable: false });
      return current;
    }
  };
}
