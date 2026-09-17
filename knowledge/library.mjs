import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The knowledge library: the files an agent reads before it writes anything.
 *
 * A file belongs to products, not to a folder. One file can belong to several:
 * that is the whole point — the outbound playbook is the same document for
 * everything the team sells, and a copy per product would mean editing it twice
 * and finding out months later that the copies disagree.
 *
 * Files live on disk beside the workspace state file — in production that is
 * the container's /data volume, so a document written here survives a deploy
 * the way the workspace does. The index (which file belongs to which product)
 * is a small JSON next to them; the documents themselves stay plain Markdown
 * on purpose, so somebody can read, diff, or rescue one without this app.
 */

const moduleRoot = fileURLToPath(new URL(".", import.meta.url));
const seedRoot = join(moduleRoot, "seed");

const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 200;

// What one message-writing call is allowed to spend on library text. Files run
// to tens of thousands of characters; the whole library in every prompt would
// cost more than the lead research it is supposed to inform, so the retrieval
// below picks the passages that match the lead and stops here.
const PROMPT_CHAR_BUDGET = 6000;
const MAX_CHUNK_CHARS = 1600;

const ADACTION_PRODUCT_ID = "adaction-value-exchange-ua";
const COURSE_PRODUCT_ID = "black-affiliate";

let dataDir = "";
let indexPath = "";
let filesDir = "";
let loaded = false;
let library = { version: 2, files: [] };
// Which product ids exist, asked of the workspace rather than copied from it:
// a file may only point at a product that is really for sale, and products come
// and go while this module stays loaded.
let knownProductIds = () => [];
// File bodies, by file id. Kept in memory because the prompt builders that need
// them are synchronous and sit deep inside the research path; a few hundred
// kilobytes of Markdown is a cheap thing to hold and a painful thing to await.
const contents = new Map();
let writeQueue = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function cleanLine(value, limit = 160) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * A display name is free text, but it also has to be safe to show and sane to
 * sort. The extension is kept when somebody typed one and added when they did
 * not, so the list reads like a folder of documents rather than a list of rows.
 */
function normalizeFileName(value, fallback = "Новий файл") {
  const clean = cleanLine(value, 120).replace(/[\\/\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  const name = clean || fallback;
  return /\.[a-z0-9]{1,8}$/i.test(name) ? name : `${name}.md`;
}

function normalizeProductIds(ids) {
  const wanted = Array.isArray(ids) ? ids : [ids];
  const known = new Set(knownProductIds());
  return [...new Set(wanted.map((id) => cleanLine(id, 60)).filter((id) => known.has(id)))];
}

export function knowledgeDataDir() {
  return dataDir;
}

/**
 * Called once at boot with the directory the workspace state lives in, so the
 * library follows STATE_FILE_PATH into whatever volume a deployment mounted,
 * and with a way to ask which products currently exist.
 */
export async function loadKnowledgeLibrary(stateFilePath, listProductIds) {
  if (typeof listProductIds === "function") knownProductIds = listProductIds;
  dataDir = join(dirname(stateFilePath), "knowledge");
  indexPath = join(dataDir, "index.json");
  filesDir = join(dataDir, "files");
  await mkdir(filesDir, { recursive: true });

  let saved = null;
  try {
    saved = JSON.parse(await readFile(indexPath, "utf8"));
  } catch {
    // No index yet: a fresh workspace, or a volume mounted for the first time.
    saved = null;
  }
  library = { version: 2, files: Array.isArray(saved?.files) ? saved.files : [] };
  contents.clear();

  for (const file of library.files) {
    try {
      contents.set(file.id, await readFile(join(filesDir, `${file.id}.md`), "utf8"));
    } catch {
      // The index knows about a document the disk does not. Keeping the row
      // with an empty body would quietly feed nothing to the agents, so the row
      // goes and the index is rewritten below.
      contents.set(file.id, "");
    }
  }
  library.files = library.files.filter((file) => contents.get(file.id) !== "" || file.bytes === 0);

  const migrated = migrateProjectsToProducts(saved);
  if (!library.files.length) {
    await seedLibrary();
  } else if (migrated) {
    await persistIndex();
  }
  loaded = true;
  return publicLibrary();
}

/**
 * The first version of this library put files in projects, and a project
 * pointed at a product. Products turned out to be the only thing a project ever
 * meant, so the indirection is read once here and then gone. Files whose
 * project pointed nowhere keep every product, rather than silently becoming
 * unreadable to every agent.
 */
function migrateProjectsToProducts(saved) {
  if (!Array.isArray(saved?.projects) || !saved.projects.length) return false;
  const productOfProject = new Map(saved.projects.map((project) => [project.id, project.productId || ""]));
  let changed = false;
  for (const file of library.files) {
    if (Array.isArray(file.productIds) && file.productIds.length) continue;
    const mapped = (file.projectIds || [])
      .map((projectId) => productOfProject.get(projectId) || "")
      .filter(Boolean);
    file.productIds = [...new Set(mapped.length ? mapped : knownProductIds())];
    delete file.projectIds;
    changed = true;
  }
  return changed;
}

/**
 * The first boot starts from the two documents the team already works from,
 * rather than from an empty page nobody would know what to put on.
 */
async function seedLibrary() {
  const documents = [
    {
      file: "outbound-knowledge-base.md",
      name: "Outbound-knowledge-base.md",
      // The shared one: how this team writes outbound, whatever it is selling.
      productIds: [ADACTION_PRODUCT_ID, COURSE_PRODUCT_ID]
    },
    {
      file: "faq-training-black-affiliate.md",
      name: "FAQ — Training Black Affiliate.md",
      productIds: [COURSE_PRODUCT_ID]
    }
  ];

  for (const document of documents) {
    let text = "";
    try {
      text = await readFile(join(seedRoot, document.file), "utf8");
    } catch {
      continue;
    }
    const id = newId("kfile");
    contents.set(id, text);
    library.files.push({
      id,
      name: document.name,
      productIds: document.productIds,
      bytes: Buffer.byteLength(text, "utf8"),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      updatedBy: "seed"
    });
    await writeFile(join(filesDir, `${id}.md`), text, "utf8");
  }
  await persistIndex();
}

/**
 * Index writes are serialized. Two people saving different files at the same
 * second would otherwise race on one JSON and one of the saves would vanish
 * with no error anywhere.
 */
function persistIndex() {
  writeQueue = writeQueue.then(async () => {
    await mkdir(filesDir, { recursive: true });
    await writeFile(indexPath, JSON.stringify(library, null, 2), "utf8");
  }).catch((error) => {
    console.error("Could not persist knowledge library index:", error instanceof Error ? error.message : error);
  });
  return writeQueue;
}

export function publicLibrary() {
  return {
    files: library.files
      .map((file) => ({ ...file, excerpt: cleanLine(contents.get(file.id) || "", 220) }))
      .sort((left, right) => left.name.localeCompare(right.name, "uk"))
  };
}

export function readKnowledgeFile(id) {
  const file = library.files.find((item) => item.id === id);
  if (!file) return null;
  return { ...file, content: contents.get(file.id) ?? "" };
}

export async function createKnowledgeFile({ name, productIds = [], content = "", updatedBy = "" } = {}) {
  if (library.files.length >= MAX_FILES) {
    throw fail(400, "Досягнуто ліміт файлів у бібліотеці.");
  }
  const text = String(content ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    throw fail(413, "Файл завеликий. Розбий його на кілька.");
  }
  const products = normalizeProductIds(productIds);
  if (!products.length) throw fail(400, "Обери хоча б один продукт, для якого цей файл.");
  const id = newId("kfile");
  const file = {
    id,
    name: normalizeFileName(name),
    productIds: products,
    bytes: Buffer.byteLength(text, "utf8"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    updatedBy: cleanLine(updatedBy, 120)
  };
  contents.set(id, text);
  library.files.push(file);
  await writeFile(join(filesDir, `${id}.md`), text, "utf8");
  await persistIndex();
  return readKnowledgeFile(id);
}

export async function updateKnowledgeFile(id, patch = {}) {
  const file = library.files.find((item) => item.id === id);
  if (!file) throw fail(404, "Файл не знайдено.");
  if (patch.name !== undefined) file.name = normalizeFileName(patch.name, file.name);
  if (patch.productIds !== undefined) {
    const products = normalizeProductIds(patch.productIds);
    if (!products.length) throw fail(400, "Файл має належати хоча б одному продукту.");
    file.productIds = products;
  }
  if (patch.content !== undefined) {
    const text = String(patch.content ?? "");
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
      throw fail(413, "Файл завеликий. Розбий його на кілька.");
    }
    contents.set(id, text);
    file.bytes = Buffer.byteLength(text, "utf8");
    await writeFile(join(filesDir, `${id}.md`), text, "utf8");
  }
  if (patch.updatedBy) file.updatedBy = cleanLine(patch.updatedBy, 120);
  file.updatedAt = nowIso();
  await persistIndex();
  return readKnowledgeFile(id);
}

export async function deleteKnowledgeFile(id) {
  const file = library.files.find((item) => item.id === id);
  if (!file) throw fail(404, "Файл не знайдено.");
  library.files = library.files.filter((item) => item.id !== id);
  contents.delete(id);
  try {
    await rm(join(filesDir, `${id}.md`), { force: true });
  } catch {
    // A document that is already gone from disk is the state we wanted.
  }
  await persistIndex();
  return { deletedFileId: id };
}

function fail(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

/** Every file this product carries, newest edit first. */
export function knowledgeFilesForProduct(productId = "") {
  if (!loaded || !productId) return [];
  return library.files
    .filter((file) => (file.productIds || []).includes(productId))
    .map((file) => ({ ...file, content: contents.get(file.id) ?? "" }))
    .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
}

/**
 * Markdown split into passages an agent can actually use. Headings start a new
 * passage and travel with it, because "§2.4 The ask" is worthless as a rule
 * once it is separated from the heading that says what it is about.
 */
function chunkDocument(text = "") {
  const lines = String(text).split("\n");
  const chunks = [];
  let heading = "";
  let buffer = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (!body) return;
    const withHeading = heading ? `${heading}\n${body}` : body;
    // A section longer than the cap is cut on paragraph boundaries rather than
    // mid-sentence, and each piece keeps the heading.
    if (withHeading.length <= MAX_CHUNK_CHARS) {
      chunks.push(withHeading);
      return;
    }
    let piece = heading ? `${heading}\n` : "";
    for (const paragraph of body.split(/\n{2,}/)) {
      if (piece.length + paragraph.length > MAX_CHUNK_CHARS && piece.trim()) {
        chunks.push(piece.trim());
        piece = heading ? `${heading}\n` : "";
      }
      piece += `${paragraph}\n\n`;
    }
    if (piece.trim()) chunks.push(piece.trim());
  };

  for (const line of lines) {
    if (/^#{1,4}\s/.test(line)) {
      flush();
      heading = line.trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

const stopWords = new Set(["about", "after", "again", "also", "company", "from", "have", "into", "more", "that", "their", "this", "with", "your", "what", "when", "where", "which"]);

function queryTokens(value = "") {
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9][a-z0-9+.-]{2,}/g) || [])]
    .filter((token) => !stopWords.has(token))
    .slice(0, 60);
}

function chunkScore(chunk, tokens) {
  if (!tokens.length) return 0;
  const lower = chunk.toLowerCase();
  const headingLine = lower.split("\n")[0];
  return tokens.reduce((score, token) => score + (headingLine.includes(token) ? 6 : 0) + (lower.includes(token) ? 2 : 0), 0);
}

/**
 * What the agents actually read. The lead in front of them decides which
 * passages come back: tokens from the company, title and notes are matched
 * against the library, and the best passages are returned until the budget runs
 * out. Every file that belongs to the product contributes its opening passage
 * even when nothing matched, so a document is never silently invisible just
 * because this particular lead used different words.
 */
export function knowledgeExcerptsForPrompt(productId = "", context = "", budget = PROMPT_CHAR_BUDGET) {
  const files = knowledgeFilesForProduct(productId);
  if (!files.length) return [];

  const contextText = typeof context === "string"
    ? context
    : [context?.name, context?.title, context?.company, context?.location, context?.website, context?.notes, context?.companyProfile?.category]
      .filter(Boolean).join(" ");
  const tokens = queryTokens(contextText);

  // Per file, its passages ranked by how well they match this lead. A passage
  // near the top of a document wins ties, because that is where a document
  // usually says what it is.
  const queues = new Map();
  for (const file of files) {
    const ranked = chunkDocument(file.content)
      // A rule of three words is a horizontal rule or a stray heading fragment,
      // and spending a file's one guaranteed slot on it would hide the file.
      .filter((chunk) => chunk.replace(/[^\p{L}\p{N}]+/gu, " ").trim().length >= 80)
      .map((chunk, index) => ({ fileId: file.id, fileName: file.name, chunk, index, score: chunkScore(chunk, tokens) + (index < 2 ? 3 - index : 0) }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    if (ranked.length) queues.set(file.id, ranked);
  }

  // Round-robin rather than a single ranked list: one long document that
  // happens to share the lead's vocabulary would otherwise take the whole
  // budget and the other files would reach the model as nothing at all.
  const picked = [];
  let spent = 0;
  let round = 0;
  let placedSomething = true;
  while (placedSomething && spent < budget) {
    placedSomething = false;
    for (const file of files) {
      const queue = queues.get(file.id);
      if (!queue?.length) continue;
      // After every file has had its turn, only passages that actually match
      // the lead are worth more budget.
      if (round > 0 && queue[0].score <= 0) continue;
      const next = queue[0];
      if (spent + next.chunk.length > budget) continue;
      queue.shift();
      picked.push(next);
      spent += next.chunk.length;
      placedSomething = true;
    }
    round += 1;
  }

  const byFile = new Map();
  for (const item of picked.sort((left, right) => left.index - right.index)) {
    if (!byFile.has(item.fileId)) byFile.set(item.fileId, { file: item.fileName, passages: [] });
    byFile.get(item.fileId).passages.push(item.chunk);
  }
  return [...byFile.values()];
}

/** For tests and for a boot that wants to know what is on disk. */
export async function knowledgeDiagnostics() {
  let onDisk = [];
  try {
    onDisk = await readdir(filesDir);
  } catch {
    onDisk = [];
  }
  return { dataDir, indexedFiles: library.files.length, onDisk: onDisk.length };
}
