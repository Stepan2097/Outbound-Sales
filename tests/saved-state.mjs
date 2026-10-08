import { readFile } from "node:fs/promises";

/**
 * Файл стану, прочитаний тоді, коли він цілий.
 *
 * Колись сервер писав його через writeFile, а той спершу обнуляє файл: читач,
 * що потрапив у цю мить, бачив порожній рядок і падав на «Unexpected end of
 * JSON input», і тест, що нічого не мав би знати про чужий запис, червонів.
 * Тепер сервер пише атомарно (state/atomic-write.mjs: тимчасовий файл і
 * rename), тож половини файлу на диску не буває. Перечитування лишилось як
 * страховка: читання повторюється, доки не вийде цілий JSON, а помилка стає
 * справжньою лише тоді, коли файл не став цілим за `timeoutMs`.
 */
export async function readSavedState(path, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
