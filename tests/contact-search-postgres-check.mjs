// Explicit integration check against a disposable database containing
// contact-search-fixture.sql. Never run against the CRM database.
// node tests/contact-search-postgres-check.mjs <ssh-host> <disposable-db>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { rankContactMatches } from "../contacts/store.mjs";

const [host, database] = process.argv.slice(2);
if (!host || !/^outbound_perf_[0-9]+$/.test(database || "")) throw Error("A host and a disposable outbound_perf_YYYYMMDD database are required");
const folder = "11111111-1111-4111-8111-111111111111";
const rows = Array.from({ length: 27594 }, (_, at) => {
  const n = at + 1;
  const hash = createHash("md5").update(`contact${n}`).digest("hex");
  return { id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`,
    name: `${n % 3 === 0 ? "Michael" : n % 3 === 1 ? "Nina" : "Owen"} ${n}`,
    company: n % 7 === 0 ? "Conventus Capital" : `Company ${n}`, email: `person${n}@example.com`,
    position: n % 2 === 0 ? "Account Manager" : "Director of Growth" };
});
rows.push(
  { id: "00000000-0000-4000-8000-000000000001", name: "Michaél Spyrka", company: "Conventus Capital", email: "michael@example.com", position: "equity trader" },
  { id: "00000000-0000-4000-8000-000000000002", name: "abc", company: "wild%_company", email: "test@example.org", position: "manager" },
  { id: "00000000-0000-4000-8000-000000000003", name: "Åndré Sâr", company: "Renée & Co", email: "andre@example.org", position: "designer" }
);
const queries = ["Michael", "Mic", "Micheal", "Åndré", "bca", "%_", "no-such-contact", "m c", "Conventus", "michael@example.com"];
const sql = "SET statement_timeout = '20s';\n" + queries.map((query) =>
  `SELECT json_build_object('query', '${query.replaceAll("'", "''")}', 'ids', coalesce(json_agg(id ORDER BY ordinality), '[]'::json)) FROM public.outbound_search_contacts('${folder}', '${query.replaceAll("'", "''")}') WITH ORDINALITY;`
).join("\n");
const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", host,
  `docker exec -i supabase-db psql -U postgres -d ${database} -qAt -v ON_ERROR_STOP=1`], { input: sql, encoding: "utf8", timeout: 180000 });
if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr);
const answers = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
assert.equal(answers.length, queries.length);
for (const answer of answers) {
  assert.deepEqual(answer.ids, rankContactMatches(rows, answer.query).map((row) => row.id), answer.query);
  console.log(`PASS PostgreSQL/JS rank parity: ${answer.query} (${answer.ids.length} matches)`);
}
