import {
  PITCH_MAX_FILE_BYTES, addPitchFile, addPitchLink, addPitchUpdate, archivePitchProduct, createPitchProduct, publicPitchBook,
  readPitchFile, removePitchFile, removePitchLink, removePitchUpdate, setPitchIntro, updatePitchProduct
} from "./pitch.mjs";

/**
 * HTTP-поверхня «Смислів», під /api/pitch, за тим самим входом у робочий
 * простір, що й решта застосунку.
 *
 * Читають усі, хто увійшов (продавець відкриває картку посеред розмови); пише
 * лише адміністратор — так погоджено з власником 15.10: продавець не має
 * випадково змінити ціну, яку потім назве клієнтові. Перевірка тут, на сервері;
 * кнопки на екрані лише відображають `canEdit`.
 *
 * Видалення — POST на …/delete, як і в решті API цього застосунку.
 *
 * Повертає true, коли відповів сам, і false, коли шлях не його.
 */
export async function handlePitchApi({ request, response, url, sendJson, readJson, readRaw, profile }) {
  const path = url.pathname;
  if (path !== "/api/pitch" && !path.startsWith("/api/pitch/")) return false;
  const canEdit = profile?.role === "admin";
  const actor = String(profile?.name || profile?.email || "").trim();
  const reply = (status = 200, extra = {}) => sendJson(response, status, { ...extra, book: publicPitchBook({ canEdit }) });

  try {
    if (request.method === "GET" && path === "/api/pitch") {
      sendJson(response, 200, publicPitchBook({ canEdit }));
      return true;
    }

    const fileDownload = path.match(/^\/api\/pitch\/files\/([^/]+)$/);
    if (request.method === "GET" && fileDownload) {
      const { file, bytes } = await readPitchFile(decodeURIComponent(fileDownload[1]));
      response.writeHead(200, {
        "Content-Type": file.type,
        "Content-Length": bytes.length,
        // Ім'я файла — і для старих браузерів (ASCII), і точне (RFC 5987).
        "Content-Disposition": `attachment; filename="${file.name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(bytes);
      return true;
    }

    if (request.method !== "POST") {
      sendJson(response, 404, { error: "Невідомий маршрут «Смислів»." });
      return true;
    }
    if (!canEdit) {
      sendJson(response, 403, { error: "Змінювати «Смисли» може лише адміністратор." });
      return true;
    }

    if (path === "/api/pitch/intro") {
      await setPitchIntro((await readJson(request))?.text, actor);
      reply();
      return true;
    }
    if (path === "/api/pitch/products") {
      const product = await createPitchProduct(await readJson(request), actor);
      reply(201, { productId: product.id });
      return true;
    }

    const match = path.match(/^\/api\/pitch\/products\/([^/]+)(?:\/(archive|updates|links|files)(?:\/([^/]+)\/(delete))?)?$/);
    if (!match) {
      sendJson(response, 404, { error: "Невідомий маршрут «Смислів»." });
      return true;
    }
    const productId = decodeURIComponent(match[1]);
    const [, , part, itemId, del] = match;

    if (!part) await updatePitchProduct(productId, await readJson(request), actor);
    else if (part === "archive" && !itemId) await archivePitchProduct(productId, actor);
    else if (part === "updates" && !itemId) await addPitchUpdate(productId, await readJson(request), actor);
    else if (part === "updates" && del) await removePitchUpdate(productId, decodeURIComponent(itemId), actor);
    else if (part === "links" && !itemId) await addPitchLink(productId, await readJson(request), actor);
    else if (part === "links" && del) await removePitchLink(productId, decodeURIComponent(itemId), actor);
    else if (part === "files" && !itemId) {
      // Файл іде тілом запиту як є, ім'я — у заголовку (закодоване: українські літери).
      const bytes = await readRaw(request, PITCH_MAX_FILE_BYTES);
      await addPitchFile(productId, { name: request.headers["x-file-name"], type: request.headers["content-type"], bytes }, actor);
    } else if (part === "files" && del) await removePitchFile(productId, decodeURIComponent(itemId), actor);
    else {
      sendJson(response, 404, { error: "Невідомий маршрут «Смислів»." });
      return true;
    }
    reply();
    return true;
  } catch (error) {
    const status = Number(error?.statusCode || 0) || (error instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error("[pitch]", error);
    sendJson(response, status, { error: status >= 500 ? "Не вдалося зберегти. Спробуйте ще раз." : error.message });
    return true;
  }
}
