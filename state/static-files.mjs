import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

// The page revalidates on every load; everything it loads comes from a URL
// that carries the release — `/r/<release>/main.js` — and is kept by the
// browser for a year (власник 17.11: «весь інтерфейс має літати»). Before,
// every one of ~90 stylesheets and modules was asked again on each load, one
// import after another. Relative imports inside the modules resolve under the
// same prefix by themselves, so one release always loads one set of files.
// A URL of an older release still answers (with the current file, revalidated),
// so a tab opened before a deployment keeps working.
const validators = new Map();
const MAX_VALIDATORS = 256;
const RELEASE_PREFIX = /^\/r\/([0-9a-f]{12})(\/.+)$/;
const IMMUTABLE = "public, max-age=31536000, immutable";
const releases = new Map();

async function appFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await appFiles(full));
    else if (entry.isFile()) found.push(full);
  }
  return found.sort();
}

/**
 * The release of the app folder: a hash of every file in it. Re-hashed only
 * when a file's size or time changed, so a local server under edit gets a new
 * release with each saved file and never serves an old module for a year.
 */
export async function appRelease(appRoot) {
  const files = await appFiles(resolve(appRoot));
  const infos = await Promise.all(files.map((file) => stat(file)));
  const shape = files.map((file, index) => `${file}:${infos[index].size}:${infos[index].mtimeMs}`).join("\n");
  const known = releases.get(appRoot);
  if (known?.shape === shape) return known.release;
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.slice(resolve(appRoot).length)).update("\0").update(await readFile(file)).update("\0");
  const release = hash.digest("hex").slice(0, 12);
  releases.set(appRoot, { shape, release });
  return release;
}

/** The page with its own files addressed by release; links elsewhere stay as they are. */
export function withRelease(html, release) {
  return String(html).replace(/(\s(?:href|src)=")\/(?!\/|r\/|api\/)([^"?#]+\.(?:js|css|svg|png|ico|webp|woff2?))"/g, `$1/r/${release}/$2"`);
}

export async function serveStaticFile(request, response, appRoot, pathname, contentType) {
  const versioned = RELEASE_PREFIX.exec(pathname);
  if (versioned) pathname = versioned[2];
  const page = pathname === "/" || pathname === "/index.html";
  const release = versioned || page ? await appRelease(appRoot).catch(() => null) : null;
  const immutable = Boolean(versioned && release && versioned[1] === release);
  const filePath = resolve(appRoot, `.${page ? "/index.html" : pathname}`);
  if (!filePath.startsWith(resolve(appRoot) + sep)) return false;
  let info;
  try { info = await stat(filePath); } catch { return false; }
  if (!info.isFile()) return false;
  const revision = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${page ? release : ""}`;
  const incoming = String(request.headers["if-none-match"] || "");
  const matches = (etag) => ["GET", "HEAD"].includes(request.method) && incoming.split(",").some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag);
  const headers = (etag) => ({
    "Content-Type": contentType(filePath), "Cache-Control": immutable ? IMMUTABLE : "public, no-cache",
    ETag: etag, "Last-Modified": info.mtime.toUTCString()
  });
  const cached = validators.get(filePath);
  if (cached?.revision === revision && matches(cached.etag)) {
    response.writeHead(304, headers(cached.etag));
    response.end();
    return true;
  }
  // Hash and send the same buffer. A release replaced between stat/read/send
  // must not get another release's strong validator or Content-Length.
  let bytes;
  try { bytes = await readFile(filePath); } catch { return false; }
  if (page && release) bytes = Buffer.from(withRelease(bytes.toString("utf8"), release));
  const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
  validators.set(filePath, { revision, etag });
  if (validators.size > MAX_VALIDATORS) validators.delete(validators.keys().next().value);
  if (matches(etag)) {
    response.writeHead(304, headers(etag));
    response.end();
    return true;
  }
  response.writeHead(200, { ...headers(etag), "Content-Length": bytes.length });
  response.end(request.method === "HEAD" ? undefined : bytes);
  return true;
}
