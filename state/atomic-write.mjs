import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Записати файл так, щоб на місці завжди лежала або стара, або нова версія.
 *
 * `writeFile` перезаписує файл на місці: обрив посередині — рестарт
 * контейнера, OOM, закінчилось місце — лишав обрізаний JSON, і стан
 * робочого простору не читався зовсім. Тут пишемо в тимчасовий файл поруч
 * (та сама файлова система), скидаємо його на диск і лише тоді
 * перейменовуємо поверх старого: rename у межах однієї ФС атомарний.
 */
export async function writeFileAtomic(path, data, { fs = { open, rename, unlink } } = {}) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, "w", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
  // Сам rename теж має дожити до диска — синхронізуємо теку.
  try {
    const directory = await fs.open(dirname(path), "r");
    await directory.sync().catch(() => {});
    await directory.close();
  } catch {
    // Не на всіх ФС теку можна відкрити; файл уже на місці.
  }
}
