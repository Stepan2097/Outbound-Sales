// Шлях людини (власник 15.10: «де буде показуватися ті люди яким я щойно
// написав і весь шлях»): від запиту в друзі до відповіді — що вже сталося, що
// зараз і що далі, по кожному каналу. Будується з того, що картка «По днях»
// уже прочитала: історія LinkedIn (запити й повідомлення), хронологія пошти й
// лог роботи. Без DOM — щоб перевірялося тестами.

const DAY = 86400000;

const nextDay = (iso) => new Date(Date.parse(iso) + DAY).toISOString();

/**
 * One track per channel the person was approached on, each a list of steps
 * `{ label, at, state }` where state is "done", "now" (the step waiting on us
 * or on them) or "next".
 */
export function pathTracks(dialog) {
  const tracks = [];
  const work = dialog?.work || [];
  const entries = dialog?.linkedin?.entries || [];

  const invited = work.find((row) => row.action === "invited")?.at || null;
  const sent = entries.find((row) => row.kind === "invite" && row.event !== "invite.accepted")?.at || null;
  const accepted = entries.find((row) => row.kind === "invite" && row.event === "invite.accepted")?.at || null;
  const messages = entries.filter((row) => row.kind !== "invite").sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const firstOut = messages.find((row) => row.direction !== "in")?.at || work.find((row) => row.action === "wrote" && row.channel !== "email")?.at || null;
  const firstIn = messages.find((row) => row.direction === "in" && (!firstOut || String(row.at) > String(firstOut)))?.at || null;
  const last = messages.at(-1) || null;

  if (invited || sent || accepted || messages.length) {
    const steps = [];
    if (invited || sent || accepted) {
      steps.push({ label: sent || accepted ? "Запит у друзі надіслано" : "Запит у друзі в черзі акаунта", at: sent || invited, state: "done" });
      steps.push({ label: "Прийняв запит", at: accepted, state: accepted ? "done" : "now" });
    }
    if (firstOut) steps.push({ label: "Перше повідомлення", at: firstOut, state: "done" });
    else if (accepted || !steps.length) steps.push({ label: "Перше повідомлення", at: null, state: "now" });
    if (firstIn) steps.push({ label: "Відповів", at: firstIn, state: "done" });
    else if (firstOut) steps.push({ label: "Відповідь", at: null, state: "now" });
    // What comes next: answer them, or write again the day after our last message.
    if (last?.direction === "in") steps.push({ label: "Відповісти йому", at: null, state: "now" });
    else if (last && firstOut) steps.push({ label: "Повторне повідомлення", at: nextDay(last.at), state: "next" });
    tracks.push({ channel: "linkedin", label: "LinkedIn", steps });
  }

  for (const timeline of dialog?.email || []) {
    const events = timeline.events || [];
    const mailed = events.find((event) => event.type === "message.sent")?.at || null;
    if (!mailed) continue;
    const replied = events.find((event) => event.type === "message.replied")?.at || null;
    const bounced = events.find((event) => event.type === "message.bounced")?.at || null;
    const steps = [{ label: "Лист надіслано", at: mailed, state: "done" }];
    if (bounced) steps.push({ label: "Лист не дійшов", at: bounced, state: "done", bad: true });
    else if (replied) steps.push({ label: "Відповів", at: replied, state: "done" });
    else steps.push({ label: "Відповідь", at: null, state: "now" });
    tracks.push({ channel: "email", label: `Пошта · ${timeline.email || ""}`.trim(), steps });
  }
  return tracks;
}
