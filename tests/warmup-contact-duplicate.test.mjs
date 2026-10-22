import assert from "node:assert/strict";
import test from "node:test";

import { insertContact } from "../warmup/people.mjs";

// CRM 22.10: другий контакт з тим самим LinkedIn база відхиляє (23505) — тоді людина
// — це наявний контакт, а не збій.

const client = (outcome) => ({ from: () => ({ insert: () => ({ select: () => ({ rows: async () => { if (outcome instanceof Error) throw outcome; return outcome; } }) }) }) });

test("новий контакт — його id; дубль за LinkedIn (23505) — id наявного; інша помилка — далі", async () => {
  assert.equal(await insertContact({ linkedin: "https://www.linkedin.com/in/ann" }, { client: client([{ id: "new" }]) }), "new");
  const dup = Object.assign(new Error("duplicate key"), { code: "23505" });
  assert.equal(await insertContact({ linkedin: "https://www.linkedin.com/in/ann" }, { client: client(dup), find: async (link) => (link.endsWith("/ann") ? "old" : null) }), "old");
  await assert.rejects(() => insertContact({ linkedin: "x" }, { client: client(dup), find: async () => null }), /duplicate/);
  await assert.rejects(() => insertContact({ linkedin: "x" }, { client: client(new Error("CRM down")) }), /CRM down/);
});
