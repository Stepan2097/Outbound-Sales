// ESP 12 — sentence spintax: whole sentences in variants, picked once per lead.
//
// Checklist (P1): «Спінтакс по реченнях — варіанти цілих речень. Рендер один
// раз на ліда, зберігати фінальний текст і ID варіантів. Режим "половина
// кампанії без спінтаксу" для A/B.»
//
// Syntax: `{First sentence.|Another way to say it.|A third one!}`. A single
// brace opens a block, `{{…}}` stays a variable (and may sit inside a
// variant). Every variant must be a whole sentence — it ends with . ! ? or … —
// so a block never swaps half a sentence and leaves the grammar to chance.
//
// The pick is deterministic: the same campaign, person and block always give
// the same variant, so "rendered once per lead" holds even if the letter is
// built twice (a preview, a retry), and the journal gets the ids that went.

import { createHash } from "node:crypto";

export class SpintaxError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.code = code;
  }
}

/** The text as plain pieces and blocks: [{ text }, { block: n, variants: [...] }, …]. */
export function parseSpintax(text) {
  const source = String(text ?? "");
  const parts = [];
  let plain = "";
  let index = 0;
  let blocks = 0;
  while (index < source.length) {
    if (source.startsWith("{{", index)) {
      const close = source.indexOf("}}", index);
      if (close === -1) { plain += source.slice(index); break; }
      plain += source.slice(index, close + 2);
      index = close + 2;
      continue;
    }
    if (source[index] === "{") {
      // A block: read to its own closing brace, stepping over variables.
      let cursor = index + 1;
      let body = "";
      while (cursor < source.length && source[cursor] !== "}") {
        if (source.startsWith("{{", cursor)) {
          const close = source.indexOf("}}", cursor);
          if (close === -1) break;
          body += source.slice(cursor, close + 2);
          cursor = close + 2;
        } else if (source[cursor] === "{") {
          throw new SpintaxError("Варіант у варіанті не підтримується: один рівень дужок.", { code: "nested_spintax" });
        } else {
          body += source[cursor];
          cursor += 1;
        }
      }
      if (source[cursor] !== "}") throw new SpintaxError("Незакритий блок варіантів: бракує «}».", { code: "broken_spintax" });
      if (plain) { parts.push({ text: plain }); plain = ""; }
      blocks += 1;
      parts.push({ block: blocks, variants: body.split("|").map((variant) => variant.trim()) });
      index = cursor + 1;
      continue;
    }
    if (source[index] === "}" && !source.startsWith("}}", index)) {
      throw new SpintaxError("Зайва «}» без блоку варіантів.", { code: "broken_spintax" });
    }
    plain += source[index];
    index += 1;
  }
  if (plain) parts.push({ text: plain });
  return parts;
}

const SENTENCE_END = /[.!?…]["»”')]*$/;

/**
 * Refuse what would not read as whole sentences: a block with one variant,
 * an empty one, or a variant that does not end a sentence. `sentences: false`
 * for a subject line, which is not a sentence.
 */
export function checkSpintax(text, { sentences = true } = {}) {
  const parts = parseSpintax(text);
  for (const part of parts) {
    if (!part.variants) continue;
    if (part.variants.length < 2) throw new SpintaxError(`Блок ${part.block}: потрібно щонайменше два варіанти через «|».`, { code: "single_variant" });
    if (part.variants.some((variant) => !variant)) throw new SpintaxError(`Блок ${part.block}: порожній варіант.`, { code: "empty_variant" });
    if (sentences) {
      const bad = part.variants.find((variant) => !SENTENCE_END.test(variant));
      if (bad) throw new SpintaxError(`Блок ${part.block}: варіант «${bad.slice(0, 60)}» — не ціле речення (має закінчуватися на . ! ? …).`, { code: "not_a_sentence" });
    }
  }
  return parts.filter((part) => part.variants).length;
}

function pick(seed, count) {
  return createHash("sha256").update(String(seed)).digest().readUInt32BE(0) % count;
}

/**
 * The text with one variant per block. `plain: true` takes the first variant
 * of every block — the A group of a half-and-half campaign. Returns the text
 * and which variant each block got, keyed `<field>.<block>`.
 */
export function spin(text, { seed, field = "body", plain = false } = {}) {
  const ids = {};
  const out = parseSpintax(text).map((part) => {
    if (!part.variants) return part.text;
    const chosen = plain ? 0 : pick(`${seed}|${field}|${part.block}`, part.variants.length);
    ids[`${field}.${part.block}`] = chosen;
    return part.variants[chosen];
  }).join("");
  return { text: out, ids };
}

export const SPIN_MODES = ["all", "half", "off"];

/**
 * Which group a person is in for a campaign: `spin` or `plain`. With `half`,
 * a stable hash of the campaign and the person decides — half get the base
 * text, half the variants.
 */
export function spinGroup(mode, { campaignId, email }) {
  if (mode === "off") return "plain";
  if (mode === "half") return pick(`${campaignId}|${email}|ab`, 2) === 0 ? "plain" : "spin";
  return "spin";
}
