import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { checkEmail, checkEmails, heloName } from "../contacts/email-check.mjs";

/**
 * Власник 12.10: «спаршені пошти треба перевіряти на валідність, пороби тести
 * чи ця пошта існує чи ні». A mail server on this machine answers RCPT TO the
 * way real ones do: 250 for a mailbox it has, 550 5.1.1 for one it does not.
 */

function mailServer({ mailboxes = [], catchAll = false, greylist = false, refuseMail = false, rcptText = null, seen = null }) {
  const server = net.createServer((socket) => {
    // The client may hang up right after QUIT; a reset here is not a failure of the test.
    socket.on("error", () => {});
    socket.write("220 mx.test ESMTP ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (/^EHLO/i.test(line)) seen?.push(line);
        if (/^EHLO/i.test(line)) socket.write("250-mx.test\r\n250 SIZE 1000\r\n");
        else if (/^MAIL FROM/i.test(line)) socket.write(refuseMail ? "550 5.7.1 we do not talk to you\r\n" : "250 2.1.0 ok\r\n");
        else if (/^RCPT TO/i.test(line)) {
          const address = line.match(/<(.*)>/)[1];
          if (rcptText) socket.write(`${rcptText}\r\n`);
          else if (greylist) socket.write("451 4.7.1 try again later\r\n");
          else if (catchAll || mailboxes.includes(address)) socket.write("250 2.1.5 ok\r\n");
          else socket.write("550-5.1.1 The email account that you tried to reach does not exist.\r\n550 5.1.1 user unknown\r\n");
        } else if (/^QUIT/i.test(line)) { socket.write("221 bye\r\n"); socket.end(); }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function withServer(t, options) {
  const server = await mailServer(options);
  t.after(() => server.close());
  return { port: server.address().port, resolveMx: async () => [{ exchange: "127.0.0.1", priority: 10 }], helo: "test.local", timeoutMs: 3000 };
}

test("a mailbox the server has is valid; one it does not have is invalid and hidden", async (t) => {
  const options = await withServer(t, { mailboxes: ["gal.shapira@apester.com"] });
  const [real, guessed] = await checkEmails(["Gal.Shapira@apester.com", "gshapira@apester.com"], options);
  assert.equal(real.status, "valid");
  assert.equal(guessed.status, "invalid");
  assert.match(guessed.reason, /такої пошти немає/);
});

test("a server that accepts any address proves nothing: catch-all, not valid", async (t) => {
  const result = await checkEmail("anyone@catchall.com", await withServer(t, { catchAll: true }));
  assert.equal(result.status, "catch_all");
});

test("greylisting or a policy block is «not tested», never «valid»", async (t) => {
  assert.equal((await checkEmail("a@grey.com", await withServer(t, { greylist: true }))).status, "unknown");
  assert.equal((await checkEmail("a@strict.com", await withServer(t, { refuseMail: true }))).status, "unknown");
});

test("a bad address and a domain that takes no mail fail before any server is asked", async () => {
  assert.equal((await checkEmail("not an address")).status, "invalid");
  const noMx = await checkEmail("x@nomail.example", {
    resolveMx: async () => { throw Object.assign(new Error("none"), { code: "ENODATA" }); },
    resolveA: async () => []
  });
  assert.equal(noMx.status, "invalid");
  assert.match(noMx.reason, /не приймає пошту/);
});

test("сервер, що двічі мовчить, у цьому проході вже не чекається (02.11: перевірка Casino brands стояла на таких)", async () => {
  let connects = 0;
  // A socket that connects and never greets.
  const connect = () => {
    connects += 1;
    return Object.assign(new net.Socket(), { setEncoding: () => {} });
  };
  const deadHosts = new Map();
  const options = { resolveMx: async () => [{ exchange: "mx.silent.test", priority: 1 }], connect, deadHosts };
  const started = Date.now();
  for (const email of ["a@silent.test", "b@silent.test", "c@silent.test", "d@silent.test"]) {
    assert.equal((await checkEmail(email, { ...options, timeoutMs: 60 })).status, "unknown");
  }
  assert.equal(connects, 2, "третю й четверту адресу не чекали");
  assert.ok(Date.now() - started < 1000);
});

test("04.11: сервер, що відмовляє НАМ (IP у Spamhaus, «Listed by CSS»), — «не перевірено», а не «такої пошти немає»", async (t) => {
  const listed = await checkEmail("johan.tan@suninternational.com", await withServer(t, { rcptText: "550 zen.mimecast.org Listed by CSS, see https://check.spamhaus.org/query/ip/169.58.60.245." }));
  assert.equal(listed.status, "unknown");
  const denied = await checkEmail("e.harris@gaminglabs.com", await withServer(t, { rcptText: "550 5.4.1 Recipient address rejected: Access denied." }));
  assert.equal(denied.status, "unknown");
});

test("04.11: сервер представляється своїм DNS-ім'ям (PTR), не голим id контейнера — «unqualified HELO» відкидали", async (t) => {
  const env = { COOLIFY_FQDN: "outbound-sales.169-58-60-245.sslip.io" };
  const name = await heloName(env, { lookup: async (host) => (host === "outbound-sales.169-58-60-245.sslip.io" ? ["169.58.60.245"] : []), reverse: async () => ["vmi3459295.contaboserver.net"] });
  assert.equal(name, "vmi3459295.contaboserver.net");
  assert.equal(await heloName({ ...env, EMAIL_CHECK_HELO: "mx.own.test" }), "mx.own.test");
  assert.equal(await heloName(env, { lookup: async () => [], reverse: async () => [] }), "outbound-sales.169-58-60-245.sslip.io");
  const seen = [];
  const options = await withServer(t, { mailboxes: ["a@b.com"], seen });
  await checkEmail("a@b.com", { ...options, helo: "vmi3459295.contaboserver.net" });
  assert.deepEqual(seen, ["EHLO vmi3459295.contaboserver.net"]);
});
