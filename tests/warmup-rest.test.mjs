import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createRestClient, likeLiteral, listValue } from "../warmup/rest.mjs";

/**
 * What the small PostgREST client puts on the wire, read back the way
 * PostgREST reads it.
 *
 * The bug this file exists for: `in.(…)` joined its values with commas and
 * nothing else, on the belief that only uuids ever went in. A LinkedIn message
 * URN has a comma and brackets in it, so the inbox's duplicate check was cut
 * into fragments that matched nothing — and every re-read of such a thread was
 * stored, and copied to the CRM, again.
 */

/**
 * PostgREST's list grammar: a quoted element runs to its closing quote with a
 * backslash escaping the next character; a bare one runs to the next `,` or
 * `)`. `list` is the part after the operator, brackets included.
 */
function listValues(list) {
  const values = [];
  let at = 1;
  while (at < list.length) {
    let value = "";
    if (list[at] === "\"") {
      at += 1;
      while (at < list.length && list[at] !== "\"") {
        if (list[at] === "\\") at += 1;
        value += list[at];
        at += 1;
      }
      at += 1;
    } else {
      while (at < list.length && list[at] !== "," && list[at] !== ")") {
        value += list[at];
        at += 1;
      }
    }
    values.push(value);
    if (list[at] === ")") break;
    at += 1;
  }
  return values;
}

let stub;
let seen = [];
let client;

test.before(async () => {
  stub = createServer((request, response) => {
    seen.push(new URL(request.url, "http://stub").searchParams);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("[]");
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${stub.address().port}`;
  client = createRestClient({ label: "stub", resolve: () => ({ url, key: "k", missing: [] }) });
});

test.after(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

const URN = "urn:li:msg_message:(urn:li:fsd_profile:ACoAAB,2-MTY5ODk=)";
const AWKWARD = [URN, "a,b", "(x)", "say \"hi\"", "back\\slash", " padded ", ""];

test("a LinkedIn URN and other awkward text reach PostgREST's list whole", async () => {
  seen = [];
  await client.from("wl_events").select("meta").in("meta->>externalId", AWKWARD).rows();
  const expression = seen[0].get("meta->>externalId");
  assert.ok(expression.startsWith("in.("));
  assert.deepEqual(listValues(expression.slice(3)), AWKWARD, "every value comes back as it was, commas, brackets and quotes too");

  seen = [];
  await client.from("wl_events").select("meta").notIn("type", [URN, "message.in"]).rows();
  const excluded = seen[0].get("type");
  assert.ok(excluded.startsWith("not.in.("));
  assert.deepEqual(listValues(excluded.slice(7)), [URN, "message.in"]);
});

test("a plain value goes in bare, exactly as it always has", async () => {
  // uuids, dates and type names: quoting them would change nothing PostgREST
  // reads, and would change what every stub and log line has always shown.
  for (const plain of ["3f2b8c1e-0000-4000-8000-000000000001", "message.in", "2026-09-25", "acc-1", "null"]) {
    assert.equal(listValue(plain), plain);
  }
  seen = [];
  await client.from("wl_runs").select("id").in("state", ["running", "paused"]).rows();
  assert.equal(seen[0].get("state"), "in.(running,paused)");
});

test("a slug goes into a LIKE pattern as literal text", () => {
  // `%` and `_` are LIKE's wildcards and `\` its escape; PostgREST turns `*`
  // into `%` first, so the most a literal `*` can be is any one character.
  assert.equal(likeLiteral("%D0%B0%D0%BD"), "\\%D0\\%B0\\%D0\\%BD");
  assert.equal(likeLiteral("anna_k"), "anna\\_k");
  assert.equal(likeLiteral("a\\b"), "a\\\\b");
  assert.equal(likeLiteral("star*"), "star_");
  assert.equal(likeLiteral("marta-kovalenko"), "marta-kovalenko", "an ordinary slug is unchanged");
});
