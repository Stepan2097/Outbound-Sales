#!/usr/bin/env node
/**
 * `run-account.mjs`, minus everything that touches an account.
 *
 * The worker cannot be tested against the real one. Running it opens a real
 * Chrome on a real warming profile through its real proxy, and an unscheduled
 * session on a real LinkedIn account is the exact signal this repository exists
 * to avoid — there is no "just once to check the loop". So the worker takes a
 * `--run-account` path, the tests point it here, and this exits with whatever
 * code the case under test needs while opening nothing at all.
 *
 * It takes the same two arguments as the real script and prints them, so the
 * tests can prove the worker passed the account id it was handed rather than a
 * name, and the portal it was pointed at.
 *
 *   STUB_EXIT=1 node agent/fixtures/stub-run-account.mjs --account x --portal y
 *
 * STUB_EXIT  the exit code. Default 0.
 * STUB_SLEEP milliseconds to stay alive first — a run long enough to outlive a
 *            lease, or to be interrupted.
 */
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};

console.log(`[stub] run-account --account ${arg('account')} --portal ${arg('portal')}`);

const wait = Number(process.env.STUB_SLEEP ?? 0);
if (wait > 0) await new Promise((r) => setTimeout(r, wait));

process.exit(Number(process.env.STUB_EXIT ?? 0));
