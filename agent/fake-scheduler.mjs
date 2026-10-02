#!/usr/bin/env node
/**
 * A server that answers like the scheduler and is not it.
 *
 *   node agent/fake-scheduler.mjs --port 4999 --scenario flaky
 *
 * The worker's whole job is to survive the server misbehaving, and the real
 * server is not going to misbehave on request: it will not return a 500 for us,
 * it will not take nine seconds to answer, and it will certainly not refuse the
 * connection at the exact moment a run is being reported. This will, on demand
 * and in order, which is the only way the worth of the loop can be shown
 * without waiting for the bad morning it was written for.
 *
 * It is deliberately literal about the contract — the field names, the reason
 * sentences, the `x-agent-token` header, the 401, the `released` flag — because
 * a fake that disagrees with the real server is worse than no test at all. The
 * shapes here came from the backend that implements them, and the last test in
 * `worker.test.mjs` is a diff against the real one on :4230 when it is up.
 *
 * As a library it is driven by a script: an array of steps consumed in order by
 * each `GET /due`, the last of which repeats forever. As a command it serves one
 * of a few named scenarios, which is enough to watch the worker's log do the
 * right thing with your own eyes.
 */
import http from 'node:http';

/**
 * The sentences, verbatim from the backend. Nothing varying inside them — no
 * timestamps, no countdowns — which is what lets the worker compare a reason as
 * a whole string and print it once per state change.
 *
 * `profileOpen` is the one that is not about scheduling at all: the server asks
 * Anty whether the profile is open before calling an account due, because the
 * things that open these profiles without asking anybody — the old in-portal
 * scheduler, a person double-clicking a profile — cannot be seen any other way.
 * It can arrive as a `/due` reason or as a 409 from `/lease`, and the worker
 * treats it like any other: one line, back to polling.
 */
export const REASONS = {
  outside: 'outside 09:00–13:00',
  nothing: 'nothing owes work today',
  coolOff: (label) => `${label} is in cool-off`,
  running: (label) => `${label} is already running`,
  profileOpen: (label) => `${label} already has its profile open`,
  off: 'the scheduler is switched off on this deployment',
};

const WINDOW = { startHour: 9, endHour: 13, label: '09:00–13:00', open: true };

/**
 * A due answer with the contract's defaults filled in.
 *
 * `leaseOnDue` is the difference between the first shape of this API and the
 * one that replaced it. It began by granting the lease with the advice, which
 * made a GET expensive — one curl cost a live account twenty-five minutes — and
 * became advice with `leaseId: null`, the account taken by a POST only when a
 * worker means to run it. The default here is the shape the server actually
 * serves today; `leaseOnDue: true` brings back the old one, because the worker
 * still honours a lease that arrives with the advice and that has to keep
 * being true rather than merely having been true once.
 */
function dueBody(step, leaseOnDue) {
  const next = step.next
    ? {
      accountId: 'acc-1111-2222',
      label: 'Chloe Stewart',
      profileRemoteId: 'anty-profile-1',
      day: 4,
      remaining: 6,
      kinds: ['profile_view', 'like'],
      leaseId: 'lease-aaaa-bbbb',
      leaseExpiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
      ...(step.next === true ? {} : step.next),
    }
    : null;
  if (next && !leaseOnDue && !(step.next !== true && 'leaseId' in (step.next ?? {}))) next.leaseId = null;
  return {
    success: true,
    window: { ...WINDOW, open: step.open ?? true },
    next,
    reason: next ? null : (step.reason ?? REASONS.nothing),
    retryAfterSeconds: step.retryAfterSeconds ?? 300,
  };
}

/**
 * Start one.
 *
 * `script` steps are consumed by `GET /due` in order and the last one repeats.
 * Besides a due answer a step can be `{ status }` for an HTTP error,
 * `{ hang: ms }` for a slow answer, or `{ close: true }` for a socket that dies
 * mid-request — the three shapes of "the server is there but not useful" that
 * a real one produces and cannot be asked to produce.
 */
export function startFake({ script = [{ reason: REASONS.nothing, retryAfterSeconds: 300 }], token = null, finished = {}, lease = null, leaseOnDue = false, port = 0 } = {}) {
  const requests = [];      // every request, in order: { method, path, token, body }
  let step = 0;
  let finishedCalls = 0;
  let leaseCalls = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, 'http://fake');
      requests.push({ method: req.method, path: url.pathname, token: req.headers['x-agent-token'] ?? null, body });

      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // The gate, in the same place the real one has it: the whole
      // `/api/warmup/agent` prefix, ahead of everything else.
      if (token && req.headers['x-agent-token'] !== token) {
        return send(401, { success: false, error: 'Agent authentication failed.' });
      }

      if (req.method === 'GET' && url.pathname === '/api/warmup/agent/due') {
        const current = script[Math.min(step, script.length - 1)];
        step += 1;
        if (current.close) return req.socket.destroy();
        if (current.hang) await new Promise((r) => setTimeout(r, current.hang));
        if (current.status) return send(current.status, { success: false, error: current.error ?? `fake ${current.status}` });
        return send(200, dueBody(current, leaseOnDue));
      }

      // Taking the account, which is its own act now.
      if (req.method === 'POST' && url.pathname === '/api/warmup/agent/lease') {
        leaseCalls += 1;
        const plan = Array.isArray(lease) ? lease[Math.min(leaseCalls - 1, lease.length - 1)] : (lease ?? {});
        if (plan.close) return req.socket.destroy();
        if (plan.status === 409) {
          return send(409, {
            success: false,
            error: 'Account is leased to another worker',
            reason: plan.reason ?? REASONS.running('Chloe Stewart'),
            retryAfterSeconds: plan.retryAfterSeconds ?? 60,
          });
        }
        if (plan.status) return send(plan.status, { success: false, error: plan.error ?? `fake ${plan.status}` });
        // Field-identical to `next`, with the two nulls filled in, and
        // authoritative: the server re-checks the window, the quota and the
        // cool-off when it grants, so this is a statement about now.
        return send(200, {
          success: true,
          lease: {
            accountId: body?.accountId ?? 'acc-1111-2222',
            label: 'Chloe Stewart',
            profileRemoteId: 'anty-profile-1',
            day: 4,
            remaining: 6,
            kinds: ['profile_view', 'like'],
            leaseId: 'lease-from-post',
            leaseExpiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
            ...(plan.lease ?? {}),
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/warmup/agent') {
        if (body?.action !== 'run.finished') return send(400, { success: false, error: 'unexpected action' });
        finishedCalls += 1;
        if (finished.close) return req.socket.destroy();
        if (finished.failTimes && finishedCalls <= finished.failTimes) {
          return send(finished.status ?? 500, { success: false, error: 'fake failure on run.finished' });
        }
        return send(200, {
          success: true,
          nextInSeconds: finished.nextInSeconds ?? 120,
          // False is normal, not an error: the lease had already been swept.
          released: finished.released ?? true,
        });
      }

      // The window, which both portals answer. Here so the fake is complete,
      // not because the worker asks for it — it does not.
      if (req.method === 'GET' && url.pathname === '/api/warmup/agent') {
        return send(200, { success: true, window: WINDOW });
      }

      send(404, { success: false, error: 'not a route on the fake' });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        requests,
        polls: () => requests.filter((r) => r.path.endsWith('/due')).length,
        finishedBodies: () => requests.filter((r) => r.body?.action === 'run.finished').map((r) => r.body),
        leases: () => requests.filter((r) => r.path.endsWith('/lease')),
        stop: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
      });
    });
  });
}

// ── as a command ───────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const scenarios = {
    // Nothing to do, ever. What the log looks like for twenty hours a day.
    idle: [{ reason: REASONS.nothing, retryAfterSeconds: 5 }],
    // Outside the window, then inside with nothing due: the one line that must
    // appear when the state changes, after the silence.
    window: [
      ...Array(4).fill({ reason: REASONS.outside, retryAfterSeconds: 3, open: false }),
      { reason: REASONS.nothing, retryAfterSeconds: 5 },
    ],
    // One account, then quiet.
    'hand-out': [{ next: true, retryAfterSeconds: 300 }, { reason: REASONS.nothing, retryAfterSeconds: 10 }],
    // Everything that can go wrong on the way to one account.
    flaky: [
      { status: 500 },
      { hang: 3000, reason: REASONS.nothing, retryAfterSeconds: 3 },
      { close: true },
      { next: true },
      { reason: REASONS.coolOff('Chloe Stewart'), retryAfterSeconds: 5 },
    ],
  };
  const name = arg('scenario', 'idle');
  const fake = await startFake({
    script: scenarios[name] ?? scenarios.idle,
    token: arg('token', null),
    port: Number(arg('port', 0)),
  });
  console.log(`fake scheduler: ${fake.url} — scenario "${name}"`);
  console.log(`  node agent/worker.mjs --portal ${fake.url} --run-account agent/fixtures/stub-run-account.mjs`);
  let printed = 0;
  setInterval(() => {
    while (printed < fake.requests.length) {
      const r = fake.requests[printed++];
      process.stdout.write(`  ← ${r.method} ${r.path}${r.body ? ` ${JSON.stringify(r.body)}` : ''}\n`);
    }
  }, 1000);
}
