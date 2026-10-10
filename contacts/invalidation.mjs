const CRM_AGENT_WRITES = new Set(["inbox.thread", "inbox.done", "outbox.sent", "invite.sent", "invites.checked"]);

// A running browser worker reports logs and leases frequently. Those reports
// must not evict a seller's folder index as though the CRM had changed.
export function shouldInvalidateContactReads(method, pathname, agentAction) {
  if (["GET", "HEAD"].includes(method)) return false;
  // Taking an existing CRM row into the local work queue changes no CRM row.
  if (pathname === "/api/contacts/queue") return false;
  if (/^\/api\/(?:contacts|prospects)(?:\/|$)/.test(pathname)) return true;
  if (/^\/api\/warmup\/inbox(?:\/|$)/.test(pathname)) return true;
  return pathname === "/api/warmup/agent" && CRM_AGENT_WRITES.has(agentAction);
}
