import { resolve4, resolveMx, resolveTxt } from "node:dns/promises";

import { allEntries, append, contactKey } from "./journal.mjs";

/**
 * The registry of sending domains and senders.
 *
 * Which domains the team sends cold email from, and which mailboxes on them —
 * with their state and the history of every change. It has no table of its own:
 * it is the journal folded (`registry()`), so it is append-only by
 * construction, and "who paused this sender, when and why" is a line, not a
 * guess. Nothing secret lives here: a sender carries only `mailboxRef`, the
 * *name* of the credential the mail connection (ESP 1) looks up outside the code.
 *
 * Domain states, as the checklist names them: `aging` (старіє — registered,
 * not sending yet), `ramp` (рампа — sending, limits still climbing), `active`,
 * `reserve` (запас — ready, held back), `retired` (виведений — never again; it
 * takes its senders with it), and `paused` — stopped for now by a person or an
 * alarm (ESP 8). Only `ramp` and `active` domains send.
 *
 * Sender: the person behind the mailbox, its ramp stage — the daily limit,
 * 5 → 10 → 15 → 20 → 25 → 30 → 35 (ESP 4 enforces it) — and its state
 * (`active`, `paused`, `retired`). Only a registered, active sender on a sending
 * domain may send: `canSend`.
 */

export const DOMAIN_STATES = ["aging", "ramp", "active", "reserve", "paused", "retired"];
export const SENDING_DOMAIN_STATES = ["ramp", "active"];
export const RAMP_STAGES = [5, 10, 15, 20, 25, 30, 35];
export const DOMAIN_LABEL = { aging: "старіє", ramp: "рампа", active: "активний", reserve: "запас", paused: "пауза", retired: "виведений" };
export const SENDER_STATES = ["active", "paused", "retired"];

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/** A domain as it is stored: lower-case, no scheme, no path, no trailing dot. */
export function domainKey(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(text) ? text : null;
}

/** The registry as of now: every domain and sender with its state and its own history. */
export async function registry() {
  const domains = new Map();
  const senders = new Map();
  for (const entry of await allEntries()) {
    const data = entry.data || {};
    const stamp = { seq: entry.seq, at: entry.at, actor: entry.actor, type: entry.type };
    if (entry.type === "domain.added") {
      const status = DOMAIN_STATES.includes(data.status) ? data.status : "aging";
      domains.set(data.domain, {
        domain: data.domain, status, note: data.note || "", registeredAt: data.registeredAt || null,
        addedAt: entry.at, addedBy: entry.actor, checks: null, history: [{ ...stamp, status }]
      });
    } else if (entry.type === "domain.status" && domains.has(data.domain)) {
      const domain = domains.get(data.domain);
      domain.status = data.status;
      domain.history.push({ ...stamp, status: data.status, reason: data.reason || "" });
    } else if (entry.type === "domain.checked" && domains.has(data.domain)) {
      domains.get(data.domain).checks = { ...data.checks, at: entry.at };
    } else if (entry.type === "sender.added") {
      senders.set(data.email, {
        email: data.email, domain: data.domain, displayName: data.displayName || "", mailboxRef: data.mailboxRef || "",
        person: data.person || "", rampStage: RAMP_STAGES.includes(data.rampStage) ? data.rampStage : RAMP_STAGES[0],
        status: "active", addedAt: entry.at, addedBy: entry.actor, history: [{ ...stamp, status: "active" }]
      });
    } else if (entry.type === "sender.updated" && senders.has(data.email)) {
      const sender = senders.get(data.email);
      for (const field of ["person", "rampStage", "mailboxRef", "displayName"]) {
        if (data[field] !== undefined) sender[field] = data[field];
      }
      sender.history.push({ ...stamp, changed: Object.keys(data).filter((key) => key !== "email") });
    } else if (entry.type === "sender.status" && senders.has(data.email)) {
      const sender = senders.get(data.email);
      sender.status = data.status;
      sender.history.push({ ...stamp, status: data.status, reason: data.reason || "", ...(data.code ? { code: data.code } : {}) });
    }
  }
  // A sender is only as live as its domain: a paused domain pauses every mailbox on it.
  for (const sender of senders.values()) {
    const domain = domains.get(sender.domain);
    sender.limit = sender.rampStage;
    sender.rampStep = RAMP_STAGES.indexOf(sender.rampStage) + 1;
    sender.effectiveStatus = !domain || domain.status === "retired" ? "retired"
      : !SENDING_DOMAIN_STATES.includes(domain.status) && sender.status === "active" ? "held" : sender.status;
    sender.heldBy = sender.effectiveStatus === "held" ? domain.status : null;
  }
  return {
    domains: [...domains.values()].sort((left, right) => left.domain.localeCompare(right.domain)),
    senders: [...senders.values()].sort((left, right) => left.email.localeCompare(right.email))
  };
}

export async function addDomain({ domain, note = "", registeredAt = "", status = "aging" }, actor) {
  const key = domainKey(domain);
  if (!key) throw fail("Це не схоже на домен: потрібне щось на зразок mail.example.com.");
  if (!DOMAIN_STATES.includes(status) || status === "retired" || status === "paused") {
    throw fail("Новий домен починає як «старіє», «рампа», «активний» або «запас».");
  }
  const date = String(registeredAt || "").trim();
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || Date.parse(date) > Date.now())) {
    throw fail("Дата реєстрації — у вигляді РРРР-ММ-ДД і не в майбутньому.");
  }
  const { domains } = await registry();
  if (domains.some((row) => row.domain === key)) throw fail(`Домен ${key} уже є в реєстрі.`, 409);
  return append({ type: "domain.added", actor, data: { domain: key, status, registeredAt: date || null, note: String(note).slice(0, 500) } });
}

export async function setDomainStatus({ domain, status, reason = "" }, actor) {
  const key = domainKey(domain);
  if (!DOMAIN_STATES.includes(status)) throw fail(`Стан домену — один із: ${DOMAIN_STATES.join(", ")}.`);
  const { domains } = await registry();
  const found = domains.find((row) => row.domain === key);
  if (!found) throw fail("Такого домену в реєстрі немає.", 404);
  if (found.status === "retired") throw fail("Домен виведено назавжди — повернути його не можна. Додайте новий.", 409);
  if (found.status === status) return null;
  if (["paused", "retired"].includes(status) && !String(reason).trim()) throw fail("Скажіть, чому: причина лишається в журналі.");
  return append({ type: "domain.status", actor, data: { domain: key, status, reason: String(reason).slice(0, 500) } });
}

export async function addSender({ email, displayName = "", mailboxRef = "", person = "", rampStage = RAMP_STAGES[0] }, actor) {
  const key = contactKey(email);
  if (!key) throw fail("Це не схоже на адресу пошти.");
  const domain = key.split("@")[1];
  const { domains, senders } = await registry();
  const host = domains.find((row) => row.domain === domain);
  if (!host) throw fail(`Спершу додайте домен ${domain} у реєстр.`, 409);
  if (host.status === "retired") throw fail(`Домен ${domain} виведено — на ньому нових відправників не буде.`, 409);
  if (senders.some((row) => row.email === key)) throw fail(`${key} уже є в реєстрі.`, 409);
  const ref = String(mailboxRef || "").trim();
  if (ref && !/^[A-Z][A-Z0-9_]{2,80}$/.test(ref)) {
    throw fail("Посилання на доступ — лише назва змінної середовища (напр. GMAIL_MARY_TOKEN), не сам ключ.");
  }
  const stage = Number(rampStage);
  if (!RAMP_STAGES.includes(stage)) throw fail(`Етап рампи — один із: ${RAMP_STAGES.join(", ")} листів на день.`);
  return append({
    type: "sender.added", actor,
    data: {
      email: key, domain, displayName: String(displayName).trim().slice(0, 120), mailboxRef: ref,
      person: String(person).trim().slice(0, 120), rampStage: stage
    }
  });
}

/**
 * Who stands behind a mailbox, its ramp stage, its credential's name. The
 * stage moves one step at a time — up only by the ramp rule (ESP 4/8), down at
 * any time — and every move is a line with its author.
 */
export async function updateSender({ email, person, rampStage, mailboxRef, displayName }, actor) {
  const key = contactKey(email);
  const { senders } = await registry();
  const found = senders.find((row) => row.email === key);
  if (!found) throw fail("Такого відправника в реєстрі немає.", 404);
  if (found.status === "retired") throw fail("Відправника виведено назавжди.", 409);
  const change = {};
  if (person !== undefined && String(person).trim() !== found.person) change.person = String(person).trim().slice(0, 120);
  if (displayName !== undefined && String(displayName).trim() !== found.displayName) change.displayName = String(displayName).trim().slice(0, 120);
  if (mailboxRef !== undefined && String(mailboxRef).trim() !== found.mailboxRef) {
    const ref = String(mailboxRef).trim();
    if (ref && !/^[A-Z][A-Z0-9_]{2,80}$/.test(ref)) {
      throw fail("Посилання на доступ — лише назва змінної середовища (напр. GMAIL_MARY_TOKEN), не сам ключ.");
    }
    change.mailboxRef = ref;
  }
  if (rampStage !== undefined && Number(rampStage) !== found.rampStage) {
    const stage = Number(rampStage);
    if (!RAMP_STAGES.includes(stage)) throw fail(`Етап рампи — один із: ${RAMP_STAGES.join(", ")} листів на день.`);
    if (RAMP_STAGES.indexOf(stage) > RAMP_STAGES.indexOf(found.rampStage) + 1) {
      throw fail("Рампа йде по одному етапу вгору: перестрибнути не можна.", 409);
    }
    change.rampStage = stage;
  }
  if (!Object.keys(change).length) return null;
  return append({ type: "sender.updated", actor, data: { email: key, ...change } });
}

export async function setSenderStatus({ email, status, reason = "", code = null }, actor) {
  const key = contactKey(email);
  if (!SENDER_STATES.includes(status)) throw fail(`Стан відправника — один із: ${SENDER_STATES.join(", ")}.`);
  const { senders } = await registry();
  const found = senders.find((row) => row.email === key);
  if (!found) throw fail("Такого відправника в реєстрі немає.", 404);
  if (found.status === "retired") throw fail("Відправника виведено назавжди.", 409);
  if (found.status === status) return null;
  if (status !== "active" && !String(reason).trim()) throw fail("Скажіть, чому: причина лишається в журналі.");
  return append({
    type: "sender.status", actor,
    data: { email: key, status, reason: String(reason).slice(0, 500), ...(code ? { code: String(code).slice(0, 80) } : {}) }
  });
}

/** Whether this address may send right now, and if not, the sentence why. */
export async function canSend(email) {
  const key = contactKey(email);
  const { senders } = await registry();
  const sender = senders.find((row) => row.email === key);
  if (!sender) return { ok: false, reason: `${email} немає в реєстрі відправників.` };
  if (sender.effectiveStatus === "held") {
    return { ok: false, reason: `${sender.email}: домен ${sender.domain} у стані «${DOMAIN_LABEL[sender.heldBy] || sender.heldBy}» — з нього не надсилають.` };
  }
  if (sender.effectiveStatus !== "active") {
    return { ok: false, reason: `${sender.email}: ${sender.effectiveStatus === "paused" ? "на паузі" : "виведено"}${sender.status === "active" ? " разом із доменом" : ""}.` };
  }
  return { ok: true, sender };
}

/**
 * What DNS says about a sending domain: MX, SPF, DMARC and, given a selector,
 * DKIM. Read-only and outward only to DNS; the answer is journalled so the
 * registry shows when it was last looked at and what was found.
 */
/**
 * Whether a domain is on a blocklist: Spamhaus DBL — only through a DQS key,
 * because Spamhaus does not answer public resolvers and a query through one
 * reads as "clean" when it is not — and SURBL. An answer in 127.0.0.0/8 is a
 * listing; "no such name" is clean; anything else is not an answer. The key is
 * read from `SPAMHAUS_DQS_KEY` and never written anywhere.
 */
export async function blocklists(key, dns = { resolve4 }, env = process.env) {
  const ask = async (name) => {
    try {
      const answers = await dns.resolve4(name);
      return answers.some((ip) => /^127\.255\.255\./.test(ip)) ? { status: "error", answers }
        : answers.some((ip) => ip.startsWith("127.")) ? { status: "listed", answers } : { status: "error", answers };
    } catch (error) {
      return error?.code === "ENOTFOUND" || error?.code === "ENODATA" ? { status: "clean" } : { status: "error", error: error?.code || "dns" };
    }
  };
  const dqs = String(env.SPAMHAUS_DQS_KEY || "").trim();
  const [dbl, surbl] = await Promise.all([
    /^[a-z0-9]{10,64}$/i.test(dqs) ? ask(`${key}.${dqs}.dbl.dq.spamhaus.net`) : Promise.resolve({ status: "not_checked", why: "немає ключа DQS" }),
    ask(`${key}.multi.surbl.org`)
  ]);
  return { spamhausDbl: dbl, surbl, listed: dbl.status === "listed" || surbl.status === "listed" };
}

export async function checkDomain({ domain, dkimSelector = "" }, actor, dns = { resolveTxt, resolveMx, resolve4 }, env = process.env) {
  const key = domainKey(domain);
  if (!key) throw fail("Це не схоже на домен.");
  const txt = async (name) => {
    try { return (await dns.resolveTxt(name)).map((parts) => parts.join("")); } catch { return []; }
  };
  const [mx, root, dmarc, dkim, lists] = await Promise.all([
    dns.resolveMx(key).then((rows) => rows.map((row) => row.exchange)).catch(() => []),
    txt(key),
    txt(`_dmarc.${key}`),
    dkimSelector && /^[a-z0-9-_.]{1,63}$/i.test(dkimSelector) ? txt(`${dkimSelector}._domainkey.${key}`) : Promise.resolve(null),
    dns.resolve4 ? blocklists(key, dns, env) : Promise.resolve(null)
  ]);
  const spf = root.find((line) => /^v=spf1\b/i.test(line)) || null;
  const dmarcRecord = dmarc.find((line) => /^v=DMARC1\b/i.test(line)) || null;
  const checks = {
    mx: mx.length ? mx : null,
    spf,
    dmarc: dmarcRecord,
    dmarcPolicy: dmarcRecord ? (/\bp=(none|quarantine|reject)\b/i.exec(dmarcRecord)?.[1]?.toLowerCase() ?? null) : null,
    dkimSelector: dkimSelector || null,
    dkim: dkim === null ? null : (dkim.find((line) => /\bp=/.test(line)) || false),
    blocklists: lists
  };
  await append({ type: "domain.checked", actor, data: { domain: key, checks } });
  return checks;
}

/**
 * The registry as the pause store of the mail connection's `SenderGate`
 * (esp/senders.mjs: `pausedFor` / `list` / `pause` / `resume`), so a sender
 * Google refused is paused *in the registry*, with its code, in the journal —
 * one truth instead of two lists.
 *
 * `pausedFor` answers for anything that may not send, not only for a pause: an
 * unregistered mailbox, a retired one, one on a domain that is ageing or held
 * in reserve. The gate then refuses before the provider is ever asked.
 */
export function registrySenderStore(actor = "esp-gate") {
  const lastChange = (sender) => [...sender.history].reverse().find((row) => row.status === sender.status) || {};
  return {
    async pausedFor(mailbox) {
      const allowed = await canSend(mailbox);
      if (allowed.ok) return null;
      const { senders } = await registry();
      const sender = senders.find((row) => row.email === contactKey(mailbox));
      const last = sender ? lastChange(sender) : {};
      return {
        code: last.code || (sender ? `sender_${sender.effectiveStatus}` : "not_registered"),
        reason: last.reason || allowed.reason,
        at: last.at || null
      };
    },
    async list() {
      const { senders } = await registry();
      return senders.filter((row) => row.status === "paused").map((row) => {
        const last = lastChange(row);
        return { mailbox: row.email, code: last.code || "paused", reason: last.reason || "", at: last.at || null };
      });
    },
    async pause(mailbox, pause) {
      const { senders } = await registry();
      const sender = senders.find((row) => row.email === contactKey(mailbox));
      // The first reason stays, as in the state store: a second refusal is the same problem.
      if (sender && sender.status === "active") {
        await setSenderStatus({ email: mailbox, status: "paused", reason: pause.reason || "відмова Google", code: pause.code }, actor);
      }
      return (await this.pausedFor(mailbox)) || pause;
    },
    async resume(mailbox) {
      const { senders } = await registry();
      const sender = senders.find((row) => row.email === contactKey(mailbox));
      if (!sender || sender.status !== "paused") return false;
      await setSenderStatus({ email: mailbox, status: "active" }, actor);
      return true;
    }
  };
}
