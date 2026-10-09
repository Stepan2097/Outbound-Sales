import assert from "node:assert/strict";
import test from "node:test";

import { loadMain } from "./app-main-excerpt.mjs";

const escapeHtml = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const main = loadMain(
  ["WARMUP_STATUS_TONE", "WARMUP_STATUS_LABEL", "warmupPauseUntil", "warmupStatusPill"],
  { escapeHtml, escapeAttr: escapeHtml }
);
const pill = main.get("warmupStatusPill");

/**
 * 09.10.2026: Chloe and gulajpole read «На паузі», and the owner asked how —
 * nobody had paused them. LinkedIn's weekly invitation limit had; the pill now
 * names that, and the date the rest ends.
 */
test("an account resting on LinkedIn's weekly limit reads «Ліміт LinkedIn · до 11.10», not «На паузі»", () => {
  const html = pill({ status: "limited", pause: { until: "2026-10-11", cause: "invite_limit" } });
  assert.match(html, />Ліміт LinkedIn · до 11\.10</);
  assert.match(html, /tone-warn/);
  assert.match(html, /title="LinkedIn не приймає нових запитів/);
  assert.doesNotMatch(html, /На паузі/);
});

test("a pause after any other warning still says pause, with its date; other states carry no date", () => {
  assert.match(pill({ status: "paused", pause: { until: "2026-10-11", cause: "warning" } }), />На паузі · до 11\.10</);
  assert.match(pill({ status: "warming", pause: null }), />Прогрівається</);
  assert.match(pill({ status: "off" }), />Вимкнено</);
});
