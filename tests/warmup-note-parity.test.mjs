import assert from "node:assert/strict";
import test from "node:test";

import { CYRILLIC_TLD, noteHasLink, noteUnderRule, noteWordCount } from "../warmup/strategy.mjs";
import { loadMain } from "./app-main-excerpt.mjs";

/**
 * The note rule lives twice: the server decides at the hand-off
 * (`warmup/strategy.mjs`), and the invite form says what will happen while the
 * note is typed (`app/main.js`). Two copies drift, and a drifted form promises
 * a note the server then drops — or warns about one it would have sent. Both
 * run here over one table, and over a few thousand generated notes.
 */

const form = loadMain(["INVITE_NOTE_CYRILLIC_TLD", "inviteNoteWords", "inviteNoteHasLink", "inviteNoteVerdict"]);
const formWords = (note) => form.context.inviteNoteWords(note);
const formHasLink = (note) => form.context.inviteNoteHasLink(note);
// Spread into this realm: the sandbox's objects have its own prototypes, and
// a deep equality that compares prototypes would call identical answers apart.
const formVerdict = (note, rule) => ({ ...form.context.inviteNoteVerdict(note, rule) });

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

const RULES = [
  false, true, { maxWords: 3, allowLinks: false }, { maxWords: 3, allowLinks: true }, { maxWords: 1 },
  { maxWords: 0 }, { allowLinks: false }, "short", undefined, null
];

test("both copies count words and find links as the table says", () => {
  for (const [note, words, link] of CASES) {
    assert.equal(noteWordCount(note), words, `server words: ${note}`);
    assert.equal(formWords(note), words, `form words: ${note}`);
    assert.equal(noteHasLink(note), link, `server link: ${note}`);
    assert.equal(formHasLink(note), link, `form link: ${note}`);
  }
});

test("both copies know the same Cyrillic top-level domains", () => {
  // The generated notes below cannot reach every entry; the list itself can
  // be compared.
  const formTld = form.get("INVITE_NOTE_CYRILLIC_TLD");
  assert.equal(formTld.source, CYRILLIC_TLD.source);
  assert.equal(formTld.flags, CYRILLIC_TLD.flags);
});

test("both copies judge every table note the same under every rule", () => {
  for (const [note] of CASES) {
    for (const rule of RULES) {
      assert.deepEqual(formVerdict(note, rule), noteUnderRule(note, rule), `${JSON.stringify(note)} under ${JSON.stringify(rule)}`);
    }
  }
  // The two notes the review sent: a Cyrillic domain on day 12, and a long
  // note joined by commas.
  const day12 = { maxWords: 3, allowLinks: false };
  assert.deepEqual(noteUnderRule("Ми з adv.укр", day12), { note: null, dropped: "has_link" });
  assert.deepEqual(noteUnderRule("Привіт,радий,знайомству,Олег", day12), { note: null, dropped: "too_many_words" });
  assert.deepEqual(noteUnderRule("Радий знайомству — Олег", day12), { note: "Радий знайомству — Олег", dropped: null });
});

test("both copies agree on generated notes", () => {
  // Seeded, so a failure names a note that fails again.
  let seed = 0x5eed;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pieces = [
    "a", "com", "ua", "x", "Z", "7", "укр", "рф", "сайт", "Київ", "м", "т", "д", "xn--p1ai", "www",
    ".", "..", "。", "．", "｡", ",", "，", ";", "/", "|", "-", "—", " ", "  ", "\n", "@", ":", "://", "ａ", "🙂", "і"
  ];
  for (let index = 0; index < 5000; index += 1) {
    const length = 1 + Math.floor(random() * 10);
    const note = Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)]).join("");
    assert.equal(formWords(note), noteWordCount(note), `words: ${JSON.stringify(note)}`);
    assert.equal(formHasLink(note), noteHasLink(note), `link: ${JSON.stringify(note)}`);
    const rule = RULES[index % RULES.length];
    assert.deepEqual(formVerdict(note, rule), noteUnderRule(note, rule), `${JSON.stringify(note)} under ${JSON.stringify(rule)}`);
  }
});
