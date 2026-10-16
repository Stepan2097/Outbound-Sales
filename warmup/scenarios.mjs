// Сценарії LinkedIn-кампаній (WorkSpace, таск f78ffd9a, 16.10.2026).
//
// Кампанія — це не лише папка й акаунти, а сценарій до дзвінка, як в артефакті
// «Кампанії лідгену» (15.10): кого шукати (сигнал), гіпотеза, ціль, флоу розмови з
// шаблонами й змінними, розгалуження і де персоналізувати. Спільний для всіх
// кампаній «хребет» — драбина кваліфікації, куди веде кожен лід і правила — один,
// лежить у стані робочого простору, і його редагує адміністратор.
//
// AI-чернетки (перше повідомлення, відповідь, нагадування) отримують сценарій
// кампанії й хребет: `scenarioForPrompt`.

export const MAX_STEPS = 12;

const line = (value, limit) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
const block = (value, limit) => String(value ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, limit);

/** Сценарій кампанії з будь-чого, що прийшло: зайве відкидається, довжини обрізаються. */
export function cleanPlan(raw) {
  const steps = (Array.isArray(raw?.steps) ? raw.steps : []).slice(0, MAX_STEPS)
    .map((step) => ({ label: line(step?.label, 80), text: block(step?.text, 2000) }))
    .filter((step) => step.label || step.text);
  return {
    template: line(raw?.template, 40),
    signal: block(raw?.signal, 1500),
    hypothesis: block(raw?.hypothesis, 1500),
    goal: block(raw?.goal, 600),
    steps,
    branches: block(raw?.branches, 4000),
    personalize: block(raw?.personalize, 2000)
  };
}

export function emptyPlan(plan) {
  return !plan || (!plan.signal && !plan.hypothesis && !plan.goal && !plan.steps?.length && !plan.branches && !plan.personalize);
}

/* ── Хребет: спільний для всіх кампаній ─────────────────────────────────── */

export const DEFAULT_SPINE = {
  ladder: [
    "Вертикаль. iGaming? Якщо ні й не суміжне — чемний вихід.",
    "Buy-side і повноваження: «Do you manage paid acquisition in-house, or mainly through affiliates/partners — and are you the one who decides on new channels?»",
    "Канали й сетап: «Which channels does your team run internally right now?»",
    "Фірмовий розворот: «Do you drive traffic to landing pages, or have you tested PWA and app funnels?» → місток у цінність."
  ].join("\n"),
  routes: [
    "Дзвінок Степана — оператор / C-level / Head, що вирішує; є інтерес до навчання, in-house або трафіку на spend від $10K. Пріоритет №1.",
    "Сам, без дзвінка — соло-практик, що хоче інструменти, не менторство → тріал платформи (повний Full 72 год).",
    "Партнер — консультант / агенція / платформа, що приводить клієнтів → кампанія «Консультант → партнер».",
    "Чемний вихід — тільки CPA/RevShare, продає трафік, whitehat-only, не buy-side → причина виходу в CRM, пінг за 3 міс."
  ].join("\n"),
  rules: [
    "Персоналізація обов'язкова: перше повідомлення — завжди конкретна деталь про них. Копіпейст пачці палить і стосунок, і акаунт.",
    "Кваліфікувати до дзвінка, але за 2–3 питання, не за 10. Дзвінок веде Степан — лідген пропонує його слоти.",
    "Кожен дотик має мету. Follow-up несе щось нове (стаття, цифра), не «just bumping».",
    "Конференції — без чіткого «так»: «Not sure yet, still sorting my plans». Певне лише: Степан у Римі 2–5.11.",
    "Ціну лідген не називає — це для дзвінка. Виняток: публічні ціни програм, якщо лід прямо побачив їх на сайті."
  ].join("\n")
};

export function cleanSpine(raw) {
  return {
    ladder: block(raw?.ladder ?? DEFAULT_SPINE.ladder, 4000),
    routes: block(raw?.routes ?? DEFAULT_SPINE.routes, 4000),
    rules: block(raw?.rules ?? DEFAULT_SPINE.rules, 4000)
  };
}

/* ── Чотири кампанії з артефакту — готові шаблони ───────────────────────── */

export const SCENARIO_TEMPLATES = [
  {
    id: "meta-operators",
    name: "Оператори, що вже ллють Meta",
    productId: "fb-training",
    plan: {
      signal: "Оператори й бренди казино/бетингу; посади Head of Marketing / Acquisition / Growth, CMO, Performance Director. Сигнали в профілі: назва оператора, згадка paid acquisition, пост про зростання чи бани.",
      hypothesis: "Head of Acquisition / CMO / Growth у оператора, який уже ллє Meta, швидше піде на дзвінок про побудову внутрішнього баїнгу, ніж баєр-одинак.",
      goal: "Кваліфікований дзвінок зі Степаном · FB Mentorship / in-house · пріоритет",
      steps: [
        { label: "Опенер — на конкретній деталі", text: "Hi {Name}! Saw {конкретика: пост / нова роль / запуск у GEO} — congrats. I work on paid acquisition and player lifecycle in iGaming. Does your scope at {Company} also cover the performance side, or is that a separate team?" },
        { label: "Кваліфікація", text: "Драбина, кроки 2–3: хто вирішує по acquisition; Meta в них in-house чи через партнерів; де болить — бани, нестабільність, якість трафіку, онбординг баєрів." },
        { label: "Місток у цінність", text: "We run Meta on casino ourselves and productised it, so operators can build or sharpen that capability in-house instead of depending on agencies. A lot of teams come to us after account instability eats their margin. Is in-house buying something you're looking at?" },
        { label: "Пруф у DM", text: "The Decision Chain (https://www.advantage-agency.co/blog/facebook-media-buying-for-igaming-the-decision-chain-from-ad-account-to-scale) або кейс аудиту (Німеччина CPA $600+ → $250). Для «як не розвалити команду»: https://www.advantage-agency.co/blog/how-to-build-an-igaming-media-buying-team-that-doesnt-fall-apart" },
        { label: "Дзвінок", text: "This is worth 20 min with Stepan, who runs our buying team — he can map it to {Company}. He has {слот 1} or {слот 2}. Which works? Drop me an email and I'll send the invite." }
      ],
      branches: [
        "«Ми вже маємо команду, але не перформить» → найкращий сигнал, одразу на дзвінок (кейс аудиту).",
        "«Все добре / не на часі» → стаття + пінг за 3–4 тижні з новим приводом.",
        "«Дайте трафік» → скрипт трафіку з хребта (spend від $10K або освітній напрям), не на дзвінок одразу.",
        "Не оператор / whitehat-only → чемний вихід."
      ].join("\n"),
      personalize: "{конкретика} в опенері — обов'язково реальна (пост, нова роль, запуск). GEO й канал у містку — під те, що лід сам назвав. Пруф під біль: бани → digest, команда → team-стаття, дорогий CPA → кейс аудиту."
    }
  },
  {
    id: "meta-bans-inapp",
    name: "Вигоріли на банах Meta → In-App / Unity",
    productId: "inapp-unity",
    plan: {
      signal: "Пости/коментарі про бани FB, Moloco, нестабільність кабінетів; баєри, що шукають друге джерело; performance-команди.",
      hypothesis: "Баєр чи команда, що скаржиться на бани й нестабільність Meta, відкрита до розмови про in-app, бо це свіжий і стабільніший канал.",
      goal: "Дзвінок або продаж Unity KB (€899) · для оператора — in-house in-app",
      steps: [
        { label: "Опенер", text: "Hi {Name}! {Їхня згадка банів/Moloco} resonated. Since the Moloco shake-up a lot of teams moved to Unity — in-app has a legal RMG lane for gambling that Meta doesn't. Are you running any in-app right now, or still mostly Meta?" },
        { label: "Кваліфікація", text: "Чи вже пробували in-app; який обсяг; що зупинило (модерація, MMP, аукціон). Це й визначає, KB їм чи дзвінок." },
        { label: "Пруф у DM", text: "Why In-App Doesn't Ban the Gambling That Facebook Bans (https://www.advantage-agency.co/blog/why-in-app-doesnt-ban-the-gambling-that-facebook-bans) + цифри: Unity Launch: $87/depositor across $48K (https://www.advantage-agency.co/blog/unity-ads-launch-87-per-depositor-across-48k)." },
        { label: "Пропозиція", text: "We run Unity ourselves and packaged it into a self-paced program — MMP, creatives, optimization, scaling, with RMG account contacts. There's a free max-bid calculator on the page if you want to sanity-check the economics first: {посилання /unity-ads}." }
      ],
      branches: [
        "Практик, хоче сам розібратись → Unity KB €899, самостійно.",
        "Оператор / команда, хоче поставити in-app in-house → дзвінок Степана.",
        "«Moloco для мене ок» → чесно: вікно Moloco вузьке й дороге (стаття про Moloco після IPO), лишаємось на зв'язку.",
        "Ще ніколи не лив paid → спершу Meta/тріал, не Unity."
      ].join("\n"),
      personalize: "Опенер чіпляється за їхню згадку банів чи Moloco — без неї кампанія не та. Калькулятор max bid даємо як безкоштовний крок, щоб не звучати як прямий пітч."
    }
  },
  {
    id: "role-change",
    name: "Зміна ролі — найсильніший сигнал часу",
    productId: "",
    plan: {
      signal: "Пости «excited to join / new chapter», «open to opportunities», зміна посади на Head/CMO/Growth в iGaming. У переписках це 20% відповідей.",
      hypothesis: "Перші місяці на новій посаді вирішують, як команда поставить acquisition. Хто щойно став Head/CMO або шукає роль — найтепліший момент.",
      goal: "Дзвінок, коли людина осіла · продукт за роллю (оператор → in-house, агенція → mentorship)",
      steps: [
        { label: "Опенер", text: "Congrats on {нова роль / компанія}, {Name}! The first months usually decide how acquisition gets set up. Is building or sharpening in-house paid acquisition on your list, or is it mostly partners for now?" },
        { label: "Якщо «ще шукаю роль»", text: "Got it — makes sense. When you land, the acquisition setup is often the first thing to fix. Happy to stay in touch and share what's working in iGaming meanwhile. What kind of role are you aiming for?" },
        { label: "Пінг у дату", text: "Назвав місяць виходу / рішення → пінг саме тоді, з їхніми ж словами: «you mentioned things settle after {місяць} — checking in as promised»." }
      ],
      branches: [
        "Осів, вирішує acquisition → кваліфікація → дзвінок (як «Оператори, що вже ллють Meta»).",
        "Між роботами → у чергу «пізніше» з датою; не палимо, це майбутній оператор-лід.",
        "Пішов з iGaming → чемний вихід."
      ].join("\n"),
      personalize: "Назва нової ролі й компанії — точно. Дата пінгу — з їхніх слів. Ця кампанія більше про своєчасний пінг, ніж про текст: головне не загубити дату."
    }
  },
  {
    id: "consultant-partner",
    name: "Консультант / агенція → партнер",
    productId: "",
    plan: {
      signal: "iGaming-консультанти, фрилансери, агенції, що радять операторам acquisition; платформи й white-label, що мають клієнтів-операторів.",
      hypothesis: "Консультанти відповідають найохочіше, але до дзвінка-клієнта доходять рідко. Зате в них є оператори-клієнти — вони цінні як канал, а не як покупці.",
      goal: "Партнерська домовленість (приводить клієнтів) · підхід ще пропрацьовуємо (decision-log #43)",
      steps: [
        { label: "Опенер", text: "Hi {Name}! You advise operators on {їхня зона: acquisition / growth}. We run Meta and in-app for iGaming and train operators' teams to do it in-house. When a client of yours needs that, there could be a clean partner fit. Open to comparing notes?" },
        { label: "Пропозиція партнерства", text: "Simplest version: when you send an operator our way for training or an audit, you get a referral share of the deal. Attribution is tracked, payouts in USDT. Want the one-pager?" },
        { label: "Пруф у DM", text: "Партнерська сторінка https://www.advantage-agency.co/affiliate-program (15% з навчання й аудиту, атрибуція 6 міс). Для розмови про цінність — будь-яка стаття під їхню тему." }
      ],
      branches: [
        "Має клієнтів-операторів, цікаво → партнерська розмова / one-pager.",
        "Сам хоче навчитись BH/in-app → це вже кампанія «Оператори…» або «In-App», не партнер.",
        "Хоче продати нам свій трафік → скрипт трафіку (spend-модель або вихід).",
        "«Цікаво, обмінятись думками» без клієнтів → стаття, nurture, не тягнути на 10 реплік."
      ].join("\n"),
      personalize: "Зона консультанта в опенері — реальна. Умови реферала (точний %) ще пропрацьовуються — вести як «referral share» і підтверджувати на дзвінку."
    }
  }
];

/** Сценарій кампанії й хребет — так, як їх читає модель. Без сценарію — лише хребет. */
export function scenarioForPrompt(campaign, spine) {
  const plan = campaign?.plan;
  const rules = cleanSpine(spine);
  return {
    campaign: campaign && !emptyPlan(plan) ? {
      name: campaign.name,
      approach: campaign.approach || "",
      whoWeTarget: plan.signal,
      hypothesis: plan.hypothesis,
      goal: plan.goal,
      flow: plan.steps,
      branches: plan.branches,
      personalize: plan.personalize
    } : (campaign?.approach ? { name: campaign.name, approach: campaign.approach } : null),
    spine: { qualificationLadder: rules.ladder, whereEachLeadGoes: rules.routes, rules: rules.rules },
    howToUse: "Follow the campaign flow: work out which step the conversation is at, take the branch that matches what the lead actually said, and write the next message in the spirit of that step's template — fill {variables} only with real facts from the profile or conversation, never invent them; if a fact is missing, write around it. The spine's rules apply to every campaign."
  };
}

/* ── HTTP: шаблони й хребет ─────────────────────────────────────────────── */

export async function handleScenarioApi({ request, response, url, sendJson, readJson, profile, spineStore }) {
  if (url.pathname !== "/api/scenarios" && !url.pathname.startsWith("/api/scenarios/")) return false;
  if (request.method === "GET" && url.pathname === "/api/scenarios") {
    sendJson(response, 200, { templates: SCENARIO_TEMPLATES, spine: cleanSpine(spineStore.read()), canEditSpine: profile?.role === "admin" });
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/scenarios/spine") {
    if (profile?.role !== "admin") {
      sendJson(response, 403, { error: "Хребет кампаній змінює адміністратор." });
      return true;
    }
    const spine = cleanSpine(await readJson(request));
    await spineStore.write(spine);
    sendJson(response, 200, { spine });
    return true;
  }
  sendJson(response, 404, { error: "Невідомий маршрут сценаріїв." });
  return true;
}
