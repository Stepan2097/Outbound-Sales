/**
 * Outreach: who was approached, from which login, and what came of it.
 *
 * The CRM says who exists; this says what we did. The person's details are
 * copied in rather than joined on, because the record has to still make sense
 * when the contact is edited, moved or deleted in the CRM.
 */

export const OUTREACH_STATUSES = ["pending", "connected", "declined", "withdrawn"];

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
