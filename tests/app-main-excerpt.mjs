import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * Pieces of `app/main.js`, run in a sandbox.
 *
 * `main.js` reads `window` and `document` the moment it loads, and imports a
 * module, so node cannot import it. Its top-level declarations can still be
 * read out by name and run together against stubs. That is how the invite
 * form is tested without a browser — and how the form's copy of the note rule
 * is held to the server's (`tests/warmup-note-parity.test.mjs`).
 *
 * A declaration is found by its first line (`function name`, `async function
 * name`, `const name` or `let name` at the start of a line) and runs to the
 * first later line that starts with `}` or `]` — the file's own formatting. A
 * one-line declaration ends on its own line. Not a parser, and it does not
 * need to be one: a declaration it cannot find throws, and a missing
 * dependency throws a ReferenceError when the test runs it, so a change that
 * breaks the excerpt fails loudly rather than testing something else.
 */

const MAIN = new URL("../app/main.js", import.meta.url);

export function mainSource() {
  return readFileSync(MAIN, "utf8");
}

function throughEnd(source, index, what) {
  const lines = source.slice(index).split("\n");
  if (/[;}]\s*$/.test(lines[0])) return lines[0];
  const end = lines.findIndex((line, at) => at > 0 && /^[}\]]/.test(line));
  if (end < 0) throw new Error(`app/main.js: could not find where ${what} ends`);
  return lines.slice(0, end + 1).join("\n");
}

/** The source of one top-level declaration of `app/main.js`. */
export function declaration(source, name) {
  const found = new RegExp(`^(?:async function|function|const|let) ${name}\\b`, "m").exec(source);
  if (!found) throw new Error(`app/main.js declares no top-level ${name}`);
  return throughEnd(source, found.index, name);
}

/** The source of the top-level statement whose first line starts with `prefix`. */
export function statement(source, prefix) {
  const at = source.split("\n").findIndex((line) => line.startsWith(prefix));
  if (at < 0) throw new Error(`app/main.js has no top-level statement starting ${prefix}`);
  const index = source.split("\n").slice(0, at).join("\n").length + (at ? 1 : 0);
  return throughEnd(source, index, prefix);
}

/**
 * Run these declarations (and statements, by prefix) of `app/main.js` in a
 * fresh context whose globals are `globals`. `get(name)` reads anything the
 * excerpt declared, `let` and `const` included.
 */
export function loadMain(names, globals = {}, statements = []) {
  const source = mainSource();
  const code = [
    ...names.map((name) => declaration(source, name)),
    ...statements.map((prefix) => statement(source, prefix))
  ].join("\n\n");
  const context = vm.createContext({ ...globals });
  vm.runInContext(code, context, { filename: "app/main.js (excerpt)" });
  return {
    context,
    get: (name) => vm.runInContext(name, context)
  };
}
