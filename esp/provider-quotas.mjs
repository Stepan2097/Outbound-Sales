/**
 * Люди в кампанію за провайдерами пошти (власник 02.11: «зроби функціонал щоб
 * при виборі в кампанії я міг вписати наприклад 10 пошт гугл 1 яхо тощо»).
 *
 * Папка «Лідів» розбивається за тим, хто тримає пошту адреси (провайдер, який
 * записала перевірка папки — esp/folder-check.mjs), і з кожного провайдера
 * береться стільки людей, скільки вписано. Беруться ті, кого ще немає в жодній
 * кампанії, хто не у виключеннях і чия адреса не «немає»; першими — перевірені
 * «є», далі «приймає будь-яку», далі неперевірені й «невідомо». Хто не пройде
 * перевірок перед додаванням (ESP 6), той не рахується — береться наступний.
 */

import { PROVIDER_LABEL } from "./folder-check.mjs";

export const UNCHECKED = "unchecked";
const ORDER = { valid: 0, catch_all: 1, "": 2, unknown: 3 };

export const providerKey = (row) => row.provider || UNCHECKED;
export const providerLabel = (key) => (key === UNCHECKED ? "Ще не перевірені" : PROVIDER_LABEL[key] || key);

/** Whether this person can still be put into a campaign. */
export function available(row) {
  return Boolean(row.email) && !row.excluded && !(row.campaigns || []).length && row.verification !== "invalid" && row.provider !== "none";
}

const TONES = ["valid", "risky", "invalid", "unknown", "none"];
const noTones = () => Object.fromEntries(TONES.map((tone) => [tone, 0]));

/**
 * The folder by provider: how many can still go, how many of them are checked
 * «є», and the verifier's dots for each (`tones`, as the table shows them —
 * decorateLeads); biggest first.
 */
export function providerBreakdown(rows) {
  const out = new Map();
  for (const row of rows) {
    const key = providerKey(row);
    const entry = out.get(key) || { key, label: providerLabel(key), total: 0, available: 0, valid: 0, tones: noTones() };
    entry.total += 1;
    if (row.tone in entry.tones) entry.tones[row.tone] += 1;
    if (available(row)) {
      entry.available += 1;
      if (row.verification === "valid") entry.valid += 1;
    }
    out.set(key, entry);
  }
  return [...out.values()].sort((left, right) => right.available - left.available || right.total - left.total || left.label.localeCompare(right.label));
}

/** The verifier's dots for the whole folder (02.11: «показує тільки сторінку а не всі перевірені пошти»). */
export function folderTones(rows) {
  const tones = noTones();
  for (const row of rows) if (row.tone in tones) tones[row.tone] += 1;
  return tones;
}

/**
 * `quotas` — { provider: how many }. `accept(lead)` — `true` when the person
 * would go in (the pre-send checks), else why not; refused ones are passed
 * over. One person per address. Returns the picked leads and, per provider
 * that came up short, how many are missing and why the others were passed.
 */
export async function pickByProvider(rows, quotas, { accept = async () => true } = {}) {
  const picked = [];
  const short = {};
  const seen = new Set();
  for (const [key, wanted] of Object.entries(quotas || {})) {
    const need = Math.max(0, Math.min(5000, Math.floor(Number(wanted) || 0)));
    if (!need) continue;
    const candidates = rows.filter((row) => providerKey(row) === key && available(row))
      .sort((left, right) => (ORDER[left.verification] ?? 2) - (ORDER[right.verification] ?? 2));
    const passed = {};
    let got = 0;
    for (const row of candidates) {
      if (got >= need) break;
      if (seen.has(row.email)) continue;
      seen.add(row.email);
      const answer = await accept(row);
      if (answer !== true) {
        passed[answer || "refused"] = (passed[answer || "refused"] || 0) + 1;
        continue;
      }
      picked.push(row);
      got += 1;
    }
    if (got < need) short[key] = { missing: need - got, passed };
  }
  return { picked, short };
}
