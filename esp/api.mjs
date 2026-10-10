// /api/esp — the cold-email side of the workspace. ESP 1 answers two things:
// which connector this server runs with, and whether one mailbox can be acted
// as. Both are the administrator's: a seller has nothing to configure here.

import { MailboxError } from "./gmail.mjs";

export async function handleEspApi({ request, response, url, sendJson, readJson, esp }) {
  const path = url.pathname.replace(/^\/api\/esp/, "") || "/";
  const method = request.method;

  if (request.auth?.profile?.role !== "admin") {
    sendJson(response, 403, { success: false, error: "Пошту для розсилки налаштовує адміністратор робочого простору." });
    return true;
  }

  if (method === "GET" && path === "/connection") {
    sendJson(response, 200, {
      success: true,
      ...esp.connector.describe(),
      // A key that was given and does not parse is said as such; the stub runs
      // meanwhile, and the screen must not read as "no key yet".
      keyError: esp.keyError || null
    });
    return true;
  }

  // Mailboxes on pause after Google refused to let us act as them (ESP 1):
  // the banner on the screen, and the one way to lift it.
  if (method === "GET" && path === "/senders/paused") {
    sendJson(response, 200, { success: true, paused: await esp.gate.paused() });
    return true;
  }

  if (method === "POST" && path === "/senders/resume") {
    const body = await readJson(request);
    if (!body?.mailbox) {
      sendJson(response, 400, { success: false, error: "Яку скриньку знімати з паузи?" });
      return true;
    }
    try {
      const resumed = await esp.gate.resume(body.mailbox);
      sendJson(response, 200, { success: true, resumed, paused: await esp.gate.paused() });
    } catch (error) {
      if (!(error instanceof MailboxError)) throw error;
      sendJson(response, 400, { success: false, error: error.message });
    }
    return true;
  }

  if (method === "POST" && path === "/mailboxes/check") {
    const body = await readJson(request);
    if (!body) {
      sendJson(response, 400, { success: false, error: "Некоректне тіло JSON" });
      return true;
    }
    try {
      const result = await esp.connector.checkMailbox(body.mailbox);
      sendJson(response, 200, { success: true, ...result });
    } catch (error) {
      if (!(error instanceof MailboxError)) throw error;
      // 200 with `ok: false`: a mailbox Google will not hand over is an answer
      // to the question asked, not a failure of the request.
      sendJson(response, 200, { success: true, ok: false, mailbox: String(body.mailbox ?? ""), code: error.code, error: error.message, detail: error.detail });
    }
    return true;
  }

  return false;
}
