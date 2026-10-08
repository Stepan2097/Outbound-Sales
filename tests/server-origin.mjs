/**
 * Адреса сервера, який слухає порт, що йому дала ОС.
 *
 * Тести колись брали фіксовані порти (43xxx), і коли два чати ганяли npm test
 * одночасно, вони билися за ті самі числа та давали хибні червоні — на кшталт
 * «збагачення не шукається вдруге», яке ніякого стосунку до збагачення не мало.
 * Тепер сервер запускається з PORT=0, а справжній порт береться з рядка, який
 * він друкує, коли почав слухати: «… running at http://localhost:<порт>».
 *
 * Для цього стандартний вивід сервера має бути каналом (`stdio: ["ignore",
 * "pipe", …]`). Після того як адресу прочитано, вивід і далі вичитується в
 * нікуди: сервер, чий канал ніхто не читає, рано чи пізно став би на запису.
 *
 * Не завершується на успіх без рядка: якщо сервер вийшов або мовчить довше за
 * `timeoutMs`, це помилка з хвостом його виводу, а не нескінченне очікування.
 */
export function listeningOrigin(child, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let seen = "";
    const settle = (finish, value) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      finish(value);
    };
    const onData = (chunk) => {
      seen += chunk;
      const match = /running at http:\/\/localhost:(\d+)/.exec(seen);
      if (!match) return;
      settle(resolve, `http://127.0.0.1:${match[1]}`);
      child.stdout.resume();
    };
    const onExit = (code, signal) => settle(reject, new Error(`server.mjs вийшов (${code ?? signal}), так і не почавши слухати: ${seen.slice(-300)}`));
    const timer = setTimeout(() => settle(reject, new Error(`server.mjs не почав слухати за ${timeoutMs} мс: ${seen.slice(-300)}`)), timeoutMs);
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}
