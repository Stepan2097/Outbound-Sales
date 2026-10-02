import test from "node:test";
import assert from "node:assert/strict";
import { rankContactMatches } from "../contacts/store.mjs";
test("search returns five ranked matches rather than the first five rows", () => {
 const rows = Array.from({length: 12}, (_, i) => ({id:String(i), name:`Alex ${i}`}));
 rows.push({id:"exact",name:"Alex"});
 const result = rankContactMatches(rows,"alex");
 assert.equal(result.length,5); assert.equal(result[0].id,"exact");
 assert.equal(rankContactMatches(rows,"unrelated").length,0);
 assert.equal(rankContactMatches(rows,"").length,0);
});
test("search recognizes accents, typos, companies and email", () => {
 const rows=[{id:"1",name:"Michaél Spyrka",company:"Conventus Capital",email:"michael@example.com"}];
 for (const term of ["Michael", "Micheal", "Conventus", "michael@example.com"]) assert.equal(rankContactMatches(rows,term)[0]?.id,"1",term);
});
