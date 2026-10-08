import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
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

/**
 * Створити файл, якого ще нема, так, щоб його ніколи не було видно половинним.
 *
 * Для ключа шифрування: `writeFileSync(..., { flag: "wx" })` теж виключний, але
 * пише в сам файл, тож обрив посередині лишав обрізаний ключ, який завантажувач
 * відкидає, — і сервер не стартував, доки хтось не прибере файл руками. Тут
 * цілий файл пишеться в тимчасовий, скидається на диск і прив'язується до
 * потрібного імені через `link`: вона, як `wx`, падає з EEXIST, якщо файл
 * уже є, — тож «хто перший створив, того й ключ» лишається, як було.
 *
 * Файлова система, що не вміє жорстких посилань (деякі мережеві й FAT), не
 * повинна ламати старт: тоді падаємо назад на звичайний `wx`.
 */
export function createFileOnceSync(path, data, { mode = 0o600, fs = nodeFs } = {}) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temp, "w", mode);
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(temp, path);
    } catch (error) {
      if (error?.code === "EEXIST" || !["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"].includes(error?.code)) throw error;
      fs.writeFileSync(path, data, { mode, flag: "wx" });
    }
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* уже закрито */ }
    try { fs.unlinkSync(temp); } catch { /* тимчасового файла вже нема */ }
  }
}
