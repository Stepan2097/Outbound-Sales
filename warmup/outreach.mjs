/**
 * Outreach: who was approached, from which login, and what came of it.
 *
 * The CRM says who exists; this says what we did. The person's details are
 * copied in rather than joined on, because the record has to still make sense
 * when the contact is edited, moved or deleted in the CRM.
 */

export const OUTREACH_STATUSES = ["pending", "connected", "declined", "withdrawn"];

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
