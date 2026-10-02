import { anty, today } from "./db.mjs";
import {
  ACTION_KINDS, ACTION_LABEL, DEFAULT_STRATEGY, dailyQuota, dayOfRun, pausedDaysOn, pausedOn, planForDay, runDay, totalDays,
  warningPause
} from "./strategy.mjs";
import { nextSession } from "./schedule.mjs";
import { connectCeiling, weeklyConnectAllowance } from "./weekly.mjs";

/**
 * When the scheduler is holding an account back (resting between two sessions
 * of one morning, or cooling off after a failed one), as epoch ms, or 0.
 *
 * The scheduler keeps those holds in memory and already imports this module,
 * so it hands the reader in (`readHoldsFrom`) rather than this module importing
 * it back: an import cycle between the two would evaluate one of them half-done.
 */
let holdReader = () => 0;

export function readHoldsFrom(reader) {
  holdReader = typeof reader === "function" ? reader : () => 0;
}

export function heldUntil(accountId) {
  return Number(holdReader(accountId)) || 0;
}

/**
 * Reading and writing the warm-up's own tables.
 *
 * The quota rule lives here rather than in the routes because two paths cause a
 * connection request — the warm-up panel's "record" and sending one to a lead
 * from the CRM queue — and a second copy of "is it allowed, add one to today,
 * attach it to the open session" is a day counter that drifts.
 */

/**
 * What a warm-up in progress can look like in the table, and what its account
 * can.
 *
 * `paused` and `restricted` are here because a warning writes them and the end
 * of the pause writes nothing: the day after `paused_until` the run is running
 * whatever its row still says (`pausedOn`). A reader that filtered on
 * `running` and `warming` alone lost every account that was ever warned — for
 * good, because only a person pressing Resume ever wrote them back, and the
 * button disappeared the day the pause ran out.
 */
export const LIVE_RUN_STATES = ["running", "paused"];
export const LIVE_ACCOUNT_STATUSES = ["warming", "restricted"];

/**
 * The log, written on the same path as the change it describes and never as an
 * afterthought: an account that gets restricted is investigated through this
 * table, and a gap in it is the moment you needed.
 *
 * `returning` hands back the row's id and time, for the one kind of caller
 * that needs to point at the event later: a copy to the CRM is keyed by the
 * event it was made from (`activities.mjs`). Null when the write failed, which
 * that caller has to be ready for anyway — this never throws.
 */
export async function logEvent(input, { returning = false } = {}) {
  try {
    let query = anty.from("wl_events").insert({
      account_id: input.accountId ?? null,
      run_id: input.runId ?? null,
      level: input.level || "info",
      type: input.type,
      message: input.message,
      meta: input.meta ?? null
    });
    if (returning) query = query.select("id,type,meta,created_at");
    const rows = await query.rows();
    return returning ? rows[0] ?? null : undefined;
  } catch (error) {
    console.error("[warmup] could not write event:", error.message);
    return returning ? null : undefined;
  }
}

/**
 * Can this key write, rewrite and remove a row in `wl_events`?
 *
 * Asked because a whole design decision hangs on it. Message and invitation
 * history lives in `wl_events` — there is no Postgres password and no
 * `exec_sql`, so no migration can give either its own table — and the plan for
 * suppressing a duplicate when a seller records a message they sent by hand is
 * to **update** the provisional row in place when the sync later brings the
 * real one. Nothing in this codebase has ever updated `wl_events`. A
 * service-role grant that allows INSERT and SELECT but not UPDATE would leave
 * that plan silently broken, and the alternative — carrying two rows forever
 * and hiding one at render time — has to be chosen before the code is written,
 * not after.
 *
 * It answers where the keys are, which is the deployed server: nobody can run
 * this locally, and guessing was the only other option.
 *
 * It cleans up after itself, and says so if it could not: a probe row that
 * survives is the one artefact this leaves behind, and an operator who can see
 * its id can go and remove it.
 */
export async function probeEventWriteAccess() {
  // "No keys here" and "the key is not allowed to" are different answers, and
  // on the screen the second one reads as a broken deployment. Locally the
  // first is the only one there can be.
  if (!anty.configured()) {
    return {
      insert: { ok: false, error: `The Anty database is not configured: ${anty.missing().join(", ")} are not set` },
      update: null, remove: null, probeId: null, canUpdate: false, verdict: "not_configured"
    };
  }

  const marker = `probe-${Date.now().toString(36)}`;
  const step = { insert: null, update: null, remove: null };
  let probeId = null;

  try {
    const row = await anty.from("wl_events").insert({
      level: "debug",
      type: "diagnostic.write",
      message: "Write-access probe. Removed immediately; if you are reading this, the delete failed.",
      meta: { marker, stage: "inserted" }
    }).select("id").single();
    probeId = row.id;
    step.insert = { ok: true };
  } catch (error) {
    step.insert = { ok: false, error: errorText(error) };
    return { ...step, probeId: null, canUpdate: false, verdict: "cannot_write" };
  }

  try {
    const updated = await anty.from("wl_events")
      .update({ meta: { marker, stage: "updated" } })
      .eq("id", probeId).select("id").rows();
    // A grant can also be silently no-op: the request succeeds and nothing
    // changes. An empty representation is that case, and it is not a yes.
    step.update = updated.length ? { ok: true } : { ok: false, error: "The update was accepted but changed no rows" };
  } catch (error) {
    step.update = { ok: false, error: errorText(error) };
  }

  try {
    const gone = await anty.from("wl_events").eq("id", probeId).remove().select("id").rows();
    step.remove = gone.length ? { ok: true } : { ok: false, error: "The delete was accepted but removed no rows" };
  } catch (error) {
    step.remove = { ok: false, error: errorText(error) };
  }

  return {
    ...step,
    probeId: step.remove.ok ? null : probeId,
    canUpdate: Boolean(step.update?.ok),
    verdict: step.update?.ok ? (step.remove.ok ? "full" : "no_delete") : "no_update"
  };
}

function errorText(error) {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

/**
 * Today's connection-request allowance, read from the run's own strategy
 * snapshot — the same source the record path checks against, so the number the
 * list shows, the number the forecast adds up and the number an action is
 * refused by cannot disagree.
 */
export function connectQuotaToday(account, run, todayIso) {
  // `paused` is a live run too once its pause has run out — see `pausedOn`.
  if (!account || !run || !LIVE_RUN_STATES.includes(run.state)) return 0;
  if (pausedOn(run, todayIso)) return 0;
  const snapshot = run.strategy_snapshot;
  if (!snapshot?.phases) return 0;
  const day = dayOfRun(run);
  // Past the last phase is working mode, which `dailyQuota` already answers
  // for; there is no "finished" to return 0 for any more.
  return dailyQuota(snapshot, account.id, day, "connect");
}

export function toStrategy(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isDefault: row.is_default,
    phases: row.phases,
    pauseDays: row.pause_days
  };
}

/**
 * The default strategy, created on first use rather than by migration — a new
 * install should not open on an empty screen with no way to begin.
 */
export async function ensureDefaultStrategy() {
  const existing = await anty.from("wl_strategies").select("*").eq("is_default", true).eq("is_archived", false).maybeSingle();
  if (existing) return toStrategy(existing);

  const created = await anty.from("wl_strategies").insert({
    name: DEFAULT_STRATEGY.name,
    description: DEFAULT_STRATEGY.description,
    is_default: true,
    phases: DEFAULT_STRATEGY.phases,
    pause_days: DEFAULT_STRATEGY.pauseDays
  }).select("*").single();
  return toStrategy(created);
}

export async function loadAccount(id) {
  return anty.from("wl_accounts").select("*").eq("id", id).maybeSingle();
}

/**
 * Who the browser is actually signed in as.
 *
 * The agent works this out on every run and logs it; it is read back here
 * rather than copied into a column, because a column would be a second answer
 * to the same question and the wrong one the day somebody points a profile at a
 * different login. `slug` is not written by the current agent build, so an
 * identity is a name with a slug missing rather than nothing at all.
 */
function toIdentity(event) {
  const who = typeof event?.meta?.who === "string" ? event.meta.who.trim() : "";
  const slug = typeof event?.meta?.slug === "string" ? event.meta.slug.trim() : "";
  if (!who && !slug) return null;
  return { name: who || null, slug: slug || null, seenAt: event.created_at };
}

export async function loginIdentity(accountId) {
  const event = await anty.from("wl_events").select("meta,created_at")
    .eq("account_id", accountId).eq("type", "agent.login")
    .order("created_at", { ascending: false })
    .maybeSingle();
  return toIdentity(event);
}

/**
 * Every account's newest sign-in, keyed by account. PostgREST applies the limit
 * per parent row, so a list of any length is still one round trip — the same
 * rule the profiles list already follows for sessions.
 */
export async function loginIdentities() {
  const rows = await anty.from("wl_accounts").select("id,wl_events(meta,created_at)")
    .eq("wl_events.type", "agent.login")
    .order("created_at", { ascending: false, foreignTable: "wl_events" })
    .limit(1, { foreignTable: "wl_events" })
    .rows();
  return new Map(rows.map((row) => [row.id, toIdentity(row.wl_events?.[0])]));
}

export async function activeRun(accountId) {
  return anty.from("wl_runs").select("*")
    .eq("account_id", accountId)
    .in("state", LIVE_RUN_STATES)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

/**
 * A LinkedIn warning, from whoever saw it: the operator's button, the agent
 * reporting one, or an invitation LinkedIn answered with a block page.
 *
 * One path for all three, so they cannot disagree about how long "stop
 * everything" is or how many days it costs. The row is written as absolutes
 * computed from the row that was read, so two reports arriving together — the
 * agent's warning and the `blocked` on the invitation it was sending — land on
 * the same pause rather than on two stacked ones.
 *
 * The `run.warning` says whether it started the pause (`extended: false`) or
 * came while one held, and a block page names the report it came from
 * (`report`: `outreachId`, `leaseId`). That is how a retry of the report that
 * paused the account tells its own pause from an earlier one
 * (`pausedByThisReport` in `warmup/api.mjs`) — so it is written straight
 * after the run: a failure on the account row below it still leaves the
 * pause saying whose it is.
 */
export async function pauseForWarning({ account, run, source, note = null, report = null, todayIso = today() }) {
  const pauseDays = run.strategy_snapshot?.pauseDays ?? DEFAULT_STRATEGY.pauseDays;
  const pause = warningPause(run, todayIso, pauseDays);
  const now = new Date().toISOString();

  await anty.from("wl_runs").update({
    paused_until: pause.pausedUntil,
    // Taken out of the count now rather than when the pause ends, so the end
    // needs no write for the count to be right — see `pausedOn`.
    paused_days: pause.pausedDays,
    state: "paused"
  }).eq("id", run.id).rows();

  await logEvent({
    accountId: account.id, runId: run.id, level: "warn", type: "run.warning",
    message: !pause.extended
      ? `LinkedIn warning — all actions stopped for ${pauseDays} days`
      : pause.added
        ? `LinkedIn warning again — the pause now runs to ${pause.pausedUntil}`
        : `LinkedIn warning again — already paused until ${pause.pausedUntil}`,
    meta: {
      until: pause.pausedUntil, added: pause.added, extended: pause.extended, source, note,
      ...(report ? { outreachId: report.outreachId ?? null, leaseId: report.leaseId ?? null } : {})
    }
  });
  await anty.from("wl_accounts").update({ status: "restricted", updated_at: now }).eq("id", account.id).rows();
  return pause;
}

/**
 * A pause that has run out, written down as over.
 *
 * Not what puts the account back to work — every reader already treats a run
 * past its `paused_until` as running — but what makes the table say so, and
 * the log line that says when it came back. Conditional on the row still
 * reading exactly what this was computed from — `paused`, the same last date
 * and the same `paused_days` — so whichever caller gets here first writes it
 * and logs it, every other one finds nothing to do, and a warning that landed
 * in between is not overwritten.
 *
 * `paused_days` becomes `pausedDaysOn` today: the dates the warning took out,
 * plus the stall — the dates after the pause on which nobody took the
 * account. Every reader already counts those as paused, so writing the same
 * number is what keeps the day from moving at the moment the row changes.
 * On the first morning after the pause the stall is none, and nothing moves.
 */
export async function settlePause(account, run, todayIso = today()) {
  if (!account || !run || pausedOn(run, todayIso)) return false;
  let resumed = [];
  const pausedDays = pausedDaysOn(run, todayIso);
  const stalled = pausedDays - Math.max(0, Number(run.paused_days) || 0);
  // Bookkeeping, so a failure here is a log line and not a lost session: the
  // account is already due on the pause's dates alone.
  try {
    if (run.state === "paused" && run.paused_until) {
      let write = anty.from("wl_runs").update({ state: "running", paused_until: null, paused_days: pausedDays })
        .eq("id", run.id).eq("state", "paused").eq("paused_until", run.paused_until);
      write = Number.isInteger(run.paused_days) ? write.eq("paused_days", run.paused_days) : write.isNull("paused_days");
      resumed = await write.select("id").rows();
    }
    // Not when the run write found a different row: a warning that landed in
    // between left the account restricted on purpose.
    if (account.status === "restricted" && (resumed.length || run.state !== "paused")) {
      await anty.from("wl_accounts").update({ status: "warming", updated_at: new Date().toISOString() })
        .eq("id", account.id).eq("status", "restricted").rows();
    }
  } catch (error) {
    console.error("[warmup] could not write the end of a pause:", error.message);
    return false;
  }
  if (!resumed.length) return false;

  await logEvent({
    accountId: account.id, runId: run.id, type: "run.resumed",
    message: `The pause after the warning is over — back to work on day ${runDay(run, new Date(`${todayIso}T12:00:00.000Z`))}`
      + (stalled > 0 ? ` (${stalled} more day(s) nobody took the account on are counted as paused too)` : ""),
    meta: { auto: true, pausedUntil: run.paused_until, pausedDays, stalled }
  });
  return true;
}

export async function newestRun(accountId) {
  return anty.from("wl_runs").select("*")
    .eq("account_id", accountId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function openSession(accountId) {
  return anty.from("wl_sessions").select("id,started_at,actions").eq("account_id", accountId).isNull("ended_at").maybeSingle();
}

/**
 * Count an action against the open session, if there is one.
 *
 * The day counters are the source of truth for quotas; this is only the
 * per-visit breakdown. An action recorded with the profile closed has nowhere
 * honest to go, so it is simply not counted against any session.
 */
export async function recordSessionAction(accountId, kind, step = 1) {
  const open = await openSession(accountId);
  if (!open) return;
  const actions = { ...(open.actions || {}) };
  actions[kind] = (Number(actions[kind]) || 0) + step;
  try {
    await anty.from("wl_sessions").update({ actions }).eq("id", open.id).rows();
  } catch (error) {
    console.error("[warmup] could not count the action on the session:", error.message);
  }
}

/**
 * May this account do `step` more of this today? Answers without writing
 * anything, so a caller can ask before it commits to work it would have to undo.
 */
export async function checkQuota(account, run, kind, step = 1) {
  const snapshot = run.strategy_snapshot;
  if (run.paused_until && run.paused_until >= today()) {
    return { ok: false, status: 409, error: "Account is paused after a warning" };
  }

  const day = dayOfRun(run);
  // Past the last phase is working mode, and counts like any other day. Only
  // a snapshot with nothing to fall back on is really over.
  if (planForDay(snapshot, account.id, day).finished) return { ok: false, status: 409, error: "Warm-up is finished" };

  // Clamped to CONNECT_HARD_MAX inside `dailyQuota`, so a request past the
  // twentieth is refused here as "quota reached" whatever the snapshot says.
  const daily = dailyQuota(snapshot, account.id, day, kind);
  let quota = daily;
  // No quota in this phase means forbidden, not unlimited.
  if (quota === 0) return { ok: false, status: 409, error: `${ACTION_LABEL[kind]} are not allowed on day ${day}` };

  // Every row for this day and kind, summed, rather than one row read with
  // `maybeSingle`. There is no unique index on (run_id, on_date, kind) and
  // there cannot be one without a migration, so two writers that both found
  // nothing can each insert — and reading only the first of them would report
  // half the day's work and hand out the quota twice.
  const existing = await anty.from("wl_day_actions").select("id,done")
    .eq("run_id", run.id).eq("on_date", today()).eq("kind", kind)
    .order("id", { ascending: true }).rows();
  const already = existing.reduce((total, row) => total + (Number(row.done) || 0), 0);

  const weekly = kind === "connect" ? await weeklyConnectAllowance(account.id) : null;
  if (weekly) quota = connectCeiling(daily, already, weekly.done);
  if (weekly && step > weekly.remaining) {
    return { ok: false, status: 409, error: "Weekly connection limit reached (60 in 7 days)", quota, done: already, weekly };
  }
  const done = already + step;
  if (done > quota) {
    return { ok: false, status: 409, error: `Daily quota reached (${quota})`, quota, done: already };
  }

  return {
    ok: true, day, quota, dailyQuota: daily, weekly, done, step,
    existingRowId: existing[0]?.id ?? null,
    // That row's own number, which is what the write is guarded on. It is not
    // the day's total when a duplicate row exists, and conflating the two is
    // how the guard would start refusing correct writes.
    rowDone: Number(existing[0]?.done) || 0,
    duplicateRows: existing.length > 1 ? existing.length : 0
  };
}

/**
 * Write the action down: the day counter, the open session, the log. Takes the
 * allowance rather than re-reading, so the number that was checked is the
 * number that gets stored.
 */
export async function commitAction(account, run, kind, allowance, detail = null) {
  const { day, quota, done, step, existingRowId, rowDone = 0, duplicateRows = 0 } = allowance;

  // An action on a run whose pause ran out is the account working today, so
  // the pause is written down as over now. Left to the next lease, a day
  // worked by hand with the scheduler off would be counted as stalled
  // tomorrow — see `pausedDaysOn`. Nothing to do, and no write, on a run
  // that is simply running.
  await settlePause(account, run);

  if (duplicateRows) {
    // Not repaired here: merging rows under a writer that may be racing is how
    // a count gets lost for good. `checkQuota` sums them, so the arithmetic is
    // right; this is so somebody knows the rows are there.
    await logEvent({
      accountId: account.id, runId: run.id, level: "warn", type: "action.duplicate_day_row",
      message: `${duplicateRows} rows count today's ${ACTION_LABEL[kind]} — they are summed, not merged`,
      meta: { kind, day, rows: duplicateRows }
    });
  }

  if (existingRowId) {
    // Conditional on the number that was read. `done` is an absolute, and
    // several awaits sit between the check and this write in every caller, so
    // two requests that both read `n` would both write `n + 1` and one of the
    // two actions would vanish from the day's count — an account sending more
    // than its plan allows, with the counter saying otherwise. Guarded, the
    // loser writes nothing and finds out.
    const written = await anty.from("wl_day_actions")
      .update({ done: rowDone + step, updated_at: new Date().toISOString() })
      .eq("id", existingRowId).eq("done", rowDone)
      .select("id").rows();
    if (!written.length) {
      // Somebody counted between the read and the write. Re-read and add this
      // action on top of whatever the truth now is, rather than overwriting it.
      const current = await anty.from("wl_day_actions").select("done").eq("id", existingRowId).maybeSingle();
      const corrected = (Number(current?.done) || 0) + step;
      await anty.from("wl_day_actions")
        .update({ done: corrected, updated_at: new Date().toISOString() })
        .eq("id", existingRowId).rows();
      await logEvent({
        accountId: account.id, runId: run.id, level: "warn", type: "action.recount",
        message: `Two ${ACTION_LABEL[kind]} were counted at once; the day now stands at ${corrected}`,
        meta: { kind, day, expected: done, corrected, quota }
      });
    }
  } else {
    // Re-read first: between the check and here another writer may have made
    // the row this one is about to duplicate. It does not close the window —
    // nothing without a unique index can — but it closes the common one, where
    // two requests arrive a few hundred milliseconds apart.
    const appeared = await anty.from("wl_day_actions").select("id,done")
      .eq("run_id", run.id).eq("on_date", today()).eq("kind", kind)
      .order("id", { ascending: true }).rows();
    if (appeared.length) {
      const mine = appeared[0];
      await anty.from("wl_day_actions")
        .update({ done: (Number(mine.done) || 0) + step, updated_at: new Date().toISOString() })
        .eq("id", mine.id).rows();
    } else {
      await anty.from("wl_day_actions").insert({
        run_id: run.id, account_id: account.id, day, on_date: today(), kind, quota, done
      }).rows();
    }
  }

  await recordSessionAction(account.id, kind, step);

  const counted = `${ACTION_LABEL[kind]}: ${done} of ${quota} (day ${day})`;
  await logEvent({
    accountId: account.id, runId: run.id, type: "action.recorded",
    message: detail ? `${counted} — ${detail}` : counted,
    meta: { kind, day, done, quota, detail }
  });
}

/** Check and commit in one go — the warm-up panel's "I did one of these". */
const actionWriters = new Map();

export function withAccountQuota(accountId, write) {
  const previous = actionWriters.get(accountId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(write);
  actionWriters.set(accountId, current);
  const clear = () => { if (actionWriters.get(accountId) === current) actionWriters.delete(accountId); };
  current.then(clear, clear);
  return current;
}

export async function recordAction(account, run, kind, step = 1, detail = null) {
  return withAccountQuota(account.id, async () => {
    const outcome = await checkQuota(account, run, kind, step);
    if (outcome.ok) await commitAction(account, run, kind, outcome, detail);
    return outcome;
  });
}

/**
 * An account with everything a screen needs and nothing it does not.
 *
 * The password is deliberately absent: the list has no use for it, and the
 * surest way to keep a secret out of a log, a cache or a screenshot is to never
 * put it in the payload.
 */
export async function describeAccount(account) {
  const [run, proxy, identity] = await Promise.all([
    newestRun(account.id),
    account.proxy_id
      ? anty.from("wl_proxies").select("id,label,kind,host,port,username,country,status,last_checked_at").eq("id", account.proxy_id).maybeSingle()
      : Promise.resolve(null),
    loginIdentity(account.id)
  ]);

  const base = {
    id: account.id,
    label: account.label,
    login: account.login,
    hasPassword: Boolean(account.password_cipher),
    profileRemoteId: account.profile_remote_id,
    proxy,
    proxyId: account.proxy_id,
    strategyId: account.strategy_id,
    status: account.status,
    identity,
    health: account.health,
    healthNote: account.health_note,
    healthChangedAt: account.health_changed_at,
    note: account.owner_note,
    createdAt: account.created_at
  };

  if (!run || run.state === "stopped") return { ...base, warmup: null, nextSession: null };

  const snapshot = run.strategy_snapshot;
  // Stands still through a pause rather than showing the paused dates already
  // taken out of it — see `runDay`.
  const day = runDay(run);
  const isPaused = pausedOn(run, today());
  const plan = planForDay(snapshot, account.id, day);
  // Working mode is not finished: past the last phase the account keeps a
  // plan, a next session and a quota, and the screen shows all three.
  const finished = plan.finished || run.state === "completed";
  const working = plan.working && !finished;

  const counters = await anty.from("wl_day_actions").select("kind,quota,done")
    .eq("run_id", run.id).eq("on_date", today()).rows();

  const done = {};
  for (const kind of ACTION_KINDS) done[kind] = 0;
  for (const row of counters) {
    // Summed, like `checkQuota`: a duplicate row carries its own writer's
    // count, and the last one read alone showed half the day.
    if (ACTION_KINDS.includes(row.kind)) done[row.kind] += Number(row.done) || 0;
  }

  const weekly = await weeklyConnectAllowance(account.id);
  plan.quotas.connect = connectCeiling(plan.quotas.connect, done.connect, weekly.done);
  const idle = {};
  for (const kind of ACTION_KINDS) idle[kind] = 0;

  return {
    ...base,
    // Only while the plan is live: a finished or paused account has no next
    // slot. An untouched quota keeps the session due today rather than rolling
    // it to tomorrow.
    nextSession: finished || isPaused
      ? null
      : nextSession(account.id, {
          outstanding: ACTION_KINDS.some((kind) => (done[kind] ?? 0) < plan.quotas[kind]),
          notBefore: heldUntil(account.id)
        }),
    warmup: {
      runId: run.id,
      strategyName: snapshot.name,
      startedAt: run.started_at,
      // The real day in working mode — "day 15 of 14" forever would hide how
      // long an account has been sending.
      day: working ? day : Math.min(day, totalDays(snapshot) + 1),
      totalDays: totalDays(snapshot),
      state: isPaused ? "paused" : finished ? "completed" : "running",
      // "warmup" or "working": which of the two a running account is in.
      mode: working ? "working" : "warmup",
      working,
      // Only while it holds. A date that has passed is not a pause, and a
      // screen that printed "paused until" it would be showing a stall that
      // is not there.
      pausedUntil: isPaused ? run.paused_until : null,
      // The stall included, the number the day is counted with — see
      // `pausedDaysOn`.
      pausedDays: pausedDaysOn(run, today()),
      phase: plan.phase?.label ?? null,
      rules: plan.rules,
      connectionNote: plan.connectionNote,
      // A paused or finished account has no plan for today, and saying "0 of 5"
      // would read as "behind" rather than "stopped".
      quotas: finished || isPaused ? idle : plan.quotas,
      weeklyConnections: weekly,
      done,
      finished
    }
  };
}
