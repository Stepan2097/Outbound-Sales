// ESP 1 — a mailbox Google stops letting us act as is paused, and stays paused.
//
// Checklist (P0): «Відкликаний токен = пауза сендера — помилка авторизації чи
// блок акаунта → сендер на паузу, сповіщення людині. Не повторювати спроби в
// циклі.» So every send goes through `SenderGate`: a paused mailbox is refused
// before Google is asked, and an authorisation failure pauses it on the spot,
// with Google's sentence kept as the reason. Only a person lifts the pause
// (`resume`), after fixing what the reason says — the gate never retries.
//
// The pause list is the gate's only state. It is written through a small store
// interface so it can live in the workspace state now and move into the
// sender registry (ESP 9) without touching the gate.

import { MailboxError, normalizeMailbox } from "./gmail.mjs";
import { assertPlainLetter } from "./letter.mjs";

/**
 * Google answers that mean "this mailbox cannot be used until somebody fixes
 * something". Not a network blip, not a 5xx, not our own `SendingLocked`.
 */
const AUTH_CODES = new Set(["delegation_missing", "mailbox_rejected", "token_failed"]);

export function isAuthFailure(error) {
  if (!(error instanceof MailboxError)) return false;
  if (AUTH_CODES.has(error.code)) return true;
  // 401 — the token is no longer good; 403 — the account is suspended or the
  // API is off for it. A 429 or 5xx is load, not authorisation.
  return error.code === "gmail_error" && (error.status === 401 || error.status === 403);
}

export class SenderPaused extends Error {
  constructor(mailbox, pause) {
    super(`Скринька ${mailbox} на паузі: ${pause.reason}`);
    this.code = "sender_paused";
    this.mailbox = mailbox;
    this.pause = pause;
  }
}

/** The pause list kept in the workspace state (`read()` / `write(value)`). */
export function stateSenderStore({ read, write }) {
  const all = () => ({ ...(read() || {}) });
  return {
    async pausedFor(mailbox) { return all()[mailbox] || null; },
    async list() { return Object.entries(all()).map(([mailbox, pause]) => ({ mailbox, ...pause })); },
    async pause(mailbox, pause) {
      const next = all();
      // The first reason stays: a second failure after the pause is the same
      // problem, and the person needs the sentence that started it.
      if (!next[mailbox]) next[mailbox] = pause;
      await write(next);
      return next[mailbox];
    },
    async resume(mailbox) {
      const next = all();
      const had = Boolean(next[mailbox]);
      delete next[mailbox];
      await write(next);
      return had;
    }
  };
}

export class SenderGate {
  constructor({ connector, store, notify = async () => {}, now = () => new Date() }) {
    this.connector = connector;
    this.store = store;
    this.notify = notify;
    this.now = now;
  }

  async send(value, raw, options = {}) {
    const mailbox = normalizeMailbox(value);
    // ESP 2: one text/plain part and nothing that tracks, read back from the
    // finished message — whatever built it, a letter that is not plain stops
    // here, before Google is asked anything.
    assertPlainLetter(raw);
    const paused = await this.store.pausedFor(mailbox);
    if (paused) throw new SenderPaused(mailbox, paused);
    try {
      return await this.connector.send(mailbox, raw, options);
    } catch (error) {
      if (!isAuthFailure(error)) throw error;
      const pause = await this.store.pause(mailbox, {
        code: error.code,
        status: error.status ?? null,
        reason: error.message,
        at: this.now().toISOString()
      });
      // Said to a person once, when the pause starts — not on every refusal
      // after it.
      await this.notify({ mailbox, ...pause }).catch(() => {});
      throw new SenderPaused(mailbox, pause);
    }
  }

  async resume(value) {
    return this.store.resume(normalizeMailbox(value));
  }

  async paused() {
    return this.store.list();
  }
}
