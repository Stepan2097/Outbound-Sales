// Перевірка адрес кампаній ще раз (власник 04.11): «перепровір і ті адреси в
// яких не впевнений прибери з кампаній».
//
// Who: everybody still waiting for the first letter whose address was not
// checked to the end — «не перевірено» or no check at all — and those set
// aside 04.11 as catch-all or unchecked. 05.11, the owner: «відкидаємо тільки
// пошти в яких 80%+ впевнені що вони погані» — only a server that says the
// mailbox does not exist takes a person out; catch-all and «no answer» stay
// in the campaign. A catch-all is not asked again: the answer would be the same.

const UNSURE_REASONS = new Set(["not_verified", "catch_all"]);

/** Waiting for the first letter, and not known to be a real mailbox. */
export function needsRecheck(row) {
  if (row.lastSent || row.step > 0) return false;
  if (row.status === "active") return !["valid", "catch_all", "invalid"].includes(String(row.lead?.verification || "").toLowerCase());
  return row.status === "stopped" && UNSURE_REASONS.has(row.reason);
}

/**
 * `campaigns` — the campaign store (enrollments(), saveEnrollments());
 * `deep` — the mailbox check, `(email) → { status, reason }`. A run may bring
 * its own answers instead (`verdicts`, email → { status, reason }: a check made
 * elsewhere, e.g. through a proxy); a person it has no answer for is left as is.
 */
export function campaignRecheck({ campaigns, deep, now = () => new Date(), concurrency = 8, batch = 50 }) {
  let run = null;

  async function go(current, verdicts) {
    const verifier = verdicts ? null : deep();
    const rows = campaigns.enrollments().filter((row) => needsRecheck(row) && (!verdicts || verdicts.has(row.email)));
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
        if (found.status !== "invalid") return [{ ...row, lead, status: "active", reason: null, detail: null, stoppedAt: null }];
        return [{ ...row, lead, status: "stopped", reason: "invalid", detail: found.reason, stoppedAt: found.at }];
      }));
    };
    let next = 0;
    const worker = async () => {
      while (next < rows.length && !current.stopped) {
        const row = rows[next++];
        let found;
        try {
          found = verdicts ? verdicts.get(row.email) : verifier ? await verifier(row.email) : { status: "unknown", reason: "перевірку адрес не підключено" };
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
    start({ verdicts = null } = {}) {
      if (run?.running) return run;
      const answers = verdicts && typeof verdicts === "object"
        ? new Map(Object.entries(verdicts).map(([email, value]) => [String(email).trim().toLowerCase(), { status: String(value?.status || value || ""), reason: String(value?.reason || "") }]))
        : null;
      const current = { running: true, stopped: false, startedAt: now().toISOString(), total: 0, checked: 0, counts: { valid: 0, invalid: 0, catch_all: 0, unknown: 0 }, error: null };
      run = current;
      const done = go(current, answers)
        .catch((error) => { current.error = error.message; })
        .finally(() => { current.running = false; current.finishedAt = now().toISOString(); });
      Object.defineProperty(current, "done", { value: done, enumerable: false });
      return current;
    }
  };
}
