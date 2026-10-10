import { accessView, adminLog, can, changeAccess } from "./access.mjs";
import { entries, timeline, verify } from "./journal.mjs";
import { secretsStatus } from "./secrets.mjs";
import { TIMELINE_TYPES } from "./messages.mjs";
import {
  DOMAIN_LABEL, DOMAIN_STATES, RAMP_STAGES, addDomain, addSender, checkDomain, registry, setDomainStatus, setSenderStatus, updateSender
} from "./registry.mjs";

/**
 * The ESP's journal and registry over HTTP, under /api/esp, behind the same
 * workspace sign-in as everything else.
 *
 * There is no route that changes or removes a journal line, and there will not
 * be one: a correction is a new event. Changing the registry — adding a domain,
 * pausing a sender — and reading the whole journal (every message's exact text)
 * are an administrator's; a person's own timeline is anybody's on the team.
 *
 * Mounted from `esp/api.mjs` ahead of its administrator-only gate (that file
 * is ESP 1's), because a person's timeline is the whole team's. Returns true
 * when it answered, false when the path is not one of these — the rest of
 * /api/esp is the mail connection's.
 */
export async function handleEspDataApi({ request, response, url, sendJson, readJson, profile = null, dns, env = process.env }) {
  const path = url.pathname;
  if (path !== "/api/esp" && !path.startsWith("/api/esp/")) return false;
  const method = request.method;
  const actor = profile?.email || profile?.name || "";
  // Who may do what is ESP 10's matrix (esp/access.mjs), not a role check here.
  const allowed = (permission) => can(profile, permission);
  const refuse = (permission) => sendJson(response, 403, { error: `Немає права: ${permission}. Його видає адміністратор у «Налаштуваннях».` });

  try {
    if (method === "GET" && path === "/api/esp/registry") {
      sendJson(response, 200, {
        ...await registry(),
        canEdit: await allowed("registry.change") || await allowed("limits.change"),
        canAdd: await allowed("registry.change"),
        canLimit: await allowed("limits.change"),
        domainStates: DOMAIN_STATES, domainLabels: DOMAIN_LABEL, rampStages: RAMP_STAGES });
      return true;
    }

    // A person's whole history with the cold-email side: every attempt with the
    // exact text, every reply, bounce, unsubscribe and skip — oldest first.
    if (method === "GET" && path === "/api/esp/contacts/timeline") {
      if (!await allowed("replies.read")) return refuse("replies.read"), true;
      const email = url.searchParams.get("email") || "";
      const events = (await timeline(email)).filter((entry) => TIMELINE_TYPES.includes(entry.type));
      sendJson(response, 200, { email: email.trim().toLowerCase(), events });
      return true;
    }

    if (method === "GET" && path === "/api/esp/journal") {
      if (!await allowed("journal.read")) return refuse("journal.read"), true;
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
      const before = Number(url.searchParams.get("before")) || null;
      sendJson(response, 200, {
        events: await entries({
          type: url.searchParams.get("type") || "",
          contact: url.searchParams.get("contact") || "",
          limit, before
        })
      });
      return true;
    }

    if (method === "GET" && path === "/api/esp/journal/verify") {
      if (!await allowed("journal.read")) return refuse("journal.read"), true;
      sendJson(response, 200, await verify());
      return true;
    }

    // Rights, the administrators' log and which secrets are set (ESP 10).
    if (method === "GET" && path === "/api/esp/access") {
      const view = await accessView(profile);
      sendJson(response, 200, await allowed("access.manage") ? view : { permissions: view.permissions, roles: view.roles, mine: view.mine, people: [] });
      return true;
    }
    if (method === "POST" && (path === "/api/esp/access/grant" || path === "/api/esp/access/revoke")) {
      const body = await readJson(request);
      if (!body || typeof body !== "object") return sendJson(response, 400, { error: "Некоректне тіло JSON." }), true;
      const event = await changeAccess({ ...body, grant: path.endsWith("/grant") }, profile);
      sendJson(response, 200, { success: true, event, unchanged: event === null, ...await accessView(profile) });
      return true;
    }
    if (method === "GET" && path === "/api/esp/admin-log") {
      if (!await allowed("journal.read")) return refuse("journal.read"), true;
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
      sendJson(response, 200, { events: await adminLog({ limit, before: Number(url.searchParams.get("before")) || null }) });
      return true;
    }
    if (method === "GET" && path === "/api/esp/secrets") {
      if (!await allowed("access.manage")) return refuse("access.manage"), true;
      sendJson(response, 200, secretsStatus(env, (await registry()).senders));
      return true;
    }

    // Each change needs its own right: adding and retiring is the registry's,
    // a ramp step or a pause is a limit.
    const writes = {
      "/api/esp/domains": ["registry.change", (body) => addDomain(body, actor)],
      "/api/esp/domains/status": [(body) => (body?.status === "retired" ? "registry.change" : "limits.change"), (body) => setDomainStatus(body, actor)],
      "/api/esp/domains/check": ["registry.change", (body) => checkDomain(body, actor, dns)],
      "/api/esp/senders": ["registry.change", (body) => addSender(body, actor)],
      "/api/esp/senders/status": [(body) => (body?.status === "retired" ? "registry.change" : "limits.change"), (body) => setSenderStatus(body, actor)],
      "/api/esp/senders/update": [(body) => (body?.rampStage !== undefined ? "limits.change" : "registry.change"), (body) => updateSender(body, actor)]
    };
    if (method === "POST" && writes[path]) {
      const body = await readJson(request);
      if (!body || typeof body !== "object") {
        sendJson(response, 400, { error: "Некоректне тіло JSON." });
        return true;
      }
      const [need, run] = writes[path];
      const permission = typeof need === "function" ? need(body) : need;
      if (!await allowed(permission)) return refuse(permission), true;
      const result = await run(body);
      sendJson(response, path.endsWith("/check") ? 200 : 201, {
        success: true,
        ...(path.endsWith("/check") ? { checks: result } : { event: result, unchanged: result === null }),
        ...await registry()
      });
      return true;
    }

    return false;
  } catch (error) {
    const status = Number(error?.statusCode || 500);
    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
