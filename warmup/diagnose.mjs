/**
 * What LinkedIn actually showed when the agent did not get to the feed, read
 * from the screenshot by a model (власник 30.10: «чому цю інфу точну з скріна
 * не проаналізувати через апі аі і точно не писати причину»). The agent's own
 * markers only know «a login form is on the page»; a restriction notice, a
 * verification step, a password page and an error page all came out as
 * «LinkedIn просить увійти».
 *
 * One sentence for a person, plus the kind, from what is on the screen and
 * nothing else. Without a key, or when the model fails, the caller keeps the
 * agent's own note.
 */

export const DIAGNOSE_KINDS = ["password", "login", "verification", "captcha", "restricted", "banned", "error", "other"];

const PROMPT = `Це знімок вкладки LinkedIn у серверному браузері, який мав відкрити стрічку LinkedIn, але не відкрив. Під знімком — текст сторінки і її адреса.
Скажи, що саме показує LinkedIn, лише з того, що видно на знімку й у тексті; нічого не вигадуй і не здогадуйся про причини, яких не видно.
Поверни лише JSON без пояснень:
{"kind": "password" | "login" | "verification" | "captcha" | "restricted" | "banned" | "error" | "other", "sentence": "..."}
kind:
- password — сторінка «З поверненням» з іменем акаунта і полем пароля (сесію завершено, треба ввести пароль);
- login — порожня форма входу (email і пароль);
- verification — LinkedIn просить код, підтвердження телефону чи пошти, перевірку безпеки;
- captcha — капча чи «підтвердьте, що ви людина»;
- restricted — акаунт тимчасово обмежено (restricted, temporarily limited, обмежено);
- banned — акаунт заблоковано чи закрито назавжди;
- error — сторінка помилки, порожня сторінка, сайт не завантажився;
- other — щось інше.
sentence — одне речення українською для людини, яка не бачила знімка: що показує LinkedIn і що потрібно зробити (наприклад: «LinkedIn завершив сесію й просить пароль для Mary Lindsay — треба увійти в профілі»). Без технічних слів і адрес, до 200 символів.`;

/** The JSON object in a model answer, or null. */
export function parseDiagnosis(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[0]);
    const sentence = String(data.sentence || "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!sentence) return null;
    return { kind: DIAGNOSE_KINDS.includes(data.kind) ? data.kind : "other", sentence };
  } catch {
    return null;
  }
}

/**
 * One question to the model with a picture (optional) and text; the answer's
 * text, or null. Never throws — a failure is said through `onFail`.
 */
async function askModel({ shot = null, prompt }, {
  key = String(process.env.ANTHROPIC_API_KEY || "").trim(),
  model = String(process.env.ANTHROPIC_DIAGNOSE_MODEL || "").trim() || "claude-sonnet-5-5",
  fetchImpl = fetch,
  timeoutMs = 45000,
  onFail = (why) => console.warn(`[diagnose] ${why}`)
} = {}) {
  if (!key) return null;
  const content = [
    ...(shot ? [{ type: "image", source: { type: "base64", media_type: String(shot).startsWith("iVBOR") ? "image/png" : "image/jpeg", data: shot } }] : []),
    { type: "text", text: prompt }
  ];
  try {
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      // Room for the thinking that comes before the answer: with 2000 the
      // failure explanation (longer input) came back with no text at all (03.11).
      body: JSON.stringify({ model, max_tokens: 8000, output_config: { effort: "low" }, messages: [{ role: "user", content }] }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      onFail(`HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const payload = await response.json();
    const text = (payload.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
    if (!text) onFail(`empty answer (stop_reason ${payload.stop_reason}, ${payload.usage?.output_tokens ?? "?"} tokens out)`);
    return text;
  } catch (error) {
    onFail(error?.message || String(error));
    return null;
  }
}

/**
 * Ask the model. `shot` is a base64 JPEG/PNG of the tab, `text` the page's
 * innerText. Resolves to { kind, sentence } or null; never throws.
 */
export async function diagnoseScreen({ shot, text = "", url = "" }, options = {}) {
  if (!shot) return null;
  const onFail = options.onFail ?? ((why) => console.warn(`[diagnose] ${why}`));
  const answer = await askModel({ shot, prompt: `${PROMPT}\n\nАдреса: ${String(url).slice(0, 300)}\nТекст сторінки:\n${String(text).slice(0, 3000)}` }, { ...options, onFail });
  if (answer == null) return null;
  const seen = parseDiagnosis(answer);
  if (!seen) onFail(`no JSON in the answer: ${answer.slice(0, 200)}`);
  return seen;
}

const EXPLAIN_PROMPT = `Це звіт системи моніторингу внутрішнього інструменту команди продажів. Робоча сесія браузера для одного з акаунтів команди завершилась помилкою, і керівнику треба коротко пояснити, що сталося. Нижче — текст помилки, журнал сесії, що система вже зробила сама, і знімок екрана в момент помилки (якщо є).
Поверни лише JSON без пояснень:
{"cause": "...", "next": "..."}
cause — одне-два речення українською простими словами: що саме пішло не так, з того, що видно на знімку й у даних; нічого не вигадуй; без технічних слів, назв файлів і адрес.
next — одне речення: що система зробить далі сама; і лише якщо без людини ніяк — яку саму дію має зробити людина (наприклад, увійти в акаунт у його профілі браузера). Не проси «перевірити» чи «глянути».`;

/** { cause, next } from a JSON answer, or null. */
export function parseExplanation(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[0]);
    const cause = String(data.cause || "").replace(/\s+/g, " ").trim().slice(0, 400);
    const next = String(data.next || "").replace(/\s+/g, " ").trim().slice(0, 300);
    return cause ? { cause, next } : null;
  } catch {
    return null;
  }
}

/**
 * Why a session failed, said by the model from everything the worker has:
 * the error, the session's own record, what was already done, the screenshot
 * (власник 03.11: «аі має всюди бути запхана де тільки можна спростити життя людині»).
 */
export async function explainFailure({ shot = null, label = "", error = "", record = "", done = "" }, options = {}) {
  const onFail = options.onFail ?? ((why) => console.warn(`[diagnose] ${why}`));
  // The screenshot is read on its own first and handed over as words: the
  // picture of a sign-in page in the same question as «why did the session
  // fail» was refused outright (03.11, stop_reason refusal), the reading of the
  // screen alone never was.
  const seen = shot ? await diagnoseScreen({ shot, text: error }, { ...options, onFail }) : null;
  const ask = async (screen) => {
    const prompt = `${EXPLAIN_PROMPT}\n\nАкаунт: ${String(label).slice(0, 100)}\nПомилка: ${String(error).slice(0, 600)}\nЩо система вже зробила: ${String(done || "нічого").slice(0, 300)}\nНа знімку екрана: ${screen || "знімка немає"}\nЖурнал сесії:\n${String(record).slice(0, 4000)}`;
    const answer = await askModel({ prompt }, { ...options, onFail });
    const said = answer == null ? null : parseExplanation(answer);
    if (answer != null && !said) onFail(`no JSON in the answer: ${answer.slice(0, 200)}`);
    return said;
  };
  // A refusal is not the end: once more without the screen's words, and at
  // worst the screen's own reading is the cause (03.11: a sign-in page's
  // words were refused one time in two).
  return await ask(seen?.sentence) ?? (seen ? await ask("") : null) ?? (seen ? { cause: seen.sentence, next: "" } : null);
}
