/**
 * Outbound як конектор для ChatGPT (і будь-якого клієнта MCP) — власник 27.11: «щоб чат гпт
 * підключався до оутбаун і мав можливість писати листи людям через лінкедин … дати таку
 * можливість Богдану».
 *
 * Протокол — MCP поверх HTTP (JSON-RPC на POST /mcp). Кожен інструмент — це той самий запит до
 * API порталу, який робить екран Workspace, з особистим ключем людини: ті самі права, ті самі
 * ліміти, та сама черга агента. Лідген бачить і пише лише з акаунтів, які веде; адмін — з усіх.
 * Повідомлення не йде з ChatGPT у LinkedIn напряму: воно стає в чергу акаунта, і агент надсилає
 * його так само, як відповідь, написану в порталі.
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Outbound — робочий простір продажів у LinkedIn. Ти працюєш від імені людини, якій належить ключ: бачиш розмови LinkedIn з акаунтів, які вона веде, і можеш писати людям.
Як писати: спершу прочитай розмову (read_conversation), потім надішли відповідь (send_message). Тим, хто прийняв запит у друзі й кому ще не писали, — send_first_message.
Повідомлення не йде миттєво: воно стає в чергу акаунта, і агент надсилає його сам, з денними лімітами LinkedIn; відповідь інструмента каже, коли воно піде.
Пиши мовою співрозмовника, коротко й по-людськи, без шаблонних фраз. Не надсилай нічого, про що людина не просила.`;

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const clip = (value, size) => {
  const flat = text(value);
  return flat.length > size ? `${flat.slice(0, size - 1)}…` : flat;
};

const TOOLS = [
  {
    name: "list_conversations",
    title: "Розмови LinkedIn",
    description: "Розмови LinkedIn з акаунтів, які веде людина: хто, з якого акаунта, останнє повідомлення, чи є непрочитане. Найновіші — першими.",
    inputSchema: {
      type: "object",
      properties: {
        unread_only: { type: "boolean", description: "Лише з непрочитаними повідомленнями" },
        search: { type: "string", description: "Ім'я, компанія чи слово з повідомлення" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Скільки розмов повернути (типово 25)" }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "read_conversation",
    title: "Прочитати розмову",
    description: "Уся переписка з людиною, від найстарішого повідомлення. account_id і thread_key — з list_conversations або todays_work.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        thread_key: { type: "string" }
      },
      required: ["account_id", "thread_key"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "send_message",
    title: "Надіслати повідомлення в розмову",
    description: "Надіслати людині повідомлення в наявній розмові LinkedIn. Воно стає в чергу акаунта, і агент надсилає його сам з денними лімітами — відповідь каже, коли піде.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        thread_key: { type: "string" },
        text: { type: "string", description: "Текст повідомлення" }
      },
      required: ["account_id", "thread_key", "text"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "todays_work",
    title: "Робота на сьогодні",
    description: "Черга людини на сьогодні: кому відповісти, кому нагадати, кому написати перше повідомлення — з account_id, thread_key чи outreach_id для дії.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, description: "Скільки пунктів (типово 30)" } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "send_first_message",
    title: "Перше повідомлення",
    description: "Перше повідомлення людині, яка прийняла запит у друзі й якій ще не писали (outreach_id — з todays_work, блок «Перші повідомлення»). Стає в чергу акаунта, агент надсилає сам.",
    inputSchema: {
      type: "object",
      properties: {
        outreach_id: { type: "string" },
        text: { type: "string", description: "Текст повідомлення" }
      },
      required: ["outreach_id", "text"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }
];

/** When a queued message goes out, in words — the same facts the Workspace screen shows. */
function goesOut(answer) {
  if (answer?.agentOff) return "чекає: для акаунта вимкнено синхронізацію повідомлень («Прогрів» → таблиця акаунтів)";
  if (answer?.limitReached) return `денний ліміт повідомлень акаунта вичерпано — піде ${answer.goesOutToday ? "сьогодні" : "завтра"}${answer.goesOutAt ? ` близько ${clock(answer.goesOutAt)}` : ""}`;
  if (answer?.goesOutNow) return `піде за кілька хвилин${answer.goesOutAt ? `, близько ${clock(answer.goesOutAt)}` : ""}`;
  if (answer?.goesOutAt) return `піде ${answer.goesOutToday ? "сьогодні" : "завтра"} близько ${clock(answer.goesOutAt)}`;
  return "піде в наступну сесію акаунта";
}

function clock(iso) {
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? at.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" }) : "";
}

/**
 * The MCP endpoint for one person. `call(path, { method, body })` asks the portal's own API with
 * that person's key and answers `{ status, data }`; `allowed(accountId)` says whether they may see
 * and write from the account.
 */
export function mcpServer({ call, allowed, version = "1" }) {
  const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });
  const ok = (data, summary) => ({ content: [{ type: "text", text: summary ? `${summary}\n\n${JSON.stringify(data, null, 1)}` : JSON.stringify(data, null, 1) }], structuredContent: data });
  const apiError = (answer) => answer?.data?.error || `Портал відповів ${answer?.status}`;

  const tools = {
    async list_conversations(args) {
      const answer = await call(`/api/warmup/inbox${args.unread_only ? "?unread=1" : ""}`);
      if (answer.status >= 400) return fail(apiError(answer));
      const terms = text(args.search).toLowerCase().split(" ").filter(Boolean);
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
      const rows = (answer.data.threads || [])
        .filter((thread) => allowed(thread.accountId))
        .filter((thread) => !terms.length || terms.every((term) => [thread.participant?.name, thread.participant?.headline, thread.lastMessage?.body]
          .map((part) => String(part || "").toLowerCase()).join(" ").includes(term)))
        .sort((left, right) => String(right.lastMessage?.sentAt || "").localeCompare(String(left.lastMessage?.sentAt || "")))
        .slice(0, limit)
        .map((thread) => ({
          account_id: thread.accountId,
          account: thread.accountIdentity || thread.accountLabel || "",
          thread_key: thread.threadKey,
          person: thread.participant?.name || "",
          headline: clip(thread.participant?.headline, 120),
          unread: Boolean(thread.unread),
          answered: Boolean(thread.answered),
          label: thread.aiLabel?.label || null,
          last: thread.lastMessage ? { from: thread.lastMessage.direction === "out" ? "ми" : "людина", text: clip(thread.lastMessage.body, 300), at: thread.lastMessage.sentAt || null } : null
        }));
      return ok({ conversations: rows }, rows.length ? `${rows.length} розмов` : "Розмов немає (або немає акаунтів, які ця людина веде).");
    },

    async read_conversation(args) {
      if (!allowed(args.account_id)) return fail("Цей акаунт веде інша людина — його розмов тут не видно.");
      const query = new URLSearchParams({ accountId: String(args.account_id || ""), threadKey: String(args.thread_key || "") });
      const answer = await call(`/api/warmup/inbox/thread?${query}`);
      if (answer.status >= 400) return fail(apiError(answer));
      const thread = answer.data.thread || {};
      const messages = (answer.data.messages || []).map((message) => ({
        from: message.direction === "out" ? "ми" : "людина",
        text: message.body,
        at: message.sentAt || message.linkedinAt || null
      }));
      const queued = (answer.data.outbox || answer.data.replies || [])
        .filter((reply) => reply.state === "waiting")
        .map((reply) => ({ text: reply.body, state: "чекає відправки" }));
      return ok({
        account_id: args.account_id,
        thread_key: args.thread_key,
        person: thread.participant?.name || "",
        headline: thread.participant?.headline || "",
        messages,
        ...(queued.length ? { queued } : {})
      });
    },

    async send_message(args) {
      if (!allowed(args.account_id)) return fail("Цей акаунт веде інша людина — писати з нього не можна.");
      if (!text(args.text)) return fail("Порожнє повідомлення.");
      const answer = await call("/api/warmup/inbox/reply", {
        method: "POST",
        body: { accountId: String(args.account_id), threadKey: String(args.thread_key), text: String(args.text) }
      });
      if (answer.status >= 400) return fail(apiError(answer));
      return ok({ queued: true, duplicate: Boolean(answer.data.duplicate), goes_out: goesOut(answer.data) },
        answer.data.duplicate ? "Таке саме повідомлення вже чекає в черзі — друге не ставлю." : `Поставлено в чергу: ${goesOut(answer.data)}.`);
    },

    async todays_work(args) {
      const answer = await call("/api/today?scope=mine");
      if (answer.status >= 400) return fail(apiError(answer));
      if (answer.data.configured === false) return fail("Черга пінгів на цьому сервері не налаштована.");
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
      const titles = { replies: "Відповісти", overdue: "Прострочено", today: "На сьогодні", first: "Перші повідомлення" };
      const items = Object.entries(answer.data.blocks || {})
        .flatMap(([block, list]) => (list || []).map((item) => ({ block: titles[block] || block, item })))
        .filter(({ item }) => !item.accountId || allowed(item.accountId))
        .slice(0, limit)
        .map(({ block, item }) => ({
          block,
          why: item.reasonTitle || item.title || "",
          person: item.name || "",
          company: item.company || "",
          account: item.accountName || "",
          account_id: item.accountId || null,
          thread_key: item.threadKey || null,
          outreach_id: item.outreachId || null,
          last: item.preview ? { from: item.preview.direction === "out" ? "ми" : "людина", text: clip(item.preview.body, 300) } : null,
          due: item.dueDay || null
        }));
      return ok({ items }, items.length ? `${items.length} пунктів` : "На сьогодні нічого немає.");
    },

    async send_first_message(args) {
      if (!text(args.text)) return fail("Порожнє повідомлення.");
      const answer = await call("/api/warmup/first-messages/send", {
        method: "POST",
        body: { outreachId: String(args.outreach_id || ""), text: String(args.text) }
      });
      if (answer.status >= 400) return fail(apiError(answer));
      return ok({ queued: true, duplicate: Boolean(answer.data.duplicate), goes_out: goesOut(answer.data) },
        answer.data.duplicate ? "Таке саме перше повідомлення вже чекає." : `Поставлено в чергу: ${goesOut(answer.data)}.`);
    }
  };

  async function one(message) {
    const id = message?.id;
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    const error = (code, text) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message: text } });
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return error(-32600, "Invalid request");
    // A notification (no id) is answered with nothing.
    if (id === undefined) return null;
    switch (message.method) {
      case "initialize": {
        const asked = message.params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "outbound", title: "Outbound — LinkedIn", version },
          instructions: INSTRUCTIONS
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const tool = tools[message.params?.name];
        if (!tool) return error(-32602, `Unknown tool: ${message.params?.name}`);
        try {
          return reply(await tool(message.params?.arguments || {}));
        } catch (failure) {
          return reply(fail(`Не вдалося: ${failure?.message || failure}`));
        }
      }
      default:
        return error(-32601, `Method not found: ${message.method}`);
    }
  }

  /** One POST body (a message or a batch) → the JSON to answer, or null when only notifications came. */
  return async function handle(body) {
    if (Array.isArray(body)) {
      const answers = (await Promise.all(body.map(one))).filter(Boolean);
      return answers.length ? answers : null;
    }
    return one(body);
  };
}

export const MCP_TOOL_NAMES = TOOLS.map((tool) => tool.name);
