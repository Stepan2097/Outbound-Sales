# ESP — журнал і реєстр (ESP 9)

Власний ESP для холодних листів. Ця тека — дані: журнал, який лише дописується,
точний текст кожного відправленого листа і реєстр доменів та відправників.
Підключення пошти, сам лист, ліміти й ланцюжок (ESP 1–5) пишуть **сюди** і
тільки через функції нижче.

## Журнал (`journal.mjs`)

- Файл JSON-рядків поруч зі станом робочого простору: `ESP_JOURNAL_PATH`, інакше
  `esp-journal.jsonl` у теці `STATE_FILE_PATH` (на проді — `/data`, той самий том).
- Лише дописування: `O_APPEND`, один рядок одним записом, `datasync` до відповіді.
  Немає ні функції, ні маршруту, що змінює чи видаляє рядок. Виправлення — нова подія.
- Ланцюг SHA-256: кожен рядок несе `prev` (хеш попереднього) і `hash`. `verify()`
  (і `GET /api/esp/journal/verify`) каже, де ланцюг порушено. Обірваний аварією
  останній рядок лишається у файлі й видимий, журнал іде далі з останнього цілого.
- Подія: `{ seq, at, type, actor, contact, data, prev, hash }`; `contact` — адреса в
  нижньому регістрі, коли подія про одну людину (за нею читається хронологія).

## Відправка — лише так (`messages.mjs`)

```js
import { recordSending, recordSent, recordFailed, recordAboutContact } from "./esp/messages.mjs";

const sending = await recordSending({ from, to, subject, text, headers, campaignId, step, leadId }, actor);
// …тепер і лише тепер — виклик провайдера з РІВНО цими subject/text/headers…
await recordSent(sending, { messageId, threadId });      // провайдер прийняв
// або
await recordFailed(sending, { error });                   // не пішло
```

- `recordSending` відмовляє (і нічого не пише), якщо відправника немає в реєстрі,
  він на паузі/виведений (сам чи разом із доменом), адреса не адреса, лист порожній
  або в тексті є HTML. Записує тему, `text/plain` тіло й заголовки **байт у байт** і
  їхній SHA-256 (`contentHash`).
- `recordSent` прив'язаний до спроби: той самий `hash`, `sendingSeq`, id провайдера.
- Інше про людину — `recordAboutContact(type, email, data)`: `message.replied`,
  `message.bounced`, `contact.unsubscribed`, `contact.skipped` (ESP 6: перевірка сказала
  «ні»), `contact.note`. «Надіслано» цим шляхом записати не можна.

## Реєстр (`registry.mjs`)

Домени й відправники — це журнал, складений докупи (`registry()`), тож кожна зміна
має автора, час і причину. Стани: `active`, `paused` (потрібна причина), `retired`
(назавжди; виведений домен виводить своїх відправників). `canSend(email)` — чи може
ця адреса надсилати зараз. У відправника лише `mailboxRef` — **назва** змінної
середовища з доступом (напр. `GMAIL_MARY_TOKEN`), ніколи сам ключ. `checkDomain`
читає з DNS MX, SPF, DMARC (з політикою) і DKIM за селектором і записує знайдене.

## Маршрути (`data-api.mjs` — гілка в `esp/api.mjs`, `/api/esp`)

| | |
|---|---|
| `GET /registry` | домени й відправники (кожен) |
| `GET /contacts/timeline?email=` | уся пошта людини від найстарішого, з точним текстом (кожен) |
| `GET /journal?type=&contact=&limit=&before=` | журнал, найновіше першим (адміністратор) |
| `GET /journal/verify` | цілість ланцюга (адміністратор) |
| `POST /domains`, `/domains/status`, `/domains/check`, `/senders`, `/senders/status` | зміни реєстру (адміністратор) |

На екрані: «Налаштування» → «Пошта: домени й відправники»; картка контакта →
розділ «Пошта».
