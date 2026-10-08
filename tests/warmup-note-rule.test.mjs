import assert from "node:assert/strict";
import test from "node:test";

import { noteHasLink, noteUnderRule, noteWordCount } from "../warmup/strategy.mjs";

/**
 * The note rule on a connection request: how many words a note has, whether it
 * carries a link, and what the day's rule then does with it.
 *
 * This table used to check two copies against each other — the server's and
 * the one in the invite form on a lead. The form went with the lead workspace
 * (87001c96), and the server's copy is now the only one: the table stays, as
 * the server's own cases.
 */

// [note, words, has a link]
const CASES = [
  // Spaces, as before.
  ["  Привіт,   Марто  ", 2, false],
  ["Hi\nthere\tMarta", 3, false],
  ["", 0, false],
  [null, 0, false],
  // Joined without a space — a person still counts the words.
  ["Привіт,радий,знайомству", 3, false],
  ["Привіт;радий;знайомству;Олег", 4, false],
  ["Привіт/радий/знайомству/Олег", 4, false],
  ["Привіт|радий|знайомству|Олег", 4, false],
  ["Привіт，радий，знайомству，Олег", 4, false],
  // A dash between spaces is not a word; a dash inside one does not split it.
  ["Радий знайомству — Олег", 3, false],
  ["IT-компанія шукає", 2, false],
  ["Привіт!  🙂", 1, false],
  // Links, Latin. A slash splits words too; a link is dropped for the link.
  ["https://adaction.com", 2, true],
  ["see www.adaction", 2, true],
  ["adaction.com", 1, true],
  ["AdAction.COM", 1, true],
  ["bit.ly/3xyz", 2, true],
  ["t.me/marta", 2, true],
  ["linkedin.com/in/marta", 3, true],
  ["пиши на m@adaction.io", 3, true],
  ["(adaction.com.ua)", 1, true],
  ["Node.js", 1, true],
  // Links the Latin-only rule let through.
  ["Ми з adv.укр", 3, true],
  ["сайт.укр", 1, true],
  ["пошта@adv.укр", 1, true],
  ["Пишіть на сайт.рф", 3, true],
  ["пошта.com", 1, true],
  ["adv.xn--p1ai", 1, true],
  ["xn--80aswg.xn--j1amh", 1, true],
  ["adaction。com", 1, true],
  ["adaction．com", 1, true],
  ["adaction｡com", 1, true],
  ["ａｄａｃｔｉｏｎ.com", 1, true],
  ["https：／／x", 2, true],
  // Not links: abbreviations, numbers, and Ukrainian typed without a space.
  ["Привіт, Марто!", 2, false],
  ["e.g. UA", 2, false],
  ["i.e. you", 2, false],
  ["3.5 роки", 2, false],
  ["U.S. team", 2, false],
  ["Hello.", 1, false],
  ["т.д.", 1, false],
  ["м.Київ", 1, false],
  ["вул.Шевченка", 1, false],
  ["тис.грн", 1, false],
  ["Привіт.Дякую", 1, false],
  ["Раді знайомству", 2, false],
  // Spelled out is out of scope: nothing a person reads as words is a link.
  ["adaction dot com", 3, false]
];

test("the note rule counts words and finds links as the table says", () => {
  for (const [note, words, link] of CASES) {
    assert.equal(noteWordCount(note), words, `words: ${note}`);
    assert.equal(noteHasLink(note), link, `link: ${note}`);
  }
});

test("a link or too many words drops the note, and a fitting one goes as typed", () => {
  // The two notes the review sent: a Cyrillic domain on day 12, and a long
  // note joined by commas.
  const day12 = { maxWords: 3, allowLinks: false };
  assert.deepEqual(noteUnderRule("Ми з adv.укр", day12), { note: null, dropped: "has_link" });
  assert.deepEqual(noteUnderRule("Привіт,радий,знайомству,Олег", day12), { note: null, dropped: "too_many_words" });
  assert.deepEqual(noteUnderRule("Радий знайомству — Олег", day12), { note: "Радий знайомству — Олег", dropped: null });
});
