// ESP 5 — the chain: one tick walks the running campaigns and sends what is
// due, through every check there is, and never the same letter twice.
//
// Checklist (P0):
// - «Ідемпотентність — ключ на "лід + крок". Повтор після збою чи таймауту API
//   не дає другого листа.»
// - «Один лід — один сендер — весь ланцюжок з однієї скриньки.»
// - «Розклад кампанії в робочих днях — лист 1 — день 0, лист 2 — +3, лист 3 —
//   +4 робочі дні. Налаштовується на кампанію.»
// - «Кнопка "стоп усе" і пауза на кожному рівні — сендер, домен, кампанія, вся
//   система.»
//
// The order of checks for one person, cheapest and most final first:
//   the system stop → the campaign's state → a reply, bounce or unsubscribe
//   since they joined (the chain stops) → the sender and its domain in the
//   registry (ESP 9) and the gate's pauses (ESP 1) → the limits and the
//   recipient's window (ESP 4) → the journal for this campaign + person +
//   step (the idempotency key) → the letter (ESP 2/3) → the send.
//
// The idempotency key is looked up in the journal, not in memory: a letter is
// written down as `message.sending` before Google is asked, so after a crash,
// a restart or a timeout the next tick finds it. Sent — the enrolment is
// repaired from the journal and nothing goes out. Refused by Gmail with an
// answer — it did not go, and may be tried again. No answer at all — nobody
// knows; the person is set aside as `uncertain` for a human to check in the
// mailbox's Sent folder. It is never retried on its own: a duplicate is worse
// than a missing follow-up.

import { CampaignError } from "./campaigns.mjs";
import { composeLetter } from "./compose.mjs";
import { MailboxError, SendingLocked } from "./gmail.mjs";
import { LetterError } from "./letter.mjs";
import { COUNTING_ZONE, localTime, sendDecision, sendLedger, zonesFor } from "./limits.mjs";
import { SenderPaused, SendingHalted } from "./senders.mjs";
import { companyKey } from "./company.mjs";

export { SendingHalted };

// What stops a person's chain, from the journal: they answered, the address
// bounced, or they asked to be left alone.
const STOPPERS = { "message.replied": "replied", "message.bounced": "bounced", "contact.unsubscribed": "unsubscribed" };

/** A date `days` working days (Mon–Fri) after `date` (YYYY-MM-DD). */
export function addWorkingDays(date, days) {
  const at = new Date(`${date}T12:00:00Z`);
  let left = days;
  while (left > 0) {
    at.setUTCDate(at.getUTCDate() + 1);
    const weekday = at.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return at.toISOString().slice(0, 10);
}

/** The recipient's today: their first zone's date, or ours when they have none. */
function recipientToday(lead, now) {
  return localTime(now, zonesFor(lead)[0] || COUNTING_ZONE).date;
}

function stopperFor(entries, enrollment) {
  const since = new Date(enrollment.enrolledAt).getTime();
  for (const entry of entries) {
    const reason = STOPPERS[entry.type];
    // A 4.x.x is a delay, counted apart (ESP 7) — only a permanent bounce ends the chain.
    if (entry.type === "message.bounced" && !/^5\./.test(String(entry.data?.code || ""))) continue;
    if (reason && entry.contact === enrollment.email && new Date(entry.at).getTime() >= since) return reason;
  }
  return null;
}

/** The journal's word on campaign + person + step: none, sent, failed or in flight. */
export function attemptOf(entries, { campaignId, email, step }) {
  const attempts = entries.filter((entry) => entry.type === "message.sending" && entry.contact === email
    && entry.data?.campaignId === campaignId && entry.data?.step === step);
  if (!attempts.length) return { state: "none" };
  const outcomes = new Map();
  for (const entry of entries) {
    if ((entry.type === "message.sent" || entry.type === "message.failed") && entry.data?.sendingSeq != null) outcomes.set(entry.data.sendingSeq, entry);
  }
  // Any attempt that went is the answer, whatever came after it.
  const sent = attempts.find((attempt) => outcomes.get(attempt.seq)?.type === "message.sent");
  if (sent) return { state: "sent", sending: sent, sent: outcomes.get(sent.seq) };
  const open = attempts.find((attempt) => !outcomes.has(attempt.seq));
  if (open) return { state: "in_flight", sending: open };
  return { state: "failed" };
}

function advance(enrollment, campaign, { messageId, threadId, subject, references, at }, today) {
  const next = enrollment.step + 1;
  const done = next >= campaign.steps.length;
  return {
    ...enrollment,
    // ESP 13: when this person first heard from us — what «new contacts from
    // one company today» counts.
    ...(enrollment.step === 0 ? { firstSentAt: at } : {}),
    step: next,
    status: done ? "done" : "active",
    lastSent: { messageId, threadId: threadId || null, subject, references: references || [], at },
    nextDueDate: done ? null : addWorkingDays(today, campaign.steps[next].delayDays),
    ...(done ? { finishedAt: at } : {})
  };
}

/**
 * One pass over the running campaigns.
 *
 * `deps`:
 * - `campaigns` — the store (esp/campaigns.mjs); `templates` — the template store
 * - `journal` — { allEntries, recordSending, recordSent, recordFailed, recordAboutContact }
 * - `registry` — { senders(): [{ email, rampStage, effectiveStatus, displayName }], canSend(email) }
 * - `gate` — the SenderGate; `signature()` — the workspace signature; `unsubscribe` — { secret, base }
 * - `halted()` — the system stop; `dryRun` — say what would go, send nothing
 */
export async function runTick({ now = new Date(), dryRun = false, ...deps }) {
  const summary = { sent: 0, planned: [], skipped: {}, stopped: 0, uncertain: 0, halted: false, locked: false };
  const skip = (reason) => { summary.skipped[reason] = (summary.skipped[reason] || 0) + 1; };
  if (deps.halted()) return { ...summary, halted: true };

  const entries = [...await deps.journal.allEntries()];
  const senders = new Map((await deps.registry.senders()).map((sender) => [sender.email, sender]));
  // ESP 13: per company, today's first letters (across every campaign) and
  // the domains its live chains run from. Kept up to date within the pass.
  const countingDay = localTime(now, COUNTING_ZONE).date;
  const everyone = deps.campaigns.enrollments();
  const companyToday = new Map();
  const companyDomains = new Map();
  for (const row of everyone) {
    const key = companyKey(row.lead || { email: row.email });
    if (!key) continue;
    if (row.firstSentAt && localTime(new Date(row.firstSentAt), COUNTING_ZONE).date === countingDay) companyToday.set(key, (companyToday.get(key) || 0) + 1);
    if ((row.status === "active" || row.status === "uncertain") && row.step > 0) {
      if (!companyDomains.has(key)) companyDomains.set(key, new Set());
      companyDomains.get(key).add(row.sender.split("@")[1]);
    }
  }

  // ESP 6: what the pre-send checks read once for the whole pass — exclusions,
  // excluded countries, who answered or was written to lately.
  const filterCtx = deps.filters ? await deps.filters.context(entries, now) : null;
  // ESP 14: who answered, per campaign and company — the company's other
  // people in that campaign wait for a person instead of getting the next letter.
  const leadOf = new Map(everyone.map((row) => [`${row.campaignId}|${row.email}`, row]));
  const companyReplies = new Map();
  for (const entry of entries) {
    if (entry.type !== "message.replied" || !entry.data?.campaignId) continue;
    const row = leadOf.get(`${entry.data.campaignId}|${entry.contact}`);
    const key = companyKey(row?.lead || { email: entry.contact });
    if (key) companyReplies.set(`${entry.data.campaignId}|${key}`, { contact: entry.contact, at: entry.at });
  }

  for (const campaign of deps.campaigns.list().filter((row) => row.state === "running")) {
    for (const enrollment of deps.campaigns.enrollmentsOf(campaign.id).filter((row) => row.status === "active")) {
      // Checked before every letter, not once a tick: «стоп усе» takes effect
      // between two letters, not after the whole pass.
      if (deps.halted()) return { ...summary, halted: true };
      if (deps.campaigns.find(campaign.id)?.state !== "running") break;

      const today = recipientToday(enrollment.lead, now);
      if (enrollment.nextDueDate && today < enrollment.nextDueDate) { skip("not_due"); continue; }

      const stopper = stopperFor(entries, enrollment);
      if (stopper) {
        if (!dryRun) await deps.campaigns.saveEnrollment({ ...enrollment, status: "stopped", reason: stopper, stoppedAt: now.toISOString() });
        summary.stopped += 1;
        continue;
      }

      // ESP 6, before every letter (not only when the list was loaded): an
      // exclusion, an unverified or stale address, a country, a role mailbox,
      // a recipient not on Google, no source. A reason that will not change
      // stops this person's chain; one that a re-check fixes waits, marked once.
      if (filterCtx) {
        const check = await deps.filters.check(enrollment.lead || { email: enrollment.email }, { ...filterCtx, step: enrollment.step, now });
        if (!check.ok) {
          if (check.permanent) {
            if (!dryRun) {
              await deps.campaigns.saveEnrollment({ ...enrollment, status: "stopped", reason: check.reason, stoppedAt: now.toISOString() });
              await deps.journal.recordAboutContact("contact.skipped", enrollment.email, { reason: check.reason, detail: check.detail, campaignId: campaign.id, step: enrollment.step }).catch(() => {});
            }
            summary.stopped += 1;
          } else {
            if (!dryRun && check.needsRecheck && enrollment.recheck !== check.reason) {
              await deps.campaigns.saveEnrollment({ ...enrollment, recheck: check.reason });
              await deps.journal.recordAboutContact("contact.skipped", enrollment.email, { reason: check.reason, detail: check.detail, needsRecheck: true, campaignId: campaign.id, step: enrollment.step }).catch(() => {});
            }
            skip(check.reason);
          }
          continue;
        }
        if (enrollment.recheck && !dryRun) await deps.campaigns.saveEnrollment({ ...enrollment, recheck: null });
      }

      const companyReply = companyReplies.get(`${campaign.id}|${companyKey(enrollment.lead || { email: enrollment.email })}`);
      // Only an answer since the person joined — or since a person picked them
      // back up after one: a resume is a decision, not a moment to re-pause.
      const heldSince = new Date(enrollment.resumedAt || enrollment.enrolledAt);
      if (companyReply && companyReply.contact !== enrollment.email && new Date(companyReply.at) >= heldSince) {
        if (!dryRun) await deps.campaigns.saveEnrollment({ ...enrollment, status: "paused", reason: "company_replied", pausedBecause: companyReply.contact, stoppedAt: now.toISOString() });
        summary.stopped += 1;
        continue;
      }

      const sender = senders.get(enrollment.sender);
      const allowed = sender ? await deps.registry.canSend(enrollment.sender) : { ok: false };
      if (!allowed.ok) { skip("sender_unavailable"); continue; }
      if (await deps.gate.store.pausedFor(enrollment.sender)) { skip("sender_paused"); continue; }

      const decision = sendDecision({ sender, recipient: enrollment.lead, ledger: sendLedger(entries, { now }), now });
      if (!decision.ok) {
        if (decision.reason === "unknown_timezone") {
          if (!dryRun) {
            await deps.campaigns.saveEnrollment({ ...enrollment, status: "stopped", reason: "unknown_timezone", stoppedAt: now.toISOString() });
            await deps.journal.recordAboutContact("contact.skipped", enrollment.email, { reason: "unknown_timezone", campaignId: campaign.id, step: enrollment.step }).catch(() => {});
          }
          summary.stopped += 1;
        } else {
          skip(decision.reason);
        }
        continue;
      }

      // ESP 13, first letters only (a follow-up is a conversation already
      // under way): at most two new people from one company a day, and never
      // a second of our domains on a company one of them is already writing to.
      const company = enrollment.step === 0 ? companyKey(enrollment.lead || { email: enrollment.email }) : null;
      const domain = enrollment.sender.split("@")[1];
      if (company) {
        if ((companyToday.get(company) || 0) >= COMPANY_DAILY_NEW) { skip("company_daily_limit"); continue; }
        const running = companyDomains.get(company);
        if (running && [...running].some((other) => other !== domain)) { skip("company_other_domain"); continue; }
      }

      // The idempotency key: this campaign, this person, this step.
      const key = { campaignId: campaign.id, email: enrollment.email, step: enrollment.step };
      const attempt = attemptOf(entries, key);
      if (attempt.state === "sent") {
        // The letter went and the enrolment never heard: catch up from the
        // journal instead of sending it again.
        const headers = attempt.sending.data.headers || {};
        if (!dryRun) {
          await deps.campaigns.saveEnrollment(advance(enrollment, campaign, {
            messageId: headers["Message-ID"], threadId: attempt.sent.data.threadId, subject: attempt.sending.data.subject,
            references: String(headers.References || "").split(/\s+/).filter(Boolean), at: attempt.sent.at
          }, today));
        }
        skip("already_sent");
        continue;
      }
      if (attempt.state === "in_flight") {
        if (!dryRun) await deps.campaigns.saveEnrollment({ ...enrollment, status: "uncertain", reason: "no_answer_from_provider", stoppedAt: now.toISOString() });
        summary.uncertain += 1;
        continue;
      }

      const template = deps.templates.get(campaign.steps[enrollment.step].templateId);
      const letter = template && composeLetter({
        template,
        sender: { ...deps.signature(), name: sender.displayName || deps.signature().name, email: enrollment.sender },
        lead: enrollment.lead,
        previous: enrollment.lastSent ? { ...enrollment.lastSent, sender: enrollment.sender } : null,
        unsubscribe: deps.unsubscribe,
        campaignId: campaign.id,
        date: now,
        spinMode: campaign.spinMode || "all"
      });
      if (!letter?.ok) {
        const reason = letter?.reason || "template_missing";
        if (!dryRun) {
          await deps.campaigns.saveEnrollment({ ...enrollment, status: "stopped", reason, stoppedAt: now.toISOString() });
          await deps.journal.recordAboutContact("contact.skipped", enrollment.email, { reason, campaignId: campaign.id, step: enrollment.step }).catch(() => {});
        }
        summary.stopped += 1;
        continue;
      }

      if (dryRun) {
        summary.planned.push({ campaign: campaign.name, email: enrollment.email, sender: enrollment.sender, step: enrollment.step + 1, subject: letter.subject });
        if (company) countCompany(companyToday, companyDomains, company, domain);
        // Counted as if sent, so the plan respects the same limits the send would.
        entries.push({ seq: -entries.length, type: "message.sending", at: now.toISOString(), contact: enrollment.email, data: { from: enrollment.sender } });
        continue;
      }

      const headers = letter.raw.slice(0, letter.raw.indexOf("\r\n\r\n")).replace(/\r\n /g, " ").split("\r\n")
        .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()])
        .filter(([name]) => ["Message-ID", "In-Reply-To", "References", "List-Unsubscribe", "List-Unsubscribe-Post"].includes(name));
      let sending;
      try {
        sending = await deps.journal.recordSending({
          from: enrollment.sender, to: enrollment.email, subject: letter.subject, text: letter.text,
          headers: Object.fromEntries(headers), campaignId: campaign.id, step: enrollment.step, leadId: enrollment.email,
          variantIds: letter.variantIds
        }, "esp-sequence");
      } catch (error) {
        // The registry said no between our check and the write.
        skip("sender_unavailable");
        continue;
      }
      entries.push(sending);

      try {
        const result = await deps.gate.send(enrollment.sender, letter.raw, { threadId: enrollment.lastSent?.threadId || null });
        const sent = await deps.journal.recordSent(sending, { messageId: result.id, threadId: result.threadId }, "esp-sequence");
        entries.push(sent);
        await deps.campaigns.saveEnrollment(advance(enrollment, campaign, {
          messageId: letter.messageId, threadId: result.threadId, subject: letter.subject, references: letter.references, at: now.toISOString()
        }, today));
        if (company) countCompany(companyToday, companyDomains, company, domain);
        summary.sent += 1;
      } catch (error) {
        const definite = error instanceof SendingHalted || error instanceof SendingLocked || error instanceof SenderPaused
          || error instanceof LetterError || (error instanceof MailboxError && error.status);
        if (!definite) {
          // No answer: it may have gone. Left in flight on purpose — the next
          // tick finds it and sets the person aside instead of sending twice.
          await deps.campaigns.saveEnrollment({ ...enrollment, status: "uncertain", reason: "no_answer_from_provider", stoppedAt: now.toISOString() });
          summary.uncertain += 1;
          continue;
        }
        entries.push(await deps.journal.recordFailed(sending, { error: error.message }, "esp-sequence"));
        if (error instanceof SendingHalted) return { ...summary, halted: true };
        if (error instanceof SendingLocked) return { ...summary, locked: true };
        if (error instanceof LetterError) {
          await deps.campaigns.saveEnrollment({ ...enrollment, status: "stopped", reason: error.code, stoppedAt: now.toISOString() });
          summary.stopped += 1;
        } else {
          skip(error instanceof SenderPaused ? "sender_paused" : "provider_refused");
        }
      }
    }
  }
  return summary;
}

/**
 * ESP 7: an auto-reply moves the person's next letter instead of ending the
 * chain — to the day after the date they said they are back, or three
 * working days on when they said none. Never earlier than it already was.
 */
export function postponedDue(enrollment, { until = null, today }) {
  const back = until ? addWorkingDays(until, 1) : addWorkingDays(today, 3);
  return enrollment.nextDueDate && enrollment.nextDueDate > back ? enrollment.nextDueDate : back;
}

// ESP 13: «не більше 2 нових контактів з однієї компанії на день».
export const COMPANY_DAILY_NEW = 2;

function countCompany(today, domains, company, domain) {
  today.set(company, (today.get(company) || 0) + 1);
  if (!domains.has(company)) domains.set(company, new Set());
  domains.get(company).add(domain);
}

/**
 * The runner: one tick at a time, every minute, only when switched on. Two
 * ticks never overlap — the second waits for the next minute.
 */
export function startSequence({ intervalMs = 60_000, tick }) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const summary = await tick();
      if (summary.sent || summary.uncertain || summary.halted || summary.locked || summary.errors?.length || Object.keys(summary.actions || {}).some((key) => !["seen", "own", "not_ours"].includes(key))) console.log("[esp] tick", JSON.stringify(summary));
    } catch (error) {
      console.error("[esp] tick failed:", error.message);
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export { CampaignError };
