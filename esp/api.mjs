// /api/esp — the cold-email side of the workspace. ESP 1 answers two things:
// which connector this server runs with, and whether one mailbox can be acted
// as. Both are the administrator's: a seller has nothing to configure here.

import { can, logAdminAction } from "./access.mjs";
import { SKIP_REASON_LABEL, defaultFilters, exclusions, refusedAtEnrolment } from "./filters.mjs";
import { erasePerson, exportPerson } from "./erasure.mjs";
import { campaignReport, senderDailyReport, toCsv } from "./reports.mjs";
import { dueForRetention, retentionDays, runRetention } from "./retention.mjs";
import { handleEspDataApi } from "./data-api.mjs";
import { MailboxError } from "./provider.mjs";
import { CampaignError, parseLeadLines } from "./campaigns.mjs";
import { composeLetter } from "./compose.mjs";
import { ReplyError, conversations, quickReply } from "./conversations.mjs";
import { REPLY_LABELS } from "./replies.mjs";
import { recordFailed, recordSending, recordSent } from "./messages.mjs";
import { allEntries, append } from "./journal.mjs";
import { applyRampReviews, reviewRamp } from "./ramp.mjs";
import { DOMAIN_DAILY_LIMIT, GAP_MINUTES, WINDOW, sendLedger, senderDailyLimit } from "./limits.mjs";
import { registry, updateSender } from "./registry.mjs";
import { LetterError, assertPlainLetter } from "./letter.mjs";
import { TEMPLATE_VARIABLES, TemplateError, prepareTemplate } from "./template.mjs";
import { DEFAULT_SIGNATURE, prepareSignature } from "./templates.mjs";

/**
 * The right each part of the mail set-up needs (ESP 10, esp/access.mjs). Seeing
 * campaigns, limits and whether everything is stopped is the team's; starting,
 * pausing and filling a campaign is `campaigns.launch`, «стоп усе» is
 * `stop.all`, templates and the signature are `templates.edit`, lifting a
 * mailbox pause is a limit, and the connection itself is the registry's.
 */
export function espRouteRight(method, path) {
  if (path === "/halt") return method === "GET" ? "replies.read" : "stop.all";
  if (path === "/limits" || path === "/ramp" || (method === "GET" && (path.startsWith("/campaigns") || path === "/inbox" || path === "/alerts" || path === "/conversations"))) return "replies.read";
  // ESP 14: answering a lead and correcting a reply's label are the inbox's work.
  if (path === "/conversations/reply" || path === "/conversations/label") return "replies.write";
  // ESP 17: what we hold about a person is the journal's to read; forgetting
  // them for good is an administrator's alone.
  if (path === "/people/export") return "journal.read";
  if (path === "/people/erase") return "access.manage";
  // ESP 8: running the alarm check now.
  if (path === "/alerts/check") return "limits.change";
  // ESP 7: reading the mailboxes now, rather than waiting five minutes.
  if (path === "/inbox/poll") return "limits.change";
  // ESP 13: stepping a sender's ramp up (or holding it) is a limit.
  if (path.startsWith("/ramp/")) return "limits.change";
  // ESP 16: the reports are the team's to read; anonymising old leads is an administrator's.
  if (path.startsWith("/reports")) return "replies.read";
  if (path === "/retention") return method === "GET" ? "replies.read" : "access.manage";
  if (path === "/retention/run") return "access.manage";
  // ESP 15: running the DNS and blocklist watch now — the registry's.
  if (path === "/monitor/run") return "registry.change";
  if (path.startsWith("/campaigns")) return "campaigns.launch";
  if (path === "/templates" || path === "/signature" || path === "/preview") return "templates.edit";
  if (path.startsWith("/senders/")) return "limits.change";
  return "registry.change";
}

export async function handleEspApi({ request, response, url, sendJson, readJson, esp }) {
  const path = url.pathname.replace(/^\/api\/esp/, "") || "/";
  const method = request.method;

  // ESP 9 — the journal, the registry and a person's mail timeline — is its own
  // module with its own rules about who may do what (a timeline is the whole
  // team's), so it answers first and the gate below is the mail connection's.
  const profile = request.auth?.profile;
  if (await handleEspDataApi({ request, response, url, sendJson, readJson, profile })) return true;

  // ESP 10: each part of the mail set-up needs its own right (esp/access.mjs) —
  // templates and the signature are `templates.edit`, lifting a mailbox pause is
  // a limit, the connection itself is the registry's. By default all three are
  // an administrator's, as before; an administrator may hand one to a seller.
  const need = espRouteRight(method, path);
  if (!await can(profile, need)) {
    sendJson(response, 403, { success: false, error: "Пошту для розсилки налаштовує адміністратор робочого простору." });
    return true;
  }
  // What an administrator changes here goes into the administrators' log.
  const actor = profile?.email || profile?.name || "";
  const logged = (action, data) => logAdminAction(action, actor, data).catch((error) => console.warn(`[esp] admin log: ${error.message}`));

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
      if (resumed) await logged("mailbox_resumed", { mailbox: String(body.mailbox) });
      sendJson(response, 200, { success: true, resumed, paused: await esp.gate.paused() });
    } catch (error) {
      if (!(error instanceof MailboxError)) throw error;
      sendJson(response, 400, { success: false, error: error.message });
    }
    return true;
  }

  // ── ESP 16: reports (no opens, no clicks — there are none) and retention ─
  if (method === "GET" && (path === "/reports/senders" || path === "/reports/campaigns")) {
    const entries = await allEntries();
    const csv = url.searchParams.get("format") === "csv";
    if (path === "/reports/senders") {
      const report = senderDailyReport(entries, { from: url.searchParams.get("from") || "", to: url.searchParams.get("to") || "" });
      if (csv) {
        const which = url.searchParams.get("by") === "domain" ? "domains" : "senders";
        const columns = [which === "domains" ? "domain" : "sender", "day", "sent", "firsts", "followups", "bounces", "bounceRate", "bounceCodes", "replies", "positive", "autoreplies", "unsubscribes"];
        return sendCsv(response, `esp-${which}.csv`, toCsv(report[which], ["day", ...columns.filter((column) => column !== "day")])), true;
      }
      sendJson(response, 200, { success: true, ...report });
      return true;
    }
    const sources = new Map(esp.campaigns.enrollments().map((row) => [`${row.campaignId}|${row.email}`, row.lead?.source || ""]));
    const report = campaignReport(entries, { campaigns: esp.campaigns.list(), sourceOf: (campaignId, email) => sources.get(`${campaignId}|${email}`) || "" });
    if (csv) {
      const rows = report.flatMap((campaign) => campaign.steps.map((step) => ({ campaign: campaign.name, step: step.step, sent: step.sent, replied: step.replied, positive: step.positive, shareOfReplies: step.shareOfReplies, replyRate: step.replyRate })));
      return sendCsv(response, "esp-campaign-steps.csv", toCsv(rows, ["campaign", "step", "sent", "replied", "positive", "shareOfReplies", "replyRate"])), true;
    }
    sendJson(response, 200, { success: true, campaigns: report });
    return true;
  }

  if (method === "GET" && path === "/retention") {
    const days = retentionDays();
    const due = dueForRetention(esp.campaigns.enrollments(), { days });
    const last = (await allEntries()).filter((entry) => entry.type === "retention.anonymized").at(-1);
    sendJson(response, 200, { success: true, days, due: due.length, last: last ? { at: last.at, count: last.data?.count ?? 0 } : null, canRun: await can(profile, "access.manage") });
    return true;
  }

  if (method === "POST" && path === "/retention/run") {
    const result = await runRetention({ campaigns: esp.campaigns, force: true, actor });
    await logged("retention_run", { anonymized: result.anonymized, days: result.days });
    sendJson(response, 200, { success: true, ...result });
    return true;
  }

  // ── ESP 15: run the daily watch now (DNS, blocklists), not tomorrow ─────
  if (method === "POST" && path === "/monitor/run") {
    if (!esp.runMonitor) return badRequest(sendJson, response, "Моніторинг на цьому сервері не підключено.");
    const result = await esp.runMonitor({ force: true });
    await logged("monitor_run", { domains: result.domains.length, alarms: result.actions.length });
    sendJson(response, 200, { success: true, ...result });
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
    await logged(on ? "halt_on" : "halt_off", { reason: halt.reason });
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
      await logged(method === "POST" ? "campaign_created" : "campaign_updated", { id: campaign?.id ?? null, name: campaign?.name ?? null });
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
      const changed = await esp.campaigns.setState(String(body.id || ""), String(body.state || ""));
      await logged("campaign_state", { id: String(body.id || ""), status: String(body.state || "") });
      sendJson(response, 200, { success: true, campaign: changed });
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
    // ESP 6: every person through the same checks the chain runs before each
    // letter — exclusions (unsubscribes, hard bounces, «ні», complaints, clients,
    // partners), the 90-day rule (ESP 13), source, country, role addresses,
    // Apple mail, verification and Google MX. Checked here first, because the
    // checks wait on DNS and enrolment does not.
    const { leads, rejected } = parseLeadLines(body.text);
    const filters = esp.filters || defaultFilters();
    const context = await filters.context(await allEntries(), new Date());
    const verdicts = new Map();
    for (const lead of leads) verdicts.set(lead.email, await filters.check(lead, context));
    // Enrolled, but not going until the data is fixed: no source, no or stale
    // verification, unknown country. Said now, so nobody waits for nothing.
    const waiting = [...verdicts.entries()].filter(([, verdict]) => !verdict.ok && !refusedAtEnrolment(verdict))
      .map(([email, verdict]) => ({ email, reason: verdict.reason, label: SKIP_REASON_LABEL[verdict.reason] || verdict.reason, detail: verdict.detail, needsRecheck: verdict.needsRecheck }));
    try {
      const result = await esp.campaigns.enroll(String(body.id || ""), leads, { blocked: (email) => (refusedAtEnrolment(verdicts.get(email)) ? verdicts.get(email).reason : null) });
      await logged("campaign_leads_added", { id: String(body.id || ""), added: result.added.length });
      sendJson(response, 200, {
        success: true, added: result.added.length, skipped: result.skipped, rejected, waiting,
        labels: Object.fromEntries(result.skipped.map((row) => [row.email, SKIP_REASON_LABEL[row.reason] || row.reason]))
      });
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
      sender: row.sender, step: row.step, status: row.status, reason: row.reason || null, recheck: row.recheck || null, nextDueDate: row.nextDueDate, lastSentAt: row.lastSent?.at || null
    })) });
    return true;
  }

  // What would go out if the chain ran this minute — the same checks, no send.
  if (method === "GET" && path === "/campaigns/plan") {
    const plan = await esp.tick({ dryRun: true });
    sendJson(response, 200, { success: true, sequenceOn: Boolean(esp.sequenceOn), ...plan });
    return true;
  }

  // ── ESP 14: the team's inbox for cold email ────────────────────────────
  if (method === "GET" && path === "/conversations") {
    const label = String(url.searchParams.get("label") || "");
    const sender = String(url.searchParams.get("sender") || "").toLowerCase();
    const campaign = String(url.searchParams.get("campaign") || "");
    const query = String(url.searchParams.get("q") || "").toLowerCase();
    const names = new Map((esp.campaigns?.list() || []).map((row) => [row.id, row.name]));
    const list = conversations(await allEntries()).filter((row) =>
      (!label || row.label === label) && (!sender || row.sender === sender) && (!campaign || row.campaignId === campaign)
      && (!query || row.contact.includes(query) || row.messages.some((message) => String(message.text || "").toLowerCase().includes(query))));
    sendJson(response, 200, {
      success: true,
      labels: REPLY_LABELS,
      conversations: list.slice(0, 200).map((row) => ({ ...row, campaignName: names.get(row.campaignId) || null })),
      liveSend: Boolean(esp.connector?.describe().liveSend),
      mode: esp.connector?.describe().mode || "stub",
      replyOnStub: Boolean(esp.sequenceOn)
    });
    return true;
  }

  /**
   * ESP 17: a person asks what we hold about them — where the address came
   * from, every letter as sent, what came back — and may ask to be forgotten.
   */
  if (method === "GET" && path === "/people/export") {
    const email = url.searchParams.get("email") || "";
    const entries = await allEntries();
    const report = exportPerson(email, { entries, enrollments: esp.campaigns?.enrollments() || [], campaigns: esp.campaigns?.list() || [], exclusions: await exclusions(entries) });
    sendJson(response, 200, { success: true, person: report });
    return true;
  }

  if (method === "POST" && path === "/people/erase") {
    const body = await readJson(request);
    const email = String(body?.email || "").trim().toLowerCase();
    // Irreversible: the address typed a second time, the same.
    if (!email || email !== String(body?.confirm || "").trim().toLowerCase()) return badRequest(sendJson, response, "Для видалення введіть адресу ще раз — так само.");
    const result = await erasePerson(email, { campaigns: esp.campaigns, actor, note: String(body?.note || "") });
    await logged("person_erased", { journalLines: result.journalLines, campaignRows: result.campaignRows });
    sendJson(response, 200, { success: true, erased: result });
    return true;
  }

  if (method === "POST" && path === "/conversations/label") {
    const body = await readJson(request);
    if (!body?.gmailId || !REPLY_LABELS[body.label]) return badRequest(sendJson, response, `Мітка — одна з: ${Object.keys(REPLY_LABELS).join(", ")}.`);
    // A correction is its own entry: the rule's first label stays on record.
    await append({ type: "reply.labelled", actor, data: { gmailId: String(body.gmailId), label: body.label } });
    sendJson(response, 200, { success: true });
    return true;
  }

  /**
   * A quick reply from the conversation's own sender, in its thread. Through
   * the gate like every letter — so until ESP 11 it is refused, and says so.
   */
  if (method === "POST" && path === "/conversations/reply") {
    const body = await readJson(request);
    if (!body?.key || !body.text) return badRequest(sendJson, response, "Яка розмова і що відповісти?");
    // On the stub nothing reaches anybody: journalling "sent" for it would put
    // a letter in the timeline that never left. Only the acceptance cycle
    // (ESP 11, ESP_SEQUENCE=on) answers through the stub on purpose.
    if (esp.connector?.kind === "stub" && !esp.sequenceOn) {
      sendJson(response, 409, { success: false, code: "not_connected", error: "Пошту ще не підключено (працює заглушка) — відповідь нікуди б не пішла, тож її не надіслано й не записано." });
      return true;
    }
    const conversation = conversations(await allEntries()).find((row) => row.key === String(body.key));
    if (!conversation) {
      sendJson(response, 404, { success: false, error: "Такої розмови немає." });
      return true;
    }
    const lead = (esp.campaigns?.enrollments() || []).find((row) => row.email === conversation.contact)?.lead || {};
    let letter;
    try {
      letter = quickReply(conversation, body.text, { ...DEFAULT_SIGNATURE, ...(esp.signature.read() || {}) }, { lead });
    } catch (error) {
      if (!(error instanceof ReplyError) && !(error instanceof LetterError)) throw error;
      sendJson(response, 400, { success: false, error: error.message, code: error.code });
      return true;
    }
    let sending;
    try {
      sending = await recordSending({ from: conversation.sender, to: conversation.contact, subject: letter.subject, text: letter.text, headers: { "Message-ID": letter.messageId, "In-Reply-To": conversation.messages.map((message) => message.messageId).filter(Boolean).at(-1) }, campaignId: conversation.campaignId, step: null }, actor);
    } catch (error) {
      sendJson(response, 409, { success: false, error: error.message, code: "sender_unavailable" });
      return true;
    }
    try {
      const sent = await esp.gate.send(conversation.sender, letter.raw, { threadId: conversation.threadId });
      await recordSent(sending, { messageId: sent.id, threadId: sent.threadId }, actor);
      logged("esp.reply.sent", { sender: conversation.sender, contact: conversation.contact });
      sendJson(response, 200, { success: true, sent: true, stub: Boolean(sent.stub) });
    } catch (error) {
      await recordFailed(sending, { error: error.message }, actor);
      sendJson(response, 409, { success: false, error: error.message, code: error.code || "send_failed" });
    }
    return true;
  }

  if (method === "POST" && path === "/campaigns/people/resume") {
    const body = await readJson(request);
    if (!body) return badRequest(sendJson, response, "Некоректне тіло JSON");
    try {
      const person = await esp.campaigns.resumePerson(String(body.id || ""), String(body.email || ""));
      logged("esp.campaign.person.resumed", { campaignId: body.id, email: person.email });
      sendJson(response, 200, { success: true, person });
    } catch (error) {
      if (!(error instanceof CampaignError)) throw error;
      sendJson(response, error.status, { success: false, error: error.message, code: error.code });
    }
    return true;
  }

  // ── ESP 8: the automatic pauses and the alarms ─────────────────────────
  if (method === "GET" && path === "/alerts") {
    const weekAgo = Date.now() - 7 * 86_400_000;
    const alerts = (await allEntries()).filter((entry) => entry.type === "esp.alert" && new Date(entry.at).getTime() >= weekAgo)
      .reverse().map((entry) => ({ at: entry.at, ...entry.data }));
    sendJson(response, 200, { success: true, alerts, telegram: Boolean(esp.alertsTelegram) });
    return true;
  }

  if (method === "POST" && path === "/alerts/check") {
    const raised = await esp.checkAlerts();
    if (raised.length) logged("esp.alerts.checked", { raised: raised.map((row) => row.key) });
    sendJson(response, 200, { success: true, raised });
    return true;
  }

  // ── ESP 7: what came into the sending mailboxes ───────────────────────
  if (method === "GET" && path === "/inbox") {
    const kinds = new Set(["message.replied", "message.autoreplied", "message.bounced", "contact.unsubscribed", "sender.alert"]);
    const events = (await allEntries()).filter((entry) => kinds.has(entry.type)).slice(-100).reverse().map((entry) => ({
      at: entry.at, type: entry.type, contact: entry.contact || entry.data?.contact || null,
      sender: entry.data?.sender || entry.data?.email || null, code: entry.data?.code || null, via: entry.data?.via || null,
      returnDate: entry.data?.returnDate || null, subject: entry.data?.subject || null,
      text: entry.data?.text ? String(entry.data.text).slice(0, 300) : null, campaignId: entry.data?.campaignId || null
    }));
    sendJson(response, 200, { success: true, events, polling: Boolean(esp.sequenceOn) });
    return true;
  }

  if (method === "POST" && path === "/inbox/poll") {
    const summary = await esp.pollInbox();
    sendJson(response, 200, { success: true, ...summary });
    return true;
  }

  // ── ESP 13: the ramp, reviewed on a clean week ─────────────────────────
  if (method === "GET" && path === "/ramp") {
    const now = new Date();
    const [{ senders }, entries] = await Promise.all([registry(), allEntries()]);
    sendJson(response, 200, { success: true, reviews: senders.filter((sender) => sender.effectiveStatus === "active").map((sender) => reviewRamp(sender, entries, { now })) });
    return true;
  }

  if (method === "POST" && path === "/ramp/review") {
    const [{ senders }, entries] = await Promise.all([registry(), allEntries()]);
    const results = await applyRampReviews({ senders, entries, updateSender, append, actor });
    if (results.length) logged("esp.ramp.reviewed", { results: results.map((row) => ({ email: row.email, action: row.action, stage: row.stage, reasons: row.reasons })) });
    sendJson(response, 200, { success: true, results });
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
      await logged(method === "POST" ? "template_created" : "template_updated", { id: saved.template?.id ?? saved.id ?? body.id ?? null, name: saved.template?.name ?? body.name ?? null });
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
    if (removed) await logged("template_removed", { id: String(url.searchParams.get("id") || "") });
    sendJson(response, removed ? 200 : 404, { success: removed, templates: esp.templates.list(), ...(removed ? {} : { error: "Такого шаблону немає." }) });
    return true;
  }

  if (method === "PUT" && path === "/signature") {
    const body = await readJson(request);
    if (!body) return badRequest(sendJson, response, "Некоректне тіло JSON");
    const signature = prepareSignature(body);
    await esp.signature.write(signature);
    await logged("signature_changed", { fields: Object.keys(signature) });
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
        // ESP 12: which sentence variants this person gets, and whether the
        // EU/UK notice is under the signature (and which version).
        variantIds: letter.variantIds,
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

/** A report as a file to save. */
function sendCsv(response, filename, body) {
  response.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" });
  response.end(`\uFEFF${body}`);
}
