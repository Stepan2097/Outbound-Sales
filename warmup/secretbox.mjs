import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Account and proxy passwords, encrypted at rest.
 *
 * These are credentials to real accounts, so the database is not allowed to
 * hold them in the clear. AES-256-GCM rather than plain CBC because it
 * authenticates: a row edited in the database fails to decrypt instead of
 * returning quietly corrupted text.
 *
 * Distinct from the workspace vault in server.mjs, whose key is random per
 * boot — this one has to survive a restart, so it comes from the environment.
 * With no key configured, storing a password FAILS rather than falling back to
 * plaintext: a silent downgrade is how secrets end up in a table forever.
 */
const ALGORITHM = "aes-256-gcm";

function key() {
  const raw = process.env.LINKEDIN_SECRET_KEY;
  if (!raw) return null;
  // Any passphrase length is folded to 32 bytes, so rotating to a longer key
  // never becomes a migration.
  return createHash("sha256").update(raw).digest();
}

export function secretsConfigured() {
  return key() !== null;
}

export function encryptSecret(plaintext) {
  const secret = key();
  if (!secret) throw new Error("LINKEDIN_SECRET_KEY is not set — refusing to store a password");

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, secret, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  // iv.tag.payload — self-describing, so rotating the format later stays possible.
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptSecret(payload) {
  const secret = key();
  if (!secret || !payload) return null;

  const [version, iv, tag, data] = String(payload).split(".");
  if (version !== "v1" || !iv || !tag || !data) return null;

  try {
    const decipher = createDecipheriv(ALGORITHM, secret, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered row. Null keeps the caller on the "no password"
    // path instead of handing it something that is not the password.
    return null;
  }
}
