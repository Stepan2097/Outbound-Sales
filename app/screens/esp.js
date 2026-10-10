// The cold-email screens (ESP): one entry for main.js, each part its own module.
// Листи — templates and the signature (ESP 2); Налаштування → «Пошта для
// розсилки» — the mailboxes (ESP 1); the domain and sender registry (ESP 9);
// rights, the administrators' log and the secrets' status (ESP 10).
import "./esp-mailboxes.js";
import "./esp-registry.js";
import "./esp-access.js";
import "./esp-templates.js";
import "./esp-limits.js";
import "./esp-campaigns.js";
import "./esp-inbox.js";
