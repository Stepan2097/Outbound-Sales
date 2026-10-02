import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Stylesheet rules that have broken on screen and can be checked without one.
 *
 * `html, body` clip sideways overflow, so a line that does not wrap is not a
 * scrollbar — its tail is simply gone. A `pre` that keeps the author's line
 * breaks holds text somebody else wrote: a message, a note, a draft. A
 * tracking link or a pasted token has no space to break at, and ran past the
 * card on the Контакти page and in Історія.
 */

const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rules() {
  const found = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(css))) found.push({ selector: match[1].trim(), body: match[2] });
  return found;
}

test("every pre that keeps line breaks also breaks a word too long for the card", () => {
  const pres = rules().filter(({ selector, body }) => /(^|[\s>,])pre\b/.test(selector) && /white-space:\s*pre-wrap/.test(body));
  assert.ok(pres.some(({ selector }) => selector === ".history-body pre"), "the conversation's message bodies are among them");
  for (const { selector, body } of pres) {
    assert.match(body, /overflow-wrap:\s*anywhere/, selector);
  }
});
