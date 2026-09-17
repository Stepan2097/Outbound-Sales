import {
  createKnowledgeFile, deleteKnowledgeFile, publicLibrary, readKnowledgeFile, updateKnowledgeFile
} from "./library.mjs";

/**
 * The knowledge library's HTTP surface, mounted under /api/knowledge/library
 * behind the same workspace sign-in as everything else.
 *
 * Returns true when it answered the request, false when the path was not one of
 * ours, so the caller can carry on matching its own routes.
 */
export async function handleKnowledgeLibraryApi({ request, response, url, sendJson, readJson, actingUser = "" }) {
  const path = url.pathname;
  if (path !== "/api/knowledge/library" && !path.startsWith("/api/knowledge/library/")) return false;

  try {
    if (request.method === "GET" && path === "/api/knowledge/library") {
      sendJson(response, 200, publicLibrary());
      return true;
    }

    const fileMatch = path.match(/^\/api\/knowledge\/library\/files\/([^/]+)(\/delete)?$/);

    if (request.method === "GET" && fileMatch && !fileMatch[2]) {
      const file = readKnowledgeFile(decodeURIComponent(fileMatch[1]));
      if (!file) {
        sendJson(response, 404, { error: "Файл не знайдено." });
        return true;
      }
      sendJson(response, 200, { file });
      return true;
    }

    if (request.method === "POST" && path === "/api/knowledge/library/files") {
      const body = await readJson(request);
      const file = await createKnowledgeFile({ ...body, updatedBy: actingUser });
      sendJson(response, 201, { file, library: publicLibrary() });
      return true;
    }

    if (request.method === "POST" && fileMatch && !fileMatch[2]) {
      const body = await readJson(request);
      const file = await updateKnowledgeFile(decodeURIComponent(fileMatch[1]), { ...body, updatedBy: actingUser });
      sendJson(response, 200, { file, library: publicLibrary() });
      return true;
    }

    // Deletes are POSTs to /delete rather than the DELETE verb, matching the
    // rest of this app's API and keeping the browser call one shape.
    if (request.method === "POST" && fileMatch && fileMatch[2]) {
      const result = await deleteKnowledgeFile(decodeURIComponent(fileMatch[1]));
      sendJson(response, 200, { ...result, library: publicLibrary() });
      return true;
    }

    sendJson(response, 404, { error: "Невідомий маршрут бібліотеки знань." });
    return true;
  } catch (error) {
    const status = Number(error?.statusCode || 500);
    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
