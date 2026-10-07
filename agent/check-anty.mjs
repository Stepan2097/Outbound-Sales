// Read-only connectivity/session check. Never sends requests, likes or messages,
// and does not open the messenger or claim a production scheduler lease.
import './lib/env.mjs';
import { chromium } from 'playwright-core';
import { AntyApi } from './lib/anty-api.mjs';
const profileId = process.argv[process.argv.indexOf('--profile') + 1];
if (!process.argv.includes('--profile') || !profileId || !process.env.WARMUP_ANTY_API) {
  console.error('usage: WARMUP_ANTY_API=http://127.0.0.1:3032 node agent/check-anty.mjs --profile <cloud-id> [--linkedin]');
  process.exit(2);
}
let session;
try {
  session = await new AntyApi(process.env.WARMUP_ANTY_API).open(profileId, chromium);
  const page = session.context.pages()[0] || await session.context.newPage();
  await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 45000 });
  const ip = JSON.parse(await page.locator('body').innerText()).ip;
  const report = { profile: session.profile.name, proxyReachable: Boolean(ip), linkedinChecked: false };
  if (process.argv.includes('--linkedin')) {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 20; i += 1) {
      const state = await page.evaluate(() => ({
        loginForm: Boolean(document.querySelector('input#username,input[name="session_key"],input[name="session_password"]')),
        signedInNav: Boolean(document.querySelector('a[href*="/mynetwork"],.search-global-typeahead__input')),
        checkpoint: /\/checkpoint\//.test(location.pathname),
      })).catch(() => null);
      if (state?.loginForm || state?.checkpoint || state?.signedInNav) {
        Object.assign(report, { linkedinChecked: true, ...state });
        break;
      }
      await page.waitForTimeout(1500);
    }
    if (!report.linkedinChecked) report.reason = 'No conclusive login marker; manual verification required';
  }
  console.log(JSON.stringify(report));
  if (process.argv.includes('--linkedin') && (!report.signedInNav || report.loginForm || report.checkpoint)) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await session?.close().catch(error => { console.error(`Cleanup failed: ${error.message}`); process.exitCode = 1; }); }
