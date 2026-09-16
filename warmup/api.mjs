import { anty, crm, antyTeamId, crmError, leadById, leadQueue, today } from "./db.mjs";
import { RestError } from "./rest.mjs";
import { ACTION_KINDS, ACTION_LABEL, currentDay, dailyQuota, planForDay, totalDays, validateStrategy } from "./strategy.mjs";
import { SESSION_WINDOW, insideWindow, nextSession, windowLabel } from "./schedule.mjs";
import { HEALTH_LABEL, HEALTH_VALUES, deriveStatus, isHealth } from "./status.mjs";
import { PLATFORMS, parseProxy, platformOf, proxyString, retag } from "./platform.mjs";
import { OUTREACH_COLUMNS, OUTREACH_STATUSES, describeOutreach, sentBy } from "./outreach.mjs";
import { antyTimestampToIso, describeSession, durationMin } from "./sessions.mjs";
import { encryptSecret, secretsConfigured } from "./secretbox.mjs";
import {
  activeRun, checkQuota, commitAction, describeAccount, ensureDefaultStrategy,
  logEvent, loadAccount, newestRun, openSession, recordAction, toStrategy
} from "./store.mjs";

/**
 * The warm-up's HTTP surface, mounted under /api/warmup.
 *
 * Every route here sits behind the workspace sign-in the rest of the app
 * already enforces. That matters: the standalone portal this was ported from
 * held a service-role key and could only be safe by binding to 127.0.0.1.
 */

const AGENT_SESSION_MAX_MS = 2 * 60 * 60 * 1000;

function fail(response, sendJson, status, error) {
  sendJson(response, status, { success: false, error });
  return true;
}

/** A refusal, worded and shaped identically wherever it came from. */
function refusal(response, sendJson, outcome) {
  sendJson(response, outcome.status, {
    success: false,
    error: outcome.error,
    ...(outcome.quota === undefined ? {} : { quota: outcome.quota, done: outcome.done })
  });
  return true;
}

function intParam(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

async function setAccountStatus(accountId, status) {
  await anty.from("wl_accounts").update({ status, updated_at: new Date().toISOString() }).eq("id", accountId).rows();
}

/**
 * Today's connection-request allowance, read from the run's own strategy
 * snapshot — the same source the record path checks against, so the number the
 * list shows and the number an action is refused by cannot disagree.
 */
function connectQuotaToday(account, run, todayIso) {
  if (!account || !run || run.state !== "running") return 0;
  if (run.paused_until && run.paused_until >= todayIso) return 0;
  const snapshot = run.strategy_snapshot;
  if (!snapshot?.phases) return 0;
  const day = currentDay(new Date(run.started_at), run.paused_days ?? 0);
  if (day > totalDays(snapshot)) return 0;
  return dailyQuota(snapshot, account.id, day, "connect");
}

/**
 * The first day this strategy allows a connection request. An empty column on
 * day 2 reads as broken; it is not, the plan forbids requests for three days.
 * Only while that day is still ahead — "from day 4" on day 9 would be a lie.
 */
function connectStartsDay(run) {
  const phases = run?.strategy_snapshot?.phases;
  if (!run || !phases?.length) return null;
  const first = phases.find((phase) => Array.isArray(phase.quotas?.connect) && phase.quotas.connect[1] > 0);
  if (!first) return null;
  const day = currentDay(new Date(run.started_at), run.paused_days ?? 0);
  return day < first.fromDay ? first.fromDay : null;
}

function phaseOf(account, run) {
  return account.status === "excluded" ? "excluded"
    : !run || run.state === "stopped" ? "idle"
    : run.state === "completed" ? "finished"
    : run.paused_until && run.paused_until >= today() ? "paused"
    : "warming";
}

export async function handleWarmupApi({ request, response, url, sendJson, readJson }) {
  const path = url.pathname.replace(/^\/api\/warmup/, "") || "/";
  const method = request.method;

  try {
    // ── configuration ──────────────────────────────────────────────────────
    if (method === "GET" && path === "/config") {
      sendJson(response, 200, {
        success: true,
        configured: anty.configured(),
        missing: anty.missing(),
        crmConfigured: crm.configured(),
        crmMissing: crm.missing(),
        secretsConfigured: secretsConfigured(),
        teamConfigured: Boolean(antyTeamId()),
        window: { ...SESSION_WINDOW, label: windowLabel(), open: insideWindow() },
        actionKinds: ACTION_KINDS.map((kind) => ({ kind, label: ACTION_LABEL[kind] })),
        healthValues: HEALTH_VALUES.map((value) => ({ value, label: HEALTH_LABEL[value] }))
      });
      return true;
    }

    // ── overview ───────────────────────────────────────────────────────────
    if (method === "GET" && path === "/dashboard") {
      const rows = await anty.from("wl_accounts").select("*").rows();
      const accounts = await Promise.all(rows.map(describeAccount));

      const totals = { total: accounts.length, warming: 0, paused: 0, completed: 0, idle: 0 };
      let plannedToday = 0;
      let doneToday = 0;
      const attention = [];

      for (const account of accounts) {
        const warmup = account.warmup;
        if (!warmup) { totals.idle += 1; continue; }
        if (warmup.state === "paused") {
          totals.paused += 1;
          attention.push({ id: account.id, label: account.label, reason: `Paused after a warning until ${warmup.pausedUntil}` });
          continue;
        }
        if (warmup.finished) {
          totals.completed += 1;
          attention.push({ id: account.id, label: account.label, reason: "Warm-up finished — ready for working mode" });
          continue;
        }
        totals.warming += 1;
        for (const kind of Object.keys(warmup.quotas)) {
          plannedToday += warmup.quotas[kind];
          doneToday += Math.min(warmup.done[kind], warmup.quotas[kind]);
        }
        if (!account.profileRemoteId) {
          attention.push({ id: account.id, label: account.label, reason: "No Anty profile linked" });
        }
      }

      const recent = await anty.from("wl_events").select("id,account_id,level,type,message,created_at")
        .order("created_at", { ascending: false }).limit(8).rows();

      sendJson(response, 200, {
        success: true,
        date: today(),
        totals,
        todayProgress: { planned: plannedToday, done: doneToday },
        attention: attention.slice(0, 8),
        recent
      });
      return true;
    }

    // ── Anty profiles, with the warm-up joined on ──────────────────────────
    if (method === "GET" && path === "/profiles") {
      const platform = url.searchParams.get("platform") || "linkedin";
      const showExcluded = url.searchParams.get("excluded") === "1";
      const search = (url.searchParams.get("q") || "").trim().toLowerCase();
      const teamId = antyTeamId();

      let query = anty.from("anty_browser_profiles")
        .select("id,name,status,start_page,tags,proxy,last_launched_at,created_by_name,created_by_email")
        .eq("is_deleted", false);
      if (teamId) query = query.eq("team_id", teamId);
      const profileRows = await query.order("name").rows();

      // Every account with its newest session embedded: PostgREST applies the
      // limit per parent row, so this stays one round trip however many
      // sessions there are.
      const linked = await anty.from("wl_accounts")
        .select("id,profile_remote_id,status,health,health_note,wl_sessions(started_at,ended_at)")
        .order("started_at", { ascending: false, foreignTable: "wl_sessions" })
        .limit(1, { foreignTable: "wl_sessions" })
        .rows();

      // One query for every run rather than one per profile: the list is the
      // screen people keep open, and it should not cost 22 round trips to draw.
      const runs = await anty.from("wl_runs")
        .select("account_id,state,paused_until,started_at,paused_days,strategy_snapshot")
        .in("state", ["running", "paused", "completed"])
        .order("started_at", { ascending: false })
        .rows();

      const runByAccount = new Map();
      for (const run of runs) if (!runByAccount.has(run.account_id)) runByAccount.set(run.account_id, run);

      const todayIso = today();
      const dayRows = await anty.from("wl_day_actions").select("account_id,on_date,kind,quota,done").rows();
      const connectionsByAccount = new Map();
      const outstandingByAccount = new Map();
      const hasDayRow = new Set();
      for (const row of dayRows) {
        if (row.on_date === todayIso) hasDayRow.add(row.account_id);
        if (row.kind === "connect") {
          const sum = connectionsByAccount.get(row.account_id) || { today: 0, total: 0 };
          sum.total += row.done ?? 0;
          if (row.on_date === todayIso) sum.today += row.done ?? 0;
          connectionsByAccount.set(row.account_id, sum);
        }
        if (row.on_date === todayIso && (row.done ?? 0) < (row.quota ?? 0)) {
          outstandingByAccount.set(row.account_id, true);
        }
      }

      const outreachRows = await anty.from("wl_outreach").select("account_id").rows();
      const outreachByAccount = new Map();
      for (const row of outreachRows) {
        outreachByAccount.set(row.account_id, (outreachByAccount.get(row.account_id) ?? 0) + 1);
      }

      const byProfile = new Map(linked.map((account) => [account.profile_remote_id, account]));

      const describe = (row) => {
        const account = byProfile.get(row.id) || null;
        const run = account ? runByAccount.get(account.id) || null : null;
        const last = account?.wl_sessions?.[0] || null;
        const status = deriveStatus(account, run, todayIso);
        // The day the account is on, so the list's Day column has something to
        // put there. Read from the run's own snapshot, which is what the detail
        // panel reads too — two ways of counting the day is two answers.
        const day = run && run.state !== "stopped"
          ? { day: currentDay(new Date(run.started_at), run.paused_days ?? 0), totalDays: totalDays(run.strategy_snapshot) }
          : null;
        return {
          id: row.id,
          name: row.name,
          platform: platformOf(row),
          startPage: row.start_page,
          proxy: row.proxy?.host ? proxyString(row.proxy) : null,
          lastLaunchedAt: row.last_launched_at,
          owner: row.created_by_name?.trim() || row.created_by_email || null,
          ownerEmail: row.created_by_email,
          account: account ? { id: account.id, status: account.status, phase: phaseOf(account, run) } : null,
          day: day && day.day <= day.totalDays ? `${day.day}/${day.totalDays}` : null,
          health: account?.health ?? "ok",
          healthNote: account?.health_note ?? null,
          status,
          isRunningNow: row.status === "running",
          connections: {
            ...(connectionsByAccount.get(account?.id ?? "") || { today: 0, total: 0 }),
            quota: connectQuotaToday(account, run, todayIso),
            startsDay: connectStartsDay(run)
          },
          outreachTotal: outreachByAccount.get(account?.id ?? "") ?? 0,
          lastSession: last
            ? { startedAt: last.started_at, endedAt: last.ended_at, durationMin: durationMin(last.started_at, last.ended_at) }
            : null,
          // Only an account that is warming and not already open has a next
          // session: promising "next at 14:20" for one that is off or blocked
          // would be a commitment nobody is going to keep.
          nextSession: account && status === "warming" && row.status !== "running"
            ? nextSession(account.id, {
                // No day row yet means today has not been started at all, which
                // is the most outstanding a day can be.
                outstanding: outstandingByAccount.get(account.id) ?? !hasDayRow.has(account.id)
              })
            : null
        };
      };

      const profiles = profileRows
        .map(describe)
        .filter((profile) => (platform === "all" ? true : profile.platform === platform))
        .filter((profile) => (showExcluded ? profile.account?.phase === "excluded" : profile.account?.phase !== "excluded"))
        .filter((profile) => (search ? profile.name.toLowerCase().includes(search) : true));

      const counts = { all: 0, excluded: 0 };
      for (const row of profileRows) {
        if (byProfile.get(row.id)?.status === "excluded") { counts.excluded += 1; continue; }
        const name = platformOf(row);
        counts[name] = (counts[name] ?? 0) + 1;
        counts.all += 1;
      }

      sendJson(response, 200, { success: true, profiles, counts, teamConfigured: Boolean(teamId) });
      return true;
    }

    /**
     * Edit an Anty profile: name, owner, type or proxy. These rows belong to
     * Anty and its desktop app syncs them, so every write here is a write into
     * somebody else's product — which is why each field is validated first and
     * the type is re-tagged rather than stored in a column of our own.
     */
    if (method === "PATCH" && path === "/profiles") {
      const body = await readJson(request);
      if (!body?.id) return fail(response, sendJson, 400, "Which profile?");

      const profile = await anty.from("anty_browser_profiles")
        .select("id,name,start_page,tags,proxy,created_by_name,created_by_email")
        .eq("id", String(body.id)).maybeSingle();
      if (!profile) return fail(response, sendJson, 404, "Profile not found");

      const patch = { updated_at: new Date().toISOString() };
      const changes = [];

      if (typeof body.name === "string") {
        const name = body.name.trim();
        if (!name) return fail(response, sendJson, 400, "The name cannot be empty");
        if (name !== profile.name) { patch.name = name; changes.push(`renamed to "${name}"`); }
      }

      if (typeof body.owner === "string") {
        const owner = body.owner.trim();
        if (owner !== (profile.created_by_name ?? "")) {
          patch.created_by_name = owner || null;
          changes.push(owner ? `owner set to "${owner}"` : "owner cleared");
        }
      }

      if (typeof body.platform === "string") {
        if (!PLATFORMS.includes(body.platform)) return fail(response, sendJson, 400, "Unknown type");
        if (platformOf(profile) !== body.platform) {
          const result = retag(profile, body.platform);
          if (result.conflict) {
            return fail(response, sendJson, 409, `Its start page is ${result.conflict} — change that first, or the two will disagree`);
          }
          patch.tags = result.tags;
          changes.push(`marked as ${body.platform}`);
        }
      }

      if (typeof body.proxy === "string") {
        const input = body.proxy.trim();
        if (!input) {
          if (profile.proxy?.host) { patch.proxy = null; changes.push("proxy removed"); }
        } else {
          const parsed = parseProxy(input);
          if (parsed.error) return fail(response, sendJson, 400, `Proxy: ${parsed.error}`);
          patch.proxy = parsed;
          changes.push(`proxy set to ${parsed.host}:${parsed.port}`);
        }
      }

      if (!changes.length) { sendJson(response, 200, { success: true, unchanged: true }); return true; }

      await anty.from("anty_browser_profiles").update(patch).eq("id", profile.id).rows();
      // The proxy password is not repeated into the log; the host is enough to
      // know which proxy was meant.
      await logEvent({ type: "profile.edited", message: `"${profile.name}": ${changes.join(", ")}`, meta: { profileId: profile.id } });
      sendJson(response, 200, { success: true });
      return true;
    }

    // ── accounts ───────────────────────────────────────────────────────────
    if (method === "GET" && path === "/accounts") {
      // One account by id, for the detail panel — the list is too heavy an
      // answer to a question about a single row.
      const single = url.searchParams.get("id");
      if (single) {
        const account = await loadAccount(single);
        if (!account) return fail(response, sendJson, 404, "Account not found");
        sendJson(response, 200, {
          success: true,
          secretsConfigured: secretsConfigured(),
          account: await describeAccount(account)
        });
        return true;
      }

      const status = url.searchParams.get("status");
      const search = (url.searchParams.get("q") || "").trim();

      let query = anty.from("wl_accounts").select("*");
      if (status && status !== "all") query = query.eq("status", status);
      if (search) query = query.or(`label.ilike.*${search}*,login.ilike.*${search}*`);
      const rows = await query.order("created_at", { ascending: false }).rows();

      sendJson(response, 200, {
        success: true,
        secretsConfigured: secretsConfigured(),
        accounts: await Promise.all(rows.map(describeAccount))
      });
      return true;
    }

    if (method === "POST" && path === "/accounts") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Invalid JSON body");

      const label = String(body.label || "").trim();
      const login = String(body.login || "").trim();
      const password = String(body.password || "");
      const profileRemoteId = body.profileRemoteId ? String(body.profileRemoteId) : null;

      // A login is optional: an account created from an Anty profile is
      // identified by that profile, and demanding one here is what made
      // "Warm up" fail on a screen that has no field to type it into.
      if (!label) return fail(response, sendJson, 400, "A name is required");

      // One warm-up record per profile — two would count the same day twice.
      if (profileRemoteId) {
        const existing = await anty.from("wl_accounts").select("*").eq("profile_remote_id", profileRemoteId).maybeSingle();
        if (existing) { sendJson(response, 200, { success: true, account: await describeAccount(existing) }); return true; }
      }

      // Refuse rather than save the account with the password silently dropped.
      if (password && !secretsConfigured()) {
        return fail(response, sendJson, 503, "Password storage is not configured on this server (LINKEDIN_SECRET_KEY)");
      }

      const strategy = body.strategyId ? { id: String(body.strategyId) } : await ensureDefaultStrategy();

      const created = await anty.from("wl_accounts").insert({
        label,
        login: login || null,
        password_cipher: password ? encryptSecret(password) : null,
        profile_remote_id: profileRemoteId,
        proxy_id: body.proxyId ? String(body.proxyId) : null,
        strategy_id: strategy.id,
        owner_note: body.note ? String(body.note) : null
      }).select("*").single();

      await logEvent({ accountId: created.id, type: "account.created", message: `Account "${label}" added`, meta: { login } });
      sendJson(response, 201, { success: true, account: await describeAccount(created) });
      return true;
    }

    if (method === "PATCH" && path === "/accounts") {
      const body = await readJson(request);
      if (!body?.id) return fail(response, sendJson, 400, "Which account?");

      const account = await loadAccount(String(body.id));
      if (!account) return fail(response, sendJson, 404, "Account not found");

      const patch = { updated_at: new Date().toISOString() };
      const changed = [];
      if (typeof body.label === "string" && body.label.trim()) { patch.label = body.label.trim(); changed.push("name"); }
      if (typeof body.login === "string" && body.login.trim()) { patch.login = body.login.trim(); changed.push("login"); }
      if ("proxyId" in body) { patch.proxy_id = body.proxyId || null; changed.push("proxy"); }
      if ("profileRemoteId" in body) { patch.profile_remote_id = body.profileRemoteId || null; changed.push("Anty profile"); }
      if ("strategyId" in body) { patch.strategy_id = body.strategyId || null; changed.push("strategy"); }
      if ("note" in body) { patch.owner_note = body.note ? String(body.note) : null; changed.push("note"); }
      if (typeof body.password === "string" && body.password) {
        if (!secretsConfigured()) return fail(response, sendJson, 503, "Password storage is not configured (LINKEDIN_SECRET_KEY)");
        patch.password_cipher = encryptSecret(body.password);
        changed.push("password");
      }

      await anty.from("wl_accounts").update(patch).eq("id", account.id).rows();
      if (changed.length) {
        // The value is not logged — a proxy change is worth knowing about, the
        // credentials behind it are not something to leave in a log table.
        await logEvent({ accountId: account.id, type: "account.updated", message: `Changed ${changed.join(", ")}` });
      }

      const fresh = await loadAccount(account.id);
      sendJson(response, 200, { success: true, account: await describeAccount(fresh) });
      return true;
    }

    if (method === "DELETE" && path === "/accounts") {
      const id = url.searchParams.get("id");
      if (!id) return fail(response, sendJson, 400, "Which account?");
      const account = await loadAccount(id);
      if (!account) return fail(response, sendJson, 404, "Account not found");

      await logEvent({ accountId: null, level: "warn", type: "account.deleted", message: `Account "${account.label}" deleted` });
      await anty.from("wl_accounts").remove().eq("id", account.id).rows();
      sendJson(response, 200, { success: true });
      return true;
    }

    /**
     * Health: what a human saw when they opened the profile.
     *
     * Nothing here can detect a block — the browser is Anty's and LinkedIn does
     * not send a webhook — so this is a hand-set flag. It exists because
     * "blocked" has to outrank every warm-up state in the list: a run that
     * keeps advancing on a blocked account is exactly how the next account gets
     * treated the same way.
     */
    if (method === "POST" && path === "/accounts/health") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Invalid JSON body");
      if (!body.accountId) return fail(response, sendJson, 400, "Which account?");
      if (!isHealth(body.health)) return fail(response, sendJson, 400, `Health must be one of: ${HEALTH_VALUES.join(", ")}`);

      const account = await loadAccount(String(body.accountId));
      if (!account) return fail(response, sendJson, 404, "Account not found");

      const health = body.health;
      const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
      if (health === account.health && note === account.health_note) {
        sendJson(response, 200, { success: true, unchanged: true, account: await describeAccount(account) });
        return true;
      }

      const now = new Date().toISOString();
      const fresh = await anty.from("wl_accounts").update({
        health,
        // Always written, even to null: a "captcha on login" note left on an
        // account that is OK again is a note somebody will act on by mistake.
        health_note: note,
        // "Blocked since Tuesday" must survive a note added on Thursday, so the
        // timestamp moves only with the health itself.
        health_changed_at: health === account.health ? account.health_changed_at : now,
        updated_at: now
      }).eq("id", account.id).select("*").single();

      await logEvent({
        accountId: account.id,
        type: "account.health",
        // Anything but OK is a person's problem to solve, which is what warn
        // means in this log.
        level: health === "ok" ? "info" : "warn",
        message: `Health: ${HEALTH_LABEL[health]}${note ? ` — ${note}` : ""}`,
        meta: { health, previous: account.health, note }
      });

      sendJson(response, 200, { success: true, account: await describeAccount(fresh) });
      return true;
    }

    /**
     * Warm-up control: exclude, include, start, warning, resume, stop, record.
     *
     * Every branch writes to the event log on the same path as the change,
     * because this log is what gets read when an account is restricted and
     * somebody needs to know what was done to it in the days before.
     */
    if (method === "POST" && path === "/control") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Invalid JSON body");

      const account = body.accountId ? await loadAccount(String(body.accountId)) : null;
      if (!account) return fail(response, sendJson, 404, "Account not found");
      const action = String(body.action || "");

      // Excluded is a state rather than a deletion, because "we decided not to
      // warm this one" is a decision worth keeping — otherwise the profile
      // reappears in the list and gets put on warm-up by the next person.
      if (action === "exclude") {
        const running = await activeRun(account.id);
        if (running) {
          await anty.from("wl_runs").update({ state: "stopped", completed_at: new Date().toISOString() }).eq("id", running.id).rows();
        }
        await setAccountStatus(account.id, "excluded");
        await logEvent({
          accountId: account.id, level: "warn", type: "account.excluded",
          message: running ? "Excluded from warm-up — the run in progress was stopped" : "Excluded from warm-up"
        });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      if (action === "include") {
        await setAccountStatus(account.id, "idle");
        await logEvent({ accountId: account.id, type: "account.included", message: "Back in the warm-up list" });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      if (action === "start") {
        if (account.status === "excluded") return fail(response, sendJson, 409, "This account is excluded from warm-up");
        if (await activeRun(account.id)) return fail(response, sendJson, 409, "This account is already warming up");

        let strategy;
        if (account.strategy_id) {
          const row = await anty.from("wl_strategies").select("*").eq("id", account.strategy_id).maybeSingle();
          strategy = row ? toStrategy(row) : await ensureDefaultStrategy();
        } else {
          strategy = await ensureDefaultStrategy();
        }

        const run = await anty.from("wl_runs").insert({
          account_id: account.id,
          strategy_id: strategy.id,
          // Snapshot: editing a strategy later must not rewrite what an account
          // part-way through was working to.
          strategy_snapshot: { name: strategy.name, phases: strategy.phases, pauseDays: strategy.pauseDays }
        }).select("*").single();

        await setAccountStatus(account.id, "warming");
        await logEvent({
          accountId: account.id, runId: run.id, type: "run.started",
          message: `Warm-up started on "${strategy.name}"`, meta: { days: totalDays(strategy) }
        });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      const run = await activeRun(account.id);
      if (!run) return fail(response, sendJson, 409, "No warm-up in progress");

      if (action === "warning") {
        const pauseDays = run.strategy_snapshot?.pauseDays ?? 2;
        const until = new Date();
        until.setUTCDate(until.getUTCDate() + pauseDays);

        await anty.from("wl_runs").update({
          paused_until: until.toISOString().slice(0, 10),
          // Added to paused_days so the schedule does not advance through the pause.
          paused_days: (run.paused_days ?? 0) + pauseDays,
          state: "paused"
        }).eq("id", run.id).rows();
        await setAccountStatus(account.id, "restricted");

        await logEvent({
          accountId: account.id, runId: run.id, level: "warn", type: "run.warning",
          message: `LinkedIn warning — all actions stopped for ${pauseDays} days`,
          meta: { until: until.toISOString().slice(0, 10), note: body.note ?? null }
        });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      if (action === "resume") {
        await anty.from("wl_runs").update({ paused_until: null, state: "running" }).eq("id", run.id).rows();
        await setAccountStatus(account.id, "warming");
        await logEvent({ accountId: account.id, runId: run.id, type: "run.resumed", message: "Warm-up resumed" });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      if (action === "stop") {
        await anty.from("wl_runs").update({ state: "stopped", completed_at: new Date().toISOString() }).eq("id", run.id).rows();
        await setAccountStatus(account.id, "idle");
        await logEvent({ accountId: account.id, runId: run.id, level: "warn", type: "run.stopped", message: "Warm-up stopped" });
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      if (action === "record") {
        const kind = String(body.kind || "");
        if (!ACTION_KINDS.includes(kind)) return fail(response, sendJson, 400, "Unknown action");
        const step = Number.isInteger(body.count) ? Math.max(1, Number(body.count)) : 1;
        const outcome = await recordAction(account, run, kind, step);
        if (!outcome.ok) return refusal(response, sendJson, outcome);
        sendJson(response, 200, { success: true, account: await describeAccount(await loadAccount(account.id)) });
        return true;
      }

      return fail(response, sendJson, 400, "Unknown action");
    }

    // ── strategies ─────────────────────────────────────────────────────────
    if (method === "GET" && path === "/strategies") {
      await ensureDefaultStrategy();
      const rows = await anty.from("wl_strategies").select("*").eq("is_archived", false)
        .order("is_default", { ascending: false }).order("created_at").rows();
      sendJson(response, 200, { success: true, strategies: rows.map(toStrategy) });
      return true;
    }

    if (method === "POST" && path === "/strategies") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Invalid JSON body");
      const problem = validateStrategy(body);
      if (problem) return fail(response, sendJson, 400, problem);

      const created = await anty.from("wl_strategies").insert({
        name: String(body.name).trim(),
        description: body.description ? String(body.description) : null,
        phases: body.phases,
        pause_days: Number.isInteger(body.pauseDays) ? body.pauseDays : 2
      }).select("*").single();

      await logEvent({ type: "strategy.created", message: `Strategy "${created.name}" created` });
      sendJson(response, 201, { success: true, strategy: toStrategy(created) });
      return true;
    }

    if (method === "PATCH" && path === "/strategies") {
      const body = await readJson(request);
      if (!body?.id) return fail(response, sendJson, 400, "Which strategy?");
      const problem = validateStrategy(body);
      if (problem) return fail(response, sendJson, 400, problem);

      const existing = await anty.from("wl_strategies").select("*").eq("id", String(body.id)).maybeSingle();
      if (!existing) return fail(response, sendJson, 404, "Strategy not found");

      const updated = await anty.from("wl_strategies").update({
        name: String(body.name).trim(),
        description: body.description ? String(body.description) : null,
        phases: body.phases,
        pause_days: Number.isInteger(body.pauseDays) ? body.pauseDays : existing.pause_days,
        updated_at: new Date().toISOString()
      }).eq("id", existing.id).select("*").single();

      // Runs already under way keep their snapshot; only future ones see this.
      await logEvent({
        type: "strategy.updated",
        message: `Strategy "${updated.name}" edited — runs already in progress keep the version they started on`
      });
      sendJson(response, 200, { success: true, strategy: toStrategy(updated) });
      return true;
    }

    if (method === "DELETE" && path === "/strategies") {
      const id = url.searchParams.get("id");
      if (!id) return fail(response, sendJson, 400, "Which strategy?");
      const existing = await anty.from("wl_strategies").select("*").eq("id", id).maybeSingle();
      if (!existing) return fail(response, sendJson, 404, "Strategy not found");
      if (existing.is_default) return fail(response, sendJson, 409, "The default strategy cannot be deleted");

      // Archived, not deleted: accounts point at it, and runs reference it for
      // provenance even though they carry their own snapshot.
      await anty.from("wl_strategies").update({ is_archived: true }).eq("id", existing.id).rows();
      await logEvent({ type: "strategy.archived", level: "warn", message: `Strategy "${existing.name}" archived` });
      sendJson(response, 200, { success: true });
      return true;
    }

    // ── proxies ────────────────────────────────────────────────────────────
    if (method === "GET" && path === "/proxies") {
      const rows = await anty.from("wl_proxies")
        .select("id,label,kind,host,port,username,country,status,last_checked_at,last_check_note")
        .order("created_at", { ascending: false }).rows();

      // How many accounts sit behind each proxy: when one burns, that is the
      // blast radius, and it belongs on the list rather than in someone's head.
      const usage = await anty.from("wl_accounts").select("proxy_id").rows();
      const counts = new Map();
      for (const row of usage) {
        if (row.proxy_id) counts.set(row.proxy_id, (counts.get(row.proxy_id) ?? 0) + 1);
      }

      sendJson(response, 200, { success: true, proxies: rows.map((proxy) => ({ ...proxy, accounts: counts.get(proxy.id) ?? 0 })) });
      return true;
    }

    if (method === "POST" && path === "/proxies") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Invalid JSON body");

      const label = String(body.label || "").trim();
      const host = String(body.host || "").trim();
      const port = Number(body.port);
      if (!label || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
        return fail(response, sendJson, 400, "Name, host and a valid port are required");
      }
      const password = String(body.password || "");
      if (password && !secretsConfigured()) {
        return fail(response, sendJson, 503, "Password storage is not configured (LINKEDIN_SECRET_KEY)");
      }

      const created = await anty.from("wl_proxies").insert({
        label, host, port,
        kind: ["http", "https", "socks5"].includes(String(body.kind)) ? String(body.kind) : "http",
        username: body.username ? String(body.username) : null,
        password_cipher: password ? encryptSecret(password) : null,
        country: body.country ? String(body.country) : null
      }).select("id,label,kind,host,port,username,country,status,last_checked_at").single();

      await logEvent({ type: "proxy.created", message: `Proxy "${label}" added (${host}:${port})` });
      sendJson(response, 201, { success: true, proxy: { ...created, accounts: 0 } });
      return true;
    }

    if (method === "DELETE" && path === "/proxies") {
      const id = url.searchParams.get("id");
      if (!id) return fail(response, sendJson, 400, "Which proxy?");
      const proxy = await anty.from("wl_proxies").select("id,label").eq("id", id).maybeSingle();
      if (!proxy) return fail(response, sendJson, 404, "Proxy not found");

      // Accounts survive; they fall back to whatever their browser profile uses.
      await anty.from("wl_proxies").remove().eq("id", proxy.id).rows();
      await logEvent({ type: "proxy.deleted", level: "warn", message: `Proxy "${proxy.label}" deleted` });
      sendJson(response, 200, { success: true });
      return true;
    }

    // ── the log, sessions and outreach history ─────────────────────────────
    if (method === "GET" && path === "/events") {
      const accountId = url.searchParams.get("accountId");
      const level = url.searchParams.get("level");
      const limit = intParam(url.searchParams.get("limit"), 100, 500);

      let query = anty.from("wl_events").select("id,account_id,level,type,message,meta,created_at");
      if (accountId) query = query.eq("account_id", accountId);
      if (level && level !== "all") query = query.eq("level", level);
      const events = await query.order("created_at", { ascending: false }).limit(limit).rows();

      sendJson(response, 200, { success: true, events });
      return true;
    }

    if (method === "GET" && path === "/sessions") {
      const accountId = url.searchParams.get("accountId");
      if (!accountId) return fail(response, sendJson, 400, "Which account?");
      // Capped rather than paged: the question this answers is "what has this
      // account been doing lately", and lately is not four months ago.
      const rows = await anty.from("wl_sessions")
        .select("id,account_id,profile_remote_id,started_at,ended_at,source,running_on,actions,note")
        .eq("account_id", accountId).order("started_at", { ascending: false }).limit(100).rows();
      sendJson(response, 200, { success: true, sessions: rows.map(describeSession) });
      return true;
    }

    if (method === "GET" && path === "/outreach") {
      const accountId = url.searchParams.get("accountId");
      if (!accountId) return fail(response, sendJson, 400, "Which account?");
      const limit = intParam(url.searchParams.get("limit"), 100, 500);
      const rows = await anty.from("wl_outreach").select(OUTREACH_COLUMNS)
        .eq("account_id", accountId).order("created_at", { ascending: false }).limit(limit).rows();
      sendJson(response, 200, { success: true, outreach: rows.map(describeOutreach) });
      return true;
    }

    /**
     * What came of a request: connected, declined, or withdrawn. Set by hand,
     * because nothing here can see the other person's answer.
     */
    if (method === "PATCH" && path === "/outreach") {
      const body = await readJson(request);
      if (!body?.id) return fail(response, sendJson, 400, "Which outreach?");
      const status = String(body.status || "");
      if (!OUTREACH_STATUSES.includes(status)) return fail(response, sendJson, 400, "Unknown status");

      const existing = await anty.from("wl_outreach").select(OUTREACH_COLUMNS).eq("id", String(body.id)).maybeSingle();
      if (!existing) return fail(response, sendJson, 404, "That outreach record is gone");

      const patch = { status };
      if (typeof body.note === "string") patch.note = body.note.trim() || null;
      // Stamped on the way out of pending and cleared on the way back in, so the
      // time always means "when they answered". Kept as it was when one is
      // already recorded: correcting declined to connected should not move the
      // answer to the moment somebody fixed the typo.
      patch.responded_at = status === "pending" ? null : existing.responded_at ?? new Date().toISOString();

      const updated = await anty.from("wl_outreach").update(patch).eq("id", existing.id).select(OUTREACH_COLUMNS).single();
      await logEvent({
        accountId: existing.account_id, type: "outreach.updated",
        message: `${existing.person_name ?? "A contact"}: ${existing.status} → ${status}`,
        meta: { outreachId: existing.id, crmContactId: existing.crm_contact_id, from: existing.status, to: status }
      });
      sendJson(response, 200, { success: true, outreach: describeOutreach(updated) });
      return true;
    }

    // ── the lead queue ─────────────────────────────────────────────────────
    if (method === "GET" && path === "/leads") {
      const limit = intParam(url.searchParams.get("limit"), 10, 50);
      try {
        const leads = await nextCandidates(limit);
        sendJson(response, 200, {
          success: true,
          leads: leads.map((lead) => ({
            id: lead.id,
            name: lead.name,
            company: lead.company,
            position: lead.position,
            linkedin: lead.linkedin,
            country: lead.country,
            createdAt: lead.created_at
          }))
        });
      } catch (error) {
        // The CRM being unreachable is a different answer from "nobody left to
        // approach", and the panel has to be able to tell them apart.
        return fail(response, sendJson, 502, crmError(error));
      }
      return true;
    }

    /**
     * "I sent this person a connection request."
     *
     * One click that has to land in two places at once: the outreach record, so
     * nobody is approached twice from any account, and the warm-up day counter,
     * so a request sent from here costs the same as one recorded by hand.
     *
     * The order below is the whole design. The quota is asked first and nothing
     * is written when it refuses, so a request that was never allowed leaves no
     * trace claiming the person has been approached. The outreach row goes in
     * next, because that is the write that can still fail — the person may have
     * been taken from another account a second ago — and only once it is safely
     * in does the day counter move.
     */
    if (method === "POST" && path === "/leads/take") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Invalid JSON body");
      if (!body.crmContactId) return fail(response, sendJson, 400, "Which contact?");

      const account = body.accountId ? await loadAccount(String(body.accountId)) : null;
      if (!account) return fail(response, sendJson, 404, "Account not found");

      const run = await activeRun(account.id);
      if (!run) return fail(response, sendJson, 409, "No warm-up in progress");

      // Re-read rather than trusting what the panel had on screen: it may have
      // been open for an hour, and the snapshot we keep is the answer to "who
      // did we approach" long after the CRM row has moved on.
      let lead;
      try {
        lead = await leadById(String(body.crmContactId));
      } catch (error) {
        return fail(response, sendJson, 502, crmError(error));
      }
      if (!lead) return fail(response, sendJson, 404, "That contact is no longer in the CRM");

      const allowance = await checkQuota(account, run, "connect");
      if (!allowance.ok) return refusal(response, sendJson, allowance);

      let outreach;
      try {
        outreach = await anty.from("wl_outreach").insert({
          account_id: account.id,
          crm_contact_id: lead.id,
          person_name: lead.name,
          person_company: lead.company,
          person_position: lead.position,
          person_linkedin: lead.linkedin,
          person_country: lead.country,
          sent_by: sentBy(account),
          status: "pending"
        }).select(OUTREACH_COLUMNS).single();
      } catch (error) {
        // wl_outreach_person_once: one person, one approach, across every
        // account. A race between two screens is expected here, not exceptional.
        if (error instanceof RestError && error.code === "23505") {
          return fail(response, sendJson, 409, "This person has already been approached");
        }
        throw error;
      }

      await commitAction(account, run, "connect", allowance);

      await logEvent({
        accountId: account.id, runId: run.id, type: "outreach.sent",
        message: `Connection request to ${lead.name ?? "a contact"}${lead.company ? ` (${lead.company})` : ""}`,
        meta: { outreachId: outreach.id, crmContactId: lead.id, day: allowance.day, done: allowance.done, quota: allowance.quota }
      });

      sendJson(response, 200, {
        success: true,
        outreach: describeOutreach(outreach),
        account: await describeAccount(await loadAccount(account.id))
      });
      return true;
    }

    // ── reconciling Anty's "profile is running" with the sessions table ────
    if (method === "POST" && path === "/sync") {
      sendJson(response, 200, await syncSessions());
      return true;
    }

    // ── the seam between the portal and the agent ──────────────────────────
    if (method === "GET" && path === "/agent") {
      const accountId = url.searchParams.get("accountId");
      // Without an account, the one thing worth answering is whether the agent
      // should be running at all right now.
      if (!accountId) {
        sendJson(response, 200, { success: true, window: { ...SESSION_WINDOW, label: windowLabel(), open: insideWindow() } });
        return true;
      }

      const account = await loadAccount(accountId);
      if (!account) return fail(response, sendJson, 404, "Account not found");

      const run = await activeRun(account.id);
      const session = await openSession(account.id);
      const base = {
        success: true,
        account: {
          id: account.id,
          label: account.label,
          login: account.login,
          profileRemoteId: account.profile_remote_id,
          status: account.status,
          health: account.health
        },
        session: session ? { id: session.id, startedAt: session.started_at } : null,
        // The agent asks rather than carrying its own copy, so moving the
        // window on screen moves it for today's run too.
        window: { ...SESSION_WINDOW, label: windowLabel(), open: insideWindow() }
      };

      if (account.status === "excluded") {
        sendJson(response, 200, { ...base, runnable: false, reason: "Excluded from warm-up", plan: [] });
        return true;
      }
      if (!run) {
        sendJson(response, 200, { ...base, runnable: false, reason: "No warm-up in progress", plan: [] });
        return true;
      }
      if (run.paused_until && run.paused_until >= today()) {
        sendJson(response, 200, { ...base, runnable: false, reason: `Paused until ${run.paused_until}`, plan: [] });
        return true;
      }

      const snapshot = run.strategy_snapshot;
      const day = currentDay(new Date(run.started_at), run.paused_days ?? 0);
      if (day > totalDays(snapshot)) {
        sendJson(response, 200, { ...base, runnable: false, reason: "Warm-up is finished", plan: [], day });
        return true;
      }

      const dayPlan = planForDay(snapshot, account.id, day);
      const doneRows = await anty.from("wl_day_actions").select("kind,done").eq("run_id", run.id).eq("on_date", today()).rows();
      const doneByKind = new Map(doneRows.map((row) => [row.kind, Number(row.done) || 0]));

      const plan = ACTION_KINDS
        .map((kind) => {
          const quota = dayPlan.quotas[kind];
          const done = doneByKind.get(kind) ?? 0;
          return { kind, label: ACTION_LABEL[kind], quota, done, remaining: Math.max(0, quota - done) };
        })
        // A kind with no quota today is forbidden, not merely finished — the
        // agent never sees it, so it cannot decide to do "just one".
        .filter((row) => row.quota > 0);

      sendJson(response, 200, {
        ...base,
        runnable: true,
        runId: run.id,
        day,
        phase: dayPlan.phase?.label ?? null,
        rules: dayPlan.rules,
        connectionNote: dayPlan.connectionNote,
        plan
      });
      return true;
    }

    if (method === "POST" && path === "/agent") {
      const body = await readJson(request);
      if (!body) return fail(response, sendJson, 400, "Invalid JSON body");

      const account = body.accountId ? await loadAccount(String(body.accountId)) : null;
      if (!account) return fail(response, sendJson, 404, "Account not found");
      const action = String(body.action || "");

      // Idempotent on purpose: an agent that crashed after opening and is run
      // again should continue the session it left, not stack a second one on an
      // account that only has room for one open at a time.
      if (action === "session.open") {
        const existing = await openSession(account.id);
        if (existing) {
          sendJson(response, 200, { success: true, sessionId: existing.id, startedAt: existing.started_at, resumed: true });
          return true;
        }

        const startedAt = new Date().toISOString();
        let created;
        try {
          created = await anty.from("wl_sessions").insert({
            account_id: account.id,
            profile_remote_id: account.profile_remote_id,
            started_at: startedAt,
            running_on: String(body.host || "").trim() || "agent",
            source: "agent"
          }).select("id").single();
        } catch {
          return fail(response, sendJson, 409, "Could not open a session — one may already be open");
        }

        await logEvent({
          accountId: account.id, type: "session.opened", message: "Agent opened the profile",
          meta: { source: "agent", startedAt, host: body.host ?? null }
        });
        sendJson(response, 200, { success: true, sessionId: created.id, startedAt, resumed: false });
        return true;
      }

      if (action === "session.close") {
        const existing = await openSession(account.id);
        if (!existing) { sendJson(response, 200, { success: true, closed: false }); return true; }

        const endedAt = new Date().toISOString();
        const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
        const ended = await anty.from("wl_sessions").update({ ended_at: endedAt, note })
          .eq("id", existing.id).isNull("ended_at").select("id").rows();
        if (!ended.length) { sendJson(response, 200, { success: true, closed: false }); return true; }

        const minutes = durationMin(existing.started_at, endedAt);
        const did = Object.entries(existing.actions || {})
          .map(([kind, count]) => `${ACTION_LABEL[kind] ?? kind}: ${count}`)
          .join(", ");
        await logEvent({
          accountId: account.id,
          level: body.failed ? "error" : "info",
          type: "session.closed",
          message: `Agent finished after ${minutes} min${did ? ` — ${did}` : " — nothing done"}`,
          meta: { sessionId: existing.id, durationMin: minutes, actions: existing.actions || {}, note }
        });
        sendJson(response, 200, { success: true, closed: true, durationMin: minutes });
        return true;
      }

      // Checked here rather than trusted from the agent, so the strategy on
      // screen is the strategy that runs even when the agent is an older build.
      if (action === "record") {
        const run = await activeRun(account.id);
        if (!run) return fail(response, sendJson, 409, "No warm-up in progress");

        const kind = String(body.kind || "");
        if (!ACTION_KINDS.includes(kind)) return fail(response, sendJson, 400, "Unknown action");
        const step = Number.isInteger(body.count) ? Math.max(1, Number(body.count)) : 1;
        const detail = typeof body.detail === "string" ? body.detail.slice(0, 200) : null;

        const outcome = await checkQuota(account, run, kind, step);
        if (!outcome.ok) return refusal(response, sendJson, outcome);
        await commitAction(account, run, kind, outcome, detail);
        sendJson(response, 200, { success: true, done: outcome.done, quota: outcome.quota, remaining: outcome.quota - outcome.done });
        return true;
      }

      // Anything that is not a quota action but still belongs in the account's
      // history: which IP the proxy handed us, who we turned out to be signed in
      // as, and every failure. This is the half of the log that explains the other.
      if (action === "log") {
        const type = String(body.type || "agent.note");
        const message = String(body.message || "").slice(0, 500);
        if (!message) return fail(response, sendJson, 400, "An empty log line says nothing");
        const level = body.level === "warn" || body.level === "error" ? body.level : "info";
        const run = await activeRun(account.id);
        await logEvent({ accountId: account.id, runId: run?.id ?? null, level, type, message, meta: body.meta ?? undefined });
        sendJson(response, 200, { success: true });
        return true;
      }

      // The agent is the only thing that ever sees a checkpoint or a sign-out at
      // the moment it happens, so it is the only thing that can set this honestly.
      if (action === "health") {
        if (!isHealth(body.health)) return fail(response, sendJson, 400, "Unknown health value");
        const note = typeof body.note === "string" ? body.note.slice(0, 300) : null;
        const now = new Date().toISOString();
        await anty.from("wl_accounts").update({
          health: body.health, health_note: note, health_changed_at: now, updated_at: now
        }).eq("id", account.id).rows();
        await logEvent({
          accountId: account.id,
          level: body.health === "ok" ? "info" : "warn",
          type: "account.health",
          message: note ? `Agent: ${body.health} — ${note}` : `Agent: ${body.health}`,
          meta: { health: body.health, note }
        });
        sendJson(response, 200, { success: true });
        return true;
      }

      return fail(response, sendJson, 400, "Unknown action");
    }

    return false;
  } catch (error) {
    if (error instanceof RestError) {
      return fail(response, sendJson, error.status >= 400 && error.status < 600 ? error.status : 502, error.message);
    }
    return fail(response, sendJson, 500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * How much of the queue to read per round trip, as a multiple of what is asked
 * for. People already approached are filtered out after the CRM has answered,
 * so a page the size of `limit` would come back short as soon as anyone had
 * been taken. MAX_PAGES is the hard stop: the exclusion list only grows, and a
 * queue whose head is entirely spoken for would otherwise walk thousands of
 * rows a page at a time while somebody waits for a panel to paint.
 */
const OVERFETCH = 4;
const MAX_PAGES = 5;

/**
 * The next people to approach. The account asking does not narrow it:
 * wl_outreach_person_once means one person is approached once across every
 * account, so the candidate list is the same whoever is asking.
 */
async function nextCandidates(limit) {
  const pageSize = Math.max(limit * OVERFETCH, 40);
  const candidates = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES && candidates.length < limit; page += 1) {
    const batch = await leadQueue({ limit: pageSize + offset, offset });
    if (batch.length === 0) break;
    offset += batch.length;

    // Asked per page rather than "every contact ever approached": the list only
    // has to be long enough to answer this page.
    const taken = await anty.from("wl_outreach").select("crm_contact_id")
      .in("crm_contact_id", batch.map((lead) => lead.id)).rows();
    const approached = new Set(taken.map((row) => row.crm_contact_id));

    for (const lead of batch) {
      if (candidates.length >= limit) break;
      if (!approached.has(lead.id)) candidates.push(lead);
    }

    // A short page is the end of the queue, not a reason to ask again.
    if (batch.length < pageSize) break;
  }

  return candidates;
}

/**
 * Reconcile Anty with the sessions table.
 *
 * Anty knows whether a profile is open right now and nothing about history;
 * this app wants the history. Rather than a webhook Anty does not have, the
 * screen polls this: a profile running with no open session starts one, an open
 * session on a profile that is not running ends. Run it twice and the second
 * pass finds nothing to do — that, not a lock, is what keeps two tabs polling
 * from double-counting.
 */
async function syncSessions() {
  const linked = await anty.from("wl_accounts")
    .select("id,profile_remote_id,wl_sessions(ended_at)")
    .notNull("profile_remote_id")
    .order("ended_at", { ascending: false, nullsFirst: false, foreignTable: "wl_sessions" })
    .limit(1, { foreignTable: "wl_sessions" })
    .rows();

  const profileIds = linked.map((account) => account.profile_remote_id);
  const profiles = profileIds.length
    ? await anty.from("anty_browser_profiles").select("id,status,running_on,last_launched_at,is_deleted").in("id", profileIds).rows()
    : [];
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

  // Open sessions for every account, not only the linked ones: an account whose
  // profile was unlinked mid-session has nothing left to keep it open.
  const openRows = await anty.from("wl_sessions").select("id,account_id,started_at,source").isNull("ended_at").rows();
  const openByAccount = new Map(openRows.map((session) => [session.account_id, session]));

  const running = new Map();
  for (const account of linked) {
    const profile = profileById.get(account.profile_remote_id);
    // A deleted profile can still carry the status it had when it went; it is
    // not running anywhere a session could describe.
    if (!profile || profile.status !== "running" || profile.is_deleted) continue;
    running.set(account.id, { profile, lastEndedAt: account.wl_sessions?.[0]?.ended_at ?? null });
  }

  const now = new Date().toISOString();
  let opened = 0;
  let closed = 0;

  for (const [accountId, { profile, lastEndedAt }] of running) {
    if (openByAccount.has(accountId)) continue;

    // Anty's launch stamp, so a session opened by the first poll after launch is
    // not a minute short. A stamp older than this account's last close belongs
    // to an earlier session, though, and now is the honest answer then.
    const launched = antyTimestampToIso(profile.last_launched_at);
    const stale = launched && lastEndedAt && Date.parse(launched) <= Date.parse(lastEndedAt);
    const startedAt = launched && !stale ? launched : now;
    const runningOn = profile.running_on?.trim() || null;

    try {
      await anty.from("wl_sessions").insert({
        account_id: accountId,
        profile_remote_id: profile.id,
        started_at: startedAt,
        running_on: runningOn,
        source: "anty"
      }).rows();
    } catch (error) {
      // 23505 is the one-open-session index: another poll got here first, which
      // is the outcome we wanted, not an error.
      if (!(error instanceof RestError) || error.code !== "23505") {
        console.error("[warmup] could not open a session:", error.message);
      }
      continue;
    }
    opened += 1;
    await logEvent({
      accountId,
      type: "session.opened",
      message: runningOn ? `Profile opened on ${runningOn}` : "Profile opened",
      meta: { profileId: profile.id, runningOn, startedAt }
    });
  }

  for (const [accountId, session] of openByAccount) {
    if (running.has(accountId)) continue;
    // An agent session ends when the agent says so, not when Anty fails to see a
    // profile it never launched. Only a stuck one is closed here.
    const stuckAgent = Date.now() - Date.parse(session.started_at) > AGENT_SESSION_MAX_MS;
    if (session.source !== "anty" && !stuckAgent) continue;

    // Guarded on ended_at so a concurrent poll closes it once, and only the poll
    // that did gets to count it and write the event.
    const ended = await anty.from("wl_sessions").update({ ended_at: now })
      .eq("id", session.id).isNull("ended_at").select("id").rows();
    if (!ended.length) continue;

    closed += 1;
    const minutes = durationMin(session.started_at, now);
    const abandoned = session.source !== "anty";
    await logEvent({
      accountId,
      level: abandoned ? "warn" : "info",
      type: "session.closed",
      message: abandoned
        ? `Agent session closed after ${minutes} min without the agent reporting back`
        : `Profile closed after ${minutes} min`,
      meta: { sessionId: session.id, durationMin: minutes, source: session.source }
    });
  }

  return { success: true, opened, closed };
}
