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

  /** A line in the group. `button` is one inline button, or nothing. */
  send(text, button = null) {
    return this.#call('sendMessage', {
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
      ...(button ? { reply_markup: { inline_keyboard: [[{ text: button.text, callback_data: button.data }]] } } : {})
    });
  }

  /**
   * Callback presses since the last one we took, and the offset to ask with
   * next time. Long polling with a short timeout: the watcher has its own
   * sleep and a request that hangs for a minute hides a crash for a minute.
   */
  async callbacks(offset = 0) {
    const updates = await this.#call('getUpdates', {
      offset, timeout: 0, allowed_updates: ['callback_query']
    }, { timeoutMs: 25000 });
    const rows = Array.isArray(updates) ? updates : [];
    const next = rows.reduce((highest, update) => Math.max(highest, Number(update.update_id) + 1), offset);
    return {
      offset: next,
      presses: rows.map((update) => update.callback_query).filter(Boolean).map((query) => ({
        id: query.id,
        data: String(query.data || ''),
        from: String(query.from?.first_name || query.from?.username || 'хтось')
      }))
    };
  }

  /** The grey toast on the button the person just pressed. */
  answer(id, text) {
    return this.#call('answerCallbackQuery', { callback_query_id: id, text: text.slice(0, 190) });
  }
}
