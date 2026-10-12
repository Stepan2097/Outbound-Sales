// The cold-email screens (ESP): one entry for main.js, each part its own module.
// «Кампанії» — the list, the builder and the letter editor (mail-campaigns.js,
// ESP-UI 1–3, with templates, the signature, limits and alarms); Налаштування → «Пошта для
// розсилки» — the mailboxes (ESP 1); the domain and sender registry (ESP 9);
// rights, the administrators' log and the secrets' status (ESP 10); reports
// and how long a lead's data is kept (ESP 16); a person's request about their
// data (ESP 17).
import "./esp-mailboxes.js";
import "./esp-registry.js";
import "./esp-access.js";
import "./esp-filters.js";
import "./esp-privacy.js";
import "./mail-campaigns.js";
import "./esp-inbox.js";
import "./esp-conversations.js";
import "./esp-reports.js";
