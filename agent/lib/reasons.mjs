/**
 * Why a session failed, said to a person (власник 28.10: «де нормальні
 * причини?»): «The operation was aborted due to timeout» told nobody that the
 * server's Anty had run out of memory under a browser left open for two hours.
 * A message nobody has a sentence for goes through as it is, after the known ones.
 */
const KNOWN = [
  [/aborted due to timeout|Anty API: .*timeout|ETIMEDOUT/i,
    'серверна Anty не відповіла вчасно — вона зависла або їй забракло пам\'яті (зазвичай через браузер, що лишився відкритим після попередньої сесії)'],
  [/is already running in Anty|Profile is still starting|belongs to another browser session/i,
    'профіль уже відкритий на сервері — попередня сесія не закрила браузер'],
  [/Target crashed|Page crashed|has been closed|Target page, context or browser has been closed/i,
    'вкладка браузера впала посеред сесії — найчастіше браузеру забракло пам\'яті'],
  [/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|проксі .* не відповідає/i,
    'проксі профілю не відповідає — LinkedIn не відкривали'],
  [/not available in this server scope/i,
    'профілю немає на серверній Anty і в хмарі Anty теж (видалений або в іншій команді)'],
  [/Cloud profile unavailable/i,
    'хмара Anty не віддала профіль — сервер не стартує на старій копії, спробує ще'],
  [/has no proxy/i,
    'у профілю немає проксі — без нього сервер LinkedIn не відкриває'],
  [/не залогінено|login form|сторінка входу/i,
    'LinkedIn вийшов із сесії — потрібен вхід у цьому профілі'],
  [/checkpoint|captcha/i,
    'LinkedIn просить підтвердити, що це ви (код, капча або перевірка безпеки)'],
  [/сесію зупинено сторожем/i,
    'сесія йшла довше 40 хв і її зупинено — браузер завис'],
];

export function humanReason(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'сесія завершилась з помилкою, а причини агент не записав';
  for (const [pattern, said] of KNOWN) if (pattern.test(text)) return said;
  return text.slice(0, 300);
}
