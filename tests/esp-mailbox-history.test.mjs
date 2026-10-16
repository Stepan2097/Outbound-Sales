import assert from "node:assert/strict";
import test from "node:test";

import { mailboxHistory } from "../esp/mail-warmup.mjs";

// «Прогрів пошт»: клік по пошті — її дні за весь час: скільки відправлено і
// скільки з відправленого того дня опинилось у спамі (власник 16.10).

const at = (date, time = "10:00") => `${date}T${time}:00+03:00`;
let seq = 0;
const e = (type, when, data) => ({ seq: ++seq, type, at: when, data });

test("по днях: перші, відповіді, холодні; спам — на день відправки; невдалі не рахуються", () => {
  const entries = [
    e("warmup.sending", at("2026-10-14"), { from: "a@x.com", kind: "first", messageId: "<m1>" }),
    e("warmup.sending", at("2026-10-14", "11:00"), { from: "a@x.com", kind: "first", messageId: "<m2>" }),
    e("warmup.sent_id", at("2026-10-14", "11:01"), { sendingSeq: 2, messageId: "<g2>" }),
    e("warmup.sending", at("2026-10-15"), { from: "a@x.com", kind: "reply", inReplyTo: "<other>" }),
    e("message.sending", at("2026-10-15", "12:00"), { from: "a@x.com" }),
    e("warmup.sending", at("2026-10-15", "13:00"), { from: "a@x.com", kind: "first" }),
    e("warmup.failed", at("2026-10-15", "13:01"), { sendingSeq: 6 }),
    // m2 (sent 14.10) found in Spam on 16.10 — counts on 14.10.
    e("warmup.received", at("2026-10-16"), { mailbox: "b@y.com", from: "a@x.com", messageId: "<g2>", inSpam: true }),
    e("warmup.rescued", at("2026-10-16", "10:01"), { mailbox: "b@y.com", from: "a@x.com" }),
    // b answered a's first letter.
    e("warmup.sending", at("2026-10-16", "15:00"), { from: "b@y.com", kind: "reply", inReplyTo: "<m1>" }),
    e("warmup.sending", at("2026-10-16", "16:00"), { from: "other@z.com", kind: "first" })
  ];
  const { days, total } = mailboxHistory(entries, "A@x.com");
  assert.deepEqual(days.map((row) => row.date), ["2026-10-16", "2026-10-15", "2026-10-14"]);
  const [d16, d15, d14] = days;
  assert.deepEqual([d14.firsts, d14.sent, d14.inSpam], [2, 2, 1]);
  assert.deepEqual([d15.replies, d15.cold, d15.sent, d15.failed], [1, 1, 2, 1]);
  assert.deepEqual([d16.sent, d16.rescued, d16.repliesReceived], [0, 1, 1]);
  assert.deepEqual([total.sent, total.inSpam, total.cold], [4, 1, 1]);
});
