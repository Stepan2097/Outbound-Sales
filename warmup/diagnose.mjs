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
 * Ask the model. `shot` is a base64 JPEG/PNG of the tab, `text` the page's
 * innerText. Resolves to { kind, sentence } or null; never throws.
 */
export async function diagnoseScreen({ shot, text = "", url = "" }, {
  key = String(process.env.ANTHROPIC_API_KEY || "").trim(),
  model = String(process.env.ANTHROPIC_DIAGNOSE_MODEL || "").trim() || "claude-sonnet-5-5",
  fetchImpl = fetch,
  timeoutMs = 45000
} = {}) {
  if (!key || !shot) return null;
  const mediaType = String(shot).startsWith("iVBOR") ? "image/png" : "image/jpeg";
  try {
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        output_config: { effort: "low" },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: shot } },
            { type: "text", text: `${PROMPT}\n\nАдреса: ${String(url).slice(0, 300)}\nТекст сторінки:\n${String(text).slice(0, 3000)}` }
          ]
        }]
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return parseDiagnosis((payload.content || []).filter((block) => block.type === "text").map((block) => block.text).join(""));
  } catch {
    return null;
  }
}
