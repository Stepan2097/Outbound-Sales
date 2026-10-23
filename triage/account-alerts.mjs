// Сповіщення лідгену у верхньому куті (Марко 23.10, таск 4e97fa87): «кожен аккаунт лінкедин
// прив'язується до лідгена, варто щоб лідгену… приходило сповіщення, що аккаунт потребує уваги…
// і чітка інструкція». Акаунт із «потрібен вхід» чи капчею планувальник не роздає, доки вартовий
// входу (agent/lib/login-watch.mjs) не побачить вхід — сам раз на 30 хв або на запит.
//
// Лідген бачить акаунти, які веде (Налаштування → акаунти), адмін — усі. «Перевірити вхід» —
// той самий запит, що посилання «Я увійшов» з Telegram-групи (login.recheck_requested з nonce):
// вартовий забирає його за хвилину й відповідає login.recheck_done.

import { randomBytes } from "node:crypto";

import { anty } from "../warmup/db.mjs";
import { RECHECK_DONE, RECHECK_REQUESTED } from "../warmup/login-check.mjs";
import { logEvent, loginIdentities } from "../warmup/store.mjs";

/** Стани, за яких потрібна людина; «заблоковано» сюди не входить — акаунт уже поза роботою. */
export const NEEDS_PERSON = ["needs_login", "captcha"];

/** Скільки після вдалої перевірки акаунт ще лишається в сповіщенні з «Вхід є» (суддя 23.10). */
export const RECOVERED_SHOW_MS = 30 * 60000;

/** Чий це акаунт: адмін — усі, лідген — ті, що веде. */
const ownedBy = (account, { leadgens = {}, viewerId = "", admin = false }) => admin || Boolean(viewerId && leadgens[account.id] === viewerId);

/** Чиї це сповіщення: адмін — усі акаунти, лідген — свої. */
export function alertsFor(accounts, who) {
  return accounts.filter((account) => NEEDS_PERSON.includes(account.health) && account.status !== "excluded" && ownedBy(account, who));
}

/**
 * Акаунти, що щойно відновились за перевіркою: вартовий спершу знімає паузу (health → ok), а потім
 * пише відповідь, тож без цього акаунт мовчки зникав би, і людина не бачила б «Вхід є».
 */
export function recoveredFor(accounts, done, who, now = Date.now()) {
  const fresh = new Map(done.filter((row) => row.meta?.signedIn === true && now - Date.parse(row.created_at) < RECOVERED_SHOW_MS)
    .map((row) => [row.account_id, row]));
  return accounts.filter((account) => account.health === "ok" && fresh.has(account.id) && ownedBy(account, who));
}

const nonceOf = () => randomBytes(9).toString("base64url");

/** Акаунти, що чекають людину, з останнім запитом перевірки за добу і його відповіддю. */
export async function accountAlerts({ viewerId, admin, leadgens }) {
  const who = { leadgens, viewerId, admin };
  const rows = await anty.from("wl_accounts").select("id,label,status,health,health_note,health_changed_at").rows();
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  const done = await anty.from("wl_events").select("account_id,meta,created_at").eq("type", RECHECK_DONE).gte("created_at", since).order("created_at", { ascending: false }).limit(100).rows();
  const recovered = new Set(recoveredFor(rows, done, who).map((account) => account.id));
  const mine = [...alertsFor(rows, who), ...rows.filter((account) => recovered.has(account.id))];
  if (!mine.length) return [];
  const ids = mine.map((account) => account.id);
  const [asked, identities] = await Promise.all([
    anty.from("wl_events").select("account_id,meta,created_at").eq("type", RECHECK_REQUESTED).in("account_id", ids).gte("created_at", since).order("created_at", { ascending: false }).limit(50).rows(),
    loginIdentities().catch(() => new Map())
  ]);
  return mine.map((account) => {
    const request = asked.find((row) => row.account_id === account.id);
    const answer = request && done.find((row) => String(row.meta?.nonce || "") === String(request.meta?.nonce || ""));
    return {
      id: account.id,
      label: account.label,
      identity: identities.get?.(account.id)?.name || null,
      health: account.health,
      note: account.health_note || "",
      since: account.health_changed_at || null,
      // Вхід щойно відновлено за перевіркою — показуємо результат, а не кроки (до 30 хв).
      recovered: recovered.has(account.id),
      recheck: request ? { requestedAt: request.created_at, doneAt: answer?.created_at || null, signedIn: answer ? answer.meta?.signedIn === true : null, reason: answer?.meta?.reason || "" } : null
    };
  });
}

/** «Перевірити вхід» з порталу: лише для акаунта, що чекає людину, і лише тим, хто його веде (чи адміну). */
export async function requestRecheck({ accountId, viewerId, admin, leadgens, by = "" }) {
  const [account] = await anty.from("wl_accounts").select("id,label,status,health").eq("id", String(accountId || "")).limit(1).rows();
  if (!account) throw Object.assign(new Error("Такого акаунта немає."), { statusCode: 404 });
  if (!alertsFor([account], { leadgens, viewerId, admin }).length) {
    throw Object.assign(new Error(NEEDS_PERSON.includes(account.health) ? "Це акаунт іншого лідгена." : "Цей акаунт уже працює — перевіряти нічого."), { statusCode: 409 });
  }
  const nonce = nonceOf();
  await logEvent({
    accountId: account.id,
    type: RECHECK_REQUESTED,
    message: `Попросили перевірити вхід з порталу — ${account.label}${by ? ` (${by})` : ""}`,
    meta: { nonce, issuedAt: Date.now(), source: "portal" }
  });
  return { accountId: account.id, nonce };
}
