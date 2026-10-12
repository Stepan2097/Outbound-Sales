// Чи існує адреса (власник 12.10): «спаршені пошти треба перевіряти на
// валідність… якщо тест не пройшла то навіть не показувати, і з срм коли
// підтягуєш пошту теж треба тестувати і якщо ні то ставити "!"».
//
// Three tests, the third only when the first two pass:
//   1. the address is an address;
//   2. its domain takes mail — an MX record (or, as the RFC allows, an A record);
//   3. the domain's mail server, asked the way a sending server asks, says it
//      has this mailbox — and says it does NOT have a random one next to it,
//      because a server that accepts anything («catch-all») proves nothing.
// Nothing is sent: the conversation stops at RCPT TO and ends with QUIT.
//
// Statuses: `valid` (the server knows the mailbox), `invalid` (the address,
// the domain or the server says no), `catch_all` (the server accepts any
// address — existence cannot be told), `unknown` (no answer, greylisting, a
// block — not tested). Only `valid` passes.

import { randomBytes } from "node:crypto";
import { resolve4, resolveMx as dnsResolveMx } from "node:dns/promises";
import net from "node:net";
import os from "node:os";

const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const ROLE = /^(info|sales|support|hello|contact|admin|office|marketing|hr|jobs|careers|team|help|noreply|no-reply|billing|press|partners?)$/i;

export const EMAIL_CHECK_LABEL = {
  valid: "скринька існує",
  invalid: "такої скриньки немає",
  catch_all: "сервер приймає будь-яку адресу — існування не перевірити",
  unknown: "перевірити не вдалося"
};

function result(email, status, reason, extra = {}) {
  return { email, status, reason, checkedAt: new Date().toISOString(), ...extra };
}

/** One SMTP conversation: banner, EHLO, MAIL FROM, RCPT TO for each address, QUIT. Codes by address. */
function smtpProbe({ host, port = 25, helo, from = "", addresses, timeoutMs = 12000, connect = net.connect }) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const replies = [];
    let buffer = "";
    let step = 0;
    const commands = [`EHLO ${helo}`, `MAIL FROM:<${from}>`, ...addresses.map((address) => `RCPT TO:<${address}>`), "QUIT"];
    const done = (outcome) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on?.("error", () => {});
      socket.destroy?.();
      resolve(outcome);
    };
    const timer = setTimeout(() => done({ error: "timeout", replies }), timeoutMs);
    socket.setEncoding?.("utf8");
    socket.on("error", (error) => done({ error: error.code || error.message, replies }));
    socket.on("data", (chunk) => {
      buffer += chunk;
      // A reply is complete on a line whose 4th character is a space ("250 ok"), not a dash ("250-…").
      let match;
      while ((match = buffer.match(/^(\d{3})([ -])(.*)\r?\n/m))) {
        const end = buffer.indexOf(match[0]) + match[0].length;
        const line = match[0];
        buffer = buffer.slice(end);
        if (match[2] === "-") continue;
        const code = Number(match[1]);
        replies.push({ code, text: line.trim() });
        // The banner, EHLO and MAIL FROM must be 2xx; anything else ends the talk.
        if (replies.length <= 3 && (code < 200 || code >= 300)) { socket.write("QUIT\r\n"); return done({ error: `refused_${code}`, replies }); }
        if (step < commands.length) socket.write(`${commands[step]}\r\n`);
        step += 1;
        if (step > commands.length) return done({ replies });
      }
    });
    socket.on("end", () => done({ replies, error: replies.length < commands.length ? "closed" : null }));
  });
}

/**
 * Is this address real? See the top of the file. `resolveMx`, `connect`,
 * `port` are for tests; `helo` and `from` default to this host and a null
 * sender, the way a bounce-checking server introduces itself.
 */
export async function checkEmail(value, { resolveMx = dnsResolveMx, resolveA = resolve4, connect, port = 25, helo = process.env.EMAIL_CHECK_HELO || os.hostname(), from = process.env.EMAIL_CHECK_FROM || "", timeoutMs = 12000 } = {}) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!ADDRESS.test(email) || email.length > 254) return result(email, "invalid", "неправильний формат адреси");
  const [local, domain] = email.split("@");
  const role = ROLE.test(local);

  let exchanges = [];
  try {
    exchanges = (await resolveMx(domain)).sort((left, right) => left.priority - right.priority).map((row) => row.exchange).filter(Boolean);
  } catch (error) {
    if (!["ENODATA", "ENOTFOUND", "ESERVFAIL"].includes(error?.code)) return result(email, "unknown", "DNS не відповів", { role });
  }
  if (!exchanges.length) {
    // No MX: RFC 5321 lets the domain's own address take mail — rarely real, but not «no».
    const hasA = await resolveA(domain).then((rows) => rows.length > 0).catch(() => false);
    if (!hasA) return result(email, "invalid", `домен ${domain} не приймає пошту (немає MX)`, { role });
    exchanges = [domain];
  }

  const decoy = `${randomBytes(6).toString("hex")}-nobody@${domain}`;
  for (const host of exchanges.slice(0, 2)) {
    const probe = await smtpProbe({ host, port, helo, from, addresses: [email, decoy], timeoutMs, connect });
    // banner, EHLO, MAIL FROM, RCPT real, RCPT decoy
    const real = probe.replies[3];
    const fake = probe.replies[4];
    if (!real) {
      if (probe.error?.startsWith("refused_5")) return result(email, "unknown", "поштовий сервер не відповідає на перевірки з нашої адреси", { role, mx: host });
      continue;
    }
    if (real.code >= 500) {
      // 5.1.x / 550 user unknown — the server says no. A 5.7.x is a policy on us, not on them.
      if (/5\.7\.\d/.test(real.text)) return result(email, "unknown", "поштовий сервер відхилив перевірку (політика)", { role, mx: host, detail: real.text });
      return result(email, "invalid", "поштовий сервер каже: такої скриньки немає", { role, mx: host, detail: real.text });
    }
    if (real.code >= 400) return result(email, "unknown", "поштовий сервер просить повторити пізніше (сірий список)", { role, mx: host, detail: real.text });
    if (fake && fake.code < 300) return result(email, "catch_all", EMAIL_CHECK_LABEL.catch_all, { role, mx: host });
    return result(email, "valid", role ? "скринька існує, але це спільна адреса (info@, sales@…)" : EMAIL_CHECK_LABEL.valid, { role, mx: host });
  }
  return result(email, "unknown", "поштовий сервер не відповів", { role, mx: exchanges[0] });
}

/** Several addresses, two at a time — a mail server is asked politely or not at all. */
export async function checkEmails(values, options = {}) {
  const unique = [...new Set(values.map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean))];
  const results = [];
  for (let at = 0; at < unique.length; at += 2) {
    results.push(...await Promise.all(unique.slice(at, at + 2).map((email) => checkEmail(email, options))));
  }
  return results;
}
