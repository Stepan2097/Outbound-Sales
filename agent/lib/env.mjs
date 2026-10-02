import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Shell values win. This loads configuration, never the archived credentials.
for (const name of ['.env.local', '.env']) {
  const file = path.join(repo, name);
  if (!fs.existsSync(file)) continue;
  if (process.loadEnvFile) {
    const before = { ...process.env };
    process.loadEnvFile(file);
    for (const [key, value] of Object.entries(before)) process.env[key] = value;
  }
}
export const DEFAULT_PORTAL = process.env.WARMUP_PORTAL || 'http://127.0.0.1:4173';
export const CHROME_PATH = process.env.WARMUP_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
