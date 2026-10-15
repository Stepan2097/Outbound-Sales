// Сповіщення лідгенам у Telegram (таск «Система сповіщень в телеграм для
// лідгенів з outbound-sales системи», 15.10).
//
// Two kinds, both send-only — this never reads the bot's updates:
//   1. a reply from a lead, the moment the agent brings it in from LinkedIn:
//      who, through which account, the first lines, and where to answer;
//   2. the morning line, 09:00 Kyiv on working days: what is waiting for us
//      today — replies, follow-ups (and how many were carried over), people
//      who accepted and wait for a first message — and how yesterday went.
//
// The bot is the one the agent already reports logins with
// (TELEGRAM_BOT_TOKEN); the chat is OUTBOUND_TELEGRAM_CHAT_ID, else the group
// the login alerts go to (TELEGRAM_LOGIN_CHAT_ID) — the leadgens are there.
// Without a token or a chat nothing is sent and nothing breaks.

export const DIGEST_HOUR = 9;
// Past noon the morning line is late news: a server that restarts in the
// afternoon does not send it then.
export const DIGEST_UNTIL_HOUR = 12;
export const ZONE = "Europe/Kyiv";
// A reply older than this is history being read in (a new account's first
// sweep), not news: it is stored, not announced.
export const REPLY_FRESH_HOURS = 48;
// One sweep that brings many replies says the first few and how many more.
export const REPLIES_PER_SWEEP = 5;

export function leadgenTelegram(env = process.env, { fetch = globalThis.fetch } = {}) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const chat = String(env.OUTBOUND_TELEGRAM_CHAT_ID || env.TELEGRAM_LOGIN_CHAT_ID || "").trim();
  if (!token || !chat) return { configured: false, send: async () => false };
  return {
    configured: true,
    send: async (text) => {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 3900), disable_web_page_preview: true })
      });
      if (!response.ok) throw new Error(`Telegram ${response.status}`);
      return true;
    }
  };
}

const clip = (text, limit) => {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};
const cleanName = (name) => String(name || "").replace(/^(переглянути профіль|view profile( of)?)\s+/i, "").trim() || "Хтось";

/** The replies of one sweep worth announcing: fresh ones only, newest last. */
export function freshReplies(inbound = [], { now = new Date(), hours = REPLY_FRESH_HOURS } = {}) {
  return inbound
    .filter((message) => {
      const at = message.sentAtIso ? Date.parse(message.sentAt) : NaN;
      // A LinkedIn time the agent could not read as a date is taken as now: it
      // came in this sweep, and a thread's first sweep is cut by the cap below.
      return !Number.isFinite(at) || now.getTime() - at <= hours * 3600000;
    })
    .slice(-REPLIES_PER_SWEEP);
}

/** «💬 Відповів …» — one message per thread, however many lines they sent. */
export function replyText({ name, headline = "", account = "", messages = [], url = "" }) {
  const lines = messages.map((message) => `«${clip(message.body, 300)}»`);
  return [
    `💬 Відповів ${cleanName(name)}${headline ? ` — ${clip(headline, 80)}` : ""}`,
    account ? `через ${account}` : "",
    ...lines,
    url ? `Відповісти: ${url}` : ""
  ].filter(Boolean).join("\n");
}

const plural = (count, one, few, many) => {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
};

/** The morning line. Every number says what to do with it; nothing waiting says so. */
export function digestText({ unread = [], planned = { total: 0, carried: 0 }, accepted = 0, yesterday = { written: 0, replies: 0 }, url = "" }) {
  const lines = ["☀️ Outbound на сьогодні"];
  if (unread.length) {
    const names = unread.slice(0, 5).map((row) => cleanName(row.name)).join(", ");
    lines.push(`💬 Чекають відповіді: ${unread.length} — ${names}${unread.length > 5 ? "…" : ""}`);
  }
  if (planned.total) lines.push(`🔁 Написати повторно: ${planned.total}${planned.carried ? ` (з них перенесено з минулих днів: ${planned.carried})` : ""}`);
  if (accepted) lines.push(`🤝 Прийняли запит, чекають першого повідомлення: ${accepted}`);
  if (lines.length === 1) lines.push("Нічого не чекає — можна брати нових людей на «Головній».");
  lines.push(`Вчора написали ${yesterday.written} ${plural(yesterday.written, "людині", "людям", "людям")}, відповідей прийшло: ${yesterday.replies}.`);
  if (url) lines.push(url);
  return lines.join("\n");
}

/** Whether the morning line is due now: a working day in Kyiv, 09:00–12:00, not yet sent today. */
export function digestDue(now = new Date(), lastSentOn = "") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
    .formatToParts(now).map((part) => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = !["Sat", "Sun"].includes(parts.weekday);
  const hour = Number(parts.hour);
  return { due: weekday && hour >= DIGEST_HOUR && hour < DIGEST_UNTIL_HOUR && lastSentOn !== today, today };
}
