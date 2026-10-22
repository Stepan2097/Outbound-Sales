// Головна (власник 12.10): «список папок з срм, я вибираю папку і отримую
// послідовність контактів (до яких ніхто ще не писав)… впершу чергу показувати
// людей які вже є в друзях лінкедин акаунтів».
//
// One person at a time from a CRM folder, in this order:
//   1. friends — people who accepted one of our LinkedIn accounts' requests and
//      have not had a first message yet (the warm-up's own «кому написати»),
//      newest acceptance first;
//   2. then the folder itself, oldest first (the CRM's queue order).
// Left out: whoever was marked «не валідний» here, whoever somebody already
// wrote to — a LinkedIn conversation, a queued or sent first message, a cold
// email in the ESP journal — and whoever the seller skipped this session.
//
// The person comes with what decides the next step: which of our accounts they
// are friends with (and whether that account can still write), which requests
// are still pending, whether their address was already written to.

import { contactEmails } from "../contacts/enrich-crm.mjs";
import { ALL_CONTACTS, listAllContacts, listFolderContacts, readContact } from "../contacts/store.mjs";
import { IN_FOLDER, anty, crm, withFolder } from "../warmup/db.mjs";
import { firstMarks, firstMessageBoard, talkingTo } from "../warmup/first-messages.mjs";
import { linkedinSlug } from "../warmup/outreach.mjs";

const PAGE = 100;
const MAX_PAGES = 20;
const FRIEND = new Set(["accepted", "connected"]);

/** Accounts by id, with whether they still work (blocked or excluded ones cannot write). */
async function accountsById() {
  if (!anty.configured()) return new Map();
  const rows = await anty.from("wl_accounts").select("id,label,login,status,health").rows();
  return new Map(rows.map((row) => [row.id, {
    id: row.id,
    name: row.login?.trim() || row.label || "акаунт",
    retired: row.status === "excluded" || row.health === "blocked"
  }]));
}

/** Everything the warm-up holds about these CRM contacts: their requests, by contact. */
async function outreachByContact(contactIds) {
  const found = new Map();
  if (!anty.configured() || !contactIds.length) return found;
  for (let at = 0; at < contactIds.length; at += 100) {
    const rows = await anty.from("wl_outreach").select("id,account_id,crm_contact_id,status,created_at,responded_at")
      .in("crm_contact_id", contactIds.slice(at, at + 100)).rows();
    for (const row of rows) {
      const key = String(row.crm_contact_id);
      found.set(key, [...(found.get(key) || []), row]);
    }
  }
  return found;
}

/** What has been written already, from every channel this workspace writes on. */
async function writtenSignals({ emailed }) {
  let slugs = new Set();
  try {
    if (anty.configured()) {
      const accounts = (await anty.from("wl_accounts").select("id").rows()).map((row) => row.id);
      slugs = new Set([...await talkingTo(accounts)].map((key) => key.split("|")[1]).filter(Boolean));
    }
  } catch { /* an unread warm-up hides nobody */ }
  return { slugs, emailed };
}

function alreadyWritten(contact, rows, signals) {
  if (rows.some((row) => row.status === "connected")) return true;
  const slug = linkedinSlug(contact.linkedin);
  if (slug && signals.slugs.has(slug)) return true;
  const email = String(contact.email || "").trim().toLowerCase();
  return Boolean(email && signals.emailed.has(email));
}

/**
 * The next person to work on in this folder.
 *
 * `cursor` is how far into the folder the seller has gone (the friends come
 * before it and do not move it); `skip` is who they passed over this session.
 */
export async function nextContact({ folderId, cursor = 0, skip = [], decisions = {}, emailed = new Map(), cacheScope }) {
  const skipped = new Set(skip.map(String));
  const decided = (id) => Boolean(decisions[id]);
  const accounts = await accountsById().catch(() => new Map());

  // 1. Friends who are waiting for a first message, in this folder.
  let friends = [];
  try {
    if (anty.configured()) {
      const board = await firstMessageBoard(null, { limit: 2000 });
      friends = board.toWrite.filter((row) => row.crmContactId && !accounts.get(row.accountId)?.retired);
    }
  } catch { friends = []; }
  const friendIds = [...new Set(friends.map((row) => row.crmContactId))];
  const everyone = folderId === ALL_CONTACTS;
  const inFolder = new Set(everyone ? friendIds : []);
  for (let at = 0; !everyone && at < friendIds.length; at += 100) {
    const rows = await crm.from("contacts").select(withFolder("id")).eq(IN_FOLDER, folderId).in("id", friendIds.slice(at, at + 100)).rows();
    for (const row of rows) inFolder.add(String(row.id));
  }
  const friendsHere = friendIds.filter((id) => inFolder.has(id) && !decided(id));
  const friendsLeft = friendsHere.filter((id) => !skipped.has(id));
  const signals = await writtenSignals({ emailed });

  let contactId = friendsLeft[0] || null;
  let phase = contactId ? "friends" : "folder";
  let position = Number(cursor) || 0;
  let total = null;

  // 2. The folder, oldest first, past whoever was decided, written to, skipped or already shown as a friend.
  if (!contactId) {
    for (let page = 0; page < MAX_PAGES && !contactId; page += 1) {
      const answer = everyone
        ? await listAllContacts({ limit: PAGE, offset: position, cacheScope })
        : await listFolderContacts({ folderId, limit: PAGE, offset: position, queueOrder: true, cacheScope });
      total = answer.total;
      if (!answer.contacts.length) break;
      const outreach = await outreachByContact(answer.contacts.map((row) => String(row.id)));
      for (const [index, row] of answer.contacts.entries()) {
        const id = String(row.id);
        if (decided(id) || skipped.has(id) || friendsHere.includes(id)) continue;
        if (alreadyWritten(row, outreach.get(id) || [], signals)) continue;
        contactId = id;
        position += index;
        break;
      }
      if (!contactId) position += answer.contacts.length;
    }
  }

  if (!contactId) {
    return { contact: null, phase, cursor: position, total, friendsLeft: 0, done: true };
  }
  const contact = await readContact(contactId, { cacheScope, fresh: true });
  return {
    contact,
    phase,
    cursor: position,
    total,
    friendsLeft: friendsLeft.length,
    ...(await channelsFor(contact, { accounts, friends, emailed }))
  };
}

/**
 * Where this person stands with us on each channel: LinkedIn friends and
 * pending requests by account, and whether their address was written to.
 */
export async function channelsFor(contact, { accounts = null, friends = null, emailed = new Map(), emailSentAt = null } = {}) {
  const byId = accounts || await accountsById().catch(() => new Map());
  const rows = (await outreachByContact([String(contact.id)]).catch(() => new Map())).get(String(contact.id)) || [];
  const board = friends ? new Map(friends.map((row) => [row.outreachId, row])) : new Map();
  const { drafts } = rows.length ? await firstMarks(rows.map((row) => String(row.id))).catch(() => ({ drafts: new Map() })) : { drafts: new Map() };
  const linkedin = {
    friends: rows.filter((row) => FRIEND.has(row.status)).map((row) => {
      const account = byId.get(row.account_id);
      const waiting = board.get(String(row.id));
      return {
        outreachId: String(row.id),
        accountId: row.account_id,
        accountName: account?.name || "акаунт",
        status: row.status,
        acceptedAt: row.responded_at || null,
        // Only an accepted, silent friend on a working account takes a first message from here.
        canWrite: row.status === "accepted" && !account?.retired,
        why: account?.retired ? "акаунт заблоковано або виключено" : row.status === "connected" ? "розмова вже йде — пишіть у Workspace" : "",
        reply: waiting?.reply || null,
        draft: drafts.get(String(row.id))?.text || waiting?.draft?.text || ""
      };
    }),
    pending: rows.filter((row) => !FRIEND.has(row.status)).map((row) => ({
      outreachId: String(row.id),
      accountId: row.account_id,
      accountName: byId.get(row.account_id)?.name || "акаунт",
      status: row.status,
      at: row.created_at
    }))
  };
  const address = String(contact.email || "").trim().toLowerCase();
  const sent = address && emailed.get ? emailed.get(address) : null;
  const email = {
    address,
    written: Boolean(address && emailed.has(address)),
    writtenAt: sent?.at || emailSentAt,
    writtenFrom: sent?.from || null,
    // Every address the CRM holds for them — its own and the confirmed ones
    // enrichment added — with what its mail server said and whether we wrote.
    addresses: contactEmails(contact).map((row) => {
      const went = emailed.get ? emailed.get(row.address) : null;
      return { ...row, written: Boolean(went), writtenAt: went?.at || null, writtenFrom: went?.from || null };
    })
  };
  return { linkedin, email };
}
