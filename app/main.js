// The page's entry: the shell and the five screens, then the workspace starts.
// Each screen registers itself with the shell when it loads, so importing it
// is all it takes; the badge and the boot wait until every screen is here.
import { bootApplication } from "./core.js";
import "./screens/home.js";
import "./screens/warmup-accounts.js";
import "./screens/warmup-campaign.js";
import { startWarmupBadge } from "./screens/inbox.js";
import "./screens/contacts.js";
import "./screens/settings.js";
import "./screens/esp-mailboxes.js";
import "./screens/esp-registry.js";

startWarmupBadge();
await bootApplication();
