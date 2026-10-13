// ESP 17 — the mail provider behind one contract, so Microsoft (Graph API) can
// come later without touching the letter, the limits, the chain or the inbox.
//
// Checklist (P2): «Абстракція провайдера — Microsoft (Graph API) додамо
// пізніше — не зашивати Google у бізнес-логіку.»
//
// A connector is anything with:
//   describe()                        → { mode, liveSend, … } for the screen
//   checkMailbox(mailbox)             → { ok, mailbox, address, stub }
//   send(mailbox, raw, { threadId })  → { id, threadId, stub }   (raw = RFC 5322)
//   inboxSince(mailbox, cursor)       → { messages: [{ id, threadId, raw }], cursor }
// and fails with the errors below. Thread and message ids are opaque strings:
// Gmail's threadId and Graph's conversationId fit the same slot.
//
// Business modules import errors and the router from here, never from a
// provider's file — a test fences that (tests/esp-provider.test.mjs).

export class SendingLocked extends Error {
  constructor() {
    super("Справжня відправка вимкнена: до приймання ESP 11 листи назовні не йдуть.");
    this.code = "sending_locked";
  }
}

export class MailboxError extends Error {
  constructor(message, { code, status = null, detail = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function normalizeMailbox(value) {
  const mailbox = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox)) {
    throw new MailboxError("Це не адреса пошти.", { code: "bad_mailbox" });
  }
  return mailbox;
}

/**
 * Microsoft 365 through Graph — the contract is ready, the connector is not.
 * Every call says so in words; nothing pretends to send. When it is built:
 * client credentials with Mail.Send / Mail.Read application permissions,
 * POST /users/{mailbox}/sendMail with the MIME body, GET /users/{mailbox}/
 * mailFolders/inbox/messages/delta for the inbox (the cursor is the deltaLink).
 */
export class MicrosoftGraphConnector {
  constructor() {
    this.kind = "microsoft";
  }

  describe() {
    return { mode: "microsoft", liveSend: false, serviceAccountEmail: null, clientId: null, scopes: ["Mail.Send", "Mail.Read"] };
  }

  #notYet() {
    return new MailboxError("Пошти Microsoft 365 ще не підключено: конектор Graph API — наступний крок (ESP 17).", { code: "provider_not_ready" });
  }

  async checkMailbox() { throw this.#notYet(); }
  async send() { throw this.#notYet(); }
  async inboxSince() { throw this.#notYet(); }
  async lettersFrom() { throw this.#notYet(); }
  async setLabels() { throw this.#notYet(); }
}

/**
 * One connector in front of several: each mailbox goes to its provider.
 * `providerOf(mailbox)` names it; the default provider takes the rest.
 */
export function providerRouter({ connectors, providerOf = () => "gmail", fallback = "gmail", primary = () => fallback }) {
  const pick = (mailbox) => {
    const name = providerOf(normalizeMailbox(mailbox)) || fallback;
    const connector = connectors[name];
    if (!connector) throw new MailboxError(`Для пошти ${mailbox} немає провайдера «${name}».`, { code: "no_provider" });
    return connector;
  };
  const main = connectors[fallback];
  // What the screens and the gates read as «the» connection: the default
  // provider, unless `primary()` names another — the per-mailbox Google
  // sign-in once a mailbox is connected while no service-account key exists.
  const lead = () => connectors[primary()] || main;
  return {
    get kind() { return lead().kind; },
    get liveSend() { return lead().liveSend; },
    providers: Object.keys(connectors),
    providerOf: (mailbox) => pick(mailbox).kind,
    describe: () => ({ ...lead().describe(), providers: Object.fromEntries(Object.entries(connectors).map(([name, connector]) => [name, connector.describe().mode])) }),
    checkMailbox: (mailbox) => pick(mailbox).checkMailbox(mailbox),
    send: (mailbox, raw, options) => pick(mailbox).send(mailbox, raw, options),
    inboxSince: (mailbox, cursor) => pick(mailbox).inboxSince(mailbox, cursor),
    // The mailbox warm-up: our letters wherever they landed, and their labels.
    lettersFrom: (mailbox, senders, options) => pick(mailbox).lettersFrom(mailbox, senders, options),
    setLabels: (mailbox, id, labels) => pick(mailbox).setLabels(mailbox, id, labels),
    // The Message-ID the provider really gave a sent letter (Gmail replaces ours).
    messageIdOf: (mailbox, id) => (pick(mailbox).messageIdOf ? pick(mailbox).messageIdOf(mailbox, id) : Promise.resolve(null)),
    // The stub's test hooks, when the default is the stub.
    deliver: main.deliver ? (...args) => main.deliver(...args) : undefined,
    get sent() { return main.sent; }
  };
}

/**
 * Which provider a mailbox is on: Microsoft for the domains listed in
 * `ESP_MICROSOFT_DOMAINS` (comma-separated), Google for the rest.
 */
export function providerOfFromEnv(env = process.env) {
  const microsoft = new Set(String(env.ESP_MICROSOFT_DOMAINS || "").split(",").map((domain) => domain.trim().toLowerCase()).filter(Boolean));
  return (mailbox) => (microsoft.has(mailbox.split("@")[1]) ? "microsoft" : "gmail");
}
