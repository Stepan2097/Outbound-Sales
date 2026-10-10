import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Revalidate every asset URL: the application imports modules without content
// hashes, so a deployment must never leave a browser executing yesterday's JS.
// Cache only content hashes, not response data or any authenticated API.
const validators = new Map();
const MAX_VALIDATORS = 128;

export async function serveStaticFile(request, response, appRoot, pathname, contentType) {
  const filePath = resolve(appRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!filePath.startsWith(resolve(appRoot) + sep)) return false;
  let info;
  try { info = await stat(filePath); } catch { return false; }
  if (!info.isFile()) return false;
  const revision = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const incoming = String(request.headers["if-none-match"] || "");
  const matches = (etag) => ["GET", "HEAD"].includes(request.method) && incoming.split(",").some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag);
  const headers = (etag) => ({
    "Content-Type": contentType(filePath), "Cache-Control": "public, no-cache",
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
