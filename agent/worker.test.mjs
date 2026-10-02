/**
 * The loop, against a server that misbehaves on purpose.
 *
 *   node --test agent/worker.test.mjs
 *
 * What is being proved here is not that the worker can run an account — it is
 * that it keeps running when things go wrong, which is the only property that
 * matters in a process meant to stay up for weeks. So every case below is a
 * failure of some kind: a 500, a dropped socket, a server that is not there at
 * all, a run that exits 1, a report the server refuses. The happy path is one
 * test and the least interesting one.
 *
 * Nothing here opens a browser or touches LinkedIn. The worker is started with
 * `--run-account` pointed at `fixtures/stub-run-account.mjs`, which exits with
 * the code the case needs and opens nothing — the real script would open a real
 * warming profile outside its window, and that is the signal the whole folder
 * exists to avoid. The server is `fake-scheduler.mjs`, which answers the
 * documented shapes and can be told to fall over.
 *
 * The last two tests keep the rest honest: they ask the real backend for a real
 * answer and compare its fields with the fake's, because a fake that has drifted
 * from the server is worse than no test at all. They skip, and say so, when it
 * is not up. They take no lease and write nothing — asking is free now, which it
 * was not this morning.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFake, REASONS } from './fake-scheduler.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, 'worker.mjs');
const STUB = path.join(here, 'fixtures', 'stub-run-account.mjs');
const TOKEN = 'fake-token-for-tests';

const REAL = process.env.WARMUP_REAL_PORTAL ?? 'http://127.0.0.1:4230';
const REAL_TOKEN = process.env.WARMUP_REAL_TOKEN ?? 'probe-token-local';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a worker and watch what it says.
 *
 * Its log is the interface under test: the dedup rule, the reasons, the
 * outcome of a run and the pauses are all things a person reads in this file
 * and nowhere else, so asserting on the text is asserting on the thing that
 * was actually specified.
 */
function startWorker({ portal, env = {}, args = [], runAccount = STUB } = {}) {
  const child = spawn(
    process.execPath,
    [WORKER, '--portal', portal, '--run-account', runAccount, '--offline-first', '1', ...args],
    {
      cwd: path.resolve(here, '..'),
      env: { ...process.env, WARMUP_AGENT_TOKEN: TOKEN, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  return {
    child,
    out: () => out,
    /** Wait for a line to appear, or fail with the whole log, which is the useful part. */
    async until(pattern, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(out)) return out;
        if (child.exitCode !== null) break;
        await wait(50);
      }
      assert.fail(`не дочекався ${pattern} за ${timeoutMs} мс${child.exitCode !== null ? ` (воркер вийшов з кодом ${child.exitCode})` : ''}\n--- log ---\n${out}`);
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((r) => { child.on('close', r); setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000); });
    },
  };
}

const count = (text, needle) => text.split(needle).length - 1;

describe('worker', () => {
  test('sleeps for exactly as long as the server says, and not for a length of its own', async () => {
    // Two servers, identical but for one number. If the worker had any pacing
    // of its own left in it, the two would poll the same number of times.
    const fast = await startFake({ script: [{ reason: REASONS.nothing, retryAfterSeconds: 1 }], token: TOKEN });
    const slow = await startFake({ script: [{ reason: REASONS.nothing, retryAfterSeconds: 60 }], token: TOKEN });
    const a = startWorker({ portal: fast.url });
    const b = startWorker({ portal: slow.url });
    try {
      await a.until(/nothing owes work today/);
      await b.until(/nothing owes work today/);
      await wait(3200);
      assert.ok(fast.polls() >= 3, `очікував ≥3 запити за 3 с при retryAfterSeconds=1, було ${fast.polls()}`);
      assert.ok(fast.polls() <= 6, `очікував ≤6 запитів, було ${fast.polls()} — воркер не спить скільки сказано`);
      assert.equal(slow.polls(), 1, 'при retryAfterSeconds=60 має бути рівно один запит за перші три секунди');
    } finally {
      await a.stop(); await b.stop(); await fast.stop(); await slow.stop();
    }
  });

  test('says a repeated reason once, and again only when it changes', async () => {
    const fake = await startFake({
      script: [
        ...Array(5).fill({ reason: REASONS.outside, retryAfterSeconds: 1, open: false }),
        { reason: REASONS.coolOff('Chloe Stewart'), retryAfterSeconds: 1 },
      ],
      token: TOKEN,
    });
    const worker = startWorker({ portal: fake.url });
    try {
      await worker.until(/is in cool-off/);
      const log = worker.out();
      assert.equal(count(log, REASONS.outside), 1,
        `«${REASONS.outside}» мало бути один раз, а було ${count(log, REASONS.outside)} — саме це й є той лог, який ніхто не читає:\n${log}`);
      // And the silence is accounted for rather than simply lost.
      assert.match(log, /↑ те саме ще \d+ раз/);
      assert.ok(fake.polls() >= 5, 'воркер мав опитати сервер більше разів, ніж написав рядків');
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('survives a 500 and keeps asking', async () => {
    const fake = await startFake({
      script: [{ status: 500 }, { status: 500 }, { reason: REASONS.nothing, retryAfterSeconds: 1 }],
      token: TOKEN,
    });
    const worker = startWorker({ portal: fake.url });
    try {
      await worker.until(/nothing owes work today/);
      assert.match(worker.out(), /сервер відмовив/);
      assert.equal(worker.child.exitCode, null, 'воркер не має виходити через 500');
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('survives a socket that dies mid-answer', async () => {
    const fake = await startFake({
      script: [{ close: true }, { reason: REASONS.nothing, retryAfterSeconds: 1 }],
      token: TOKEN,
    });
    const worker = startWorker({ portal: fake.url });
    try {
      await worker.until(/nothing owes work today/);
      assert.match(worker.out(), /сервер недоступний/);
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('survives the server not being there at all, and recovers when it comes back', async () => {
    // The case the whole first constraint is about: the Mac wakes before the
    // network does, or the server is redeployed mid-morning. The worker must
    // still be running when it returns — and must not have decided, while
    // nothing answered, that it is talking to the other portal.
    const probe = await startFake({ token: TOKEN });
    const port = probe.port;
    await probe.stop();

    const worker = startWorker({ portal: `http://127.0.0.1:${port}` });
    let fake = null;
    try {
      await worker.until(/сервер недоступний/);
      await wait(1500);
      assert.equal(worker.child.exitCode, null, 'воркер вийшов, коли сервера не було — саме те, чого не можна');

      fake = await startFake({ script: [{ reason: REASONS.nothing, retryAfterSeconds: 1 }], token: TOKEN, port });
      await worker.until(/nothing owes work today/, 20_000);
      assert.ok(fake.requests.every((r) => r.path.startsWith('/api/warmup/agent')),
        `воркер пішов не на той префікс: ${JSON.stringify(fake.requests.map((r) => r.path))}`);
    } finally {
      await worker.stop(); await fake?.stop();
    }
  });

  test('runs the account it was handed and reports a success', async () => {
    const fake = await startFake({
      script: [{ next: true }, { reason: REASONS.nothing, retryAfterSeconds: 60 }],
      token: TOKEN,
      finished: { nextInSeconds: 2 },
    });
    const worker = startWorker({ portal: fake.url, env: { STUB_EXIT: '0' } });
    try {
      await worker.until(/пауза 2 с/);
      const log = worker.out();
      // The account id, not the label: a name is what a person types, an id is
      // what cannot match the wrong account.
      assert.match(log, /\[stub\] run-account --account acc-1111-2222 --portal /);
      assert.match(log, /▶ Chloe Stewart: день 4, лишилось 6 \(profile_view, like\)/);

      const [report] = fake.finishedBodies();
      assert.deepEqual(
        { action: report.action, accountId: report.accountId, leaseId: report.leaseId, ok: report.ok },
        { action: 'run.finished', accountId: 'acc-1111-2222', leaseId: 'lease-from-post', ok: true },
      );
      // Every request carried the token, including the GET.
      assert.ok(fake.requests.every((r) => r.token === TOKEN), 'запит без x-agent-token');
      // And the gap after the run came from run.finished, not from the poll's
      // own retryAfterSeconds.
      await worker.until(/nothing owes work today/, 8000);
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('asks for the account with a POST, because the question itself is free now', async () => {
    // The shape that replaced the first one: a GET advises and takes nothing,
    // and a worker that means to run an account says so. It matters that the
    // POST happens *before* the browser would have opened — a lease taken after
    // the fact is not a lease, it is a note.
    const fake = await startFake({
      script: [{ next: true }, { reason: REASONS.nothing, retryAfterSeconds: 60 }],
      token: TOKEN,
      finished: { nextInSeconds: 120 },
    });
    const worker = startWorker({ portal: fake.url, env: { STUB_EXIT: '0' } });
    try {
      await worker.until(/пауза 120 с/);
      assert.equal(fake.leases().length, 1, 'акаунт мав бути взятий рівно один раз');
      assert.deepEqual(fake.leases()[0].body, { accountId: 'acc-1111-2222' });
      const order = fake.requests.map((r) => `${r.method} ${r.path}`);
      assert.ok(order.indexOf('POST /api/warmup/agent/lease') < order.indexOf('POST /api/warmup/agent'),
        `лізу взято не перед запуском: ${JSON.stringify(order)}`);
      assert.equal(fake.finishedBodies()[0].leaseId, 'lease-from-post');
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('believes the lease over the poll about what is left to do', async () => {
    // The GET is advice, and advice ages: the worker may have been running
    // another account for twenty minutes since it read that answer. The server
    // re-checks the window, the quota and the cool-off when it grants, so the
    // grant is the one that is about now.
    const fake = await startFake({
      script: [{ next: { day: 9, remaining: 99, kinds: ['profile_view', 'like'] } }, { reason: REASONS.nothing, retryAfterSeconds: 60 }],
      token: TOKEN,
      lease: { lease: { day: 2, remaining: 3, kinds: ['profile_view'], label: 'gulajpoleamis@gmail.com' } },
    });
    const worker = startWorker({ portal: fake.url, env: { STUB_EXIT: '0' } });
    try {
      await worker.until(/▶ /);
      assert.match(worker.out(), /▶ gulajpoleamis@gmail\.com: день 2, лишилось 3 \(profile_view\)/);
      assert.doesNotMatch(worker.out(), /день 9/);
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('a 409 is somebody else getting there first, not an error', async () => {
    const fake = await startFake({
      script: [{ next: true }],
      token: TOKEN,
      lease: [
        { status: 409, reason: REASONS.running('Chloe Stewart'), retryAfterSeconds: 1 },
        { status: 409, reason: REASONS.running('Chloe Stewart'), retryAfterSeconds: 1 },
        { status: 409, reason: REASONS.running('Chloe Stewart'), retryAfterSeconds: 1 },
      ],
    });
    const worker = startWorker({ portal: fake.url });
    try {
      await worker.until(/не дістався/);
      await wait(2500);
      assert.doesNotMatch(worker.out(), /\[stub\] run-account/, 'програвши гонку, воркер усе одно щось запустив');
      assert.equal(count(worker.out(), 'is already running'), 1, 'програш у гонці має бути один рядок, а не по одному на кожну спробу');
      assert.ok(fake.leases().length >= 2, 'воркер мав спробувати ще раз, а не здатись');
      assert.equal(worker.child.exitCode, null);
      assert.equal(fake.finishedBodies().length, 0, 'нічого не запускалось — нема про що звітувати');
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('a profile somebody else has open is a reason like any other', async () => {
    // The server asks Anty before calling an account due, because the things
    // that open these profiles without asking it — the old in-portal scheduler,
    // a person double-clicking in Anty — are invisible to a lease. It reaches
    // the worker as an ordinary sentence in both places it can appear, and the
    // worker must not open a browser on either.
    const open = REASONS.profileOpen('gulajpoleamis@gmail.com');
    const fake = await startFake({
      script: [
        { next: true, retryAfterSeconds: 1 },
        ...Array(4).fill({ reason: open, retryAfterSeconds: 1 }),
      ],
      token: TOKEN,
      lease: { status: 409, reason: open, retryAfterSeconds: 1 },
    });
    const worker = startWorker({ portal: fake.url });
    try {
      await worker.until(/не дістався/);
      await worker.until(/⏸ gulajpoleamis@gmail\.com already has its profile open/);
      await wait(2000);
      assert.doesNotMatch(worker.out(), /\[stub\] run-account/, 'воркер поліз у профіль, який уже відкритий');
      assert.equal(fake.finishedBodies().length, 0);
      // Two states, two lines, and then silence however long it lasts: the
      // 409 is "I tried and lost", the /due reason is "not offered at all".
      assert.equal(count(worker.out(), open), 2, `очікував два рядки на дві різні події:\n${worker.out()}`);
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('an account the server does not have is said out loud every time', async () => {
    // The one lease answer that means the question was wrong. Nothing here can
    // fix it, so it is not folded into the quiet states: a bug that repeats is
    // worth repeating.
    const fake = await startFake({
      script: [{ next: true, retryAfterSeconds: 1 }],
      token: TOKEN,
      lease: { status: 404, error: 'Account not found' },
    });
    const worker = startWorker({ portal: fake.url });
    try {
      await worker.until(/якого сам не знає/);
      await wait(2500);
      assert.ok(count(worker.out(), 'якого сам не знає') >= 2, 'мало повторюватись, а не замовкнути');
      assert.equal(worker.child.exitCode, null, '404 на лізу — не привід виходити');
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('still honours a lease that arrives with the advice', async () => {
    // The shape before the split. The worker must not take a second lease on an
    // account it has already been given — that would be two leases on one run,
    // and the second one outliving the first is how an account goes quiet for
    // twenty-five minutes for no reason.
    const fake = await startFake({
      script: [{ next: true }, { reason: REASONS.nothing, retryAfterSeconds: 60 }],
      token: TOKEN,
      leaseOnDue: true,
      finished: { nextInSeconds: 7 },
    });
    const worker = startWorker({ portal: fake.url, env: { STUB_EXIT: '0' } });
    try {
      await worker.until(/пауза 7 с/);
      assert.equal(fake.leases().length, 0, 'ліза вже була видана — другої просити не можна');
      assert.equal(fake.finishedBodies()[0].leaseId, 'lease-aaaa-bbbb');
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('reports a failed run, which is what starts the cool-off', async () => {
    const fake = await startFake({
      script: [{ next: true }, { reason: REASONS.coolOff('Chloe Stewart'), retryAfterSeconds: 60 }],
      token: TOKEN,
      finished: { nextInSeconds: 120 },
    });
    const worker = startWorker({ portal: fake.url, env: { STUB_EXIT: '1' } });
    try {
      await worker.until(/run-account завершився з кодом 1/);
      await worker.until(/пауза 120 с/);
      const [report] = fake.finishedBodies();
      assert.equal(report.ok, false, 'провалений запуск має піти на сервер як ok:false');
      assert.equal(report.leaseId, 'lease-from-post');
      assert.match(String(report.note), /exit 1/);
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('reports even when run-account could not start at all', async () => {
    const fake = await startFake({
      script: [{ next: true }, { reason: REASONS.nothing, retryAfterSeconds: 60 }],
      token: TOKEN,
    });
    const worker = startWorker({
      portal: fake.url,
      runAccount: path.join(here, 'fixtures', 'no-such-script.mjs'),
    });
    try {
      await worker.until(/run.finished|пауза/);
      await wait(300);
      const [report] = fake.finishedBodies();
      assert.ok(report, 'нічого не відзвітовано — ліза лишилась би висіти');
      assert.equal(report.ok, false);
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('a stop signal in the middle of a run still reports it', async () => {
    // launchd stopping the worker, or somebody pressing Ctrl-C, must not be the
    // one path that leaves a lease hanging: the server would keep believing
    // this account is running until the lease expires on its own.
    const fake = await startFake({
      script: [{ next: true }, { reason: REASONS.nothing, retryAfterSeconds: 60 }],
      token: TOKEN,
      finished: { nextInSeconds: 120 },
    });
    const worker = startWorker({ portal: fake.url, env: { STUB_EXIT: '0', STUB_SLEEP: '10000' } });
    try {
      await worker.until(/\[stub\] run-account/);
      worker.child.kill('SIGTERM');
      await worker.until(/воркер зупинено/, 10_000);
      const [report] = fake.finishedBodies();
      assert.ok(report, 'воркер вийшов, не відзвітувавши — ліза лишилась би до самого кінця');
      assert.equal(report.ok, false, 'перерваний запуск не є успішним');
      assert.equal(report.leaseId, 'lease-from-post');
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('takes released:false as information, not as a failure', async () => {
    // A run longer than the lease is expected — the server has already swept
    // it and says so. The report still counted, so this must not read like an
    // error in the log and must not be retried.
    const fake = await startFake({
      script: [{ next: true }, { reason: REASONS.nothing, retryAfterSeconds: 60 }],
      token: TOKEN,
      finished: { released: false, nextInSeconds: 3 },
    });
    const worker = startWorker({ portal: fake.url, env: { STUB_EXIT: '0' } });
    try {
      await worker.until(/пауза 3 с/);
      assert.match(worker.out(), /сервер уже зняв лізу/);
      assert.doesNotMatch(worker.out(), /не зміг звітувати/);
      assert.equal(fake.finishedBodies().length, 1, 'звіт не мав повторюватись');
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('retries run.finished once when the server has a bad minute, then carries on', async () => {
    const fake = await startFake({
      script: [{ next: true }, { reason: REASONS.nothing, retryAfterSeconds: 60 }],
      token: TOKEN,
      finished: { failTimes: 1, nextInSeconds: 5 },
    });
    const worker = startWorker({ portal: fake.url, env: { STUB_EXIT: '0' } });
    try {
      await worker.until(/ще одна спроба/);
      await worker.until(/пауза 5 с/, 10_000);
      assert.equal(fake.finishedBodies().length, 2, 'мала бути рівно одна повторна спроба');
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('clamps a number the server should never have sent, and says whose bug it is', async () => {
    const fake = await startFake({
      script: [{ reason: REASONS.nothing, retryAfterSeconds: 0 }],
      token: TOKEN,
    });
    const worker = startWorker({ portal: fake.url });
    try {
      await worker.until(/поза межами/);
      assert.match(worker.out(), /помилка сервера/);
      await wait(1200);
      // The point of the clamp: a 0 must not become a loop that hammers the
      // server as fast as the network allows.
      assert.ok(fake.polls() <= 4, `retryAfterSeconds=0 перетворився на гарячий цикл: ${fake.polls()} запитів за секунду`);
    } finally {
      await worker.stop(); await fake.stop();
    }
  });

  test('a 401 is a warning repeated once, not an exit', async () => {
    const fake = await startFake({ script: [{ reason: REASONS.nothing, retryAfterSeconds: 1 }], token: 'a-different-token' });
    const worker = startWorker({ portal: fake.url });
    try {
      await worker.until(/Agent authentication failed/);
      await wait(2500);
      assert.equal(worker.child.exitCode, null, 'воркер не має виходити через 401 — токен міняють на сервері, поки він чекає');
      assert.equal(count(worker.out(), 'Agent authentication failed'), 1, '401 має бути в логу один раз, а не на кожному опитуванні');
    } finally {
      await worker.stop(); await fake.stop();
    }
  });
});

/**
 * The fake against the real thing.
 *
 * Everything above proves the worker behaves against a server of my own
 * writing, which proves nothing at all if that server and the real one have
 * drifted apart. This asks the real backend for a real answer and compares the
 * field names and the types — not the values, which are properly none of this
 * file's business.
 */
describe('the fake against the real backend', () => {
  /**
   * The fake is a liability the moment it and the server disagree, so this asks
   * the real one for a real answer and compares the fields.
   *
   * It runs by default, which it could not do a few hours ago: `GET /due` used
   * to grant a lease, so a test suite that polled it parked a live warming
   * account for twenty-five minutes — during the window, on a real account, to
   * check field names. Asking is free now, and a test that can run for real is
   * worth more than one guarded by an environment variable nobody sets.
   *
   * Nothing here takes a lease. The only POST is to an account id that cannot
   * exist, which proves the route, the header and the body shape and writes
   * nothing, the same way `run.finished` was proved.
   */
  const real = async (path, init) => {
    const res = await fetch(`${REAL}${path}`, {
      ...init,
      headers: { 'x-agent-token': REAL_TOKEN, ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    });
    return { status: res.status, body: await res.json() };
  };

  test('same fields, same types — and the GET still takes nothing', async (t) => {
    let first = null;
    try {
      first = await real('/api/warmup/agent/due');
    } catch (error) {
      return t.skip(`${REAL} недоступний (${error.message}) — підніми бекенд і повтори`);
    }
    if (first.status === 401) return t.skip(`${REAL} відповів 401 — потрібен правильний WARMUP_REAL_TOKEN`);

    // Asked three times. If the question still cost a lease, the second answer
    // would already be "is already running" — which is exactly how the leaking
    // GET was found in the first place.
    const second = await real('/api/warmup/agent/due');
    const third = await real('/api/warmup/agent/due');
    for (const [n, answer] of [first, second, third].entries()) {
      assert.equal(answer.body.next?.leaseId ?? null, null,
        `GET #${n + 1} видав лізу — питання знову коштує акаунта: ${JSON.stringify(answer.body.next)}`);
    }
    assert.equal(second.body.next?.accountId ?? second.body.reason, third.body.next?.accountId ?? third.body.reason,
      'два однакові запити дали різні стани — щось у GET усе-таки пише');

    const fake = await startFake({ script: [{ reason: REASONS.nothing }] });
    try {
      const mine = await (await fetch(`${fake.url}/api/warmup/agent/due`)).json();
      assert.deepEqual(Object.keys(first.body).sort(), Object.keys(mine).sort(),
        `поля /due розійшлись — справжній: ${JSON.stringify(Object.keys(first.body))}, фейковий: ${JSON.stringify(Object.keys(mine))}`);
      assert.deepEqual(Object.keys(first.body.window).sort(), Object.keys(mine.window).sort(), 'поля window розійшлись');
      const n = first.body.retryAfterSeconds;
      assert.ok(Number.isInteger(n) && n >= 1 && n <= 900, `retryAfterSeconds=${n} поза домовленими [1, 900]`);
      if (first.body.next) {
        assert.deepEqual(Object.keys(first.body.next).sort(), Object.keys(nextShape()).sort(), 'поля next розійшлись');
      }
    } finally {
      await fake.stop();
    }
  });

  test('the lease route refuses an account that does not exist, and writes nothing', async (t) => {
    let answer = null;
    try {
      answer = await real('/api/warmup/agent/lease', {
        method: 'POST',
        body: JSON.stringify({ accountId: '00000000-0000-0000-0000-000000000000' }),
      });
    } catch (error) {
      return t.skip(`${REAL} недоступний (${error.message})`);
    }
    if (answer.status === 401) return t.skip('потрібен правильний WARMUP_REAL_TOKEN');
    // 404 and nothing else: this is the one lease answer the worker treats as
    // final, and the only one that can be checked against a live server without
    // taking an account away from it.
    assert.equal(answer.status, 404, `очікував 404 на неіснуючий акаунт, отримав ${answer.status}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.success, false);
    assert.ok(typeof answer.body.error === 'string' && answer.body.error.length > 0);
  });
});

/** The shape the fake hands out, for the comparison above. */
function nextShape() {
  return {
    accountId: '', label: '', profileRemoteId: '', day: 0,
    remaining: 0, kinds: [], leaseId: '', leaseExpiresAt: '',
  };
}
