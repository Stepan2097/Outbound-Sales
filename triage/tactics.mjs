// Тактики першого листа (власник 15.10: «можливість вибрати тактику по якій
// писати лист: згадати за конференцію тощо — продумай 10 варіантів»).
//
// Each tactic is one reason to write to this person now, and it only works when
// the data behind it exists: a news tactic with no news is a made-up event, and
// a conference tactic with no conference is a lie. So every tactic says what it
// needs, `tacticOptions` says which are possible for this contact and why the
// others are not, and «Сама вибере» lets the model pick among the possible ones
// and say which it took.

export const AUTO_TACTIC = "auto";

export const TACTICS = [
  {
    id: "conference",
    label: "Конференція",
    hint: "Будемо на події — зустрінемось там на 15 хвилин",
    needs: "event",
    instruction: "Open with the event: say plainly that we will be at {event} and ask whether they will be there too. Offer a short meeting at the event (15 minutes), and give a fallback for the case they are not going — a short call the week after. Do not invent which talks or stands they have."
  },
  {
    id: "news",
    label: "Свіжа новина компанії",
    hint: "Одна конкретна подія з досьє: запуск, ринок, угода",
    needs: "signals",
    instruction: "Anchor the message on exactly one item from research.company.news — name it the way the source does, with its month if given — and connect it, as a hedged guess, to what usually gets hard next for a team in that situation. Never add details the item does not state."
  },
  {
    id: "role",
    label: "Їхня роль",
    hint: "Що зазвичай болить людині на цій посаді",
    needs: "position",
    instruction: "Write to the seat, not the company: start from what a person with contact.position usually owns and is measured on, one hedged guess about where it hurts, and how that maps to our offer. No congratulations unless research states a recent move."
  },
  {
    id: "product",
    label: "Їхній продукт чи застосунок",
    hint: "Конкретний продукт або апка з досьє і гіпотеза про трафік",
    needs: "products",
    instruction: "Name one concrete product, brand or app from research.company (products or apps) and make one specific, falsifiable guess about how they acquire users for it today, then where we would fit. One product only."
  },
  {
    id: "market",
    label: "Ринок / GEO",
    hint: "Країна чи ринок компанії — як ми ллємо туди",
    needs: "market",
    instruction: "Lead with their market: the country or region from the contact record or research. Say what we do in that GEO (only what product.brief or product knowledge states), and ask whether that market is a priority for them this quarter."
  },
  {
    id: "proof",
    label: "Кейс із цифрою",
    hint: "Один результат з брифу продукту, для схожої компанії",
    needs: "proof",
    instruction: "Lead with one proof point from product.brief.proofWeAreAllowedToUse or product.proofPoints, with its real number, chosen for its closeness to this company's type. Then one sentence on why it may apply to them, written as a guess, and one question."
  },
  {
    id: "linkedin",
    label: "Ми вже на зв'язку",
    hint: "Людина в друзях нашого LinkedIn-акаунта",
    needs: "friend",
    instruction: "Mention plainly that we are already connected on LinkedIn (through research.linkedin.friendOf) — as the reason a direct note is not out of the blue. No pretending to know them better than that."
  },
  {
    id: "question",
    label: "Одне питання",
    hint: "Без пітчу: коротке питання, що кваліфікує",
    needs: null,
    instruction: "No pitch at all. Two or three sentences: who we are in half a line, then one qualifying question about how they handle the problem our product solves (for example, whether they run paid acquisition in-house). The question must be answerable in one line."
  },
  {
    id: "insight",
    label: "Спостереження",
    hint: "Одне конкретне спостереження про їхній сайт, офер чи апку",
    needs: "research",
    instruction: "Share one specific observation drawn from research.company (their site description, products, apps or audience), framed as an outside view that may be wrong, and offer to send the rest of what we noticed. The observation must be checkable by them, not generic."
  },
  {
    id: "partnership",
    label: "Партнерство",
    hint: "Конкретний формат співпраці з брифу: тест, revshare, CPA",
    needs: "firstStep",
    instruction: "Propose the concrete first step from product.brief.firstSmallStepWeAskFor as a partnership offer — small, specific, low-risk — and ask whether it is worth a look on their side."
  }
];

const BY_ID = new Map(TACTICS.map((tactic) => [tactic.id, tactic]));

/** What the contact and its research hold, reduced to what the tactics ask for. */
export function tacticData({ contact = {}, research = {}, product = {}, event = "" } = {}) {
  const company = research.company || {};
  const brief = product.brief || {};
  return {
    event: String(event || "").trim(),
    signals: (company.news || []).length > 0,
    position: Boolean(String(contact.position || "").trim()),
    products: (company.products || []).length + (company.apps || []).length > 0,
    market: Boolean(String(contact.country || company.headquarters || "").trim()),
    proof: Boolean(String(brief.proof || "").trim() || (product.proofPoints || []).length),
    friend: (research.linkedin?.friendOf || []).length > 0,
    research: Boolean(company.summary || (company.products || []).length || (company.apps || []).length),
    firstStep: Boolean(String(brief.firstStep || "").trim())
  };
}

const MISSING = {
  event: "вкажіть, яка конференція",
  signals: "новин про компанію не знайдено",
  position: "у базі немає посади",
  products: "продуктів чи застосунків не знайдено",
  market: "невідомо, на якому ринку компанія",
  proof: "у брифі продукту немає кейсу з цифрою",
  friend: "людина не в друзях наших акаунтів",
  research: "про компанію нічого не зібрано",
  firstStep: "у брифі продукту немає першого кроку"
};

/** Every tactic with whether it can be used for this contact, and why not. */
export function tacticOptions(data) {
  return TACTICS.map((tactic) => {
    const ok = !tactic.needs || Boolean(data[tactic.needs]);
    return { id: tactic.id, label: tactic.label, hint: tactic.hint, available: ok, why: ok ? "" : MISSING[tactic.needs] };
  });
}

/**
 * The instruction the drafting prompt gets. «auto» hands the model every
 * possible tactic and asks it to name the one it chose; a tactic that is not
 * possible for this contact falls back to «auto» rather than inventing its
 * missing fact.
 */
export function tacticForPrompt(id, data) {
  const options = tacticOptions(data);
  const possible = options.filter((option) => option.available).map((option) => BY_ID.get(option.id));
  const chosen = BY_ID.get(id);
  const fill = (text) => text.replaceAll("{event}", data.event || "the event");
  if (chosen && options.find((option) => option.id === id)?.available) {
    return { id: chosen.id, label: chosen.label, instruction: fill(chosen.instruction) };
  }
  return {
    id: AUTO_TACTIC,
    label: "Сама вибере",
    instruction: "Pick the single strongest angle for this person from the tactics listed in `tactics`, using only facts the research holds, write the drafts with it, and return its id in tacticUsed.",
    tactics: possible.map((tactic) => ({ id: tactic.id, label: tactic.label, instruction: fill(tactic.instruction) }))
  };
}

export function tacticLabel(id) {
  return BY_ID.get(id)?.label || (id === AUTO_TACTIC ? "Сама вибере" : "");
}
