import { anty, crm, CONTACT_ID_BATCH, queueLeads, queuePage, slugLikeForms, today } from "./db.mjs";
import { RestError } from "./rest.mjs";
import { CONNECT_HARD_MAX, dayOfRun, pausedOn } from "./strategy.mjs";
import { DEFAULT_FROM_DAY, targetingOf } from "./campaigns.mjs";
import { INVITE_FAILED, isPlainSlug, skippedAmong } from "./invites.mjs";
import { linkedinSlug } from "./outreach.mjs";

/**
 * A campaign's folder, read as the list of people nobody has approached yet.
 *
 * Three callers ask the same question and must get the same answer: a person
 * pressing "Закріпити зараз", the top-up that fills an account's allowance
 * from the folder, and the scheduler deciding whether that top-up would find
 * anybody — so an account is woken for folder work only when there is some.
 *
 * **The walk.** The folder is read newest first and everybody who already has
 * a `wl_outreach` row — any status, any account — is stepped over, and so is
 * everybody the folder has let go (`FEED_SKIPPED`). Those pile up at the head:
 * every person taken is taken from the front. The old walk read five pages
 * from the front and stopped, so once about two hundred people had been
 * approached a folder of twenty thousand answered "nobody left". It now pages
 * on the server, grows the page as it goes, and remembers where the approached
 * head ended.
 *
 * **One profile, one person.** The CRM holds people twice — two contact ids,
 * one LinkedIn profile — and `wl_outreach_person_once` only knows the id. So
 * the people about to be offered are also checked by their profile slug,
 * against every `wl_outreach` row and every skip, and against each other.
 * Without it the same human got a request from two of our logins.
 */

/** The page the walk starts with, as a multiple of what is asked for, and its bounds. */
const OVERFETCH = 4;
const FIRST_PAGE_MIN = 40;
/** Below the thousand rows Supabase answers with at most, whatever is asked. */
const PAGE_MAX = 500;
/**
 * The pages one call may read. The hint below is what makes this enough: a
 * call that ran out of pages leaves the hint where it stopped, and the next
 * call carries on from there instead of walking the same head again.
 */
const PAGES_PER_CALL = 12;

/**
 * Where the approached head of each folder query ended, as of which date.
 *
 * A hint and nothing more: the walk still checks every row it offers against
 * `wl_outreach`, so a wrong hint can only make it look further than it had to
 * or start a little late — never offer somebody who was approached. It is kept
 * for a day and then the walk starts from the front again, which is how a
 * person added to the folder, or released back to it, is found: by the next
 * day at the latest. In memory like the scheduler's leases, and for the same
 * reason — a restart that forgets it costs one longer walk.
 */
const hints = new Map();

function hintKey(targeting) {
  return JSON.stringify([targeting.folderId, targeting.filters]);
}

/** Tests only — the process itself forgets these by restarting. */
export function resetFeedHints() {
  hints.clear();
}

/**
 * Which of these contacts somebody has already approached, held or asked for —
 * or the folder has let go and must not offer again, or our own browser
 * failed on today (`restingToday`).
 */
async function approachedAmong(contactIds, { todayIso = today() } = {}) {
  const approached = new Set();
  for (let start = 0; start < contactIds.length; start += CONTACT_ID_BATCH) {
    const rows = await anty.from("wl_outreach").select("crm_contact_id")
      .in("crm_contact_id", contactIds.slice(start, start + CONTACT_ID_BATCH)).rows();
    for (const row of rows) approached.add(row.crm_contact_id);
  }
  for (const id of (await skippedAmong({ contactIds })).ids) approached.add(id);
  for (const id of await restingToday(contactIds, todayIso)) approached.add(id);
  return approached;
}

/**
 * The outcomes that put a person back in the pool unmarked — about our
 * browser, not about them — and so must not bring them straight back.
 */
const RESTING_OUTCOMES = ["no_button", "cannot_connect"];

/**
 * Which of these contacts our own browser could not send to today.
 *
 * `no_button` is not written off (see `INVITE_PERSON_OUTCOMES`): the row is
 * let go and the person goes back to the pool unmarked, so a page LinkedIn
 * redesigned does not empty the folder. But unmarked and still at the head of
 * the folder, they were the very next person the top-up queued — on 08.10.2026
 * Ajay Manger came back `no_button` on one account in the morning and was
 * queued, failed and queued again on another in the evening. On day 6 an
 * account sends one or two a day, so one such profile was the whole day's
 * allowance, every session, every day.
 *
 * Resting them until tomorrow keeps both halves: nobody is written off for our
 * fault, and the place goes to the next person in the folder. Tomorrow the
 * walk starts from the front again (the hint is a day long), and an agent that
 * works by then sends to them.
 */
async function restingToday(contactIds, todayIso) {
  const resting = new Set();
  const since = `${todayIso}T00:00:00.000Z`;
  for (let start = 0; start < contactIds.length; start += CONTACT_ID_BATCH) {
    const rows = await anty.from("wl_events").select("type,meta")
      .eq("type", INVITE_FAILED).gte("created_at", since)
      .in("meta->>outcome", RESTING_OUTCOMES)
      .in("meta->>crmContactId", contactIds.slice(start, start + CONTACT_ID_BATCH).map(String)).rows();
    for (const row of rows) {
      if (row.type === INVITE_FAILED && RESTING_OUTCOMES.includes(row.meta?.outcome) && row.meta?.crmContactId) {
        resting.add(String(row.meta.crmContactId));
      }
    }
  }
  return resting;
}

/** How many slugs go into one `or=(…)` against `wl_outreach`. Two spellings each, well inside a URL. */
const SLUG_BATCH = 30;

/**
 * Which of these profile slugs are already somebody's — a `wl_outreach` row
 * under any contact id, or a person the folder let go.
 *
 * The column holds whatever link the CRM had, spelled any way a seller pasted
 * it, so the database is asked for links containing `/in/<slug>` (as read and
 * percent-encoded) and the answer is decided here, by comparing slugs exactly.
 * That comparison is the whole check; the query only narrows what is read.
 * A slug that could cut an `or=(…)` is asked on its own.
 */
async function slugsTaken(slugs) {
  const wanted = new Set(slugs.filter(Boolean));
  if (!wanted.size) return new Set();
  const taken = new Set((await skippedAmong({ slugs: [...wanted] })).slugs);
  const note = (rows) => {
    for (const row of rows) {
      const slug = linkedinSlug(row.person_linkedin);
      if (wanted.has(slug)) taken.add(slug);
    }
  };
  // Literal forms: an unescaped `_` or percent-encoded `%` is a wildcard, and
  // the read would carry every link that merely resembles the slug.
  const pattern = (slug) => slugLikeForms(slug).map((form) => `*/in/${form}*`);

  const plain = [...wanted].filter(isPlainSlug);
  for (let start = 0; start < plain.length; start += SLUG_BATCH) {
    const clause = plain.slice(start, start + SLUG_BATCH).flatMap(pattern)
      .map((like) => `person_linkedin.ilike.${like}`).join(",");
    note(await anty.from("wl_outreach").select("person_linkedin").or(clause).rows());
  }
  for (const slug of [...wanted].filter((slug) => !isPlainSlug(slug))) {
    note(await anty.from("wl_outreach").select("person_linkedin").ilike("person_linkedin", `*/in/${slugLikeForms(slug)[0]}*`).rows());
  }
  return taken;
}

/**
 * The ids of the next people to approach from one campaign's folder, in the
 * order they would be approached. The account asking does not narrow it:
 * `wl_outreach_person_once` means one person is approached once across every
 * account, so the list is the same whoever is asking.
 *
 * Only ever reads. The one thing it keeps is the hint, which records where the
 * approached rows ended — a fact about the database, not a decision.
 */
async function nextCandidateIds(limit, targeting, { todayIso = today() } = {}) {
  if (!(limit > 0)) return [];
  const key = hintKey(targeting);
  const hint = hints.get(key);
  let offset = hint?.day === todayIso ? hint.offset : 0;
  let size = Math.min(PAGE_MAX, Math.max(limit * OVERFETCH, FIRST_PAGE_MIN));
  let firstFree = null;
  const found = [];
  // Profiles already offered by this walk: the second contact of one person
  // in the same page has no row yet for the check below to find.
  const offered = new Set();

  for (let page = 0; page < PAGES_PER_CALL && found.length < limit; page += 1) {
    const batch = await queuePage({ targeting, offset, limit: size });
    if (!batch.length) break;
    const approached = await approachedAmong(batch.map((row) => row.id), { todayIso });
    const open = batch.map((row, index) => ({ row, index, slug: linkedinSlug(row.linkedin) }))
      .filter(({ row }) => !approached.has(row.id));

    // Checked by profile only as many at a time as are still wanted: most
    // pages offer what they are asked for on the first try, and a check per
    // row of a five-hundred-row page would be the walk's whole cost.
    let cursor = 0;
    while (found.length < limit && cursor < open.length) {
      const next = open.slice(cursor, cursor + (limit - found.length));
      cursor += next.length;
      const taken = await slugsTaken(next.map(({ slug }) => slug));
      for (const { row, index, slug } of next) {
        if (slug && (taken.has(slug) || offered.has(slug))) continue;
        if (firstFree === null) firstFree = offset + index;
        if (slug) offered.add(slug);
        found.push(row.id);
      }
    }
    offset += batch.length;
    // A short page is the end of the queue, not a reason to ask again.
    if (batch.length < size) break;
    size = Math.min(PAGE_MAX, size * 2);
  }

  hints.set(key, { day: todayIso, offset: firstFree ?? offset });
  return found;
}

/** The next people to approach, in full — what a claim or an invitation is written from. */
export async function nextCandidates(limit, targeting, options = {}) {
  return queueLeads(targeting, await nextCandidateIds(limit, targeting, options));
}

/**
 * Take up to `need` people from these campaigns, first campaign first.
 *
 * `take` writes one person — a claim for the button, a waiting invitation for
 * the top-up — and a 23505 from `wl_outreach_person_once` is somebody else
 * getting there a moment earlier: counted and stepped over, not a failed
 * batch. A folder that could not be read stops the walk and comes back as
 * `error` beside whatever was already taken, because what was taken is real.
 */
export async function takeFromCampaigns({ campaigns, need, take }) {
  const taken = [];
  let collided = 0;
  for (const campaign of campaigns) {
    if (taken.length >= need) break;
    let leads;
    try {
      leads = await nextCandidates(need - taken.length, targetingOf(campaign));
    } catch (error) {
      return { taken, collided, error, campaign };
    }
    for (const lead of leads) {
      if (taken.length >= need) break;
      try {
        taken.push(await take(lead, campaign));
      } catch (error) {
        if (error instanceof RestError && error.code === "23505") {
          collided += 1;
          continue;
        }
        throw error;
      }
    }
  }
  return { taken, collided, error: null, campaign: null };
}

/**
 * How many people each running campaign could still offer the accounts it
 * would feed today — the scheduler's evidence for waking an account to send
 * to its folder.
 *
 * Read-only, like the poll that asks it: nothing is taken here, only counted.
 * Capped at the most one account may send in a day, which is all a wake needs
 * to know. A folder the CRM would not show counts as empty for this poll and
 * is handed to `onError` — the poll must answer, and the next one asks again.
 * The scheduler passes one that says an outage once rather than every poll.
 *
 * Answers `accountId → [{ campaignId, fromDay, available }]`; `folderWork`
 * turns that into invitations for one account on one day.
 */
export async function folderFeeds({
  campaigns = [], runs = [], nowMs = Date.now(), todayIso = today(),
  onError = (campaign, error) => console.error(`[warmup] could not read the folder of campaign "${campaign.name}":`, error.message)
}) {
  const feeds = new Map();
  if (!campaigns.length || !crm.configured()) return feeds;

  const dayOf = new Map();
  for (const run of runs) {
    if (pausedOn(run, todayIso)) continue;
    dayOf.set(run.account_id, dayOfRun(run, new Date(nowMs)));
  }

  for (const campaign of campaigns) {
    if (campaign.state !== "running" || !campaign.folderId) continue;
    const fromDay = campaign.fromDay ?? DEFAULT_FROM_DAY;
    // Only the campaigns somebody would actually be fed from today cost a read.
    const fed = campaign.accountIds.filter((id) => (dayOf.get(id) ?? 0) >= fromDay);
    if (!fed.length) continue;

    let available = 0;
    try {
      // Ids only: the poll needs how many, not who.
      available = (await nextCandidateIds(CONNECT_HARD_MAX, targetingOf(campaign), { todayIso })).length;
    } catch (error) {
      onError(campaign, error);
    }
    for (const accountId of fed) {
      feeds.set(accountId, [...(feeds.get(accountId) ?? []), { campaignId: campaign.id, fromDay, available }]);
    }
  }
  return feeds;
}
