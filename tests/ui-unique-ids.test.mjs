import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

/**
 * Every element id the page can hold is used once.
 *
 * Two chats build panels on the same screen («Налаштування» holds the mail
 * connection, the registry, the filters and the rights), and on 10.10.2026 two
 * of them each had a form `id="espCheckForm"`: the second form's button sent
 * nothing, because `getElementById` found the first. Nothing failed — the
 * button simply did not work. So every literal `id="…"` in the page and in the
 * screens' templates is counted here, and a second one turns the build red.
 */

const APP = new URL("../app/", import.meta.url);

test("жоден id не повторюється в index.html і шаблонах екранів", () => {
  const sources = [
    ["index.html", readFileSync(new URL("index.html", APP), "utf8")],
    ...readdirSync(new URL("screens/", APP)).filter((name) => name.endsWith(".js"))
      .map((name) => [`screens/${name}`, readFileSync(new URL(`screens/${name}`, APP), "utf8")])
  ];
  const seen = new Map();
  const twice = [];
  for (const [file, text] of sources) {
    // Only fixed ids: one built from a value (`id="row-${…}"`) is a family, not one id.
    // And only markup: an id inside a regular expression (`/<div id="x"[^>]*>/`)
    // finds an element, it does not make one.
    for (const match of text.matchAll(/\bid="([A-Za-z][\w-]*)"/g)) {
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      if (/\/<[^/\n]*$/.test(text.slice(lineStart, match.index))) continue;
      const id = match[1];
      if (seen.has(id) && seen.get(id) !== file) twice.push(`${id}: ${seen.get(id)} і ${file}`);
      else if (seen.has(id)) twice.push(`${id}: двічі в ${file}`);
      else seen.set(id, file);
    }
  }
  assert.ok(seen.size > 50, "id прочитано");
  assert.deepEqual(twice, []);
});
