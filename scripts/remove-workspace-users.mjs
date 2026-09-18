#!/usr/bin/env node
/**
 * Прибрати профілі з локального стану робочого простору.
 *
 * Профіль тут — це запис застосунку про людину: обрана модель, витрати, час.
 * Він не є акаунтом: акаунти живуть у Supabase, і цей скрипт їх не чіпає.
 * Тому прибрати можна саме те, що лишилося записом без акаунта, — наприклад
 * фікстуру AUTH_DEV_BYPASS або профіль від акаунта, який уже видалили з бази.
 *
 * Якщо людина ще може увійти, її профіль створиться наново при наступному
 * вході — і це правильно: список користувачів веде CRM, а не цей файл.
 *
 * Перед записом поруч із файлом стану лишається копія .backup-<мітка часу>.
 *
 * Запуск:
 *   node scripts/remove-workspace-users.mjs <пошта> [ще пошта ...]
 *   node scripts/remove-workspace-users.mjs --list
 */

import { copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const statePath = process.env.STATE_FILE_PATH || join(root, ".data", "outbound-state.json");

if (!existsSync(statePath)) {
  console.error(`Файлу стану немає: ${statePath}`);
  process.exit(1);
}

const wanted = process.argv.slice(2).map((value) => value.trim().toLowerCase()).filter(Boolean);
const state = JSON.parse(await readFile(statePath, "utf8"));
const users = Array.isArray(state.users) ? state.users : [];

const describe = (user) => `${user.email || "?"} (роль ${user.role || "?"}, id ${String(user.id || "").slice(0, 12)}…)`;

if (!wanted.length || wanted.includes("--list")) {
  console.log(`Профілі в ${statePath}:`);
  for (const user of users) console.log(`  ${describe(user)}`);
  console.log("\nЩоб прибрати: node scripts/remove-workspace-users.mjs пошта@приклад");
  process.exit(0);
}

const removed = users.filter((user) => wanted.includes(String(user.email || "").toLowerCase()));
const missing = wanted.filter((email) => !users.some((user) => String(user.email || "").toLowerCase() === email));
if (missing.length) console.warn(`Не знайдено серед профілів: ${missing.join(", ")}`);
if (!removed.length) {
  console.log("Нічого прибирати.");
  process.exit(0);
}

// Останній адміністратор не прибирається: робочий простір без жодного лишився б
// без нікого, хто може роздавати ролі.
const remaining = users.filter((user) => !removed.includes(user));
if (users.some((user) => user.role === "admin") && !remaining.some((user) => user.role === "admin")) {
  console.error("Це прибрало б останнього адміністратора. Спершу лиши когось із роллю admin.");
  process.exit(1);
}

const backupPath = `${statePath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
await copyFile(statePath, backupPath);

state.users = remaining;
// Час, записаний на профіль, якого більше немає, — вже нічий рядок.
const activity = state.userActivity && typeof state.userActivity === "object" ? state.userActivity : {};
for (const user of removed) delete activity[user.id];
state.userActivity = activity;
await writeFile(statePath, JSON.stringify(state), "utf8");

for (const user of removed) console.log(`прибрано: ${describe(user)}`);
console.log(`лишилось: ${remaining.map((user) => user.email).join(", ") || "нікого"}`);
console.log(`копія попереднього стану: ${backupPath}`);
console.log("\nЗапис у файлі, який тримає запущений сервер. Перезапусти його, щоб зміна була видна.");
