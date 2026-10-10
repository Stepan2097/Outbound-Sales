// /api/esp — the cold-email side of the workspace. ESP 1 answers two things:
// which connector this server runs with, and whether one mailbox can be acted
// as. Both are the administrator's: a seller has nothing to configure here.

import { handleEspDataApi } from "./data-api.mjs";
import { MailboxError } from "./gmail.mjs";
import { LetterError, assertPlainLetter, buildLetter, signatureText } from "./letter.mjs";
import { TEMPLATE_VARIABLES, TemplateError, prepareTemplate, renderTemplate } from "./template.mjs";
import { DEFAULT_SIGNATURE, prepareSignature } from "./templates.mjs";

export async function handleEspApi({ request, response, url, sendJson, readJson, esp }) {
  const path = url.pathname.replace(/^\/api\/esp/, "") || "/";
  const method = request.method;

  // ESP 9 — the journal, the registry and a person's mail timeline — is its own
  // module with its own rules about who may do what (a timeline is the whole
  // team's), so it answers first and the gate below is the mail connection's.
  const profile = request.auth?.profile;
  if (await handleEspDataApi({
    request, response, url, sendJson, readJson,
    actor: profile?.email || profile?.name || "", role: profile?.role || "seller"
  })) return true;

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

  // ── ESP 2: templates, the signature, and a preview of the letter ────────
  if (method === "GET" && path === "/templates") {
    sendJson(response, 200, {
      success: true,
      templates: esp.templates.list(),
      variables: Object.entries(TEMPLATE_VARIABLES).map(([name, label]) => ({ name, label })),
      signature: { ...DEFAULT_SIGNATURE, ...(esp.signature.read() || {}) }
    });
    return true;
  }

  if ((method === "POST" || method === "PATCH") && path === "/templates") {
    const body = await readJson(request);
    if (!body) return badRequest(sendJson, response, "Некоректне тіло JSON");
    try {
      const saved = method === "POST" ? await esp.templates.create(body) : await esp.templates.update(String(body.id || ""), body);
      if (!saved) {
        sendJson(response, 404, { success: false, error: "Такого шаблону немає." });
        return true;
      }
      // `removed` is what the cleaning took out — the screen says it, so
      // nobody wonders where their bold went.
      sendJson(response, method === "POST" ? 201 : 200, { success: true, ...saved, templates: esp.templates.list() });
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error;
      sendJson(response, 400, { success: false, error: error.message, code: error.code });
    }
    return true;
  }

  if (method === "DELETE" && path === "/templates") {
    const removed = await esp.templates.remove(String(url.searchParams.get("id") || ""));
    sendJson(response, removed ? 200 : 404, { success: removed, templates: esp.templates.list(), ...(removed ? {} : { error: "Такого шаблону немає." }) });
    return true;
  }

  if (method === "PUT" && path === "/signature") {
    const body = await readJson(request);
    if (!body) return badRequest(sendJson, response, "Некоректне тіло JSON");
    const signature = prepareSignature(body);
    await esp.signature.write(signature);
    sendJson(response, 200, { success: true, signature });
    return true;
  }

  /**
   * The letter one lead would get from one mailbox, built exactly as it would
   * be sent and checked the same way — but not sent. A template that cannot
   * be sent to this lead says why.
   */
  if (method === "POST" && path === "/preview") {
    const body = await readJson(request);
    if (!body) return badRequest(sendJson, response, "Некоректне тіло JSON");
    try {
      const template = body.templateId ? esp.templates.get(String(body.templateId)) : prepareTemplate({ subject: body.subject, body: body.body });
      if (!template) {
        sendJson(response, 404, { success: false, error: "Такого шаблону немає." });
        return true;
      }
      const lead = body.lead || {};
      const sender = { ...DEFAULT_SIGNATURE, ...(esp.signature.read() || {}), ...(body.sender || {}) };
      const rendered = renderTemplate(template, lead, sender);
      if (!rendered.ok) {
        sendJson(response, 200, { success: true, ok: false, reason: rendered.reason, variables: rendered.variables, error: rendered.message });
        return true;
      }
      const signature = signatureText(sender, { country: lead.country });
      const mailbox = String(body.mailbox || "sender@example.com");
      const raw = buildLetter({
        from: { email: mailbox, name: sender.name },
        to: { email: String(lead.email || "lead@example.com"), name: lead.name || "" },
        subject: rendered.subject,
        body: rendered.body,
        signature
      });
      assertPlainLetter(raw);
      sendJson(response, 200, {
        success: true,
        ok: true,
        subject: rendered.subject,
        text: [rendered.body, signature].join("\n\n"),
        headers: raw.slice(0, raw.indexOf("\r\n\r\n")).split("\r\n").filter((line) => !line.startsWith(" ")).map((line) => line.split(":")[0]),
        contentType: "text/plain; charset=UTF-8",
        bytes: Buffer.byteLength(raw)
      });
    } catch (error) {
      if (!(error instanceof TemplateError) && !(error instanceof LetterError)) throw error;
      sendJson(response, 200, { success: true, ok: false, reason: error.code, error: error.message });
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

function badRequest(sendJson, response, error) {
  sendJson(response, 400, { success: false, error });
  return true;
}
