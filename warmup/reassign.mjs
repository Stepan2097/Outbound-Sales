// Бан акаунта не губить діалогів (етап 4/6 плану кампаній і пінгів, таск 7735844f, 16.10.2026).
//
// Коли акаунт кампанії позначають «Заблоковано», його люди — у черзі на запит,
// з надісланим запитом, прийняті й ті, з ким уже розмова, — переходять порівну на
// інші справні акаунти тієї ж кампанії. Новий акаунт ще не в друзях з людиною,
// тож для нього вона знову в черзі на запит у друзі (`waiting`): агент надішле його
// в межах денних лімітів нового акаунта, як будь-який запит. Уся історія лишається:
// повідомлення в базі прогріву й рядки в CRM не чіпаються, а сам перенос записано
// і в журнал прогріву (`invite.reassigned` з `reason: account_blocked`), і нотаткою
// в картці контакту в CRM. Пінг контакту — задача CRM — нікуди не дівається.
//
// Без кампанії або без жодного справного акаунта в ній нікого не переносимо —
// і кажемо чому: переносити людей «кудись» без кампанії — рішення людини.

import { anty, crm } from "./db.mjs";
import { CLAIM_STATUS, sentBy } from "./outreach.mjs";
import { ACCEPTED_STATUS, INVITE_REASSIGNED, WAITING_STATUS } from "./invites.mjs";
import { accountName } from "./activities.mjs";
import { loadAccount, logEvent } from "./store.mjs";

export const REASSIGNABLE = [WAITING_STATUS, CLAIM_STATUS, "pending", ACCEPTED_STATUS, "connected"];
export const BLOCKED_REASON = "account_blocked";

/**
 * Хто куди: порівну, кожен наступний — тому, у кого зараз найменше людей
 * (рівність — за порядком акаунтів у кампанії). Чиста функція.
 */
export function planReassign(rows, targets, load = new Map()) {
  const counts = new Map(targets.map((id) => [id, load.get(id) || 0]));
  return rows.map((row) => {
    const target = targets.reduce((best, id) => ((counts.get(id) < counts.get(best)) ? id : best), targets[0]);
    counts.set(target, counts.get(target) + 1);
    return { row, target };
  });
}

/** Справні акаунти кампаній цього акаунта, крім нього самого. */
async function targetsFor(accountId, campaigns) {
  const mine = campaigns.filter((campaign) => campaign.state !== "done" && campaign.accountIds.includes(accountId));
  const ids = [...new Set(mine.flatMap((campaign) => campaign.accountIds))].filter((id) => id !== accountId);
  const healthy = [];
  for (const id of ids) {
    const account = await loadAccount(id).catch(() => null);
    if (account && account.status !== "excluded" && account.health === "ok") healthy.push(account);
  }
  return { campaigns: mine, accounts: healthy };
}

export async function reassignBlockedAccount({ account, campaigns, movedBy = "" }) {
  const { campaigns: mine, accounts } = await targetsFor(account.id, campaigns);
  if (!mine.length) return { moved: 0, reason: "Акаунт не в жодній кампанії — людей нікуди переносити." };
  if (!accounts.length) return { moved: 0, reason: "У кампанії немає іншого справного акаунта — люди лишились на заблокованому." };

  const rows = await anty.from("wl_outreach").select("id,crm_contact_id,person_name,status")
    .eq("account_id", account.id).in("status", REASSIGNABLE).limit(5000).rows();
  if (!rows.length) return { moved: 0, to: [] };

  const load = new Map();
  for (const target of accounts) {
    load.set(target.id, await anty.from("wl_outreach").select("id").eq("account_id", target.id).in("status", REASSIGNABLE).count().catch(() => 0));
  }
  const byId = new Map(accounts.map((target) => [target.id, target]));
  const fromName = accountName(account);
  const moved = [];
  for (const { row, target } of planReassign(rows, accounts.map((item) => item.id), load)) {
    const to = byId.get(target);
    // Рядок саме цього акаунта: перенесений вже іншим запитом — не чіпаємо вдруге.
    const [updated] = await anty.from("wl_outreach")
      .update({ account_id: to.id, sent_by: sentBy(to), status: WAITING_STATUS, note: null })
      .eq("id", row.id).eq("account_id", account.id).select("id").rows();
    if (!updated) continue;
    const toName = accountName(to);
    await logEvent({
      accountId: to.id,
      type: INVITE_REASSIGNED,
      message: `${row.person_name || "Contact"} moved from ${fromName} (blocked) to ${toName}`,
      meta: {
        outreachId: row.id, crmContactId: row.crm_contact_id, accountId: to.id, movedBy,
        reason: BLOCKED_REASON, fromAccountId: account.id, fromAccount: fromName, toAccount: toName, previousStatus: row.status
      }
    });
    if (row.crm_contact_id) {
      await crm.from("activities").insert({
        contact_id: row.crm_contact_id,
        type: "note",
        origin: "outbound",
        content: `Outbound: акаунт ${fromName} заблоковано в LinkedIn — людину перепризначено на ${toName}. Новий запит у друзі піде з ${toName} у межах його лімітів; переписка вище лишається.`
      }).rows().catch((error) => console.warn(`[reassign] CRM note for ${row.crm_contact_id}: ${error.message}`));
    }
    moved.push({ outreachId: row.id, to: to.id });
  }
  const to = accounts.map((target) => ({ id: target.id, name: accountName(target), count: moved.filter((item) => item.to === target.id).length }));
  return { moved: moved.length, to };
}
