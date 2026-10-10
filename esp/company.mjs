// ESP 13 — who counts as one company, and who was written to too recently.
//
// Checklist (P1): «Не більше 2 нових контактів з однієї компанії на день — і
// ніколи з кількох наших доменів одночасно.» «Повторний контакт не раніше ніж
// через 90 днів для тих, кому вже писали й хто не відповів.»
//
// A company is the lead's email domain — the surest thing a lead row has —
// unless that domain is a free mailbox (gmail.com is not a company); then the
// company name, normalised; and with neither, the person stands alone.

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.es", "ymail.com", "outlook.com", "hotmail.com",
  "hotmail.co.uk", "hotmail.fr", "hotmail.es", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net", "web.de", "t-online.de", "mail.com", "zoho.com", "yandex.ru",
  "yandex.com", "mail.ru", "bk.ru", "inbox.ru", "list.ru", "ukr.net", "i.ua", "meta.ua", "bigmir.net", "qq.com", "163.com",
  "126.com", "naver.com", "uol.com.br", "bol.com.br", "terra.com.br", "libero.it", "orange.fr", "free.fr", "wp.pl", "o2.pl",
  "interia.pl", "seznam.cz", "tutanota.com", "hey.com", "fastmail.com"
]);

export function isFreeMail(domain) {
  return FREE_MAIL.has(String(domain ?? "").toLowerCase());
}

/** `d:northwind.com`, `n:northwind` or null. */
export function companyKey(lead = {}) {
  const domain = String(lead.email ?? "").toLowerCase().split("@")[1] || "";
  if (domain && !isFreeMail(domain)) return `d:${domain.replace(/^(www|mail|email|m)\./, "")}`;
  const name = String(lead.company ?? "").toLowerCase()
    .normalize("NFKD").replace(/\p{M}+/gu, "")
    .replace(/\b(inc|llc|ltd|limited|gmbh|sa|s\.a\.|srl|sp\. z o\.o\.|ooo|тов|corp|corporation|co|company|group|holding)\b\.?/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return name ? `n:${name}` : null;
}

export const RECONTACT_DAYS = 90;

/**
 * Who may not be put into a campaign again yet, from the journal: anybody
 * written to in the last 90 days who has not answered, and anybody who ever
 * answered (a person, not a sequence, writes to them now). Returns a function
 * email → reason or null.
 */
export function recentContactBlocks(entries, { now = new Date(), days = RECONTACT_DAYS } = {}) {
  const since = now.getTime() - days * 86_400_000;
  const replied = new Set();
  const recent = new Set();
  for (const entry of entries) {
    if (!entry.contact) continue;
    if (entry.type === "message.replied") replied.add(entry.contact);
    else if (entry.type === "message.sent" && new Date(entry.at).getTime() >= since) recent.add(entry.contact);
  }
  return (email) => {
    const key = String(email ?? "").toLowerCase();
    if (replied.has(key)) return "replied_before";
    if (recent.has(key)) return "contacted_recently";
    return null;
  };
}
