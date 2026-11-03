import { append } from "../esp/journal.mjs";
import { updateSender } from "../esp/registry.mjs";

/**
 * Mailboxes that have written cold mail for `days` days before `now` and may
 * send up to `limit` a day — so a test about something else is not held to a
 * new mailbox's first days (owner 03.11: 3 on the first day, then +2 a day).
 * Dates are the mocked clock's; it is left at `now`.
 */
export async function seasoned(t, emails, { days, limit = 35, now }) {
  for (const email of emails) {
    await updateSender({ email, coldLimit: limit }, "test");
    for (let day = days; day >= 1; day -= 1) {
      t.mock.timers.setTime(now.getTime() - (7 + day) * 86_400_000);
      await append({ type: "message.sending", actor: "test", contact: "history@seasoned.test", data: { from: email, to: "history@seasoned.test" } });
    }
  }
  t.mock.timers.setTime(now.getTime());
}
