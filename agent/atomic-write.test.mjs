import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeFileAtomicSync } from './lib/atomic-write.mjs';

// The watch keeps a small file of what it has already said. A write that dies
// half-way used to leave a cut JSON, which `readState` took for "never said
// anything" — and the watch said it all again. Whatever happens in the middle,
// the file on disk is the old whole or the new whole.

const previous = JSON.stringify({ day: '2026-10-07', told: ['acc-47'] });
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-agent-atomic-'));

test('a successful write replaces the file and leaves nothing behind', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'login-watch.json');
  fs.writeFileSync(file, previous);
  writeFileAtomicSync(file, JSON.stringify({ day: '2026-10-08', told: [] }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { day: '2026-10-08', told: [] });
  assert.deepEqual(fs.readdirSync(dir), ['login-watch.json']);
});

test('a write that dies half-way leaves the previous file and no temp file', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'login-watch.json');
  fs.writeFileSync(file, previous);
  // The disk fills up after half of the data — the case the old write turned
  // into a cut file.
  const full = {
    ...fs,
    writeFileSync: (fd, data) => {
      fs.writeSync(fd, String(data).slice(0, Math.floor(String(data).length / 2)));
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
  };
  assert.throws(() => writeFileAtomicSync(file, JSON.stringify({ day: 'new', told: new Array(500).fill('acc') }), { fs: full }), /ENOSPC/);
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  assert.deepEqual(fs.readdirSync(dir), ['login-watch.json']);
});

test('a rename that fails leaves the previous file and no temp file', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'login-watch.json');
  fs.writeFileSync(file, previous);
  const broken = { ...fs, renameSync: () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); } };
  assert.throws(() => writeFileAtomicSync(file, JSON.stringify({ day: 'new' }), { fs: broken }), /EIO/);
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  assert.deepEqual(fs.readdirSync(dir), ['login-watch.json']);
});

// A smoke test: a kill lands at a random moment, so on its own it cannot prove
// the property — the two tests above do that deterministically.
test('a process killed mid-write leaves a file that still parses', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'login-watch.json');
  fs.writeFileSync(file, previous);
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeFileAtomicSync } from ${JSON.stringify(new URL('./lib/atomic-write.mjs', import.meta.url).href)};
    const big = JSON.stringify({ day: 'new', told: Array.from({ length: 200000 }, (_, i) => 'acc-' + i) });
    process.stdout.write('ready\\n');
    for (;;) writeFileAtomicSync(${JSON.stringify(file)}, big);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => writer.stdout.once('data', resolve));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const exited = new Promise((resolve) => writer.once('exit', resolve));
  writer.kill('SIGKILL');
  await exited;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.day === '2026-10-07' || saved.told.length === 200000, 'either the old or the new file, never a cut one');
});
