import { anty, today } from "./db.mjs";
import { ACTION_KINDS, ACTION_LABEL, DEFAULT_STRATEGY, currentDay, dailyQuota, planForDay, totalDays } from "./strategy.mjs";
import { nextSession } from "./schedule.mjs";

/**
 * Reading and writing the warm-up's own tables.
 *
 * The quota rule lives here rather than in the routes because two paths cause a
 * connection request — the warm-up panel's "record" and sending one to a lead
 * from the CRM queue — and a second copy of "is it allowed, add one to today,
 * attach it to the open session" is a day counter that drifts.
 */

/**
 * The log, written on the same path as the change it describes and never as an
 * afterthought: an account that gets restricted is investigated through this
 * table, and a gap in it is the moment you needed.
 */
export async function logEvent(input) {
  try {
    await anty.from("wl_events").insert({
      account_id: input.accountId ?? null,
      run_id: input.runId ?? null,
      level: input.level || "info",
      type: input.type,
      message: input.message,
      meta: input.meta ?? null
    }).rows();
  } catch (error) {
    console.error("[warmup] could not write event:", error.message);
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
  if (!account || !run || run.state !== "running") return 0;
  if (run.paused_until && run.paused_until >= todayIso) return 0;
  const snapshot = run.strategy_snapshot;
  if (!snapshot?.phases) return 0;
  const day = currentDay(new Date(run.started_at), run.paused_days ?? 0);
  if (day > totalDays(snapshot)) return 0;
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
    .in("state", ["running", "paused"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
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

  const day = currentDay(new Date(run.started_at), run.paused_days ?? 0);
  if (day > totalDays(snapshot)) return { ok: false, status: 409, error: "Warm-up is finished" };

  const quota = dailyQuota(snapshot, account.id, day, kind);
  // No quota in this phase means forbidden, not unlimited.
  if (quota === 0) return { ok: false, status: 409, error: `${ACTION_LABEL[kind]} are not allowed on day ${day}` };

  const existing = await anty.from("wl_day_actions").select("id,done")
    .eq("run_id", run.id).eq("on_date", today()).eq("kind", kind)
    .maybeSingle();

  const done = (existing?.done ?? 0) + step;
  if (done > quota) {
    return { ok: false, status: 409, error: `Daily quota reached (${quota})`, quota, done: existing?.done ?? 0 };
  }

  return { ok: true, day, quota, done, step, existingRowId: existing?.id ?? null };
}

/**
 * Write the action down: the day counter, the open session, the log. Takes the
 * allowance rather than re-reading, so the number that was checked is the
 * number that gets stored.
 */
export async function commitAction(account, run, kind, allowance, detail = null) {
  const { day, quota, done, step, existingRowId } = allowance;

  if (existingRowId) {
    await anty.from("wl_day_actions").update({ done, updated_at: new Date().toISOString() }).eq("id", existingRowId).rows();
  } else {
    await anty.from("wl_day_actions").insert({
      run_id: run.id, account_id: account.id, day, on_date: today(), kind, quota, done
    }).rows();
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
export async function recordAction(account, run, kind, step = 1, detail = null) {
  const outcome = await checkQuota(account, run, kind, step);
  if (outcome.ok) await commitAction(account, run, kind, outcome, detail);
  return outcome;
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
  const day = currentDay(new Date(run.started_at), run.paused_days ?? 0);
  const isPaused = Boolean(run.paused_until && run.paused_until >= today());
  const finished = day > totalDays(snapshot) || run.state === "completed";
  const plan = planForDay(snapshot, account.id, day);

  const counters = await anty.from("wl_day_actions").select("kind,quota,done")
    .eq("run_id", run.id).eq("on_date", today()).rows();

  const done = {};
  for (const kind of ACTION_KINDS) done[kind] = 0;
  for (const row of counters) {
    if (ACTION_KINDS.includes(row.kind)) done[row.kind] = row.done ?? 0;
  }

  const idle = {};
  for (const kind of ACTION_KINDS) idle[kind] = 0;

  return {
    ...base,
    // Only while the plan is live: a finished or paused account has no next
    // slot. An untouched quota keeps the session due today rather than rolling
    // it to tomorrow.
    nextSession: finished || isPaused
      ? null
      : nextSession(account.id, { outstanding: ACTION_KINDS.some((kind) => (done[kind] ?? 0) < plan.quotas[kind]) }),
    warmup: {
      runId: run.id,
      strategyName: snapshot.name,
      startedAt: run.started_at,
      day: Math.min(day, totalDays(snapshot) + 1),
      totalDays: totalDays(snapshot),
      state: isPaused ? "paused" : finished ? "completed" : "running",
      pausedUntil: run.paused_until,
      pausedDays: run.paused_days ?? 0,
      phase: plan.phase?.label ?? null,
      rules: plan.rules,
      connectionNote: plan.connectionNote,
      // A paused or finished account has no plan for today, and saying "0 of 5"
      // would read as "behind" rather than "stopped".
      quotas: finished || isPaused ? idle : plan.quotas,
      done,
      finished
    }
  };
}
