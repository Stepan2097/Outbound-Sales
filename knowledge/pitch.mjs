import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../state/atomic-write.mjs";

/**
 * «Смисли» — довідник продуктів для лідгенів (таск 1b128e83, 15.10.2026).
 *
 * Що ми продаємо і як про це говорити: кому й коли пропонувати, ціна, смисли,
 * пруфи, заперечення, чого не обіцяти, що слати в DM. Лідген відкриває картку
 * посеред розмови й копіює фразу чи посилання; адміністратор править зміст,
 * додає апдейти, посилання й файли. Читають усі, хто увійшов; пише лише admin.
 *
 * Це не продукти, з яких AI пише чернетки (`state.products`, «бриф» на вісім
 * відповідей) — ті живуть у стані робочого простору й годують кампанії. Тут
 * текст для людини, і він має право бути довгим та живим; звести їх в одне —
 * окреме рішення, не побічний ефект цього екрана.
 *
 * Зберігається поруч зі станом робочого простору (на проді — volume /data):
 * pitch/index.json — зміст, pitch/files/<id> — прикріплені файли як є. Перший
 * запуск на порожньому томі бере зміст із knowledge/seed/pitch-products.json;
 * далі seed не читається, щоб правки адміністратора не перезаписувались
 * деплоєм.
 */

const seedPath = join(dirname(fileURLToPath(import.meta.url)), "seed", "pitch-products.json");

export const PITCH_MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 300;
const MAX_PRODUCTS = 40;
const MAX_SECTIONS = 30;
const MAX_LINKS = 40;
const MAX_UPDATES = 300;
const TONES = new Set(["priority", "low", "exception", "muted"]);

let dataDir = "";
let indexPath = "";
let filesDir = "";
let book = { version: 1, intro: "", introUpdatedAt: "", introUpdatedBy: "", products: [] };
let writeQueue = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function line(value, limit) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** Багаторядковий текст: рядки й порожні рядки лишаються, \r та керівні символи — ні. */
function block(value, limit) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}

function cleanUrl(value) {
  const raw = line(value, 2000);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw httpError("Посилання має починатися з https:// або http://", 400);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw httpError("Посилання має починатися з https:// або http://", 400);
  return parsed.toString();
}

function cleanSections(value) {
  if (!Array.isArray(value)) throw httpError("Розділи мають бути списком.", 400);
  const sections = value.slice(0, MAX_SECTIONS)
    .map((section) => ({
      id: line(section?.id, 40) || newId("sec"),
      title: line(section?.title, 80),
      text: block(section?.text, 8000)
    }))
    .filter((section) => section.title || section.text);
  for (const section of sections) if (!section.title) throw httpError("У кожного розділу має бути назва.", 400);
  return sections;
}

function normalizeProduct(raw) {
  const product = {
    id: line(raw?.id, 60) || newId("prod"),
    name: line(raw?.name, 120) || "Новий продукт",
    badgeLabel: line(raw?.badgeLabel, 60),
    badgeTone: TONES.has(raw?.badgeTone) ? raw.badgeTone : "muted",
    price: line(raw?.price, 300),
    pitch: block(raw?.pitch, 600),
    sections: [],
    links: [],
    oneLiner: block(raw?.oneLiner, 1200),
    files: Array.isArray(raw?.files) ? raw.files : [],
    updates: Array.isArray(raw?.updates) ? raw.updates : [],
    archived: Boolean(raw?.archived),
    createdAt: raw?.createdAt || nowIso(),
    updatedAt: raw?.updatedAt || nowIso(),
    updatedBy: line(raw?.updatedBy, 120)
  };
  try { product.sections = cleanSections(raw?.sections || []); } catch { product.sections = []; }
  product.links = (Array.isArray(raw?.links) ? raw.links : []).flatMap((link) => {
    try {
      return [{ id: line(link?.id, 40) || newId("lnk"), label: line(link?.label, 200), url: cleanUrl(link?.url), addedAt: link?.addedAt || product.createdAt, addedBy: line(link?.addedBy, 120) }];
    } catch {
      return [];
    }
  });
  return product;
}

async function persist() {
  const snapshot = JSON.stringify(book, null, 2);
  writeQueue = writeQueue.then(() => writeFileAtomic(indexPath, snapshot), () => writeFileAtomic(indexPath, snapshot));
  await writeQueue;
}

/**
 * Відкривається раз при старті з каталогу, де лежить стан робочого простору,
 * тож іде за STATE_FILE_PATH у будь-який volume, який змонтував деплой.
 */
export async function loadPitchBook(stateFilePath) {
  dataDir = join(dirname(stateFilePath), "pitch");
  indexPath = join(dataDir, "index.json");
  filesDir = join(dataDir, "files");
  await mkdir(filesDir, { recursive: true });

  let saved = null;
  try {
    saved = JSON.parse(await readFile(indexPath, "utf8"));
  } catch (error) {
    // Немає файла — перший запуск на цьому томі. Зіпсований файл — не привід
    // мовчки затерти чужі правки seed-ом: падаємо голосно, файл лишається.
    if (error?.code !== "ENOENT") throw new Error(`pitch/index.json не читається: ${error.message}`);
  }
  if (saved) {
    book = {
      version: 1,
      intro: block(saved.intro, 4000),
      introUpdatedAt: saved.introUpdatedAt || "",
      introUpdatedBy: line(saved.introUpdatedBy, 120),
      products: (Array.isArray(saved.products) ? saved.products : []).map(normalizeProduct)
    };
    return;
  }
  const seed = JSON.parse(await readFile(seedPath, "utf8"));
  const at = nowIso();
  book = {
    version: 1,
    intro: block(seed.intro, 4000),
    introUpdatedAt: at,
    introUpdatedBy: "",
    products: seed.products.map((product) => normalizeProduct({ ...product, createdAt: at, updatedAt: at, updatedBy: "" }))
  };
  await persist();
}

function publicFile(file) {
  return { id: file.id, name: file.name, type: file.type, bytes: file.bytes, addedAt: file.addedAt, addedBy: file.addedBy };
}

/** Що бачить екран. `canEdit` вирішує сервер — кнопки лише відображають його рішення. */
export function publicPitchBook({ canEdit = false } = {}) {
  const products = book.products.filter((product) => !product.archived).map((product) => ({
    ...product,
    files: product.files.map(publicFile),
    // Апдейти — найсвіжіші зверху.
    updates: [...product.updates].sort((left, right) => String(right.at).localeCompare(String(left.at)))
  }));
  return { intro: book.intro, introUpdatedAt: book.introUpdatedAt, introUpdatedBy: book.introUpdatedBy, products, canEdit };
}

function findProduct(id) {
  const product = book.products.find((item) => item.id === id && !item.archived);
  if (!product) throw httpError("Продукт не знайдено.", 404);
  return product;
}

function touch(product, actor) {
  product.updatedAt = nowIso();
  product.updatedBy = actor;
}

export async function setPitchIntro(text, actor) {
  book.intro = block(text, 4000);
  book.introUpdatedAt = nowIso();
  book.introUpdatedBy = actor;
  await persist();
}

export async function createPitchProduct(body, actor) {
  if (book.products.filter((product) => !product.archived).length >= MAX_PRODUCTS) throw httpError(`Не більше ${MAX_PRODUCTS} продуктів.`, 400);
  const name = line(body?.name, 120);
  if (!name) throw httpError("Назвіть продукт.", 400);
  const at = nowIso();
  const product = normalizeProduct({ id: newId("prod"), name, badgeTone: "muted", sections: [], links: [], createdAt: at, updatedAt: at, updatedBy: actor });
  book.products.push(product);
  await persist();
  return product;
}

export async function updatePitchProduct(id, body, actor) {
  const product = findProduct(id);
  if (body?.name !== undefined) {
    const name = line(body.name, 120);
    if (!name) throw httpError("Назва продукту не може бути порожньою.", 400);
    product.name = name;
  }
  if (body?.badgeLabel !== undefined) product.badgeLabel = line(body.badgeLabel, 60);
  if (body?.badgeTone !== undefined) product.badgeTone = TONES.has(body.badgeTone) ? body.badgeTone : "muted";
  if (body?.price !== undefined) product.price = line(body.price, 300);
  if (body?.pitch !== undefined) product.pitch = block(body.pitch, 600);
  if (body?.oneLiner !== undefined) product.oneLiner = block(body.oneLiner, 1200);
  if (body?.sections !== undefined) product.sections = cleanSections(body.sections);
  touch(product, actor);
  await persist();
  return product;
}

/** Продукт не стирається: прибирається з екрана, а зміст і файли лишаються на диску. */
export async function archivePitchProduct(id, actor) {
  const product = findProduct(id);
  product.archived = true;
  touch(product, actor);
  await persist();
}

export async function addPitchUpdate(id, body, actor) {
  const product = findProduct(id);
  const text = block(body?.text, 4000);
  if (!text) throw httpError("Напишіть, що змінилось.", 400);
  if (product.updates.length >= MAX_UPDATES) product.updates.sort((left, right) => String(left.at).localeCompare(String(right.at))).shift();
  const update = { id: newId("upd"), at: nowIso(), by: actor, text };
  product.updates.push(update);
  touch(product, actor);
  await persist();
  return update;
}

export async function removePitchUpdate(id, updateId, actor) {
  const product = findProduct(id);
  const before = product.updates.length;
  product.updates = product.updates.filter((update) => update.id !== updateId);
  if (product.updates.length === before) throw httpError("Апдейт не знайдено.", 404);
  touch(product, actor);
  await persist();
}

export async function addPitchLink(id, body, actor) {
  const product = findProduct(id);
  if (product.links.length >= MAX_LINKS) throw httpError(`Не більше ${MAX_LINKS} посилань на продукт.`, 400);
  const url = cleanUrl(body?.url);
  const link = { id: newId("lnk"), label: line(body?.label, 200) || url, url, addedAt: nowIso(), addedBy: actor };
  product.links.push(link);
  touch(product, actor);
  await persist();
  return link;
}

export async function removePitchLink(id, linkId, actor) {
  const product = findProduct(id);
  const before = product.links.length;
  product.links = product.links.filter((link) => link.id !== linkId);
  if (product.links.length === before) throw httpError("Посилання не знайдено.", 404);
  touch(product, actor);
  await persist();
}

function cleanFileName(value) {
  let name = "";
  try { name = decodeURIComponent(String(value || "")); } catch { name = String(value || ""); }
  name = line(name.replace(/[\\/\u0000-\u001f"]/g, " "), 160);
  return name || "Файл";
}

function cleanType(value) {
  const type = line(value, 120).toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : "application/octet-stream";
}

export async function addPitchFile(id, { name, type, bytes }, actor) {
  const product = findProduct(id);
  if (!bytes?.length) throw httpError("Файл порожній.", 400);
  if (bytes.length > PITCH_MAX_FILE_BYTES) throw httpError("Файл більший за 20 МБ.", 413);
  if (book.products.reduce((sum, item) => sum + item.files.length, 0) >= MAX_FILES) throw httpError(`Не більше ${MAX_FILES} файлів.`, 400);
  const file = { id: newId("file"), name: cleanFileName(name), type: cleanType(type), bytes: bytes.length, addedAt: nowIso(), addedBy: actor };
  await writeFileAtomic(join(filesDir, file.id), bytes);
  product.files.push(file);
  touch(product, actor);
  await persist();
  return publicFile(file);
}

export async function removePitchFile(id, fileId, actor) {
  const product = findProduct(id);
  const file = product.files.find((item) => item.id === fileId);
  if (!file) throw httpError("Файл не знайдено.", 404);
  product.files = product.files.filter((item) => item.id !== fileId);
  touch(product, actor);
  await persist();
  await rm(join(filesDir, file.id), { force: true });
}

/** Файл для скачування — лише з продукту, який ще на екрані. */
export async function readPitchFile(fileId) {
  for (const product of book.products) {
    if (product.archived) continue;
    const file = product.files.find((item) => item.id === fileId);
    if (file) return { file, bytes: await readFile(join(filesDir, file.id)) };
  }
  throw httpError("Файл не знайдено.", 404);
}
