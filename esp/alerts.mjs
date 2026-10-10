// ESP 8 — the pauses nobody has to press, and the alarms a person gets.
//
// Checklist (P0):
// - «Bounce сендера — понад 2% за 7 днів або 3 bounce на останні 100 листів →
//   пауза сендера.»
// - «Bounce нової кампанії чи джерела — понад 3% на перших 100–300 лідах →
//   пауза кампанії, джерело на перевірку.»
// - «Помилки Gmail — перевищення ліміту, блок акаунта, масові відмови → пауза
//   сендера, сповіщення.»
//
// `reviewAlerts` reads the journal and says what to do; `applyAlerts` does it:
// a sender is paused in the registry (ESP 9) with the reason and a code, a
// campaign is paused with its source marked for checking, and each alarm is
// journalled as `esp.alert` and sent to a person (Telegram when configured).
// Each alarm has a key, and one already raised is not raised again — an hourly
// check must not become an hourly message.
//
// Only permanent bounces count (5.x.x); a 4.x.x is a delay (ESP 7).

export const SENDER_BOUNCE_RATE = 0.02;
export const SENDER_BOUNCES_PER_100 = 3;
export const CAMPAIGN_BOUNCE_RATE = 0.03;
export const CAMPAIGN_EARLY = { min: 100, max: 300 };
export const MASS_FAILURES = { count: 5, minutes: 60 };

const DAY = 86_400_000;
const permanent = (entry) => entry.type === "message.bounced" && /^5\./.test(String(entry.data?.code || ""));

function senderFindings(sender, entries, now) {
  const email = sender.email;
  const sent = entries.filter((entry) => entry.type === "message.sent" && entry.data?.from === email);
  const bounces = entries.filter((entry) => permanent(entry) && entry.data?.sender === email);
  const findings = [];

  const weekAgo = now.getTime() - 7 * DAY;
  const weekSent = sent.filter((entry) => new Date(entry.at).getTime() >= weekAgo).length;
  const weekBounced = bounces.filter((entry) => new Date(entry.at).getTime() >= weekAgo).length;
  if (weekSent && weekBounced / weekSent > SENDER_BOUNCE_RATE) {
    findings.push({ code: "bounce_rate_7d", reason: `bounce ${(weekBounced / weekSent * 100).toFixed(1)}% за 7 днів (${weekBounced} з ${weekSent}) — більше 2%` });
  }
  // The last hundred letters, and the bounces about those letters' people.
  const lastHundred = sent.slice(-100);
  const recipients = new Set(lastHundred.map((entry) => entry.contact));
  const since = lastHundred.length ? new Date(lastHundred[0].at).getTime() : Infinity;
  const recentBounced = bounces.filter((entry) => recipients.has(entry.contact) && new Date(entry.at).getTime() >= since).length;
  if (recentBounced >= SENDER_BOUNCES_PER_100 && !findings.length) {
    findings.push({ code: "bounce_per_100", reason: `${recentBounced} bounce на останні ${lastHundred.length} листів — це 3 або більше` });
  }

  // Gmail itself refusing: a daily limit hit, the account blocked, or the
  // failures piling up within an hour.
  const failures = entries.filter((entry) => entry.type === "message.failed" && entry.data?.from === email);
  const limit = failures.filter((entry) => /quota|rate ?limit|limit exceeded|5\.4\.5|429/i.test(String(entry.data?.error || ""))).at(-1);
  if (limit && now.getTime() - new Date(limit.at).getTime() < DAY) {
    findings.push({ code: "gmail_limit", reason: `Gmail: перевищено ліміт відправки — «${String(limit.data.error).slice(0, 160)}»` });
  }
  const blocked = failures.filter((entry) => /disabled|suspended|blocked|account.*(locked|restricted)|5\.7\.0|403/i.test(String(entry.data?.error || ""))).at(-1);
  if (blocked && now.getTime() - new Date(blocked.at).getTime() < DAY) {
    findings.push({ code: "gmail_blocked", reason: `Gmail: акаунт заблокований або вимкнений — «${String(blocked.data.error).slice(0, 160)}»` });
  }
  const hourAgo = now.getTime() - MASS_FAILURES.minutes * 60_000;
  const recentFailures = failures.filter((entry) => new Date(entry.at).getTime() >= hourAgo).length;
  if (recentFailures >= MASS_FAILURES.count) {
    findings.push({ code: "gmail_mass_failures", reason: `${recentFailures} відмов Gmail за годину` });
  }
  // A 5.7.x is the receiving side refusing by policy: raised by ESP 7 as
  // `sender.alert`; here it becomes a pause.
  const policy = entries.filter((entry) => entry.type === "sender.alert" && entry.data?.email === email && /^5\.7\./.test(String(entry.data?.code || ""))).at(-1);
  if (policy && now.getTime() - new Date(policy.at).getTime() < 7 * DAY) {
    findings.push({ code: "policy_bounce", reason: `відмова ${policy.data.code} за політикою отримувача (${policy.data.contact || "адресат"})` });
  }
  return findings;
}

/**
 * A campaign's first 100–300 people: more than 3% permanent bounces among
 * them pauses it — the list it was built from is suspect.
 */
function campaignFinding(campaign, enrollments, entries) {
  const reached = enrollments.filter((row) => row.firstSentAt).sort((a, b) => String(a.firstSentAt).localeCompare(String(b.firstSentAt)));
  if (reached.length < CAMPAIGN_EARLY.min) return null;
  const early = new Set(reached.slice(0, CAMPAIGN_EARLY.max).map((row) => row.email));
  const bounced = new Set(entries.filter((entry) => permanent(entry) && early.has(entry.contact) && (entry.data?.campaignId == null || entry.data.campaignId === campaign.id)).map((entry) => entry.contact));
  const rate = bounced.size / early.size;
  if (rate <= CAMPAIGN_BOUNCE_RATE) return null;
  return { code: "campaign_bounce", reason: `bounce ${(rate * 100).toFixed(1)}% на перших ${early.size} людях — більше 3%; джерело списку — на перевірку` };
}

/** What should be paused now, and why. Nothing is changed here. */
export function reviewAlerts({ entries, senders, campaigns, enrollmentsOf, now = new Date() }) {
  const actions = [];
  for (const sender of senders) {
    if (sender.status !== "active") continue;
    for (const finding of senderFindings(sender, entries, now)) {
      actions.push({ kind: "pause_sender", email: sender.email, ...finding, key: `sender:${sender.email}:${finding.code}` });
    }
  }
  // ESP 13's weekly review held a sender's ramp: no pause — the stage already
  // stands — but a person is told why, once per review.
  for (const held of entries.filter((entry) => entry.type === "sender.ramp_held" && now.getTime() - new Date(entry.at).getTime() < DAY)) {
    actions.push({
      kind: "ramp_held", email: held.data?.email, code: "ramp_held",
      reason: `етап рампи ${held.data?.stage} стоїть: ${(held.data?.reasons || []).join("; ")}`,
      key: `ramp:${held.data?.email}:${held.seq ?? held.at}`
    });
  }
  for (const campaign of campaigns) {
    if (campaign.state !== "running") continue;
    const finding = campaignFinding(campaign, enrollmentsOf(campaign.id), entries);
    if (finding) actions.push({ kind: "pause_campaign", campaignId: campaign.id, name: campaign.name, ...finding, key: `campaign:${campaign.id}:${finding.code}` });
  }
  return actions;
}

/**
 * Do what `reviewAlerts` found: pause, journal the alarm, tell a person. An
 * alarm whose key was raised in the last day is not raised again; the pause it
 * caused stands until a person lifts it.
 */
export async function applyAlerts({ actions, entries, setSenderStatus, pauseCampaign, append, notify = async () => {}, now = new Date(), actor = "esp-alerts" }) {
  const raised = new Set(entries.filter((entry) => entry.type === "esp.alert" && now.getTime() - new Date(entry.at).getTime() < DAY).map((entry) => entry.data?.key));
  const done = [];
  for (const action of actions) {
    if (raised.has(action.key)) continue;
    raised.add(action.key);
    if (action.kind === "pause_sender") {
      await setSenderStatus({ email: action.email, status: "paused", reason: action.reason, code: action.code }, actor).catch(() => null);
    } else if (action.kind === "pause_campaign") {
      await pauseCampaign(action.campaignId, action.reason);
    }
    const title = action.kind === "pause_sender" ? `Сендер ${action.email} на паузі`
      : action.kind === "ramp_held" ? `Рампа ${action.email} не росте`
      : `Кампанія «${action.name}» на паузі`;
    await append({ type: "esp.alert", actor, data: { key: action.key, kind: action.kind, code: action.code, title, reason: action.reason, email: action.email || null, campaignId: action.campaignId || null } });
    await notify(`⚠️ ${title}\n${action.reason}`).catch(() => {});
    done.push(action);
  }
  return done;
}

/**
 * Telegram, when `TELEGRAM_BOT_TOKEN` and `ESP_ALERT_CHAT_ID` are set on the
 * server; otherwise nothing — the alarm is still in the journal and on the
 * screen. Send only: this never reads the bot's updates.
 */
export function telegramNotifier(env = process.env, { fetch = globalThis.fetch } = {}) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const chat = String(env.ESP_ALERT_CHAT_ID || "").trim();
  if (!token || !chat) return { configured: false, notify: async () => {} };
  return {
    configured: true,
    notify: async (text) => {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 3900), disable_web_page_preview: true })
      });
      if (!response.ok) throw new Error(`Telegram ${response.status}`);
    }
  };
}
