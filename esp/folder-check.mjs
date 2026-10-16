/**
 * «Перевірити адреси» on a CRM folder in «Ліди» (власник 16.10: «зробити вже в
 * цій папці можливість запустити перевірку схожу до MillionVerifier»).
 *
 * Every address in the folder, in the background, with the progress on the
 * page:
 *   1. here — the address is written right, its domain exists and takes mail
 *      (MX; or an A record, as the RFC allows; a «null MX» says it never does),
 *      it is not a throwaway mailbox;
 *   2. then, when MILLIONVERIFIER_API_KEY is set, MillionVerifier asks the
 *      mailbox's own server — the step this server cannot take itself: its
 *      outbound port 25 is closed, so contacts/email-check.mjs never gets past
 *      «could not tell» here.
 * The answer goes where the rest of the app reads it — the contact's
 * custom_fields.email_check[address] — so the page's dot, the lead card and
 * the campaign filter (ESP 6: only `valid` is sent) see it at once.
 *
 * An address checked in the last 30 days with a definite answer is not asked
 * again: a second run after a restart or a deploy continues where it stopped.
 */

import { resolve4, resolve6, resolveMx } from "node:dns/promises";

const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const ROLE = /^(info|sales|support|hello|contact|admin|office|marketing|hr|jobs|careers|team|help|noreply|no-reply|billing|press|partners?)$/i;
// Throwaway mailboxes: nobody reads them a week later.
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "10minutemail.com", "10minutemail.net", "temp-mail.org",
  "tempmail.com", "tempmail.net", "throwawaymail.com", "yopmail.com", "yopmail.net", "getnada.com", "nada.email", "trashmail.com",
  "trashmail.de", "dispostable.com", "maildrop.cc", "mailnesia.com", "mintemail.com", "fakeinbox.com", "emailondeck.com",
  "mohmal.com", "tempail.com", "tempr.email", "discard.email", "spamgourmet.com", "mailcatch.com", "moakt.com", "burnermail.io"
]);
const FRESH_DAYS = 30;
const DEFINITE = new Set(["valid", "invalid", "catch_all"]);
const BATCH = 500;
const BY = "folder-check";

export const CHECK_REASON = {
  syntax: "адреса записана з помилкою",
  no_domain: "домену не існує",
  null_mx: "домен заявляє, що не приймає пошту",
  no_mail: "домен не приймає пошту (немає MX)",
  disposable: "одноразова пошта"
};

const MV_STATUS = { ok: "valid", catch_all: "catch_all", invalid: "invalid", disposable: "invalid", unknown: "unknown" };
const MV_REASON = {
  ok: "MillionVerifier: скринька існує",
  catch_all: "MillionVerifier: сервер приймає будь-яку адресу (catch-all)",
  invalid: "MillionVerifier: такої скриньки немає",
  disposable: "MillionVerifier: одноразова пошта",
  unknown: "MillionVerifier: сервер не дав відповіді"
};

/** DNS-level verdict for a domain: ok / no_domain / null_mx / no_mail / unknown. */
export function domainChecker({ mx = resolveMx, a = resolve4, aaaa = resolve6 } = {}) {
  const cache = new Map();
  const definite = (error) => error?.code === "ENOTFOUND" || error?.code === "ENODATA";
  async function verdict(domain) {
    try {
      const rows = await mx(domain);
      if (rows.length && rows.every((row) => !row.exchange || row.exchange === ".")) return "null_mx";
      if (rows.length) return "ok";
    } catch (error) {
      if (!definite(error)) return "unknown";
      if (error.code === "ENOTFOUND") return "no_domain";
    }
    for (const lookup of [a, aaaa]) {
      try { if ((await lookup(domain)).length) return "ok"; } catch (error) { if (!definite(error)) return "unknown"; }
    }
    return "no_mail";
  }
  return (domain) => {
    if (!cache.has(domain)) cache.set(domain, verdict(domain));
    return cache.get(domain);
  };
}

/** The checks this server can make itself. `{ status: "invalid", reason }` or `{ status: "pass", role }`. */
export async function quickCheck(value, domainOf) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!ADDRESS.test(email) || email.length > 254) return { status: "invalid", code: "syntax", reason: CHECK_REASON.syntax };
  const [local, domain] = email.split("@");
  const role = ROLE.test(local);
  if (DISPOSABLE.has(domain)) return { status: "invalid", code: "disposable", reason: CHECK_REASON.disposable, role };
  const verdict = await domainOf(domain);
  if (verdict === "no_domain" || verdict === "null_mx" || verdict === "no_mail") return { status: "invalid", code: verdict, reason: CHECK_REASON[verdict], role };
  return { status: "pass", role, dnsUnknown: verdict === "unknown" };
}

/**
 * MillionVerifier's single-address API. `null` when no key is set. Throws on
 * an answer that means «stop» (wrong key, no credits) — the run ends with it.
 */
export function millionVerifier({ key = process.env.MILLIONVERIFIER_API_KEY || "", fetchImpl = globalThis.fetch } = {}) {
  if (!key) return null;
  return async (email) => {
    const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&timeout=20`;
    let body = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(40000) });
        body = await response.json().catch(() => null);
        if (response.ok && body) break;
      } catch {
        body = null;
      }
    }
    if (!body) return { status: "unknown", reason: "MillionVerifier не відповів" };
    if (body.error) {
      const stop = /api|key|credit|insufficient|balance/i.test(body.error);
      if (stop) throw Object.assign(new Error(`MillionVerifier: ${body.error}`), { stop: true });
      return { status: "unknown", reason: `MillionVerifier: ${body.error}` };
    }
    const result = String(body.result || "").toLowerCase();
    const status = MV_STATUS[result] || "unknown";
    return { status, reason: MV_REASON[result] || `MillionVerifier: ${result || "без відповіді"}`, role: Boolean(body.role), free: Boolean(body.free), credits: body.credits ?? null };
  };
}

/**
 * The folder runs, one at a time per folder, kept in memory with their counts.
 * `crm` — the CRM REST client; `deep` — millionVerifier() or null.
 */
export function folderChecker({ crm, deep = () => millionVerifier(), domainOf = domainChecker(), now = () => new Date(), concurrency = 8 }) {
  const runs = new Map();
  const IN_FOLDER = "m:contact_folder_memberships!inner(folder_id)";

  function view(run) {
    if (!run) return null;
    const { finished, stopRequested, ...rest } = run;
    return { ...rest, counts: { ...run.counts } };
  }

  async function writeCheck(contact, email, check) {
    const fields = contact.custom_fields && typeof contact.custom_fields === "object" ? contact.custom_fields : {};
    const checks = fields.email_check && typeof fields.email_check === "object" ? fields.email_check : {};
    const next = { ...fields, email_check: { ...checks, [email]: check } };
    await crm.from("contacts").update({ custom_fields: next }).eq("id", contact.id).rows();
  }

  async function one(run, contact, verifier) {
    const email = String(contact.email || "").trim().toLowerCase();
    const known = contact.custom_fields?.email_check?.[email];
    const age = known?.checkedAt ? (now().getTime() - Date.parse(known.checkedAt)) / 86_400_000 : Infinity;
    if (known && DEFINITE.has(known.status) && age < FRESH_DAYS) {
      run.counts[known.status] += 1;
      run.counts.earlier += 1;
      return;
    }
    const quick = await quickCheck(email, domainOf);
    const at = now().toISOString();
    if (quick.status === "invalid") {
      run.counts.invalid += 1;
      await writeCheck(contact, email, { status: "invalid", reason: quick.reason, checkedAt: at, by: BY, ...(quick.role ? { role: true } : {}) });
      return;
    }
    if (!verifier) {
      run.counts.domainOk += 1;
      return;
    }
    const answer = await verifier(email);
    run.counts[answer.status] = (run.counts[answer.status] || 0) + 1;
    if (answer.credits != null) run.credits = answer.credits;
    await writeCheck(contact, email, { status: answer.status, reason: answer.reason, checkedAt: at, by: "millionverifier", ...(answer.role || quick.role ? { role: true } : {}) });
  }

  async function go(run) {
    const verifier = run.deep ? deep() : null;
    try {
      run.total = await crm.from("contacts").select(`id,${IN_FOLDER}`).eq("m.folder_id", run.folderId).notNull("email").neq("email", "").count();
      let after = "";
      for (;;) {
        if (run.stopRequested) { run.state = "stopped"; break; }
        let query = crm.from("contacts").select(`id,email,custom_fields,${IN_FOLDER}`).eq("m.folder_id", run.folderId).notNull("email").neq("email", "");
        if (after) query = query.gt("id", after);
        const rows = await query.order("id").limit(BATCH).rows();
        let next = 0;
        const worker = async () => {
          while (next < rows.length && !run.stopRequested) {
            const contact = rows[next++];
            try {
              await one(run, contact, verifier);
            } catch (error) {
              if (error.stop) { run.stopRequested = true; run.error = error.message; return; }
              run.counts.failed += 1;
              run.lastError = error.message;
            }
            run.done += 1;
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
        if (rows.length < BATCH) { run.state = run.stopRequested ? "stopped" : "done"; break; }
        after = rows.at(-1).id;
      }
    } catch (error) {
      run.state = "failed";
      run.error = `CRM: ${error.message}`;
    }
    if (run.state === "running") run.state = "done";
    if (run.error && run.state !== "failed") run.state = "stopped";
    run.finishedAt = now().toISOString();
  }

  return {
    deepAvailable: () => Boolean(deep()),
    status(folderId) { return view(runs.get(folderId)); },
    start(folderId) {
      const current = runs.get(folderId);
      if (current?.state === "running") return view(current);
      const run = {
        folderId, state: "running", deep: Boolean(deep()), total: null, done: 0,
        counts: { valid: 0, invalid: 0, catch_all: 0, unknown: 0, domainOk: 0, earlier: 0, failed: 0 },
        startedAt: now().toISOString(), finishedAt: null, error: null, lastError: null, credits: null, stopRequested: false
      };
      runs.set(folderId, run);
      run.finished = go(run);
      return view(run);
    },
    stop(folderId) {
      const run = runs.get(folderId);
      if (run?.state === "running") run.stopRequested = true;
      return view(run);
    },
    /** For tests: the promise of a run's end. */
    finished(folderId) { return runs.get(folderId)?.finished; }
  };
}
