import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Клас дефекту, який тут тримається: «людина щось змінила, а наступний деплой
// це тихо скасував». Так втрачались транскрипти з вебхука, правило провайдера,
// жорсткий ліміт витрат, перемикачі моделей. Кожен раз причина була одна з
// двох — маршрут не зберігав стан, або ключ стану не був ні в записі, ні в
// читанні, — і кожен раз це знаходили вже після втрати.
//
// Тести поруч (state-survives-restart.test.mjs) доводять конкретні випадки
// справжнім рестартом. Цей файл не доводить нічого про значення — він не дає
// класу повернутися: новий маршрут без збереження й новий ключ стану без
// рішення «зберігати чи ні» ламають збірку, поки хтось не напише, чому так.
//
// Читається вихідний текст server.mjs, а не працюючий сервер: маршрут, якого
// тест не вміє викликати, перевірити поведінкою не можна, а прочитати — можна.

const SOURCE = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const LINES = SOURCE.split("\n");

// ── маршрути, що змінюють щось ─────────────────────────────────────────────

function mutatingRoutes() {
  const routes = [];
  LINES.forEach((line, index) => {
    const found = /^(\s*)if \(request\.method === "(POST|PUT|PATCH|DELETE)"/.exec(line);
    if (!found) return;
    const end = LINES.findIndex((candidate, at) => at > index && candidate === `${found[1]}}`);
    assert.ok(end > index, `server.mjs:${index + 1}: не знайшов, де закінчується маршрут`);
    const path = (/pathname === "([^"]+)"/.exec(line) || /contactMatch\[2\] === "([^"]+)"/.exec(line) || [])[1];
    assert.ok(path, `server.mjs:${index + 1}: не зрозумів шлях маршруту`);
    routes.push({ method: found[2], path, line: index + 1, block: LINES.slice(index, end + 1).join("\n") });
  });
  return routes;
}

// Маршрути, що не викликають запис самі, і чому це не втрата: або стану справді
// нема, або його зберігає те, що маршрут кличе. Додати сюди рядок — це написати
// причину; «забув» тут не буває.
const SAVED_ELSEWHERE_OR_NOTHING = {
  "/api/auth/bootstrap": "профіль першого адміна створює ensureWorkspaceUserProfile і зберігає його сам (persistWorkspaceState)",
  "/api/account/heartbeat": "секунди активності зберігаються з тротлінгом раз на 30 с (recordUserHeartbeat): удари приходять щохвилини з кожної вкладки",
  "/api/auth/logout": "сесія — це cookie в браузері, на сервері стану нема",
  "/api/auth/recover": "лист для відновлення паролю надсилає GoTrue, воркспейс нічого не змінює",
  "/api/auth/complete-recovery": "новий пароль приймає GoTrue, воркспейс нічого не змінює",
  "/api/account/password": "пароль живе в GoTrue, а не в стані воркспейсу",
  "/api/openrouter/revoke": "ключ і його метадані — лише в пам'яті за задумом; на проді ключ повертається зі змінної середовища",
  "/api/openrouter/test": "результат перевірки з'єднання (providerHealth) перераховується при кожному старті",
  "/api/tasks/run": "симуляція прогону: її фальшиві рядки використання свідомо не потрапляють у файл (isRealUsageRow)"
};

test("кожен маршрут, що змінює стан, зберігає його — або названий серед винятків із причиною", () => {
  const routes = mutatingRoutes();
  assert.ok(routes.length > 50, `знайдено лише ${routes.length} маршрутів — парсер, схоже, зламався`);

  const unsaved = routes.filter((route) => !route.block.includes("writePersistentWorkspaceState("));
  const unexplained = unsaved.filter((route) => !(route.path in SAVED_ELSEWHERE_OR_NOTHING));
  assert.deepEqual(
    unexplained.map((route) => `${route.method} ${route.path} (server.mjs:${route.line})`),
    [],
    "маршрут змінює стан, але не викликає writePersistentWorkspaceState(): зміна загубиться при наступному деплої. " +
      "Додай виклик перед відповіддю — або, якщо стану справді нема, внеси маршрут у SAVED_ELSEWHERE_OR_NOTHING з причиною (і де саме він зберігається)."
  );

  // Виняток, що застарів, — це вже не виняток: список не має гнити.
  const unsavedPaths = new Set(unsaved.map((route) => route.path));
  const stale = Object.keys(SAVED_ELSEWHERE_OR_NOTHING).filter((path) => !unsavedPaths.has(path));
  assert.deepEqual(stale, [], "ці маршрути вже зберігають стан або зникли — прибери їх з SAVED_ELSEWHERE_OR_NOTHING");
});

// ── ключі стану ────────────────────────────────────────────────────────────

function stateKeys() {
  const start = LINES.findIndex((line) => line === "const state = {");
  assert.ok(start >= 0, "не знайшов `const state = {` у server.mjs");
  const keys = [];
  for (let at = start + 1; at < LINES.length && LINES[at] !== "};"; at += 1) {
    const found = /^ {2}([A-Za-z0-9_]+):/.exec(LINES[at]);
    if (found) keys.push(found[1]);
  }
  return keys;
}

function writerText() {
  const start = LINES.findIndex((line) => line.startsWith("async function writeWorkspaceStateNow"));
  assert.ok(start >= 0, "не знайшов writeWorkspaceStateNow");
  const end = LINES.findIndex((line, at) => at > start && line === "}");
  return LINES.slice(start, end + 1).join("\n");
}

// Ключ стану → під якою назвою він лежить у файлі.
const SAVED_AS = {
  selectedProductId: "selectedProductId",
  products: "products",
  prospects: "prospects",
  interactions: "interactions",
  followUpTasks: "followUpTasks",
  users: "users",
  userActivity: "userActivity",
  usage: "usage",
  historicalOutcomes: "historicalOutcomes",
  scoringModel: "scoringModel",
  researchJobs: "researchJobs",
  contactDrafts: "contactDrafts",
  accountDossiers: "accountDossiers",
  warmupCampaigns: "warmupCampaigns",
  warmupTargeting: "warmupTargeting",
  espSenderPauses: "espSenderPauses",
  providerRule: "providerRule",
  budgets: "budgets",
  aiModelDefaults: "aiModelDefaults",
  modelToggles: "modelToggles",
  tasks: "taskRouting",
  aiActions: "aiActions",
  icp: "icp",
  learning: "learning",
  integrations: "integrationSettings",
  mcpSync: "integrationSettings"
};

// Ключі, яких у файлі свідомо нема, і чому.
const NOT_SAVED = {
  workspaceId: "константа",
  environment: "читається зі змінної середовища при кожному старті",
  openRouterEnabled: "іде за ключем, а ключ на проді — зі змінної середовища",
  keyMetadata: "метадані ключа, що лежить лише в пам'яті",
  providerHealth: "перевіряється з'єднанням при кожному старті (warmRuntimeConnections)",
  models: "каталог читається з OpenRouter при кожному старті; ручні перемикачі зберігаються окремо (modelToggles)",
  agents: "сіди: жоден маршрут їх не змінює",
  analysisProfiles: "сіди: жоден маршрут їх не змінює",
  agentRuns: "історія прогонів без жодного споживача в інтерфейсі; результат лежить у самих лідах",
  intelligenceSnapshots: "похідне: сам запис аналітики лежить у ліді (leadIntelligence)",
  intelligenceJobs: "журнал фонових завдань; результат лежить у ліді",
  events: "журнал подій у пам'яті за задумом",
  vault: "секрети не пишуться на диск; на проді вони зі змінних середовища",
  apifyVault: "секрети не пишуться на диск; на проді вони зі змінних середовища",
  contactEnrichmentVault: "секрети не пишуться на диск; на проді вони зі змінних середовища",
  contactEnrichmentWebhookVault: "секрети не пишуться на диск; на проді вони зі змінних середовища",
  mcpVault: "секрети не пишуться на диск; на проді вони зі змінних середовища",
  crmVault: "секрети не пишуться на диск; на проді вони зі змінних середовища",
  transcriptVault: "секрети не пишуться на диск; токен вебхука тепер береться зі змінної TRANSCRIPT_WEBHOOK_TOKEN",
  supabaseVault: "секрети не пишуться на диск; на проді вони зі змінних середовища",
  postgresVault: "секрети не пишуться на диск; на проді вони зі змінних середовища"
};

test("кожен ключ стану або зберігається, або названий серед тих, що не зберігаються, з причиною", () => {
  const keys = stateKeys();
  assert.ok(keys.length > 30, `знайдено лише ${keys.length} ключів стану — парсер, схоже, зламався`);

  const undecided = keys.filter((key) => !(key in SAVED_AS) && !(key in NOT_SAVED));
  assert.deepEqual(
    undecided,
    [],
    "у state з'явився ключ без рішення: або запиши його в writeWorkspaceStateNow й прочитай в applyPersistentWorkspaceState " +
      "(і внеси в SAVED_AS), або внеси в NOT_SAVED з причиною, чому його втрата при деплої нормальна."
  );

  const writer = writerText();
  const missing = Object.entries(SAVED_AS).filter(([key, name]) => keys.includes(key) && !new RegExp(`\\b${name}:`).test(writer));
  assert.deepEqual(missing.map(([key, name]) => `${key} → ${name}`), [], "ці ключі заявлені збереженими, але writeWorkspaceStateNow їх не пише");

  const gone = [...Object.keys(SAVED_AS), ...Object.keys(NOT_SAVED)].filter((key) => !keys.includes(key));
  assert.deepEqual(gone, [], "ці ключі вже не існують у state — прибери їх зі списків");
});
