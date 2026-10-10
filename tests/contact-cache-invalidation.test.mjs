import test from "node:test";
import assert from "node:assert/strict";
import { shouldInvalidateContactReads } from "../contacts/invalidation.mjs";

test("only CRM-affecting reports evict contact reads while the worker is active", () => {
  for (const action of ["session.open", "session.close", "run.finished", "record", "log", "health", "login.recheck", "warning", "outbox.prepare", "invite.prepare"]) {
    assert.equal(shouldInvalidateContactReads("POST", "/api/warmup/agent", action), false, action);
  }
  assert.equal(shouldInvalidateContactReads("POST", "/api/warmup/agent/lease"), false);
  assert.equal(shouldInvalidateContactReads("POST", "/api/contacts/queue"), false);
  for (const action of ["inbox.thread", "inbox.done", "outbox.sent", "invite.sent", "invites.checked"]) {
    assert.equal(shouldInvalidateContactReads("POST", "/api/warmup/agent", action), true, action);
  }
  for (const path of ["/api/contacts/id/messages", "/api/prospects/interaction", "/api/warmup/inbox/reply"]) {
    assert.equal(shouldInvalidateContactReads("POST", path), true);
    assert.equal(shouldInvalidateContactReads("GET", path), false);
  }
  assert.equal(shouldInvalidateContactReads("POST", "/api/account/heartbeat"), false);
});
