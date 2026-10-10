// /api/esp — the cold-email side of the workspace. ESP 1 answers two things:
// which connector this server runs with, and whether one mailbox can be acted
// as. Both are the administrator's: a seller has nothing to configure here.

import { handleEspDataApi } from "./data-api.mjs";
import { MailboxError } from "./gmail.mjs";
import { CampaignError, parseLeadLines } from "./campaigns.mjs";
import { composeLetter } from "./compose.mjs";
import { allEntries } from "./journal.mjs";
import { DOMAIN_DAILY_LIMIT, GAP_MINUTES, WINDOW, sendLedger, senderDailyLimit } from "./limits.mjs";
import { registry } from "./registry.mjs";
import { LetterError, assertPlainLetter } from "./letter.mjs";
import { TEMPLATE_VARIABLES, TemplateError, prepareTemplate } from "./template.mjs";
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
      keyError: esp.keyError || null,
      // ESP 3: without ESP_UNSUBSCRIBE_SECRET the links are signed with a key
      // that dies with this process — every link sent before a restart would
      // stop working. The screen says so; ESP 11 does not pass with it.
      unsubscribe: { configured: !esp.unsubscribe?.ephemeral }
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

  // ── ESP 5: «стоп усе», campaigns, their people, and what goes now ───────
  if (method === "GET" && path === "/halt") {
    sendJson(response, 200, { success: true, halt: esp.halt.read(), sequenceOn: Boolean(esp.sequenceOn) });
    return true;
  }

  if (method === "POST" && path === "/halt") {
    const body = await readJson(request);
    if (!body) return badRequest(sendJson, response, "Некоректне тіло JSON");
    const on = body.on === true;
    const reason = String(body.reason ?? "").trim().slice(0, 300);
    if (on && !reason) return badRequest(sendJson, response, "Скажіть, чому зупиняєте все: причина лишається в стані.");
    const halt = { on, at: new Date().toISOString(), by: profile?.email || profile?.name || "", reason: on ? reason : "" };
    // Written before answering: the gate reads it before every letter, so the
    // stop is in force the moment this returns.
    await esp.halt.write(halt);
    sendJson(response, 200, { success: true, halt });
    return true;
  }

  if (method === "GET" && path === "/campaigns") {
    const entries = await allEntries();
    sendJson(response, 200, { success: true, campaigns: esp.campaigns.list().map((campaign) => campaignSummary(campaign, esp.campaigns.enrollmentsOf(campaign.id), entries)) });
    return true;
  }

  if ((method === "POST" || method === "PATCH") && path === "/campaigns") {
    const body = await readJson(request);
    if (!body) return badRequest(sendJson, response, "Некоректне тіло JSON");
    try {
      const campaign = method === "POST" ? await esp.campaigns.create(body) : await esp.campaigns.update(String(body.id || ""), body);
      sendJson(response, method === "POST" ? 201 : 200, { success: true, campaign });
    } catch (error) {
      if (!(error instanceof CampaignError)) throw error;
      sendJson(response, error.status, { success: false, error: error.message, code: error.code });
    }
    return true;
  }

  if (method === "POST" && path === "/campaigns/state") {
    const body = await readJson(request);
    if (!body) return badRequest(sendJson, response, "Некоректне тіло JSON");
    try {
      const campaign = esp.campaigns.find(String(body.id || ""));
      if (body.state === "running" && campaign && !esp.campaigns.enrollmentsOf(campaign.id).length) {
        throw new CampaignError("У кампанії ще нікого немає — додайте людей, перш ніж запускати.", { code: "empty", status: 409 });
      }
      sendJson(response, 200, { success: true, campaign: await esp.campaigns.setState(String(body.id || ""), String(body.state || "")) });
    } catch (error) {
      if (!(error instanceof CampaignError)) throw error;
      sendJson(response, error.status, { success: false, error: error.message, code: error.code });
    }
    return true;
  }

  /**
   * People into a campaign: lines «email, ім'я, компанія, країна[, пояс]».
   * Somebody who once unsubscribed or whose address bounced is not added —
   * the full pre-send checks are ESP 6, this is the floor under them.
   */
  if (method === "POST" && path === "/campaigns/leads") {
    const body = await readJson(request);
    if (!body) return badRequest(sendJson, response, "Некоректне тіло JSON");
    const entries = await allEntries();
    const gone = new Map();
    for (const entry of entries) {
      if (entry.type === "contact.unsubscribed") gone.set(entry.contact, "unsubscribed");
      else if (entry.type === "message.bounced" && /^5\./.test(String(entry.data?.code || ""))) gone.set(entry.contact, "bounced");
    }
    const { leads, rejected } = parseLeadLines(body.text);
    try {
      const result = await esp.campaigns.enroll(String(body.id || ""), leads, { blocked: (email) => gone.get(email) || null });
      sendJson(response, 200, { success: true, added: result.added.length, skipped: result.skipped, rejected });
    } catch (error) {
      if (!(error instanceof CampaignError)) throw error;
      sendJson(response, error.status, { success: false, error: error.message, code: error.code });
    }
    return true;
  }

  if (method === "GET" && path === "/campaigns/people") {
    const id = String(url.searchParams.get("id") || "");
    sendJson(response, 200, { success: true, people: esp.campaigns.enrollmentsOf(id).map((row) => ({
      email: row.email, name: row.lead?.name || "", company: row.lead?.company || "", country: row.lead?.country || "",
      sender: row.sender, step: row.step, status: row.status, reason: row.reason || null, nextDueDate: row.nextDueDate, lastSentAt: row.lastSent?.at || null
    })) });
    return true;
  }

  // What would go out if the chain ran this minute — the same checks, no send.
  if (method === "GET" && path === "/campaigns/plan") {
    const plan = await esp.tick({ dryRun: true });
    sendJson(response, 200, { success: true, sequenceOn: Boolean(esp.sequenceOn), ...plan });
    return true;
  }

  // ── ESP 4: what each sender and domain has sent today, against its limit ─
  if (method === "GET" && path === "/limits") {
    const now = new Date();
    const [{ senders, domains }, entries] = await Promise.all([registry(), allEntries()]);
    const ledger = sendLedger(entries, { now });
    sendJson(response, 200, {
      success: true,
      day: ledger.today,
      window: { ...WINDOW, days: "Пн–Пт", zone: "одержувача" },
      gapMinutes: GAP_MINUTES,
      domainLimit: DOMAIN_DAILY_LIMIT,
      senders: senders.map((sender) => {
        const row = ledger.senders.get(sender.email) || { today: 0, lastAt: null };
        return {
          email: sender.email, domain: sender.domain, status: sender.effectiveStatus, rampStage: sender.rampStage,
          limit: senderDailyLimit(sender), today: row.today, lastAt: row.lastAt ? row.lastAt.toISOString() : null
        };
      }),
      domains: domains.map((domain) => ({ domain: domain.domain, status: domain.status, today: ledger.domains.get(domain.domain) || 0, limit: DOMAIN_DAILY_LIMIT }))
    });
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
      const lead = { email: "lead@example.com", ...(body.lead || {}) };
      const mailbox = String(body.mailbox || "sender@example.com");
      const sender = { ...DEFAULT_SIGNATURE, ...(esp.signature.read() || {}), ...(body.sender || {}), email: mailbox };
      // Built exactly as a first letter of a sequence is (esp/compose.mjs),
      // with its unsubscribe headers — and not sent.
      const letter = composeLetter({ template, sender, lead, unsubscribe: esp.unsubscribe });
      if (!letter.ok) {
        sendJson(response, 200, { success: true, ok: false, reason: letter.reason, variables: letter.variables, error: letter.message });
        return true;
      }
      assertPlainLetter(letter.raw);
      const head = letter.raw.slice(0, letter.raw.indexOf("\r\n\r\n")).replace(/\r\n /g, " ").split("\r\n");
      const header = (name) => (head.find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`)) || "").slice(name.length + 1).trim();
      sendJson(response, 200, {
        success: true,
        ok: true,
        subject: letter.subject,
        text: letter.text,
        headers: head.map((line) => line.split(":")[0]),
        listUnsubscribe: header("List-Unsubscribe"),
        listUnsubscribePost: header("List-Unsubscribe-Post"),
        contentType: "text/plain; charset=UTF-8",
        bytes: Buffer.byteLength(letter.raw)
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

/**
 * A campaign as the list shows it: how many people, where they are, and what
 * the journal says came of it. No opens, no clicks — nothing here tracks them.
 */
function campaignSummary(campaign, enrollments, entries) {
  const people = new Map(enrollments.map((row) => [row.email, row]));
  const counts = { sent: 0, replied: 0, bounced: 0, unsubscribed: 0 };
  for (const entry of entries) {
    if (entry.type === "message.sent" && entry.data?.campaignId === campaign.id) counts.sent += 1;
    const row = entry.contact ? people.get(entry.contact) : null;
    if (!row || new Date(entry.at) < new Date(row.enrolledAt)) continue;
    if (entry.type === "message.replied") counts.replied += 1;
    else if (entry.type === "message.bounced") counts.bounced += 1;
    else if (entry.type === "contact.unsubscribed") counts.unsubscribed += 1;
  }
  const byStatus = {};
  for (const row of enrollments) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  return { ...campaign, people: enrollments.length, byStatus, ...counts };
}
