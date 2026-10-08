/**
 * The group chat, and nothing else.
 *
 * One account going quiet is not a server problem — it is a person problem: the
 * session died and only a human with the password can bring it back. So the
 * one thing this file does is put that sentence where that human already
 * looks, with a button that says "done, carry on".
 *
 * The token never reaches this file from the code: it comes from the
 * environment the container was started with, which on the server is a
 * mode-600 file. An unconfigured watcher is not an error — it says so once and
 * keeps checking, because the checking is useful on its own.
 *
 * **This file only sends. It must never call `getUpdates`, and nothing here
 * may be given a webhook.** On 08.10.2026 it did poll, for a callback button,
 * and that broke something nobody expected: `getUpdates` is exclusive per bot
 * and acknowledges *every* update up to its offset, so the owner's own replies
 * to another chat on the same bot were swallowed and never reached the chat
 * they were meant for. `allowed_updates` does not save them — updates of
 * types left out are dropped, not queued. A bot shared with anything else can
 * therefore only be written to, never read from. A button that needs a
 * callback needs a bot of its own.
 */
const API = 'https://api.telegram.org';

export class Telegram {
  constructor({ token = process.env.TELEGRAM_BOT_TOKEN ?? '', chatId = process.env.TELEGRAM_LOGIN_CHAT_ID ?? '', fetchImpl = fetch, timeoutMs = 20000 } = {}) {
    this.token = String(token || '').trim();
    this.chatId = String(chatId || '').trim();
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get configured() { return Boolean(this.token && this.chatId); }

  async #call(method, payload, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    const response = await this.fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.json().catch(() => ({}));
    if (!body?.ok) throw new Error(`Telegram ${method}: ${body?.description || `HTTP ${response.status}`}`);
    return body.result;
  }

  /**
   * A line in the group. `button` is one inline button that opens a link —
   * `{ text, url }` — or nothing.
   *
   * A link button is the only kind this may use: pressing it opens a page and
   * tells Telegram nothing, so no part of this needs to read the bot's
   * updates. See the note at the top of the file.
   */
  send(text, button = null) {
    if (button && !button.url) throw new Error('Only link buttons are allowed — a callback button would need getUpdates');
    return this.#call('sendMessage', {
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
      ...(button ? { reply_markup: { inline_keyboard: [[{ text: button.text, url: button.url }]] } } : {})
    });
  }

}
