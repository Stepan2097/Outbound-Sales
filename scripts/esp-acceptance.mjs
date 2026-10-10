#!/usr/bin/env node
// ESP 11 — the acceptance report before the first cold letter.
//
//   node scripts/esp-acceptance.mjs > esp-acceptance.md
//
// Runs the four automatic checks (tests/esp-acceptance.test.mjs: the test
// campaign, the original of the letter, the load run, «стоп усе») against the
// real ESP modules with Gmail stubbed, and prints PASS/FAIL for each — then the
// half only a person can do with the real mailboxes. Exit code 1 when any
// automatic check fails: the gate stays shut.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=600000", "tests/esp-acceptance.test.mjs"], { cwd: root, encoding: "utf8" });
const results = [...String(run.stdout).matchAll(/^(not ok|ok) \d+ - (ESP 11 · \d[^\n]*)$/gm)].map((match) => ({ pass: match[1] === "ok", name: match[2].trim() }));

const lines = [
  "# ESP 11 · Приймання перед першим холодним листом",
  "",
  `Прогін: ${new Date().toISOString()} · заглушка Gmail, справжні модулі ESP (журнал, реєстр, лист, ліміти, ланцюжок, вхідні).`,
  "",
  "## Автоматична частина",
  "",
  ...(results.length ? results.map((row) => `- ${row.pass ? "✅ PASS" : "❌ FAIL"} — ${row.name}`) : ["- ❌ FAIL — перевірки не запустились", "", "```", String(run.stderr || run.stdout).slice(-2000), "```"]),
  "",
  "## Жива частина — робить людина після ключів (ESP_GMAIL_SERVICE_ACCOUNT_JSON, ESP_UNSUBSCRIBE_SECRET, DNS /u/ і /privacy)",
  "",
  "- [ ] Тестова кампанія на 10–15 наших скриньок у різних поштових сервісах (Gmail, Outlook, Yahoo): 3 листи в одному треді в кожній.",
  "- [ ] Відповідь з однієї скриньки зупиняє її ланцюжок; автовідповідь «у відпустці» переносить крок; відписка (кнопка Gmail «Unsubscribe» і посилання) — того ж дня.",
  "- [ ] «Показати оригінал» у Gmail: лише text/plain, є List-Unsubscribe і List-Unsubscribe-Post, немає пікселів і переписаних посилань, SPF/DKIM/DMARC = PASS.",
  "- [ ] «Стоп усе» на екрані «Листи» зупиняє відправку за секунди (лист, що вже летить, — останній).",
  "- [ ] Лише після цього: ESP_LIVE_SEND=1 на сервері — рішення власника."
];
const report = `${lines.join("\n")}\n`;
process.stdout.write(report);
process.exit(results.length && results.every((row) => row.pass) ? 0 : 1);
