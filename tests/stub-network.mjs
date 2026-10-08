/**
 * Мережа дочірнього server.mjs, підмінена ззовні.
 *
 * Платні шляхи — водоспад Apify і виклик моделі — не мали тестів саме тому,
 * що «без шва в коді заглушку не поставити». Шов не потрібен: модуль,
 * підвантажений через `NODE_OPTIONS=--import`, виконується в тому ж процесі
 * до server.mjs і підміняє `globalThis.fetch`. Нічого в продакшн-коді для
 * цього міняти не треба, і сам код не знає, що його тестують.
 *
 * Що вміє:
 *   STUB_NETWORK_LOG      — файл, куди дописується кожен перехоплений виклик
 *                           (без токенів: вони лишаються в запиті й нікуди
 *                           не потрапляють);
 *   STUB_APIFY_ITEMS      — JSON {"<actor-id>": [ ...items ]}, що віддає актор;
 *   STUB_OPENROUTER_JSON  — рядок, який модель «повертає» як content.
 *
 * Будь-яка адреса, якої тут немає, кидає помилку: тест, що непомітно пішов у
 * справжній інтернет, — це тест, який одного дня спише гроші.
 */
import fs from "node:fs";

const LOG = process.env.STUB_NETWORK_LOG || "";
const APIFY_ITEMS = JSON.parse(process.env.STUB_APIFY_ITEMS || "{}");
const OPENROUTER_JSON = process.env.STUB_OPENROUTER_JSON || "";
const OPENROUTER_BASE = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");

function note(line) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, `${line}\n`); } catch { /* тест прочитає менше, ніж було */ }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === "string" ? input : input?.url ?? String(input);
  let url;
  try { url = new URL(raw); } catch { return realFetch(input, init); }

  if (url.hostname === "api.apify.com") {
    // /v2/acts/<actor~id>/run-sync-get-dataset-items?token=…&maxTotalChargeUsd=…
    const encoded = (url.pathname.match(/\/acts\/([^/]+)\//) || [])[1] || "";
    const actor = decodeURIComponent(encoded).replace("~", "/");
    // Стеля витрат — те, заради чого цей виклик і рахують; токен не пишемо.
    note(`apify ${actor} charge=${url.searchParams.get("maxTotalChargeUsd")}`);
    return json(APIFY_ITEMS[actor] ?? []);
  }

  if (raw.startsWith(OPENROUTER_BASE)) {
    if (url.pathname.endsWith("/models")) {
      note("openrouter models");
      return json({ data: [{ id: "anthropic/claude-haiku-4.5" }, { id: "anthropic/claude-sonnet-5" }] });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      note("openrouter chat");
      return json({
        id: "stub-1",
        model: "anthropic/claude-haiku-4.5",
        choices: [{ message: { role: "assistant", content: OPENROUTER_JSON } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 }
      });
    }
  }

  note(`НЕОЧІКУВАНА АДРЕСА ${url.origin}${url.pathname}`);
  throw new Error(`stub-network: тест не ходить у мережу, а код спробував ${url.origin}${url.pathname}`);
};
