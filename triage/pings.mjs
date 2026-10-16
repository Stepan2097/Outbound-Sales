// Пінги (етап 1/6 плану plan-outbound-campaigns-pings, таск 5f5343cb, 16.10.2026).
//
// Пінг — дата наступного дотику живого діалогу. Живе в CRM як задача (`tasks`)
// у черзі «Outbound»: CRM бачить пінги без синхронізації, виконавець — власник
// контакту. Цей файл — лише правила, без жодного звернення до баз: що має бути
// наступним кроком у діалозі, яка задача CRM за нього відповідає, і в який блок
// «Сьогодні» вона лягає. Тому він повністю покривається тестами.
//
// Як система вирішує, що пінг потрібен. Кожна подія діалогу має ключ:
//   reply:<контакт>:<коли збережено їхню відповідь>        — лід відповів, ми ні;
//   first:<контакт>:<outreach>                              — прийняв запит, ми мовчимо;
//   silent:<контакт>:<їхня остання відповідь|none>:<скільки наших поспіль>
//                                                            — ми написали, вони мовчать.
// Ключ пишеться в опис задачі. Задача з тим самим ключем — це той самий крок:
// її не створюють удруге, її дату, перенесену людиною, не чіпають. Нова подія —
// новий ключ: стара системна задача закривається з позначкою «замінено», нова
// створюється. Повідомлення, яке скасували або яке не пішло, повертає попередній
// ключ — і його задача, закрита як «замінена», відкривається знову, тож діалог
// не губиться. Задачу, яку людина закрила сама (без позначки), система не
// відкриває.

export const PING_QUEUE = "Outbound";
export const TEAM_TZ = "Europe/Kyiv";
/** Мовчання після нашого кроку: наступний дотик через 3 робочі дні (Марко 16.10). */
export const SILENT_WORKING_DAYS = 3;
/** Після трьох наших повідомлень поспіль без відповіді пінгів більше немає. */
export const SILENT_LIMIT = 3;
/** Етап 1 веде діалоги, де щось сталося за ці дні; давніші — імпорт етапу 2. */
export const WINDOW_DAYS = 14;
/** О котрій годині дня пінгу стоїть задача в CRM — початок робочого дня. */
export const DUE_HOUR = 9;

export const REASONS = {
  reply: { title: "Відповісти", line: "лід відповів — відповісти" },
  first: { title: "Перше повідомлення", line: "прийняв запит у друзі — написати перше повідомлення" },
  silent: { title: "Нагадати", line: "ми написали, лід мовчить — нагадати" },
  call: { title: "Дзвінок", line: "дзвінок" },
  manual: { title: "Пінг", line: "поставлено вручну" }
};

const MARK = /⟦ob:([^⟧]+)⟧/g;
const SUPERSEDED = "superseded";

/* ── дати ───────────────────────────────────────────────────────────────── */

/** Календарний день у часовому поясі команди: «2026-10-16». */
export function dayIn(at, tz = TEAM_TZ) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function dayPlus(day, n) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** +n робочих днів (пн–пт): з п'ятниці +1 — понеділок. */
export function addWorkingDays(day, n) {
  let current = day;
  let left = n;
  while (left > 0) {
    current = dayPlus(current, 1);
    const weekday = new Date(`${current}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return current;
}

export function addCalendarDays(day, n) {
  return dayPlus(day, n);
}

/** Мить «день, година:00» у поясі команди — те, що лягає в `tasks.due_date`. */
export function zonedIso(day, hour = DUE_HOUR, tz = TEAM_TZ) {
  const guess = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  // Скільки годин пояс відстає чи випереджає UTC саме в цей день (літній час).
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).formatToParts(guess).map((part) => [part.type, part.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess.getTime() - (local - guess.getTime())).toISOString();
}

/* ── опис задачі ────────────────────────────────────────────────────────── */

/** Ключ і позначка «замінено» з опису задачі. Без ключа — задача поставлена не системою. */
export function parseTaskMarks(description) {
  const marks = [...String(description || "").matchAll(MARK)].map((match) => match[1]);
  return { key: marks.find((mark) => mark !== SUPERSEDED) || null, superseded: marks.includes(SUPERSEDED) };
}

export function taskDescription(reason, key, note = "") {
  const line = REASONS[reason]?.line || REASONS.manual.line;
  return [`Outbound Sales · ${line}`, note ? String(note).trim() : "", `⟦ob:${key}⟧`].filter(Boolean).join("\n");
}

export function markSuperseded(description) {
  const { superseded } = parseTaskMarks(description);
  return superseded ? description : `${description || ""}\n⟦ob:${SUPERSEDED}⟧`.trim();
}

export function clearSuperseded(description) {
  return String(description || "").replace(/\n?⟦ob:superseded⟧/g, "");
}

export function reasonOfKey(key) {
  const head = String(key || "").split(":")[0];
  return ["reply", "first", "silent"].includes(head) ? head : "manual";
}

const isSystemKey = (key) => ["reply", "first", "silent"].includes(String(key || "").split(":")[0]);

/** Причина задачі: дзвінок — за типом, решта — за ключем; чужа задача — «пінг». */
export function taskReason(task) {
  if (task.task_type === "Call") return "call";
  return reasonOfKey(parseTaskMarks(task.description).key);
}

/* ── що має бути наступним кроком ───────────────────────────────────────── */

const ms = (iso) => {
  const value = Date.parse(iso || "");
  return Number.isFinite(value) ? value : 0;
};

/**
 * Наступний крок одного контакту.
 *
 * `state` — те, що про контакт відомо з прогріву:
 *   threads:  [{ accountId, threadKey, lastStoredAt, lastInboundStoredAt, lastMessage: { direction, at }, trailingOut }]
 *   pending:  наші повідомлення, ще не видимі в треді: [{ queuedAt, threadKey }] (чекають або щойно пішли)
 *   accepted: { outreachId, accountId, acceptedAt, dismissed } | null — прийняв запит
 *
 * Повертає `{ key, reason, basisAt, due, accountId, threadKey, outreachId }`;
 * `{ key: null, basisAt }` — пінгу бути не повинно (три наших без відповіді);
 * `null` — контакт поза вікном цього етапу, його задачі не чіпаємо.
 */
export function desiredPing(contactId, state, { now = new Date() } = {}) {
  const windowStart = now.getTime() - WINDOW_DAYS * 86400000;
  const threads = (state.threads || []).filter((thread) => thread.lastMessage);
  const thread = threads.sort((left, right) => ms(right.lastStoredAt) - ms(left.lastStoredAt))[0] || null;

  if (thread) {
    const lastIn = thread.lastInboundStoredAt || null;
    // Наші, що ще не з'явились у треді: лише ті, що поставлені після їхньої останньої відповіді.
    const pending = (state.pending || []).filter((item) =>
      (item.threadKey === thread.threadKey || item.threadKey === `first:${state.accepted?.outreachId}`) && ms(item.queuedAt) > ms(lastIn));
    const theyLast = thread.lastMessage.direction === "in" && !pending.length;
    if (theyLast) {
      const basisAt = lastIn || thread.lastStoredAt;
      if (ms(basisAt) < windowStart) return null;
      return { key: `reply:${contactId}:${basisAt}`, reason: "reply", basisAt, due: dayIn(basisAt), accountId: thread.accountId, threadKey: thread.threadKey, outreachId: state.accepted?.outreachId || null };
    }
    const count = (thread.lastMessage.direction === "out" ? thread.trailingOut : 0) + pending.length;
    const lastOutAt = [thread.lastMessage.direction === "out" ? thread.lastStoredAt : null, ...pending.map((item) => item.queuedAt)]
      .filter(Boolean).sort((left, right) => ms(right) - ms(left))[0];
    if (!lastOutAt || ms(lastOutAt) < windowStart) return null;
    if (count >= SILENT_LIMIT) return { key: null, basisAt: lastOutAt };
    return {
      key: `silent:${contactId}:${lastIn || "none"}:${count}`, reason: "silent", basisAt: lastOutAt,
      due: addWorkingDays(dayIn(lastOutAt), SILENT_WORKING_DAYS), accountId: thread.accountId, threadKey: thread.threadKey, outreachId: state.accepted?.outreachId || null
    };
  }

  const accepted = state.accepted;
  if (!accepted) return null;
  const firstPending = (state.pending || []).filter((item) => item.threadKey === `first:${accepted.outreachId}`);
  if (firstPending.length) {
    const queuedAt = firstPending.map((item) => item.queuedAt).sort((left, right) => ms(right) - ms(left))[0];
    if (ms(queuedAt) < windowStart) return null;
    return {
      key: `silent:${contactId}:none:${firstPending.length}`, reason: "silent", basisAt: queuedAt,
      due: addWorkingDays(dayIn(queuedAt), SILENT_WORKING_DAYS), accountId: accepted.accountId, threadKey: null, outreachId: accepted.outreachId
    };
  }
  if (accepted.dismissed || !accepted.acceptedAt || ms(accepted.acceptedAt) < windowStart) return null;
  return {
    key: `first:${contactId}:${accepted.outreachId}`, reason: "first", basisAt: accepted.acceptedAt,
    due: dayIn(accepted.acceptedAt), accountId: accepted.accountId, threadKey: null, outreachId: accepted.outreachId
  };
}

/**
 * Що зробити з задачами CRM одного контакту, щоб вони відповідали наступному кроку.
 *
 * `tasks` — задачі черги Outbound цього контакту (відкриті й закриті).
 * Дії: `supersede` (закрити як замінену), `reopen` (відкрити замінену знову),
 * `create` (нова задача під ключ).
 */
export function planPingChanges(desired, tasks) {
  if (!desired) return [];
  const actions = [];
  const parsed = tasks.map((task) => ({ task, ...parseTaskMarks(task.description), open: !task.completed }));
  const closing = new Set();

  for (const item of parsed) {
    if (!item.open || (desired.key && item.key === desired.key)) continue;
    // Системна задача іншого кроку — уже не актуальна. Поставлена людиною —
    // лише коли після неї в діалозі сталося щось нове.
    if (isSystemKey(item.key) || ms(desired.basisAt) > ms(item.task.created_at)) {
      actions.push({ op: "supersede", task: item.task });
      closing.add(item.task.id);
    }
  }

  if (!desired.key) return actions;
  const same = parsed.filter((item) => item.key === desired.key);
  if (same.some((item) => item.open)) return actions;
  if (same.length) {
    const newest = same.sort((left, right) => ms(right.task.created_at) - ms(left.task.created_at))[0];
    // Закрита як «замінена» — повертаємо; закрита людиною — її рішення.
    if (newest.superseded) actions.push({ op: "reopen", task: newest.task });
    return actions;
  }
  // Пінг, поставлений людиною вже після цієї події, і є наступним кроком.
  if (parsed.some((item) => item.open && !closing.has(item.task.id))) return actions;
  actions.push({ op: "create", desired });
  return actions;
}

/* ── «Сьогодні» ─────────────────────────────────────────────────────────── */

/**
 * Блок списку «Сьогодні» для відкритого пінгу:
 *   replies — лід відповів і чекає нас (дата настала);
 *   first   — прийняв запит, перше повідомлення (дата настала);
 *   overdue — дата минула;  today — сьогодні;  later — пізніше.
 * `awaitingUs` — за станом прогріву останнє слово за лідом.
 */
export function blockOf({ reason, dueDay, awaitingUs }, today) {
  if (dueDay && dueDay > today) return "later";
  if (awaitingUs || reason === "reply") return "replies";
  if (reason === "first") return "first";
  if (dueDay && dueDay < today) return "overdue";
  return "today";
}

export const BLOCK_ORDER = ["replies", "overdue", "today", "first"];

/** Порядок у блоці: давніші перші — те, що чекає довше, іде вище. */
export function compareItems(left, right) {
  return BLOCK_ORDER.indexOf(left.block) - BLOCK_ORDER.indexOf(right.block)
    || String(left.dueDay || "").localeCompare(String(right.dueDay || ""))
    || String(left.basisAt || "").localeCompare(String(right.basisAt || ""));
}

/** Нові контакти з папки — лише коли відповіді й прострочені розібрано. */
export function newContactsAllowed(blocks) {
  return !(blocks.replies?.length || blocks.overdue?.length);
}

/** Дата ручного пінгу: «+1», «+3», «+7» днів або конкретний день. */
export function manualDueDay(when, today) {
  const text = String(when || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const days = Number(text.replace(/^\+/, ""));
  if (!Number.isInteger(days) || days < 0 || days > 365) return "";
  return days === 0 ? today : addCalendarDays(today, days);
}
