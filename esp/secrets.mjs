/**
 * The ESP's secrets: where they live and what may be said about them.
 *
 * Checklist (ESP 10, P0): «Секрети поза кодом і таблицями — ключі сервісного
 * акаунта, DQS-ключ — у сховищі секретів». The store is the deployment's own:
 * environment variables set in Coolify (or a file the variable points at). So:
 *
 * - no secret is ever in the code, the workspace state, the journal, a table or
 *   a task — `tests/esp-secrets.test.mjs` scans the repository for key shapes
 *   and runs the server with fake keys to prove none of them leaks into what it
 *   writes;
 * - the registry names a mailbox's credential by the variable that holds it
 *   (`mailboxRef`), never the credential;
 * - this module answers only *whether* each one is set — never its value, never
 *   a prefix of it, never its length.
 */

export const ESP_SECRETS = [
  {
    name: "ESP_GMAIL_SERVICE_ACCOUNT_JSON",
    alternatives: ["ESP_GMAIL_SERVICE_ACCOUNT_BASE64"],
    purpose: "Ключ сервісного акаунта Google Workspace з делегуванням — доступ до скриньок (ESP 1)",
    required: true
  },
  {
    name: "SPAMHAUS_DQS_KEY",
    alternatives: [],
    purpose: "Ключ Spamhaus DQS — перевірка доменів у блоклисті DBL (ESP 9)",
    required: false
  }
];

/** Switches, not secrets — shown so nobody has to guess whether real sending is on. */
export const ESP_SWITCHES = [
  { name: "ESP_LIVE_SEND", purpose: "Справжня відправка листів — вмикається лише після приймання ESP 11", on: (value) => value === "1" }
];

const present = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * Which secrets are set, which switches are on, and whether each mailbox in the
 * registry has its credential variable. Names and yes/no only.
 */
export function secretsStatus(env = process.env, senders = []) {
  return {
    secrets: ESP_SECRETS.map((secret) => {
      const via = [secret.name, ...secret.alternatives].find((name) => present(env[name])) || null;
      return { name: secret.name, alternatives: secret.alternatives, purpose: secret.purpose, required: secret.required, set: Boolean(via), via };
    }),
    switches: ESP_SWITCHES.map((item) => ({ name: item.name, purpose: item.purpose, on: item.on(env[item.name]) })),
    mailboxes: senders.filter((sender) => sender.mailboxRef).map((sender) => ({
      email: sender.email, ref: sender.mailboxRef, set: present(env[sender.mailboxRef])
    }))
  };
}

/**
 * Shapes that are keys, wherever they turn up: a PEM private key, a service
 * account's `private_key` field, a Google API key, an OAuth access token, an
 * OpenRouter key. Used by the repository scan and by anything that wants to
 * refuse storing one (`looksLikeSecret`).
 */
export const SECRET_SHAPES = [
  /-----BEGIN (?:RSA |EC |)PRIVATE KEY-----/,
  /"private_key"\s*:\s*"-----BEGIN/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bya29\.[0-9A-Za-z_-]{20,}/,
  /\bsk-or-v1-[0-9a-f]{20,}/
];

export function looksLikeSecret(text) {
  return SECRET_SHAPES.some((shape) => shape.test(String(text ?? "")));
}
