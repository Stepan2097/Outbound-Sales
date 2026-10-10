import assert from "node:assert/strict";
import test from "node:test";

import {
  LetterError, assertPlainLetter, buildLetter, encodeHeader, formatAddress, isUnitedStates, quotedPrintable, signatureText
} from "../esp/letter.mjs";
import { TemplateError, cleanText, prepareTemplate, renderTemplate } from "../esp/template.mjs";

/**
 * ESP 2 — the letter: one text/plain part, a template cleaned when it is
 * saved, no tracking, a text signature, and an empty variable that stops the
 * letter instead of sending «Hi ,».
 */

// ── the template, cleaned when saved ────────────────────────────────────────

test("text pasted from Google Docs is saved as the text, with what was removed named", () => {
  const pasted = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr" style="line-height:1.38"><span style="font-size:11pt;font-family:Arial">Hi&nbsp;{{first_name}},</span></p><br><p><span>We help brands​ grow.</span></p></b>';
  const prepared = prepareTemplate({ subject: "Quick question", body: pasted });
  assert.equal(prepared.body, "Hi {{first_name}},\n\nWe help brands grow.");
  assert.equal(prepared.subject, "Quick question");
  assert.deepEqual([...prepared.removed].sort(), ["html", "invisible", "nbsp", "styles"]);
  assert.doesNotMatch(prepared.body, /[<> ​]/);
});

test("every invisible and look-alike space is taken out", () => {
  const { text, removed } = cleanText("a​b‌c‍d⁠e﻿f­g‮h⁦i j k\tl");
  assert.equal(text, "abcdefghi j k l");
  assert.ok(removed.includes("invisible"));
  assert.ok(removed.includes("nbsp"));
});

test("a template with an unknown or broken variable is not saved, and an empty one neither", () => {
  assert.throws(() => prepareTemplate({ subject: "Hi", body: "Hi {{firstname}}" }), (error) => error instanceof TemplateError && error.code === "unknown_variable" && /firstname/.test(error.message));
  assert.throws(() => prepareTemplate({ subject: "Hi", body: "Hi {{first_name" }), (error) => error.code === "broken_variable");
  assert.throws(() => prepareTemplate({ subject: "", body: "x" }), (error) => error.code === "empty_subject");
  assert.throws(() => prepareTemplate({ subject: "x", body: "<p>&nbsp;</p>" }), (error) => error.code === "empty_body");
});

// ── an empty variable stops the letter ──────────────────────────────────────

test("«Hi ,» never renders: a stand-in is used when the template has one, otherwise the lead is skipped with the reason", () => {
  const template = prepareTemplate({ subject: "{{company}} and us", body: "Hi {{first_name}},\nI saw {{company|your team}}." });
  const full = renderTemplate(template, { name: "Olena Hrytsenko", company: "Northwind" });
  assert.deepEqual(full, { ok: true, subject: "Northwind and us", body: "Hi Olena,\nI saw Northwind." });

  const noFirst = renderTemplate(template, { company: "Northwind" });
  assert.equal(noFirst.ok, false);
  assert.equal(noFirst.reason, "empty_variable");
  assert.deepEqual(noFirst.variables, ["first_name"]);

  const withStandIn = prepareTemplate({ subject: "Hi", body: "Hi {{first_name|there}},\nI saw {{company|your team}}." });
  assert.deepEqual(renderTemplate(withStandIn, { name: "" }), { ok: true, subject: "Hi", body: "Hi there,\nI saw your team." });
  const blankStandIn = prepareTemplate({ subject: "Hi", body: "Hi {{first_name| }}," });
  assert.equal(renderTemplate(blankStandIn, {}).ok, false, "a blank stand-in is no stand-in");
});

// ── the signature ────────────────────────────────────────────────────────────

test("the signature is text — name, title, ADvantage, site — and a US lead gets the company's postal address", () => {
  const sender = { name: "Anna Koval", title: "Partnerships", site: "advantage.agency", usPostalAddress: "ADvantage LLC\n1 Main St, Wilmington, DE 19801" };
  assert.equal(signatureText(sender, { country: "Poland" }), "Anna Koval\nPartnerships\nADvantage\nadvantage.agency");
  assert.equal(signatureText(sender, { country: "United States" }), "Anna Koval\nPartnerships\nADvantage\nadvantage.agency\nADvantage LLC\n1 Main St, Wilmington, DE 19801");
  assert.throws(() => signatureText({ ...sender, usPostalAddress: "" }, { country: "USA" }), (error) => error instanceof LetterError && error.code === "us_address_missing");
  assert.throws(() => signatureText({ site: "x" }, {}), (error) => error.code === "signature_name_missing");
  for (const country of ["US", "usa", "United States of America", "США"]) assert.equal(isUnitedStates(country), true, country);
  assert.equal(isUnitedStates("Ukraine"), false);
});

// ── the message ──────────────────────────────────────────────────────────────

const LETTER = () => buildLetter({
  from: { email: "anna@advantage-mail.com", name: "Анна Коваль" },
  to: { email: "olena@northwind.com", name: "Olena Hrytsenko" },
  subject: "Питання щодо Northwind",
  body: "Привіт, Olena!\nДивись: https://advantage.agency/case?utm=1 — без змін.",
  signature: "Анна Коваль\nADvantage\nadvantage.agency",
  date: new Date(Date.UTC(2026, 9, 12, 9, 30)),
  messageId: "<fixed@advantage-mail.com>"
});

test("one text/plain part in UTF-8, quoted-printable, with no HTML anywhere", () => {
  const raw = LETTER();
  const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
  const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
  assert.match(head, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.equal((head.match(/^Content-Type:/gim) || []).length, 1);
  assert.match(head, /^Content-Transfer-Encoding: quoted-printable$/m);
  assert.match(head, /^MIME-Version: 1\.0$/m);
  assert.doesNotMatch(raw, /text\/html|multipart|<html|<img|<a /i);
  assert.match(head, /^Date: Mon, 12 Oct 2026 09:30:00 \+0000$/m);
  assert.match(head, /^Message-ID: <fixed@advantage-mail\.com>$/m);
  assert.ok(body.split("\r\n").every((line) => line.length <= 76), "a body line longer than 76 characters");
  assert.equal(assertPlainLetter(raw), true);
});

test("the link goes out exactly as written — nothing rewrites, wraps or redirects it", () => {
  const raw = LETTER();
  const body = raw.slice(raw.indexOf("\r\n\r\n") + 4).replace(/=\r\n/g, "");
  const decoded = Buffer.from(body.replace(/=([0-9A-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1").toString("utf8");
  assert.ok(decoded.includes("https://advantage.agency/case?utm=1"), "the link was changed");
  assert.ok(decoded.includes("Привіт, Olena!"));
  assert.ok(decoded.endsWith("Анна Коваль\r\nADvantage\r\nadvantage.agency"), "the signature is the letter's last lines, as text");
});

test("non-ASCII names and subjects are encoded words, and an address is checked", () => {
  assert.equal(encodeHeader("Hello"), "Hello");
  const encoded = encodeHeader("Питання щодо співпраці з вашою командою в Україні");
  assert.ok(encoded.split("\r\n ").every((word) => word.length <= 75 && /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(word)));
  const decoded = encoded.split("\r\n ").map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join("");
  assert.equal(decoded, "Питання щодо співпраці з вашою командою в Україні");
  assert.equal(formatAddress({ email: "a@b.com", name: "A \"B\"" }), '"A \\"B\\"" <a@b.com>');
  assert.throws(() => formatAddress({ email: "not-an-address" }), (error) => error.code === "bad_address");
});

test("quoted-printable keeps escapes whole across soft breaks and encodes a trailing space", () => {
  const long = "Привіт ".repeat(20);
  const encoded = quotedPrintable(long);
  for (const line of encoded.split("\r\n")) {
    assert.ok(line.length <= 76);
    assert.doesNotMatch(line.replace(/=$/, ""), /=[0-9A-F]?$/, "an escape was split");
  }
  assert.match(quotedPrintable("end "), /=20$/);
});

test("the letter refuses headers that would change what it is", () => {
  assert.throws(() => buildLetter({ from: { email: "a@b.com", name: "A" }, to: { email: "c@d.com" }, subject: "s", body: "b", headers: { "Content-Type": "text/html" } }), (error) => error.code === "bad_header");
  assert.throws(() => buildLetter({ from: { email: "a@b.com" }, to: { email: "c@d.com" }, subject: "", body: "b" }), (error) => error.code === "empty_subject");
});

test("the check before sending refuses HTML, a second part, a pixel or a tracking redirect", () => {
  const plain = LETTER();
  assert.throws(() => assertPlainLetter(plain.replace("text/plain", "text/html")), (error) => error.code === "not_plain");
  assert.throws(() => assertPlainLetter(plain.replace("Content-Type: text/plain; charset=UTF-8", "Content-Type: multipart/alternative; boundary=x")), (error) => error.code === "not_plain");
  const withBody = (text) => `${plain.split("\r\n\r\n")[0]}\r\n\r\n${quotedPrintable(text)}`;
  assert.throws(() => assertPlainLetter(withBody('Hi <img src="https://t.example/o.gif">')), (error) => error.code === "html_in_body");
  assert.throws(() => assertPlainLetter(withBody("Hi https://t.example/open.gif?id=1")), (error) => error.code === "tracking");
  assert.throws(() => assertPlainLetter(withBody("See https://links.example/click/x?u=abc")), (error) => error.code === "tracking");
  assert.equal(assertPlainLetter(withBody("See https://advantage.agency/case")), true);
});
