// Read-only: what the agent would press to send a connection request to one
// person, on the live page, in one account's Anty browser. Clicks nothing.
//   WARMUP_ANTY_API=http://127.0.0.1:3032 node agent/check-connect.mjs --profile <cloud-id> --slug <linkedin-slug> --name "<Full Name>"
import './lib/env.mjs';
import { chromium } from 'playwright-core';
import { AntyApi } from './lib/anty-api.mjs';
import { inspectConnect } from './lib/connections.mjs';

const arg = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const profileId = arg('--profile');
const slugs = (arg('--slug') || '').split(',').filter(Boolean);
const names = (arg('--name') || '').split(',');
if (!profileId || !slugs.length || !process.env.WARMUP_ANTY_API) {
  console.error('usage: WARMUP_ANTY_API=http://127.0.0.1:3032 node agent/check-connect.mjs --profile <cloud-id> --slug <a,b> --name "<A>,<B>"');
  process.exit(2);
}
let session;
try {
  session = await new AntyApi(process.env.WARMUP_ANTY_API).open(profileId, chromium);
  const page = session.context.pages()[0] || await session.context.newPage();
  for (const [index, slug] of slugs.entries()) {
    const invite = { linkedin: `https://www.linkedin.com/in/${slug}/`, name: (names[index] || '').trim() };
    const report = await inspectConnect(page, invite).catch((error) => ({ slug, error: error.message }));
    console.log(JSON.stringify(report));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await session?.close().catch(() => {}); }
