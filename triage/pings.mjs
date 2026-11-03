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
/**
 * Кроки «мовчить» за замовчуванням (власник 20.10): перший пінг через 2 робочі
 * дні, другий через 3, третій через 5, четвертий через 7 — п'ять наших
 * повідомлень разом. Редагуються на «Сьогодні» (`usePingSteps`); кампанія може
 * мати свої.
 */
export const DEFAULT_PING_STEPS = [2, 3, 5, 7];
let pingSteps = [...DEFAULT_PING_STEPS];

/** Кроки, які налаштовано в робочому просторі (власник 20.10: «зробити ці поля редагованими»). */
export function usePingSteps(steps) {
  pingSteps = isPingSteps(steps) ? [...steps] : [...DEFAULT_PING_STEPS];
  return pingSteps;
}

export function currentPingSteps() {
  return [...pingSteps];
}

export function isPingSteps(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 6 && value.every((days) => Number.isInteger(days) && days >= 1 && days <= 30);
}

/** Після стількох наших повідомлень поспіль без відповіді пінгів більше немає: усі кроки й перше. */
export const SILENT_LIMIT = DEFAULT_PING_STEPS.length + 1;

/** «Невдалий час» (власник 20.10: «написати через місяць»): дотик через стільки календарних днів після статусу. */
export const LATER_DAYS = 30;
/** Етап 1 веде діалоги, де щось сталося за ці дні; давніші — імпорт етапу 2. */
export const WINDOW_DAYS = 14;
/** О котрій годині дня пінгу стоїть задача в CRM — початок робочого дня. */
export const DUE_HOUR = 9;

export const REASONS = {
  reply: { title: "Відповісти", line: "лід відповів — відповісти" },
  first: { title: "Перше повідомлення", line: "прийняв запит у друзі — написати перше повідомлення" },
  silent: { title: "Нагадати", line: "ми написали, лід мовчить — нагадати" },
  later: { title: "Повернутись", line: "був невдалий час — написати знову через місяць" },
  call: { title: "Дзвінок", line: "дзвінок" },
  manual: { title: "Пінг", line: "поставлено вручну" }
};

const MARK = /⟦ob:([^⟧]+)⟧/g;
const SUPERSEDED = "superseded";

/* ── дати ───────────────────────────────────────────────────────────────── */

/** Календарний день у часовому поясі команди: «2026-10-16». */
const dayFormats = new Map();
export function dayIn(at, tz = TEAM_TZ) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  if (!dayFormats.has(tz)) dayFormats.set(tz, new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }));
  return dayFormats.get(tz).format(date);
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

/** Робочий день: субота й неділя — найближчий понеділок, будній — він сам. */
export function workday(day) {
  if (!day) return day;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday === 6 ? dayPlus(day, 2) : weekday === 0 ? dayPlus(day, 1) : day;
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

/**
 * Ключ і «замінено» задачі: з колонок tasks.ping_key / ping_superseded (з 16.10), а
 * для задачі, записаної раніше, — з рядка ⟦ob:…⟧ в описі (поки його не прибрано).
 */
export function taskMarks(task) {
  const legacy = parseTaskMarks(task?.description);
  return { key: task?.ping_key || legacy.key, superseded: Boolean(task?.ping_superseded) || legacy.superseded };
}

/** Опис пінга для людини в CRM — без службових рядків: ключ живе в tasks.ping_key. */
export function taskDescription(reason, note = "") {
  const line = REASONS[reason]?.line || REASONS.manual.line;
  return [`Outbound Sales · ${line}`, note ? String(note).trim() : ""].filter(Boolean).join("\n");
}

/** Опис без службових рядків ⟦ob:…⟧ — для прибирання старих задач. */
export function stripMarks(description) {
  return String(description || "").replace(/\n?⟦ob:[^⟧]*⟧/g, "").trim();
}

export function markSuperseded(description) {
  const { superseded } = parseTaskMarks(description);
  return superseded ? description : `${description || ""}\n⟦ob:${SUPERSEDED}⟧`.trim();
}

export function clearSuperseded(description) {
  return String(description || "").replace(/\n?⟦ob:superseded⟧/g, "");
}

export function reasonOfKey(key) {
  const [head, second] = String(key || "").split(":");
  if (["reply", "first", "silent", "later"].includes(head)) return head;
  // Імпорт відкритих діалогів (етап 2): «import:<крок>:<контакт>» — крок, але задача
  // поводиться як поставлена людиною: нова подія в діалозі її замінює.
  if (head === "import" && ["reply", "silent", "call"].includes(second)) return second;
  return "manual";
}

const isSystemKey = (key) => ["reply", "first", "silent", "later"].includes(String(key || "").split(":")[0]);

/** Причина задачі: дзвінок — за типом, решта — за ключем; чужа задача — «пінг». */
export function taskReason(task) {
  if (task.task_type === "Call") return "call";
  return reasonOfKey(taskMarks(task).key);
}

/* ── гілка «мовчить» ─────────────────────────────────────────────────────── */

/**
 * Кроки «мовчить»: через скільки робочих днів після нашого n-го повідомлення —
 * наступний дотик. Кампанія задає свої (етап 3/6); поза кампанією — 3 дні й не
 * більше трьох наших поспіль, як з етапу 1 ([3, 3]).
 */
export function stepsOf(steps) {
  return Array.isArray(steps) && steps.length ? steps : currentPingSteps();
}

/**
 * Статус «Невдалий час»: один дотик через місяць від дня, коли його поставили, —
 * замість кроків «мовчить». Ключ — від цього дня, тож новий «Невдалий час»
 * пізніше дає новий дотик.
 */
export function laterPing(contactId, { since, accountId = null, threadKey = null, outreachId = null }) {
  const day = dayIn(since);
  return {
    key: `later:${contactId}:${day}`, reason: "later", basisAt: since,
    due: dayIn(new Date(Date.parse(`${day}T12:00:00Z`) + LATER_DAYS * 86400000).toISOString()),
    accountId, threadKey, outreachId
  };
}

/** День наступного дотику після нашого `count`-го повідомлення поспіль, або null — кроки скінчились. */
export function silentNext(steps, count, lastOutAt) {
  const list = stepsOf(steps);
  if (count > list.length) return null;
  return addWorkingDays(dayIn(lastOutAt), list[Math.max(0, count - 1)]);
}

/** Коли після останнього кроку тиша стає «Не відповідає»: ще стільки ж днів, як останній крок. */
export function noReplyDay(steps, lastOutAt) {
  const list = stepsOf(steps);
  return addWorkingDays(dayIn(lastOutAt), list.at(-1));
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
 *   steps:    кроки «мовчить» кампанії людини (етап 3/6) або нічого — за замовчуванням
 *
 * Повертає `{ key, reason, basisAt, due, accountId, threadKey, outreachId }`;
 * `{ key: null, basisAt }` — пінгу бути не повинно (три наших без відповіді);
 * `null` — контакт поза вікном цього етапу, його задачі не чіпаємо.
 */
export function desiredPing(contactId, state, { now = new Date() } = {}) {
  const windowStart = now.getTime() - WINDOW_DAYS * 86400000;
  // Тред заблокованого акаунта, з якого людину перепризначено (етап 4/6), — історія:
  // наступний крок веде новий акаунт.
  const live = (state.threads || []).filter((thread) => thread.lastMessage && !thread.moved);
  // Системні відправники LinkedIn (таск cdfe0440) — не розмова: ні «Відповідей», ні чернетки.
  const threads = live.filter((thread) => !isSystemSender(thread.participant));
  const thread = threads.sort((left, right) => ms(right.lastStoredAt) - ms(left.lastStoredAt))[0] || null;
  if (!thread && live.length && !state.accepted) {
    // Лише системні треди: пінг, поставлений за ними раніше, закривається.
    return { key: null, basisAt: live.map((item) => item.lastStoredAt).filter(Boolean).sort().at(-1) || null };
  }

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
    const next = silentNext(state.steps, count, lastOutAt);
    if (!next) return { key: null, basisAt: lastOutAt, noReplyDue: noReplyDay(state.steps, lastOutAt) };
    return {
      key: `silent:${contactId}:${lastIn || "none"}:${count}`, reason: "silent", basisAt: lastOutAt,
      due: next, accountId: thread.accountId, threadKey: thread.threadKey, outreachId: state.accepted?.outreachId || null
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
      due: silentNext(state.steps, firstPending.length, queuedAt) || addWorkingDays(dayIn(queuedAt), SILENT_WORKING_DAYS), accountId: accepted.accountId, threadKey: null, outreachId: accepted.outreachId
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
  const parsed = tasks.map((task) => ({ task, ...taskMarks(task), open: !task.completed }));
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
 *   first   — розмови ще немає: прийняв запит, перше повідомлення (дата настала чи минула);
 *   overdue — дата минула, а розмова вже є;  today — сьогодні;  later — пізніше.
 * `awaitingUs` — за станом прогріву останнє слово за лідом.
 * `dialog` — у треді є хоч одне повідомлення або наше вже поставлене в чергу.
 */
export function blockOf({ reason, dueDay, awaitingUs, dialog = reason !== "first" }, today) {
  if (dueDay && dueDay > today) return "later";
  if (awaitingUs || reason === "reply") return "replies";
  // Без розмови (лише взаємне додавання) — не прострочення, а перше повідомлення
  // (Марко 29.10: «мають бути лише просрочені пінги або відповіді»). Так воно не
  // стримує нові контакти — як і раніше до вердикту судді 16.10.
  if (!dialog) return reason === "first" || (dueDay && dueDay < today) ? "first" : "today";
  if (dueDay && dueDay < today) return "overdue";
  if (reason === "first") return "first";
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
  // Дата — лише повна й не в минулому й не далі року (суддя 19.10: ввід з клавіатури
  // давав 0002-10-19, і пінг падав у «Прострочені»).
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text >= today && text <= addCalendarDays(today, 365) ? workday(text) : "";
  const days = Number(text.replace(/^\+/, ""));
  if (!Number.isInteger(days) || days < 0 || days > 365) return "";
  // Субота й неділя — понеділок (таск cdfe0440: пінги не стоять на вихідні).
  return workday(days === 0 ? today : addCalendarDays(today, days));
}

/* ── Статус «Відповів» (Марко 17.10: «Ставити «Відповів» статус») ─────────── */

export const REPLIED_STATUS = "responded";
/** Статуси, які звірка сама піднімає до «Відповів». Решту ставить людина — їх не чіпаємо. */
export const AUTO_REPLIED_FROM = ["new", "in_progress"];

const lastMessageAt = (thread) => Date.parse(thread?.lastMessage?.at || thread?.lastStoredAt || "") || 0;

/** Лід хоч раз написав у будь-якій розмові. */
export function leadReplied(state) {
  return (state?.threads || []).some((thread) => thread.answered || Number(thread.inCount) > 0);
}

/**
 * Чи ставити «Відповів»: лід писав, а статус «Новий» чи «В обробці». «Без відповіді» —
 * лише якщо останнім у найсвіжішій розмові написав лід (повернувся після тиші).
 * «Дзвінок», «Відмова», «Не ICP», «Невдалий час», «Відповів» — без змін.
 */
export function repliedStatusDue(state, leadStatus) {
  if (!leadReplied(state)) return false;
  const status = leadStatus || "new";
  if (AUTO_REPLIED_FROM.includes(status)) return true;
  if (status !== "no_response") return false;
  const newest = [...(state?.threads || [])].filter((thread) => thread.lastMessage).sort((left, right) => lastMessageAt(right) - lastMessageAt(left))[0];
  return newest?.lastMessage?.direction === "in";
}

/* ── Системні відправники LinkedIn (таск cdfe0440) ──────────────────────── */

const LINKEDIN_NAME = /(^|\s)linked\s?in(\s|$)/i;

/**
 * Тред з LinkedIn, а не з людиною: «LinkedIn», «LinkedIn Team», «Команда LinkedIn»… без
 * профілю учасника, або сторінка компанії чи showcase (посилання не на /in/). Людина
 * без імені, яке агент не прочитав, лишається людиною — її відповідь не губимо.
 */
export function isSystemSender(participant) {
  if (!participant || participant.memberProfile) return false;
  const name = String(participant.name || "");
  if (LINKEDIN_NAME.test(name)) return true;
  const slug = String(participant.slug || "");
  return /(?:^|\/)(company|showcase|school)\//i.test(slug);
}

/* ── Денна ємність лідгена і згладжування пінгів (таск cdfe0440) ────────── */

/** Скільки пінгів лідген встигає за робочий день, якщо адміністратор не змінив. */
export const DEFAULT_CAPACITY = 30;
export const CAPACITY_MIN = 5;
export const CAPACITY_MAX = 200;

export function cleanCapacity(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(CAPACITY_MAX, Math.max(CAPACITY_MIN, number)) : DEFAULT_CAPACITY;
}

/**
 * Чи можна пересунути пінг на інший день і в якій черзі: системний «перше повідомлення» —
 * раніше (0), «лід мовчить» і «через місяць» — пізніше (1). Відповідь ліда, дзвінок і пінг,
 * поставлений людиною, стоять на своєму дні (`null`).
 */
export function moveRank(task) {
  if (task.task_type === "Call") return null;
  const key = String(taskMarks(task).key || "");
  const [head, second] = key.split(":");
  if (head === "first") return 0;
  if (head === "silent" || head === "later" || (head === "import" && second === "silent")) return 1;
  return null;
}

/**
 * Нові дати відкритих пінгів одного лідгена: жоден робочий день від сьогодні не має
 * більше `capacity`, вихідних дат немає.
 *
 * Нерухомі (відповіді, дзвінки, ручні) лишаються на своєму дні — лише з вихідного на
 * понеділок — і займають ємність першими. Рухомі ніколи не стають раніше своєї дати;
 * прострочені хочуть сьогодні. Кожен день заповнюється за чергою: «перше повідомлення»,
 * далі «мовчить»; усередині — хто довше чекає. Надлишок переходить на наступний робочий день.
 * Прострочені нерухомі ємності дня не займають: це бекліг, його розбирають окремо.
 *
 * Повертає `[{ task, from, due }]` — лише ті, чия дата змінюється.
 */
export function levelPings(tasks, { today, capacity = DEFAULT_CAPACITY }) {
  const limit = cleanCapacity(capacity);
  const start = workday(today);
  const changes = [];
  const fixed = new Map();
  const movable = [];
  for (const task of tasks) {
    if (task.completed) continue;
    const from = dayIn(task.due_date);
    if (!from) continue;
    const rank = moveRank(task);
    if (rank === null) {
      // Із вихідного — на понеділок, і для старих теж: дата лишається минулою, але будньою.
      const due = workday(from);
      if (due !== from) changes.push({ task, from, due });
      if (due >= start) fixed.set(due, (fixed.get(due) || 0) + 1);
      continue;
    }
    movable.push({ task, from, want: from < start ? start : workday(from), rank });
  }
  movable.sort((left, right) => left.want.localeCompare(right.want) || left.rank - right.rank
    || left.from.localeCompare(right.from) || String(left.task.created_at || "").localeCompare(String(right.task.created_at || "")));
  const waiting = [];
  let next = 0;
  let day = start;
  // Скільки днів уперед можна знадобитись: усі рухомі по одному на день — з запасом.
  for (let guard = 0; (next < movable.length || waiting.length) && guard < movable.length + 400; guard += 1) {
    while (next < movable.length && movable[next].want <= day) waiting.push(movable[next++]);
    waiting.sort((left, right) => left.rank - right.rank || left.from.localeCompare(right.from)
      || String(left.task.created_at || "").localeCompare(String(right.task.created_at || "")));
    let free = Math.max(0, limit - (fixed.get(day) || 0));
    while (free > 0 && waiting.length) {
      const item = waiting.shift();
      if (item.from !== day) changes.push({ task: item.task, from: item.from, due: day });
      free -= 1;
    }
    if (!waiting.length && next < movable.length) day = movable[next].want > day ? movable[next].want : addWorkingDays(day, 1);
    else day = addWorkingDays(day, 1);
  }
  return changes;
}

/** Навантаження на `days` робочих днів від сьогодні: `[{ day, count }]` за датами пінгів. */
export function loadAhead(dueDays, { today, days = 5 }) {
  const out = [];
  let day = workday(today);
  for (let index = 0; index < days; index += 1) {
    out.push({ day, count: 0 });
    day = addWorkingDays(day, 1);
  }
  const at = new Map(out.map((row) => [row.day, row]));
  for (const due of dueDays) {
    const row = at.get(workday(due));
    if (row) row.count += 1;
  }
  return out;
}
