#!/usr/bin/env node
/**
 * The watch, as a process.
 *
 *   node agent/login-watch.mjs            # runs until stopped
 *   node agent/login-watch.mjs --once     # one pass, for a cron or by hand
 *
 * Needs `WARMUP_PORTAL` and `WARMUP_AGENT_TOKEN` to read accounts and write
 * health, `WARMUP_ANTY_API` to open a profile, and — to say anything —
 * `TELEGRAM_BOT_TOKEN` with `TELEGRAM_LOGIN_CHAT_ID`. Without the last two it
 * still checks and still un-pauses what recovered; it just stays silent, and
 * says so once on startup.
 *
 * Deliberately separate from `worker.mjs`: the worker is the hands of the
 * schedule and must not be delayed by a profile nobody can open, and this one
 * must keep looking at exactly the accounts the schedule refuses to hand out.
 * They share the runtime, so only one of them may hold a profile at a time —
 * which is why a parked account, the only kind this opens, is the safe set.
 */
import './lib/env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { DEFAULT_PORTAL } from './lib/env.mjs';
import { Portal } from './lib/portal.mjs';
import { AntyApi } from './lib/anty-api.mjs';
import { Telegram } from './lib/telegram.mjs';
import { probeLogin } from './lib/login-probe.mjs';
import { checkParked, handlePresses, normalizeState } from './lib/login-watch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const ONCE = argv.includes('--once');
const PORTAL = arg('portal', DEFAULT_PORTAL);
const GAP_MS = Math.max(15, Number(arg('gap', 60)) || 60) * 1000;
const STATE_PATH = arg('state', path.join(here, 'runs', 'login-watch.json'));

const log = (...parts) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...parts);
const today = () => new Date().toISOString().slice(0, 10);

function readState() {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')));
  } catch {
    return normalizeState(null);
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch (error) {
    log(`не зміг зберегти стан вартового: ${error.message}`);
  }
}

const portal = new Portal(PORTAL);
const telegram = new Telegram();
const antyApi = process.env.WARMUP_ANTY_API ? new AntyApi(process.env.WARMUP_ANTY_API) : null;

const probe = async (account) => {
  if (!antyApi) throw new Error('WARMUP_ANTY_API не заданий — нема де відкрити профіль');
  return probeLogin({ api: antyApi, chromium, profileRemoteId: account.profileRemoteId });
};

let stopping = false;
let wake = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) process.exit(0);
    stopping = true;
    log(`отримав ${signal} — зупиняюсь`);
    wake?.();
  });
}
const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(() => { wake = null; resolve(); }, ms);
  wake = () => { clearTimeout(timer); wake = null; resolve(); };
});

log(`вартовий входу — портал ${PORTAL}`);
log(`токен: ${process.env.WARMUP_AGENT_TOKEN?.trim() ? 'є' : 'НЕМА — портал відповідатиме 401'}`);
log(telegram.configured
  ? 'Telegram: налаштований'
  : 'Telegram: не налаштований (TELEGRAM_BOT_TOKEN / TELEGRAM_LOGIN_CHAT_ID) — перевіряю молча');

let lastReason = null;
do {
  const state = readState();
  try {
    const pressed = await handlePresses({ portal, telegram, probe, state, log });
    if (pressed.presses) log(`кнопка: натискань ${pressed.presses}, відновлено ${pressed.restored}`);
    const checked = await checkParked({ portal, telegram, probe, state, today: today(), log });
    if (checked.checked || checked.parked !== 0) {
      const line = `на паузі ${checked.parked}, перевірено сьогодні ${checked.checked}, відновлено ${checked.restored}, у групу ${checked.announced}`;
      if (line !== lastReason) { log(line); lastReason = line; }
    }
  } catch (error) {
    log(`коло не вдалося: ${error.message}`);
  }
  writeState(state);
  if (!ONCE && !stopping) await sleep(GAP_MS);
} while (!ONCE && !stopping);
