// What «Збагатити» found, into the CRM (власник 12.10: «ця інформація додасться
// в срм автоматично»), and a contact's addresses with their checks.
//
// Rules:
// - a field the CRM already has is never overwritten — enrichment fills holes;
// - an address goes in only if its mail server confirmed the mailbox
//   (contacts/email-check.mjs); a guess that failed is not stored or shown;
// - the main `email` is filled when empty; every other confirmed address joins
//   `custom_fields.emails`; each check lands in `custom_fields.email_check`
//   (by address: status, why, when) — which is also where ESP 6 reads whether
//   an address is verified (esp/crm-leads.mjs);
// - LinkedIn, the site and a phone go in only from a confident source.

const CONFIDENT = { linkedin: 80, website: 60, phone: 80 };
const FIELD = { linkedin: "linkedin", website: "website", phone: "phone" };

const lower = (value) => String(value ?? "").trim().toLowerCase();

function customFields(contact) {
  const fields = contact?.custom_fields;
  return fields && typeof fields === "object" && !Array.isArray(fields) ? fields : {};
}

/** The contact's addresses: the CRM's own first, then confirmed ones enrichment added. */
export function contactEmails(contact) {
  const fields = customFields(contact);
  const checks = fields.email_check && typeof fields.email_check === "object" ? fields.email_check : {};
  const found = Array.isArray(fields.emails) ? fields.emails : [];
  const list = [];
  const add = (address, source) => {
    const email = lower(address);
    if (!email || list.some((row) => row.address === email)) return;
    list.push({ address: email, source, check: checks[email] || null });
  };
  add(contact?.email, "crm");
  for (const row of found) add(typeof row === "string" ? row : row?.email, "found");
  return list;
}

/**
 * The CRM patch for one contact: what enrichment found (`candidates`) and what
 * the mail servers said (`checks`, by address). Returns `{ patch, added }` —
 * `patch` empty when nothing changes; `added` in words for the screen.
 */
export function crmPatch(contact, { candidates = [], checks = [] }) {
  const patch = {};
  const added = [];
  const fields = customFields(contact);
  const byEmail = new Map(checks.map((check) => [lower(check.email), check]));
  const confidence = (email) => Number(candidates.find((item) => item.type === "email" && lower(item.value) === email)?.confidence ?? 0);

  // Every check, kept: the CRM's own address may fail and is then shown with «!».
  const emailCheck = { ...(fields.email_check && typeof fields.email_check === "object" ? fields.email_check : {}) };
  let checksChanged = false;
  for (const check of checks) {
    const email = lower(check.email);
    const known = contactEmails(contact).some((row) => row.address === email);
    // A found guess that failed is not worth remembering anywhere.
    if (!known && check.status !== "valid") continue;
    const next = { status: check.status, reason: check.reason, checkedAt: check.checkedAt };
    if (JSON.stringify(emailCheck[email]) !== JSON.stringify(next)) { emailCheck[email] = next; checksChanged = true; }
  }

  const confirmed = [...byEmail.values()].filter((check) => check.status === "valid").map((check) => lower(check.email))
    .sort((left, right) => confidence(right) - confidence(left));
  const primary = lower(contact?.email);
  const extra = (Array.isArray(fields.emails) ? fields.emails : []).map((row) => (typeof row === "string" ? { email: lower(row) } : { ...row, email: lower(row?.email) }));
  let emailsChanged = false;
  for (const email of confirmed) {
    if (!primary && !patch.email) { patch.email = email; added.push({ field: "email", value: email }); continue; }
    if (email === primary || email === patch.email || extra.some((row) => row.email === email)) continue;
    const source = candidates.find((item) => item.type === "email" && lower(item.value) === email)?.source || "";
    extra.push({ email, source, addedAt: new Date().toISOString() });
    added.push({ field: "emails", value: email });
    emailsChanged = true;
  }

  for (const type of Object.keys(FIELD)) {
    if (String(contact?.[FIELD[type]] ?? "").trim()) continue;
    const best = candidates.filter((item) => item.type === type && Number(item.confidence ?? 0) >= CONFIDENT[type])
      .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))[0];
    if (best?.value) { patch[FIELD[type]] = String(best.value).trim(); added.push({ field: FIELD[type], value: patch[FIELD[type]] }); }
  }

  if (checksChanged || emailsChanged) patch.custom_fields = { ...fields, email_check: emailCheck, emails: extra };
  return { patch, added };
}
