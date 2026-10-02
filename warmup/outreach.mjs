/**
 * Outreach: who was approached, from which login, and what came of it.
 *
 * The CRM says who exists; this says what we did. The person's details are
 * copied in rather than joined on, because the record has to still make sense
 * when the contact is edited, moved or deleted in the CRM.
 */

/**
 * The answers a human may set by hand. `accepted` joined them when invitations
 * grew a daily check: "they accepted and said nothing" is a real state of a
 * real conversation, and a seller correcting a record needs to be able to say
 * it. `waiting` is deliberately absent, like `queued` — it is a machine state,
 * not an answer.
 */
export const OUTREACH_STATUSES = ["pending", "accepted", "connected", "declined", "withdrawn"];

/**
 * A claim: this person is allocated to an account and nobody else may take
 * them, but nothing has been sent yet.
 *
 * It is a status on the same row rather than a table of its own, so the
 * existing `wl_outreach_person_once` index does the work it was built for — one
 * person, one approach, across every account and every campaign — and the send
 * later updates this row rather than racing it. It is deliberately not in
 * `OUTREACH_STATUSES`: those are the answers a human sets by hand, and "not yet
 * sent" is not one of them.
 */
export const CLAIM_STATUS = "queued";

export const OUTREACH_COLUMNS =
  "id,account_id,crm_contact_id,person_name,person_company,person_position,person_linkedin,person_country,sent_by,status,note,created_at,responded_at";

export function describeOutreach(row) {
  return {
    id: row.id,
    personName: row.person_name,
    personCompany: row.person_company,
    personPosition: row.person_position,
    personLinkedin: row.person_linkedin,
    personCountry: row.person_country,
    sentBy: row.sent_by,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
    respondedAt: row.responded_at
  };
}

/**
 * Which login the request went out from — recorded as text, not as a link to
 * the account: accounts get renamed and re-pointed at other profiles, and a
 * year from now the useful answer is the address that appeared in the other
 * person's inbox.
 */
export function sentBy(account) {
  return account.login?.trim() || account.label;
}

/**
 * The person, copied at the moment we touched them — the same columns whether
 * the row is being claimed or sent, so a claim that becomes a send carries a
 * snapshot taken at the send rather than at the claim.
 */
export function personSnapshot(lead) {
  return {
    crm_contact_id: lead.id,
    person_name: lead.name,
    person_company: lead.company,
    person_position: lead.position,
    person_linkedin: lead.linkedin,
    person_country: lead.country
  };
}

/**
 * A claimed person, as the queue, the claim response and the agent's plan all
 * see them. One shape for the three, because they are three views of the same
 * row and a caller should not have to learn which is which.
 */
export function describeClaim(row, campaign = null) {
  return {
    outreachId: row.id,
    accountId: row.account_id,
    crmContactId: row.crm_contact_id,
    name: row.person_name,
    company: row.person_company,
    position: row.person_position,
    linkedin: row.person_linkedin,
    campaignId: campaign?.id ?? null,
    campaignName: campaign?.name ?? null,
    claimedAt: row.created_at
  };
}

function segment(value) {
  try {
    return decodeURIComponent(value).trim().toLowerCase();
  } catch {
    // A stray percent in a pasted URL is not worth losing the match over.
    return value.trim().toLowerCase();
  }
}

/**
 * A comparable key out of whatever form a LinkedIn link takes: a full URL, an
 * `/in/` path, or the slug on its own. Lower-cased and stripped of the query
 * and the trailing slash, because the same person arrives spelled three ways —
 * the agent reads a href, the CRM holds whatever a seller once pasted.
 *
 * A company, school or showcase page keeps its kind in the key. Plenty of the
 * CRM's contacts carry `/company/...` in the column meant for the person, and
 * without the prefix `linkedin.com/company/acme` and `linkedin.com/in/acme`
 * reduce to the same string — which would file somebody's reply against a row
 * belonging to a different person entirely.
 *
 * A bare slug with no path is read as a person: that is what the agent hands
 * us, because what it reads is an `/in/` href.
 */
export function linkedinSlug(value) {
  const raw = typeof value === "string" ? value.trim().slice(0, 300) : "";
  if (!raw) return "";
  const person = /\/in\/([^/?#]+)/i.exec(raw);
  if (person) return segment(person[1]);

  const page = /\/(company|school|showcase)\/([^/?#]+)/i.exec(raw);
  if (page) return `${page[1].toLowerCase()}:${segment(page[2])}`;

  return segment(raw.split(/[/?#]/).filter(Boolean).pop() || "");
}
