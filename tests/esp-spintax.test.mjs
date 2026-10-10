import assert from "node:assert/strict";
import test from "node:test";

import { composeLetter } from "../esp/compose.mjs";
import { NOTICE_VERSION, needsNotice, noticeFor, privacyPage } from "../esp/notice.mjs";
import { checkSpintax, parseSpintax, spin, spinGroup } from "../esp/spintax.mjs";
import { prepareTemplate } from "../esp/template.mjs";

/**
 * ESP 12 — sentence spintax, picked once per lead, with an A/B half; and the
 * notice under letters to the EU and the UK, with its version recorded.
 */

const SENDER = { email: "anna@advantage-mail.com", name: "Anna Koval", site: "advantage.agency" };
const UNSUB = { secret: "test-unsubscribe-secret-0123456789" };
const BODY = "Hi {{first_name}}. {I saw what {{company}} launched.|Congrats on the launch at {{company}}.|Your launch caught my eye!} {Worth a chat?|Open to a quick call?}";

test("blocks are whole sentences, variables may sit inside, and the variables outside stay variables", () => {
  const parts = parseSpintax(BODY);
  assert.deepEqual(parts.filter((part) => part.variants).map((part) => part.variants.length), [3, 2]);
  assert.equal(parts[0].text, "Hi {{first_name}}. ");
  assert.equal(checkSpintax(BODY), 2);
});

test("a block that is not whole sentences, has one variant, is nested or broken — the template is not saved", () => {
  assert.throws(() => prepareTemplate({ subject: "Hi", body: "Hi {there|you}, how are you?" }), (error) => error.code === "not_a_sentence");
  assert.throws(() => prepareTemplate({ subject: "Hi", body: "{Only one.}" }), (error) => error.code === "single_variant");
  assert.throws(() => prepareTemplate({ subject: "Hi", body: "{A {b|c}.|D.}" }), (error) => error.code === "nested_spintax");
  assert.throws(() => prepareTemplate({ subject: "Hi", body: "{A.|B." }), (error) => error.code === "broken_spintax");
  assert.throws(() => prepareTemplate({ subject: "Hi", body: "{A.||B.}" }), (error) => error.code === "empty_variant");
  // A subject is not a sentence: variants there need no full stop.
  assert.equal(prepareTemplate({ subject: "{Quick question|A thought} for {{company}}", body: "{A.|B.}" }).subject, "{Quick question|A thought} for {{company}}");
});

test("rendered once per lead: the same campaign and person always get the same variants; different people get different ones", () => {
  const first = spin(BODY, { seed: "c-1|olena@northwind.com" });
  assert.deepEqual(spin(BODY, { seed: "c-1|olena@northwind.com" }), first);
  assert.deepEqual(Object.keys(first.ids), ["body.1", "body.2"]);
  const seen = new Set(Array.from({ length: 40 }, (_, index) => JSON.stringify(spin(BODY, { seed: `c-1|lead${index}@x.com` }).ids)));
  assert.ok(seen.size > 3, "everybody gets the same text");
  assert.equal(spin(BODY, { seed: "anything", plain: true }).text, "Hi {{first_name}}. I saw what {{company}} launched. Worth a chat?");
});

test("«half» splits a campaign into a base-text group and a spintax group, stably and roughly in half", () => {
  const groups = Array.from({ length: 200 }, (_, index) => spinGroup("half", { campaignId: "c-1", email: `lead${index}@x.com` }));
  const plain = groups.filter((group) => group === "plain").length;
  assert.ok(plain > 70 && plain < 130, `plain ${plain} of 200`);
  assert.equal(spinGroup("half", { campaignId: "c-1", email: "lead7@x.com" }), groups[7]);
  assert.equal(spinGroup("off", { campaignId: "c-1", email: "x@x.com" }), "plain");
  assert.equal(spinGroup("all", { campaignId: "c-1", email: "x@x.com" }), "spin");
});

test("the composed letter carries the picked sentences and says which ones in variantIds", () => {
  const template = prepareTemplate({ subject: "{Quick question|A thought} for {{company}}", body: BODY });
  const lead = { email: "olena@northwind.com", name: "Olena Hrytsenko", company: "Northwind", country: "Brazil" };
  const letter = composeLetter({ template, sender: SENDER, lead, unsubscribe: UNSUB, campaignId: "c-1" });
  assert.equal(letter.ok, true);
  assert.equal(letter.variantIds.group, "spin");
  assert.deepEqual(Object.keys(letter.variantIds).sort(), ["body.1", "body.2", "group", "notice", "subject.1"]);
  assert.doesNotMatch(letter.text, /[{}|]/, "a brace or a bar went out");
  assert.match(letter.text, /^Hi Olena\. /);
  assert.equal(letter.variantIds.notice, null, "Brazil gets no EU notice");
  const again = composeLetter({ template, sender: SENDER, lead, unsubscribe: UNSUB, campaignId: "c-1" });
  assert.equal(again.text, letter.text, "built twice, the same letter");
  const plain = composeLetter({ template, sender: SENDER, lead, unsubscribe: UNSUB, campaignId: "c-1", spinMode: "off" });
  assert.match(plain.text, /^Hi Olena\. I saw what Northwind launched\. Worth a chat\?/);
  assert.equal(plain.variantIds.group, "plain");
});

test("a lead in the EU or the UK gets the short notice under the signature, linking the sender's own domain, with its version", () => {
  for (const country of ["Poland", "Germany", "United Kingdom", "UK", "Іспанія", "es"]) assert.equal(needsNotice(country), true, country);
  for (const country of ["Ukraine", "USA", "Switzerland", "Norway", ""]) assert.equal(needsNotice(country), false, country);
  const template = prepareTemplate({ subject: "Hi", body: "Hi {{first_name}}." });
  const letter = composeLetter({ template, sender: SENDER, lead: { email: "o@northwind.de", name: "Olena", country: "Germany" }, unsubscribe: UNSUB, campaignId: "c-1" });
  assert.equal(letter.variantIds.notice, NOTICE_VERSION);
  const [, tail] = letter.text.split("Anna Koval");
  assert.match(tail, /How we handle your data: https:\/\/advantage-mail\.com\/privacy/);
  assert.match(tail, /public professional sources/);
  const notice = noticeFor({ sender: "anna@advantage-mail.com", country: "UK", base: "https://go.advantage-mail.com" });
  assert.match(notice.text, /https:\/\/go\.advantage-mail\.com\/privacy/);
  assert.equal(noticeFor({ sender: "anna@advantage-mail.com", country: "USA" }), null);
});

test("the privacy page is plain, names the company, and says nothing is tracked", () => {
  const page = privacyPage({ company: "ADvantage <LLC>" });
  assert.match(page, /ADvantage &lt;LLC&gt;/);
  assert.match(page, /do not track whether our emails are opened/);
  assert.doesNotMatch(page, /<script|<img|<iframe/i);
});

/**
 * Judge, ESP 12 round 1: «parseSpintax ділить блок через split("|") і ріже
 * змінну {{first_name|there}}. У темі такий шаблон зберігається, а частина
 * лідів отримує тему "Hi {{first_name" або "there}}". У тілі шаблон узагалі
 * не зберігається, і причину відмови названо хибно.»
 */
test("a variable with a stand-in inside a block stays whole — in the subject and in the body", () => {
  assert.deepEqual(parseSpintax("{Hi {{first_name|there}}.|Hello.}").map((part) => part.variants || part.text), [["Hi {{first_name|there}}.", "Hello."]]);
  const template = prepareTemplate({
    subject: "{Hi {{first_name|there}}|Hello} from ADvantage",
    body: "{Hi {{first_name|there}}, a question.|Hello {{first_name|friend}}!} We help {{company|teams}} grow."
  });
  assert.equal(template.subject, "{Hi {{first_name|there}}|Hello} from ADvantage", "the subject was not saved as written");
  assert.equal(template.body, "{Hi {{first_name|there}}, a question.|Hello {{first_name|friend}}!} We help {{company|teams}} grow.");
  const subjects = new Set();
  const openers = new Set();
  for (let index = 0; index < 60; index += 1) {
    const named = index % 2 === 0;
    const lead = { email: `p${index}@c${index}.com`, name: named ? "Olena Koval" : "", company: "Northwind", country: "Brazil" };
    const letter = composeLetter({ template, sender: SENDER, lead, unsubscribe: UNSUB, campaignId: "c-judge" });
    assert.equal(letter.ok, true, letter.message);
    assert.doesNotMatch(letter.subject, /[{}|]/, `a broken subject went out: ${letter.subject}`);
    assert.doesNotMatch(letter.text, /[{}|]/, `a broken body went out: ${letter.text}`);
    subjects.add(letter.subject);
    openers.add(letter.text.split(" We help")[0]);
  }
  assert.deepEqual([...subjects].sort(), ["Hello from ADvantage", "Hi Olena from ADvantage", "Hi there from ADvantage"]);
  assert.deepEqual([...openers].sort(), ["Hello Olena!", "Hello friend!", "Hi Olena, a question.", "Hi there, a question."]);
});

test("a refusal names the real reason and the whole variant — not a half cut at the variable's bar", () => {
  assert.throws(() => prepareTemplate({ subject: "Hi", body: "{Hi {{first_name|there}}|Hello.}" }),
    (error) => error.code === "not_a_sentence" && error.message.includes("«Hi {{first_name|there}}»"));
  assert.throws(() => prepareTemplate({ subject: "Hi", body: "{Hi {{first_name|there.|Hello.}" }),
    (error) => error.code === "broken_variable");
  assert.throws(() => prepareTemplate({ subject: "{Hi {{first_name|there}}}", body: "x." }),
    (error) => error.code === "single_variant", "one variant with a stand-in is still one variant");
});
