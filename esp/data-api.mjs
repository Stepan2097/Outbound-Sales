import { entries, timeline, verify } from "./journal.mjs";
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
export async function handleEspDataApi({ request, response, url, sendJson, readJson, actor = "", role = "seller", dns }) {
  const path = url.pathname;
  if (path !== "/api/esp" && !path.startsWith("/api/esp/")) return false;
  const method = request.method;
  const admin = role === "admin";
  const refuse = () => sendJson(response, 403, { error: "Це може лише адміністратор." });

  try {
    if (method === "GET" && path === "/api/esp/registry") {
      sendJson(response, 200, { ...await registry(), canEdit: admin, domainStates: DOMAIN_STATES, domainLabels: DOMAIN_LABEL, rampStages: RAMP_STAGES });
      return true;
    }

    // A person's whole history with the cold-email side: every attempt with the
    // exact text, every reply, bounce, unsubscribe and skip — oldest first.
    if (method === "GET" && path === "/api/esp/contacts/timeline") {
      const email = url.searchParams.get("email") || "";
      const events = (await timeline(email)).filter((entry) => TIMELINE_TYPES.includes(entry.type));
      sendJson(response, 200, { email: email.trim().toLowerCase(), events });
      return true;
    }

    if (method === "GET" && path === "/api/esp/journal") {
      if (!admin) return refuse(), true;
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
      if (!admin) return refuse(), true;
      sendJson(response, 200, await verify());
      return true;
    }

    const writes = {
      "/api/esp/domains": (body) => addDomain(body, actor),
      "/api/esp/domains/status": (body) => setDomainStatus(body, actor),
      "/api/esp/domains/check": (body) => checkDomain(body, actor, dns),
      "/api/esp/senders": (body) => addSender(body, actor),
      "/api/esp/senders/status": (body) => setSenderStatus(body, actor),
      "/api/esp/senders/update": (body) => updateSender(body, actor)
    };
    if (method === "POST" && writes[path]) {
      if (!admin) return refuse(), true;
      const body = await readJson(request);
      if (!body || typeof body !== "object") {
        sendJson(response, 400, { error: "Некоректне тіло JSON." });
        return true;
      }
      const result = await writes[path](body);
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
