import { createHash, randomBytes } from "node:crypto";

/**
 * Особисті ключі доступу (власник 27.11: «щоб чат гпт підключався до оутбаун і мав можливість
 * писати листи людям через лінкедин … дати таку можливість Богдану»). Ключ — це сама людина:
 * ChatGPT із ним бачить і робить рівно те, що вона в порталі, не більше. Зберігається лише хеш;
 * сам ключ показується один раз, при створенні. Відкликаний ключ перестає працювати одразу.
 */
export const TOKEN_PREFIX = "obk_";
const MAX_TOKENS_PER_USER = 10;

const hashOf = (token) => createHash("sha256").update(String(token)).digest("hex");

/** A new key for this person: the plain key (shown once) and the list with its record added. */
export function issueToken(list, { userId, email, label = "" }) {
  const plain = `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const row = {
    id: randomBytes(6).toString("hex"),
    userId: String(userId || ""),
    email: String(email || "").toLowerCase(),
    label: String(label || "").replace(/\s+/g, " ").trim().slice(0, 60) || "ChatGPT",
    hash: hashOf(plain),
    createdAt: new Date().toISOString(),
    lastUsedAt: null
  };
  const others = (list || []).filter((item) => item.userId !== row.userId);
  const own = (list || []).filter((item) => item.userId === row.userId).slice(-(MAX_TOKENS_PER_USER - 1));
  return { plain, row, list: [...others, ...own, row] };
}

/** The record a presented key belongs to, or null. Only the hash is compared — the key is never stored. */
export function tokenRow(list, presented) {
  const text = String(presented || "").trim();
  if (!text.startsWith(TOKEN_PREFIX) || text.length < TOKEN_PREFIX.length + 20) return null;
  const hash = hashOf(text);
  return (list || []).find((row) => row.hash === hash) || null;
}

/** What a person sees of their own keys: never the key or its hash. */
export function publicToken(row) {
  return { id: row.id, label: row.label, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

export function revokeToken(list, { id, userId }) {
  return (list || []).filter((row) => !(row.id === id && row.userId === userId));
}
