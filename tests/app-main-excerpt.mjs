import { readdirSync, readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * Pieces of the page's code, run in a sandbox.
 *
 * The page is ES modules under `app/` — the shell in `core.js`, one file per
 * screen in `screens/` — that read `window` and `document` the moment they
 * load, so node cannot import them. Their top-level declarations can still be
 * read out by name and run together against stubs, wherever they live: the
 * source below is every module of the page read as one, with its `import`
 * lines dropped and `export` taken off the front of a declaration.
 *
 * A declaration is found by its first line (`function name`, `async function
 * name`, `const name` or `let name` at the start of a line) and runs to the
 * first later line that starts with `}` or `]` — the files' own formatting. A
 * one-line declaration ends on its own line. Not a parser, and it does not
 * need to be one: a declaration it cannot find throws, and a missing
 * dependency throws a ReferenceError when the test runs it, so a change that
 * breaks the excerpt fails loudly rather than testing something else.
 */

const APP = new URL("../app/", import.meta.url);
const MODULES = ["core.js", ...readdirSync(new URL("screens/", APP)).filter((name) => name.endsWith(".js")).sort().map((name) => `screens/${name}`)];

export function mainSource() {
  return MODULES.map((file) => readFileSync(new URL(file, APP), "utf8"))
    .join("\n")
    .replace(/^import \{[^}]*\} from "[^"]+";\n/gm, "")
    .replace(/^export (?=(?:async function|function|const|let) )/gm, "");
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
