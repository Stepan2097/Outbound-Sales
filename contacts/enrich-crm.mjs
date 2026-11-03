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
// - LinkedIn, the site and a phone go in only from a confident source;
// - the site and a company address must belong to the lead's own company
//   (суддя 03.11, таск 10b3bb63: «UMC» з поштою @umc.co.nz отримала сайт
//   umc.org і newsdesk@umnews.org — чужу церкву). When the CRM already knows
//   the company's domain (its site or a work address), only that domain goes
//   in; when it does not, a found site goes in only if its name is the
//   company's name, and a work address only on that site's domain. Free
//   mailboxes (gmail.com…) are the person's, not a company's, and pass.

import { isFreeMail } from "../esp/company.mjs";

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

const domainOf = (value) => lower(value).replace(/^mailto:/, "").replace(/^[^@]*@/, "").replace(/^https?:\/\//, "").split(/[/?#:]/)[0].replace(/^(www|mail|email|m)\./, "");
const sameDomain = (left, right) => Boolean(left && right) && (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`));
const LEGAL = new Set(["inc", "llc", "ltd", "limited", "gmbh", "corp", "corporation", "co", "company", "group", "holding", "holdings", "sa", "srl", "plc", "pty", "the"]);

/** The company's own domain the CRM already knows: its site, else a work address. */
export function knownCompanyDomain(contact) {
  const site = domainOf(contact?.website);
  if (site.includes(".")) return site;
  for (const row of contactEmails(contact)) {
    const domain = domainOf(row.address);
    if (domain.includes(".") && !isFreeMail(domain)) return domain;
  }
  return "";
}

/** A found site with no known domain to check against: its name must be the company's name, and not a short acronym. */
export function siteNamedAfter(company, domain) {
  const name = lower(company).normalize("NFKD").replace(/\p{M}+/gu, "").split(/[^\p{L}\p{N}]+/u).filter((word) => word && !LEGAL.has(word)).join("");
  const label = domain.split(".")[0].replace(/[^a-z0-9]/g, "");
  return name.length >= 5 && label === name;
}

/**
 * The CRM patch for one contact: what enrichment found (`candidates`) and what
 * the mail servers said (`checks`, by address). Returns `{ patch, added }` —
 * `patch` empty when nothing changes; `added` in words for the screen.
 */
export function crmPatch(contact, { candidates = [], checks = [], company = "" }) {
  const patch = {};
  const added = [];
  // Found, but of another company — not written; said on the card with why.
  const skipped = [];
  const fields = customFields(contact);
  const known = knownCompanyDomain(contact);
  const siteFits = (value) => {
    const domain = domainOf(value);
    if (!domain.includes(".")) return "";
    if (known) return sameDomain(domain, known) ? "" : `інший домен (${domain}), а в ліда ${known}`;
    return siteNamedAfter(company || contact?.company, domain) ? "" : `назва ${domain} не збігається з «${company || contact?.company || "?"}» — не певні, що це та компанія`;
  };
  let siteDomain = known;
  if (!siteDomain && !String(contact?.website ?? "").trim()) {
    const site = candidates.filter((item) => item.type === "website" && Number(item.confidence ?? 0) >= CONFIDENT.website && !siteFits(item.value))
      .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))[0];
    siteDomain = site ? domainOf(site.value) : "";
  }
  const emailFits = (email) => {
    const domain = domainOf(email);
    if (isFreeMail(domain)) return "";
    if (siteDomain) return sameDomain(domain, siteDomain) ? "" : `пошта на ${domain}, а компанія ліда — ${siteDomain}`;
    return `домен ${domain} не вдалося пов'язати з компанією ліда`;
  };
  const byEmail = new Map(checks.map((check) => [lower(check.email), check]));
  const confidence = (email) => Number(candidates.find((item) => item.type === "email" && lower(item.value) === email)?.confidence ?? 0);

  // Every check, kept: the CRM's own address may fail and is then shown with «!».
  const emailCheck = { ...(fields.email_check && typeof fields.email_check === "object" ? fields.email_check : {}) };
  let checksChanged = false;
  for (const check of checks) {
    const email = lower(check.email);
    const stored = contactEmails(contact).some((row) => row.address === email);
    // A found guess that failed, or another company's address, is not worth remembering anywhere.
    if (!stored && (check.status !== "valid" || emailFits(email))) continue;
    const next = { status: check.status, reason: check.reason, checkedAt: check.checkedAt };
    if (JSON.stringify(emailCheck[email]) !== JSON.stringify(next)) { emailCheck[email] = next; checksChanged = true; }
  }

  const confirmed = [...byEmail.values()].filter((check) => check.status === "valid").map((check) => lower(check.email))
    .filter((email) => {
      if (contactEmails(contact).some((row) => row.address === email)) return true;
      const why = emailFits(email);
      if (why) skipped.push({ field: "email", value: email, reason: why });
      return !why;
    })
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
    const sure = candidates.filter((item) => item.type === type && Number(item.confidence ?? 0) >= CONFIDENT[type]);
    const best = sure.filter((item) => {
      if (type !== "website") return true;
      const why = siteFits(item.value);
      if (why && !skipped.some((row) => row.value === item.value)) skipped.push({ field: "website", value: String(item.value).trim(), reason: why });
      return !why;
    }).sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))[0];
    if (best?.value) { patch[FIELD[type]] = String(best.value).trim(); added.push({ field: FIELD[type], value: patch[FIELD[type]] }); }
  }

  if (checksChanged || emailsChanged) patch.custom_fields = { ...fields, email_check: emailCheck, emails: extra };
  return { patch, added, skipped };
}
