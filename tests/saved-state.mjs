import { readFile } from "node:fs/promises";

/**
 * Файл стану, прочитаний тоді, коли він цілий.
 *
 * Сервер пише його через writeFile, а той спершу обнуляє файл і лише потім
 * пише в нього: читач, що потрапив у цю мить, бачить порожній рядок і падає
 * на «Unexpected end of JSON input». Коли один npm test йде сам, вікно крихітне;
 * коли їх два одразу — або машина просто зайнята — воно ловиться, і тест, що
 * нічого не мав би знати про чужий запис, червоніє. Тому читання повторюється,
 * доки не вийде цілий JSON, а помилка стає справжньою лише тоді, коли файл не
 * став цілим за `timeoutMs`.
 *
 * Це про тести. Те, що сервер пише не атомарно (не через тимчасовий файл і
 * rename), — окреме питання до самого сервера, а не до цього читача.
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
