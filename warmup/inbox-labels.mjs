/**
 * «Вхідні» LinkedIn, розібрані AI (власник 20.10: «у вхідних треба якось
 * сортувати всі повідомлення через аі»).
 *
 * Кожна розмова, де людина хоч раз написала, отримує мітку — ті самі, що у
 * «Порівнянні кампаній» (triage/campaign-report.mjs, LABELS): кваліфікована,
 * не ICP, відмова, тільки трафік, інше. Ставить її модель з тексту розмови;
 * людина міняє одним кліком, і її мітку AI вже не переписує. Нова відповідь
 * людини — привід AI подивитись знову (якщо мітку ставив AI).
 *
 * Мітки — по розмові (акаунт + тред), у стані робочого простору (server.mjs,
 * state.inboxLabels). Без моделі нічого не ставиться, список лишається як був.
 */

import { LABELS } from "../triage/campaign-report.mjs";

export { LABELS };
const LABEL_KEYS = new Set(LABELS.map(([key]) => key));
// Порядок у «Вхідних»: з ким є про що говорити — вгорі, відмови — внизу.
export const LABEL_ORDER = ["qualified", "other", "traffic_only", "not_icp", "refusal"];

export const labelKey = (accountId, threadKey) => `${accountId}|${threadKey}`;
export const isInboxLabel = (value) => LABEL_KEYS.has(value);

/** What the label was put against: the person's newest message. A new one asks again. */
export function labelBasis(thread) {
  return `${thread.inCount || 0}|${thread.lastInboundStoredAt || ""}`;
}

/** Whether AI should look at this conversation: the person wrote, and no label — or AI's, from before their newest message. */
export function needsInboxLabel(thread, stored) {
  if (!thread.answered) return false;
  if (!stored) return true;
  return stored.by === "ai" && stored.basis !== labelBasis(thread);
}

// A conversation the model could not label rests before it is asked again, and a run in which
// the model keeps failing stops: on 24.11 every one of ~1000 conversations was asked again every
// ten minutes against a provider with no credits — 14 000 refusals a day, nothing labelled.
export const LABEL_REST_MS = 2 * 3600_000;
export const STOP_AFTER_FAILURES = 5;

export function inboxLabeler({ store, listThreads, readThread, classify, concurrency = 3, clock = () => Date.now() }) {
  let job = null;
  const resting = new Map();

  async function set(accountId, threadKey, label, { by = "human", basis = null } = {}) {
    if (!isInboxLabel(label)) throw Object.assign(new Error("Невідома мітка."), { status: 400 });
    const next = { ...(store.read() || {}) };
    next[labelKey(accountId, threadKey)] = { label, by, basis, at: new Date().toISOString() };
    await store.write(next);
    return next[labelKey(accountId, threadKey)];
  }

  async function run() {
    if (job?.running) return job;
    const labels = store.read() || {};
    const todo = (await listThreads({})).filter((thread) => needsInboxLabel(thread, labels[labelKey(thread.accountId, thread.threadKey)])
      && !(resting.get(labelKey(thread.accountId, thread.threadKey)) > clock()));
    job = { running: true, total: todo.length, done: 0, failed: 0, startedAt: new Date().toISOString() };
    const queue = [...todo];
    let failedInARow = 0;
    const worker = async () => {
      while (queue.length && failedInARow < STOP_AFTER_FAILURES) {
        const thread = queue.shift();
        try {
          const found = await readThread({ accountId: thread.accountId, threadKey: thread.threadKey });
          const answer = await classify({
            person: { name: thread.participant?.name || "", position: thread.participant?.headline || "", company: "" },
            messages: found?.messages || []
          });
          // A person's label made while AI was thinking stays.
          const now = (store.read() || {})[labelKey(thread.accountId, thread.threadKey)];
          if (now && now.by !== "ai") { job.done += 1; continue; }
          if (answer && isInboxLabel(answer.label)) {
            await set(thread.accountId, thread.threadKey, answer.label, { by: "ai", basis: labelBasis(thread) });
            failedInARow = 0;
          } else {
            job.failed += 1;
            resting.set(labelKey(thread.accountId, thread.threadKey), clock() + LABEL_REST_MS);
          }
        } catch (error) {
          job.failed += 1;
          failedInARow += 1;
          resting.set(labelKey(thread.accountId, thread.threadKey), clock() + LABEL_REST_MS);
          console.warn(`[inbox-labels] ${thread.accountId}/${thread.threadKey}: ${error.message}`);
          if (failedInARow === STOP_AFTER_FAILURES) console.warn(`[inbox-labels] ${STOP_AFTER_FAILURES} failures in a row — this run stops, the next is in ten minutes`);
        }
        job.done += 1;
      }
    };
    void Promise.all(Array.from({ length: concurrency }, worker)).finally(() => { job.running = false; job.finishedAt = new Date().toISOString(); });
    return job;
  }

  return {
    labels: () => store.read() || {},
    labelOf: (accountId, threadKey) => (store.read() || {})[labelKey(accountId, threadKey)] || null,
    set,
    run,
    status: () => (job ? { ...job } : null),
    /** Every `everyMs`, and once a minute after start. */
    start({ everyMs = 600_000 } = {}) {
      const tick = () => void run().catch((error) => console.error(`[inbox-labels] ${error.message}`));
      const timer = setInterval(tick, everyMs);
      timer.unref?.();
      setTimeout(tick, 60_000).unref?.();
    }
  };
}
