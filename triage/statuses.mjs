// Статуси ліда й причини виходу — спільні з CRM (етап 5/6, таск a70031f9, 16.10.2026).
//
// CRM і Outbound Sales бачать той самий статус: Outbound не тримає копії, а читає й
// пише `contacts.lead_status` у CRM, тож зміна в одній системі одразу видна в іншій,
// і одна зміна — рівно один рядок історії (його пише тригер CRM). Список і підписи —
// ті самі, що у фронтенді CRM (pavlo-ch/advantage-crm).
//
// «Без відповіді» й «Відмова» — це наявні в CRM no_response і not_interested (нові
// підписи), «Не ICP» — новий not_icp. Причина виходу — закритий список, колонка
// `contacts.exit_reason` з перевіркою в базі.

export const LEAD_STATUSES = [
  ["new", "Новий"],
  ["in_progress", "В обробці"],
  ["responded", "Відповів"],
  ["qualification", "Кваліфікація"],
  ["booked_call", "Дзвінок"],
  ["no_response", "Без відповіді"],
  ["not_interested", "Відмова"],
  ["not_icp", "Не ICP"],
  ["bad_timing", "Невдалий час"]
];

export const EXIT_REASONS = [
  ["not_icp", "Не наш клієнт (не ICP)"],
  ["no_budget", "Немає бюджету"],
  ["has_team", "Вже має команду чи підрядника"],
  ["traffic_only", "Тільки трафік (CPA/RevShare)"],
  ["not_now", "Не на часі"],
  ["no_reply", "Не відповідає"],
  ["other", "Інше"]
];

/** Статуси, що виводять людину з воронки: пінги закриваються, причина виходу — обов'язкова. */
export const CLOSING = new Set(["no_response", "not_interested", "not_icp", "bad_timing"]);

/** Причина, яку статус має за замовчуванням, коли людина її не вибрала. */
export const DEFAULT_EXIT = { not_icp: "not_icp", no_response: "no_reply", bad_timing: "not_now" };

export const ORIGIN = "outbound";

export function isStatus(value) {
  return LEAD_STATUSES.some(([key]) => key === value);
}

export function isExitReason(value) {
  return EXIT_REASONS.some(([key]) => key === value);
}

/** Що записати в контакт: статус і причина; помилка — реченням. */
export function statusPatch(status, exitReason) {
  if (!isStatus(status)) return { error: "Невідомий статус." };
  if (!CLOSING.has(status)) return { patch: { lead_status: status, exit_reason: null } };
  const reason = exitReason || DEFAULT_EXIT[status] || "";
  if (!isExitReason(reason)) return { error: "Оберіть причину виходу." };
  return { patch: { lead_status: status, exit_reason: reason } };
}
