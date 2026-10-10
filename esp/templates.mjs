// ESP 2 — the stored templates and the signature, in the workspace state.
//
// What is stored is what `prepareTemplate` returned: cleaned, tag-free, with
// known variables only. There is no other way into the list, so a template
// with HTML in it cannot exist to be sent.

import { randomUUID } from "node:crypto";

import { cleanText, prepareTemplate } from "./template.mjs";

export const DEFAULT_SIGNATURE = { name: "", title: "", company: "ADvantage", site: "", usPostalAddress: "" };

export function templateStore({ read, write, now = () => new Date() }) {
  const list = () => (Array.isArray(read()) ? read() : []);
  return {
    list,
    get(id) { return list().find((template) => template.id === id) || null; },
    async create(input) {
      const prepared = prepareTemplate(input);
      const at = now().toISOString();
      const template = { id: randomUUID(), name: prepared.name, subject: prepared.subject, body: prepared.body, createdAt: at, updatedAt: at };
      await write([...list(), template]);
      return { template, removed: prepared.removed };
    },
    async update(id, input) {
      const current = list().find((template) => template.id === id);
      if (!current) return null;
      const prepared = prepareTemplate({ name: input.name ?? current.name, subject: input.subject ?? current.subject, body: input.body ?? current.body });
      const template = { ...current, name: prepared.name, subject: prepared.subject, body: prepared.body, updatedAt: now().toISOString() };
      await write(list().map((row) => (row.id === id ? template : row)));
      return { template, removed: prepared.removed };
    },
    async remove(id) {
      const before = list();
      const after = before.filter((template) => template.id !== id);
      await write(after);
      return after.length !== before.length;
    }
  };
}

/**
 * The signature, cleaned like a template: one line per field, the postal
 * address on as many lines as it has. Text only — there is nowhere for an
 * image or a link wrapper to go.
 */
export function prepareSignature(input = {}) {
  const line = (value) => cleanText(value, { singleLine: true }).text;
  return {
    name: line(input.name),
    title: line(input.title),
    company: line(input.company) || DEFAULT_SIGNATURE.company,
    site: line(input.site),
    usPostalAddress: cleanText(input.usPostalAddress).text
  };
}
