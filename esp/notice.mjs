// ESP 12 — the short notice under letters to the EU and the UK.
//
// Checklist (P1): «Блок для ЄС і UK — для лідів з ЄС і UK автоматично
// додається коротке повідомлення, звідки адреса, і посилання на політику
// даних на домені відправника. Зберігати, яку версію отримав лід.»
//
// The notice is plain text under the signature. The policy link is on the
// sender's own domain (`https://<domain>/privacy`) — served by this server,
// like `/u/` — so the letter still links nowhere but the domain it is from.
// Each wording has a version; the letter records which one went.
//
// The wording below is a working draft for the owner to approve; changing it
// means a new version, never an edit in place.

export const NOTICE_VERSION = "eu-uk-2026-10-v1";

const EU = [
  "austria", "belgium", "bulgaria", "croatia", "cyprus", "czechia", "czech republic", "denmark", "estonia", "finland", "france",
  "germany", "greece", "hungary", "ireland", "italy", "latvia", "lithuania", "luxembourg", "malta", "netherlands", "holland",
  "poland", "portugal", "romania", "slovakia", "slovenia", "spain", "sweden",
  "at", "be", "bg", "hr", "cy", "cz", "dk", "ee", "fi", "fr", "de", "gr", "hu", "ie", "it", "lv", "lt", "lu", "mt", "nl", "pl", "pt", "ro", "sk", "si", "es", "se",
  "deutschland", "españa", "österreich", "polska", "italia", "nederland", "sverige", "suomi", "ελλάδα",
  "австрія", "бельгія", "болгарія", "хорватія", "кіпр", "чехія", "данія", "естонія", "фінляндія", "франція", "німеччина", "греція",
  "угорщина", "ірландія", "італія", "латвія", "литва", "люксембург", "мальта", "нідерланди", "польща", "португалія", "румунія",
  "словаччина", "словенія", "іспанія", "швеція"
];
const UK = ["united kingdom", "uk", "gb", "great britain", "england", "scotland", "wales", "northern ireland", "великобританія", "британія"];
const COVERED = new Set([...EU, ...UK]);

export function needsNotice(country) {
  return COVERED.has(String(country ?? "").trim().toLowerCase());
}

/** The notice for a letter from `sender`, or null when the lead is outside the EU and the UK. */
export function noticeFor({ sender, country, base = null }) {
  if (!needsNotice(country)) return null;
  const domain = String(sender).toLowerCase().split("@")[1] || "";
  const policy = `${(base || `https://${domain}`).replace(/\/$/, "")}/privacy`;
  return {
    version: NOTICE_VERSION,
    text: [
      "--",
      "I found your work address in public professional sources (your company's website or LinkedIn) and am writing because it relates to your role.",
      `How we handle your data: ${policy}`,
      "If you'd rather not hear from me, reply \"unsubscribe\" and I won't write again."
    ].join("\n")
  };
}

/** `/privacy` on a sender's domain: what the notice links to. Plain, short, no tracking. */
export function privacyPage({ company = "ADvantage", contact = "" } = {}) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>How ${escape(company)} handles your data</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:8vh auto;padding:0 16px;color:#1f2a2a}h1{font-size:22px}</style></head><body>
<h1>How ${escape(company)} handles your data</h1>
<p>We write to business addresses we find in public professional sources — company websites and professional networks — when the person's role relates to what we do.</p>
<p>We keep only what a business conversation needs: your name, work email, company, role and country, and the emails we exchanged. We do not track whether our emails are opened or which links are clicked.</p>
<p>Our legal basis is legitimate interest in business-to-business communication. You can object at any time: reply "unsubscribe" to any of our emails, or use the unsubscribe link in your mail client, and we stop the same day and keep your address only on our do-not-contact list.</p>
<p>To ask what we hold about you, or to have it deleted, reply to any of our emails${contact ? ` or write to ${escape(contact)}` : ""}.</p>
</body></html>`;
}
