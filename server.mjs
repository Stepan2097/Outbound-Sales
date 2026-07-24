import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as connectTcp } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const appRoot = join(root, "app");
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const masterKey = createHash("sha256").update(randomBytes(32)).digest();
const openRouterDefaults = {
  analysisModel: "anthropic/claude-haiku-4.5",
  writingModel: "anthropic/claude-sonnet-5"
};

const taskTypes = [
  "ICP_ANALYSIS",
  "ACCOUNT_QUALIFICATION",
  "PROSPECT_QUALIFICATION",
  "COMPANY_RESEARCH_SUMMARY",
  "PERSON_RESEARCH_SUMMARY",
  "PAIN_POINT_HYPOTHESIS",
  "BUYING_TRIGGER_DETECTION",
  "CONTACT_DATA_CLASSIFICATION",
  "RELATIONSHIP_PATH_ANALYSIS",
  "INTRODUCTION_PATH_SCORING",
  "LINKEDIN_CONNECTION_MESSAGE",
  "LINKEDIN_FOLLOW_UP",
  "LINKEDIN_COMMENT",
  "COLD_EMAIL",
  "EMAIL_FOLLOW_UP",
  "WHATSAPP_DRAFT",
  "TELEGRAM_DRAFT",
  "CALL_OPENER",
  "VOICEMAIL_SCRIPT",
  "OBJECTION_HANDLING",
  "SEQUENCE_GENERATION",
  "NEXT_BEST_ACTION",
  "LEAD_SCORING",
  "MESSAGE_QUALITY_REVIEW",
  "CLAIM_VERIFICATION",
  "LANGUAGE_TRANSLATION",
  "CRM_NOTE_SUMMARY",
  "SALES_COACHING",
  "CAMPAIGN_ANALYSIS",
  "MCP_CONTEXT_SYNTHESIS"
];

const state = {
  workspaceId: "workspace-demo",
  environment: "development",
  openRouterEnabled: false,
  keyMetadata: null,
  providerHealth: {
    status: "mock_ready",
    latencyMs: 1,
    lastCheckedAt: new Date().toISOString()
  },
  budgets: {
    monthlyWorkspaceBudgetUsd: 500,
    dailyWorkspaceBudgetUsd: 40,
    perUserMonthlyBudgetUsd: 60,
    hardLimitEnabled: true,
    warningThresholdPercent: 80
  },
  providerRule: {
    policy: "approved_providers_only",
    allowProviderFallbacks: true,
    requireNoTraining: true,
    requireZeroRetention: false
  },
  aiModelDefaults: { ...openRouterDefaults },
  models: seedModels(),
  tasks: seedTasks(),
  agents: seedOutboundAgents(),
  agentRuns: [],
  icp: {
    seedLeadIds: [],
    profile: {
      status: "empty",
      summary: "Upload ideal customer leads to build ICP filters.",
      titles: [],
      seniorities: [],
      functions: [],
      industries: [],
      companyKeywords: [],
      companySizes: [],
      countries: [],
      cities: [],
      domains: [],
      exclusions: [],
      updatedAt: null
    },
    lookalikeSearch: {
      status: "not_ready",
      totalResults: 1000,
      actorId: "kVYdvNOefemtiDXO5",
      payload: null,
      generatedAt: null,
      lastRunAt: null,
      lastImportCount: 0,
      warnings: []
    }
  },
  learning: {
    examples: [],
    playbook: {
      status: "empty",
      summary: "Feed successful outreach examples to train product-specific message patterns.",
      winningPatterns: [],
      channelTips: [],
      reusableRules: [],
      nextDataNeeded: ["Successful replies", "Booked-meeting follow-ups", "Screenshots with message text or notes"],
      updatedAt: null
    },
    modelVersion: "learning-local-v1",
    lastTrainedAt: null
  },
  products: seedProducts(),
  selectedProductId: "outbound-sales-os",
  mcpSync: {
    status: "connected",
    portal: "MCP Product Context Portal",
    baseUrl: "",
    resourceNamespace: "",
    keyMetadata: null,
    lastSyncedAt: new Date().toISOString()
  },
  integrations: {
    apify: {
      configured: false,
      actorIds: {
        leadDatabase: "",
        linkedinProfile: "",
        contactFinder: "",
        apollo: "",
        zoominfo: "",
        facebookProfile: "",
        emailPhoneFinder: "",
        phoneMessengerCheck: ""
      },
      actorInputTemplates: {
        leadDatabase: ""
      },
      maxChargeUsd: 1.5,
      status: "not_configured",
      lastRunAt: null,
      keyMetadata: null
    },
    crm: {
      configured: false,
      name: "Custom CRM",
      baseUrl: "",
      leadObject: "Lead",
      contactObject: "Contact",
      activityObject: "Activity",
      accountObject: "Account",
      leadEndpoint: "",
      activityEndpoint: "",
      syncDirection: "push_and_pull",
      status: "not_configured",
      keyMetadata: null
    },
    transcripts: {
      configured: false,
      provider: "manual",
      webhookUrl: "",
      status: "manual_paste",
      lastIngestedAt: null,
      keyMetadata: null
    },
    notifications: {
      configured: true,
      channel: "in_app",
      target: "",
      status: "in_app"
    },
    supabase: {
      configured: false,
      url: "",
      status: "not_configured",
      lastCheckedAt: null,
      keyMetadata: null
    },
    postgres: {
      configured: false,
      host: "",
      port: 5432,
      database: "",
      user: "",
      status: "not_configured",
      lastCheckedAt: null,
      keyMetadata: null
    }
  },
  prospects: seedProspects(),
  interactions: seedInteractions(),
  followUpTasks: [],
  aiActions: [],
  historicalOutcomes: seedHistoricalOutcomes(),
  usage: seedUsage(),
  events: [
    {
      at: new Date().toISOString(),
      type: "system",
      text: "Mock AI provider active. OpenRouter can be enabled from Settings."
    }
  ],
  vault: null,
  apifyVault: null,
  mcpVault: null,
  crmVault: null,
  transcriptVault: null,
  supabaseVault: null,
  postgresVault: null
};

initializeRuntimeConfigFromEnv();
void warmRuntimeConnections();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        app: "outbound-sales-os",
        runtime: state.openRouterEnabled && state.providerHealth.status === "healthy" ? "openrouter" : "local",
        checkedAt: new Date().toISOString()
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, () => {
  console.log(`OpenRouter orchestration platform running at http://localhost:${port}`);
});

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      status: "ok",
      app: "outbound-sales-os",
      runtime: state.openRouterEnabled && state.providerHealth.status === "healthy" ? "openrouter" : "local",
      checkedAt: new Date().toISOString()
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/openrouter/key") {
    const body = await readJson(request);
    if (typeof body.apiKey !== "string" || body.apiKey.trim().length < 8) {
      sendJson(response, 400, { error: "Enter a valid OpenRouter API key." });
      return;
    }

    state.environment = body.environment === "production" || body.environment === "staging" ? body.environment : "development";
    state.vault = encryptSecret(body.apiKey.trim());
    state.openRouterEnabled = true;
    updateOpenRouterDefaults(body);
    state.keyMetadata = {
      provider: "openrouter",
      environment: state.environment,
      keyVersion: (state.keyMetadata?.keyVersion ?? 0) + 1,
      rotatedAt: new Date().toISOString()
    };
    addEvent("security", `OpenRouter key ${state.keyMetadata.keyVersion === 1 ? "configured" : "rotated"} for ${state.environment}.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/openrouter/configure") {
    const body = await readJson(request);
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      if (body.apiKey.trim().length < 8) {
        sendJson(response, 400, { error: "Enter a valid OpenRouter API key." });
        return;
      }
      state.vault = encryptSecret(body.apiKey.trim());
      state.openRouterEnabled = true;
      state.keyMetadata = {
        provider: "openrouter",
        environment: "development",
        keyVersion: (state.keyMetadata?.keyVersion ?? 0) + 1,
        rotatedAt: new Date().toISOString()
      };
    }

    updateOpenRouterDefaults(body);
    if (!state.vault) {
      sendJson(response, 400, { error: "OpenRouter API key is required before model sync." });
      return;
    }

    const apiKey = decryptSecret(state.vault);
    await testOpenRouterConnection(apiKey);
    if (state.providerHealth.status === "healthy") {
      await syncOpenRouterModels(apiKey);
      enablePreferredOpenRouterModels();
      addEvent("provider", `OpenRouter connected. Analysis uses ${state.aiModelDefaults.analysisModel}; writing uses ${state.aiModelDefaults.writingModel}.`);
    }
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/openrouter/revoke") {
    state.vault = null;
    state.openRouterEnabled = false;
    state.keyMetadata = null;
    state.providerHealth = {
      status: "mock_ready",
      latencyMs: 1,
      lastCheckedAt: new Date().toISOString()
    };
    addEvent("security", "OpenRouter key revoked. Mock provider is active.");
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/openrouter/test") {
    if (!state.vault) {
      state.providerHealth = {
        status: "not_configured",
        latencyMs: 0,
        lastCheckedAt: new Date().toISOString()
      };
      sendJson(response, 200, publicState());
      return;
    }

    await testOpenRouterConnection(decryptSecret(state.vault));
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/openrouter/sync") {
    if (!state.vault) {
      addEvent("registry", "Model sync used the local mock catalog because no OpenRouter key is configured.");
      sendJson(response, 200, publicState());
      return;
    }

    await syncOpenRouterModels(decryptSecret(state.vault));
    enablePreferredOpenRouterModels();
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/models/toggle") {
    const body = await readJson(request);
    const model = state.models.find((item) => item.id === body.modelId);
    if (!model) {
      sendJson(response, 404, { error: "Model not found." });
      return;
    }
    model.enabled = Boolean(body.enabled);
    addEvent("registry", `${model.displayName} ${model.enabled ? "enabled" : "disabled"}.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tasks/update") {
    const body = await readJson(request);
    const task = state.tasks.find((item) => item.taskType === body.taskType);
    if (!task) {
      sendJson(response, 404, { error: "Task not found." });
      return;
    }
    task.primaryModel = body.primaryModel || task.primaryModel;
    task.fallbackModels = Array.isArray(body.fallbackModels) ? body.fallbackModels.slice(0, 4) : task.fallbackModels;
    task.qualityTier = body.qualityTier || task.qualityTier;
    task.maxCostUsd = clampNumber(body.maxCostUsd, 0.001, 20, task.maxCostUsd);
    task.maxLatencyMs = clampNumber(body.maxLatencyMs, 500, 120000, task.maxLatencyMs);
    task.privacyLevel = body.privacyLevel || task.privacyLevel;
    addEvent("routing", `${task.taskType} routing updated.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/budgets/update") {
    const body = await readJson(request);
    state.budgets.monthlyWorkspaceBudgetUsd = clampNumber(body.monthlyWorkspaceBudgetUsd, 1, 100000, state.budgets.monthlyWorkspaceBudgetUsd);
    state.budgets.dailyWorkspaceBudgetUsd = clampNumber(body.dailyWorkspaceBudgetUsd, 1, 100000, state.budgets.dailyWorkspaceBudgetUsd);
    state.budgets.perUserMonthlyBudgetUsd = clampNumber(body.perUserMonthlyBudgetUsd, 1, 100000, state.budgets.perUserMonthlyBudgetUsd);
    state.budgets.hardLimitEnabled = Boolean(body.hardLimitEnabled);
    state.budgets.warningThresholdPercent = clampNumber(body.warningThresholdPercent, 1, 100, state.budgets.warningThresholdPercent);
    addEvent("budget", "Workspace AI budgets updated.");
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/provider-rule/update") {
    const body = await readJson(request);
    state.providerRule = {
      ...state.providerRule,
      policy: body.policy || state.providerRule.policy,
      allowProviderFallbacks: Boolean(body.allowProviderFallbacks),
      requireNoTraining: Boolean(body.requireNoTraining),
      requireZeroRetention: Boolean(body.requireZeroRetention)
    };
    addEvent("privacy", "Provider routing policy updated.");
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/products/select") {
    const body = await readJson(request);
    const product = state.products.find((item) => item.id === body.productId);
    if (!product) {
      sendJson(response, 404, { error: "Product not found." });
      return;
    }

    state.selectedProductId = product.id;
    addEvent("product", `${product.name} selected for tailored outreach.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/products/upsert") {
    const body = await readJson(request);
    const product = normalizeProduct(body);
    if (!product.name || !product.positioning) {
      sendJson(response, 400, { error: "Product name and positioning are required." });
      return;
    }

    const existing = state.products.find((item) => item.id === product.id);
    if (existing) {
      Object.assign(existing, {
        ...existing,
        ...product,
        examples: existing.examples ?? product.examples,
        knowledge: existing.knowledge ?? product.knowledge,
        mcpContext: {
          ...existing.mcpContext,
          ...product.mcpContext
        }
      });
    } else {
      state.products.push(product);
    }
    state.selectedProductId = product.id;
    addEvent("product", `${product.name} ${existing ? "updated" : "added"}.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/products/examples") {
    const body = await readJson(request);
    const product = state.products.find((item) => item.id === (body.productId || state.selectedProductId));
    if (!product) {
      sendJson(response, 404, { error: "Product not found." });
      return;
    }

    const example = normalizeOutreachExample(body);
    if (!example.message) {
      sendJson(response, 400, { error: "Example message is required." });
      return;
    }

    product.examples ??= [];
    product.examples.unshift(example);
    product.examples = product.examples.slice(0, 50);
    addEvent("training", `Example outreach added for ${product.name}.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/products/knowledge") {
    const body = await readJson(request);
    const product = state.products.find((item) => item.id === (body.productId || state.selectedProductId));
    if (!product) {
      sendJson(response, 404, { error: "Product not found." });
      return;
    }

    const item = normalizeProductKnowledge(body);
    if (!item.title && !item.text && !item.url && !item.screenshot) {
      sendJson(response, 400, { error: "Add a link, lesson, note, or screenshot before saving." });
      return;
    }

    product.knowledge ??= [];
    product.knowledge.unshift(item);
    product.knowledge = product.knowledge
      .sort((left, right) => right.priority - left.priority || new Date(right.createdAt) - new Date(left.createdAt))
      .slice(0, 120);
    product.mcpContext = {
      ...product.mcpContext,
      freshness: "workspace_enriched",
      lastSyncedAt: new Date().toISOString()
    };
    addEvent("product", `Knowledge added for ${product.name}.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/examples") {
    const body = await readJson(request);
    const product = state.products.find((item) => item.id === (body.productId || state.selectedProductId));
    if (!product) {
      sendJson(response, 404, { error: "Product not found." });
      return;
    }

    const example = normalizeLearningExample(body, product);
    if (!example.messageText && !example.screenshot && !example.profileUrl && !example.sourceUrl) {
      sendJson(response, 400, { error: "Add text, a screenshot, or a URL before saving." });
      return;
    }

    example.signals = await analyzeLearningExample(example, product);
    state.learning.examples.unshift(example);
    state.learning.examples = state.learning.examples.slice(0, 250);
    if (example.messageText && example.outcomeScore >= 65) {
      product.examples ??= [];
      product.examples.unshift(normalizeOutreachExample({
        channel: example.channel,
        persona: example.persona,
        message: example.messageText,
        outcome: `${example.outcome || "successful"} · learning database`
      }));
      product.examples = product.examples.slice(0, 50);
    }
    await rebuildLearningPlaybook();
    addEvent("learning", `${product.name} learned from ${example.channel} ${example.assetType}.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/learning/retrain") {
    await rebuildLearningPlaybook({ forceAi: true });
    addEvent("learning", "Learning playbook rebuilt from uploaded examples.");
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/products/sync-mcp") {
    state.mcpSync = {
      status: "synced",
      portal: "MCP Product Context Portal",
      lastSyncedAt: new Date().toISOString()
    };
    state.products = state.products.map((product) => ({
      ...product,
      mcpContext: {
        ...product.mcpContext,
        version: incrementVersion(product.mcpContext.version),
        lastSyncedAt: state.mcpSync.lastSyncedAt,
        freshness: "fresh"
      }
    }));
    addEvent("mcp", "Product context synchronized from MCP portal.");
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/integrations/mcp/configure") {
    const body = await readJson(request);
    state.mcpSync.baseUrl = cleanText(body.baseUrl || state.mcpSync.baseUrl);
    state.mcpSync.resourceNamespace = cleanText(body.resourceNamespace || state.mcpSync.resourceNamespace);
    if (typeof body.apiToken === "string" && body.apiToken.trim()) {
      state.mcpVault = encryptSecret(body.apiToken.trim());
      state.mcpSync.keyMetadata = {
        configured: true,
        rotatedAt: new Date().toISOString(),
        keyVersion: (state.mcpSync.keyMetadata?.keyVersion ?? 0) + 1
      };
    }
    state.mcpSync.status = state.mcpSync.baseUrl ? "configured" : "needs_url";
    addEvent("mcp", "MCP portal connection settings saved.");
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/integrations/apify/configure") {
    const body = await readJson(request);
    state.integrations.apify.actorIds = {
      leadDatabase: normalizeApifyActorId(body.leadDatabaseActorId || state.integrations.apify.actorIds.leadDatabase),
      linkedinProfile: normalizeApifyActorId(body.linkedinProfileActorId || state.integrations.apify.actorIds.linkedinProfile),
      contactFinder: normalizeApifyActorId(body.contactFinderActorId || state.integrations.apify.actorIds.contactFinder),
      apollo: normalizeApifyActorId(body.apolloActorId || state.integrations.apify.actorIds.apollo),
      zoominfo: normalizeApifyActorId(body.zoominfoActorId || state.integrations.apify.actorIds.zoominfo),
      facebookProfile: normalizeApifyActorId(body.facebookProfileActorId || state.integrations.apify.actorIds.facebookProfile),
      emailPhoneFinder: normalizeApifyActorId(body.emailPhoneFinderActorId || state.integrations.apify.actorIds.emailPhoneFinder),
      phoneMessengerCheck: normalizeApifyActorId(body.phoneMessengerCheckActorId || state.integrations.apify.actorIds.phoneMessengerCheck)
    };
    state.integrations.apify.actorInputTemplates = {
      ...state.integrations.apify.actorInputTemplates,
      leadDatabase: cleanLongText(body.leadDatabaseInputTemplate || state.integrations.apify.actorInputTemplates?.leadDatabase || "")
    };
    state.integrations.apify.maxChargeUsd = clampNumber(body.maxChargeUsd, 0.05, 50, state.integrations.apify.maxChargeUsd);
    if (typeof body.apiToken === "string" && body.apiToken.trim()) {
      state.apifyVault = encryptSecret(body.apiToken.trim());
      state.integrations.apify.keyMetadata = {
        configured: true,
        rotatedAt: new Date().toISOString(),
        keyVersion: (state.integrations.apify.keyMetadata?.keyVersion ?? 0) + 1
      };
    }
    state.integrations.apify.configured = Boolean(state.apifyVault);
    state.integrations.apify.status = state.integrations.apify.configured ? "configured" : "missing_token";
    addEvent("integration", "Apify scraper settings saved.");
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/integrations/crm/configure") {
    const body = await readJson(request);
    state.integrations.crm = {
      ...state.integrations.crm,
      name: cleanText(body.name || state.integrations.crm.name),
      baseUrl: cleanText(body.baseUrl || state.integrations.crm.baseUrl),
      leadObject: cleanText(body.leadObject || state.integrations.crm.leadObject),
      contactObject: cleanText(body.contactObject || state.integrations.crm.contactObject),
      activityObject: cleanText(body.activityObject || state.integrations.crm.activityObject),
      accountObject: cleanText(body.accountObject || state.integrations.crm.accountObject),
      leadEndpoint: cleanText(body.leadEndpoint || state.integrations.crm.leadEndpoint),
      activityEndpoint: cleanText(body.activityEndpoint || state.integrations.crm.activityEndpoint),
      syncDirection: cleanText(body.syncDirection || state.integrations.crm.syncDirection)
    };
    if (typeof body.apiToken === "string" && body.apiToken.trim()) {
      state.crmVault = encryptSecret(body.apiToken.trim());
      state.integrations.crm.keyMetadata = {
        configured: true,
        rotatedAt: new Date().toISOString(),
        keyVersion: (state.integrations.crm.keyMetadata?.keyVersion ?? 0) + 1
      };
    }
    state.integrations.crm.configured = Boolean(state.crmVault && state.integrations.crm.baseUrl);
    state.integrations.crm.status = state.integrations.crm.configured ? "configured" : "needs_credentials";
    addEvent("integration", `${state.integrations.crm.name} settings saved.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/integrations/transcripts/configure") {
    const body = await readJson(request);
    const provider = cleanText(body.provider || "manual");
    state.integrations.transcripts = {
      ...state.integrations.transcripts,
      provider,
      webhookUrl: cleanText(body.webhookUrl || state.integrations.transcripts.webhookUrl),
      configured: provider !== "manual" && Boolean(body.apiToken || state.transcriptVault || body.webhookUrl),
      status: provider === "manual" ? "manual_paste" : "configured"
    };
    if (typeof body.apiToken === "string" && body.apiToken.trim()) {
      state.transcriptVault = encryptSecret(body.apiToken.trim());
      state.integrations.transcripts.keyMetadata = {
        provider,
        rotatedAt: new Date().toISOString(),
        keyVersion: (state.integrations.transcripts.keyMetadata?.keyVersion ?? 0) + 1
      };
    }
    state.integrations.notifications = {
      ...state.integrations.notifications,
      channel: cleanText(body.notificationChannel || state.integrations.notifications.channel),
      target: cleanText(body.notificationTarget || state.integrations.notifications.target),
      configured: true
    };
    state.integrations.notifications.status = state.integrations.notifications.channel;
    addEvent("integration", "Call transcript and follow-up notification settings saved.");
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/integrations/data/configure") {
    const body = await readJson(request);
    state.integrations.supabase.url = normalizeUrl(body.supabaseUrl || state.integrations.supabase.url);
    if (typeof body.supabaseApiKey === "string" && body.supabaseApiKey.trim()) {
      state.supabaseVault = encryptSecret(body.supabaseApiKey.trim());
      state.integrations.supabase.keyMetadata = {
        configured: true,
        rotatedAt: new Date().toISOString(),
        keyVersion: (state.integrations.supabase.keyMetadata?.keyVersion ?? 0) + 1
      };
    }

    state.integrations.postgres = {
      ...state.integrations.postgres,
      host: cleanText(body.pgHost || state.integrations.postgres.host),
      port: clampNumber(body.pgPort, 1, 65535, state.integrations.postgres.port || 5432),
      database: cleanText(body.pgDatabase || state.integrations.postgres.database),
      user: cleanText(body.pgUser || state.integrations.postgres.user)
    };
    if (typeof body.pgPassword === "string" && body.pgPassword.trim()) {
      state.postgresVault = encryptSecret(body.pgPassword.trim());
      state.integrations.postgres.keyMetadata = {
        configured: true,
        rotatedAt: new Date().toISOString(),
        keyVersion: (state.integrations.postgres.keyMetadata?.keyVersion ?? 0) + 1
      };
    }

    if (state.integrations.supabase.url) {
      state.integrations.supabase = {
        ...state.integrations.supabase,
        ...(await testSupabaseRest(state.integrations.supabase.url, state.supabaseVault ? decryptSecret(state.supabaseVault) : ""))
      };
    }
    if (state.integrations.postgres.host) {
      state.integrations.postgres = {
        ...state.integrations.postgres,
        ...(await testPostgresTcp(state.integrations.postgres.host, state.integrations.postgres.port, Boolean(state.postgresVault)))
      };
    }

    addEvent("integration", "Supabase and Postgres connection settings checked.");
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tasks/run") {
    const body = await readJson(request);
    const run = simulateRun(body.taskType || "COLD_EMAIL", body.profile || "balanced", body.preferredModel || "");
    sendJson(response, 200, { ...publicState(), run });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/crm/import-leads") {
    const body = await readJson(request);
    const action = await importCrmLeadsAction({
      source: cleanText(body.source || "supabase"),
      resource: cleanText(body.resource || ""),
      limit: clampNumber(body.limit, 1, 500, 50),
      linkedinField: cleanText(body.linkedinField || "")
    });
    state.aiActions.unshift(action);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/assistant/task") {
    const body = await readJson(request);
    const action = await runAssistantAction({
      instruction: cleanLongText(body.instruction || ""),
      scope: cleanText(body.scope || "selected"),
      limit: clampNumber(body.limit, 1, 200, 25),
      selectedProspectId: cleanText(body.selectedProspectId || "")
    });
    state.aiActions.unshift(action);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agents/run") {
    const body = await readJson(request);
    const run = await runOutboundAgent(cleanText(body.agentId || ""), {
      scope: cleanText(body.scope || "selected"),
      limit: clampNumber(body.limit, 1, 100, 10),
      selectedProspectId: cleanText(body.selectedProspectId || ""),
      instruction: cleanLongText(body.instruction || "")
    });
    state.agentRuns.unshift(run);
    state.agentRuns = state.agentRuns.slice(0, 100);
    state.aiActions.unshift(agentRunToAiAction(run));
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agents/pipeline") {
    const body = await readJson(request);
    const run = await runOutboundPipeline({
      scope: cleanText(body.scope || "selected"),
      limit: clampNumber(body.limit, 1, 50, 10),
      selectedProspectId: cleanText(body.selectedProspectId || ""),
      instruction: cleanLongText(body.instruction || "")
    });
    state.agentRuns.unshift(run);
    state.agentRuns = state.agentRuns.slice(0, 100);
    state.aiActions.unshift(agentRunToAiAction(run));
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/icp/seeds/import") {
    const body = await readJson(request);
    const prospects = Array.isArray(body.prospects) ? body.prospects : [];
    const result = importIcpSeedLeads(prospects);
    rebuildIcpProfile();
    buildPipelineLabsActorPayload(clampNumber(body.totalResults, 1, 50000, state.icp.lookalikeSearch.totalResults || 1000));
    addEvent("icp", `${result.importedCount} ICP seed leads trained the lookalike profile.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/icp/lookalike-json") {
    const body = await readJson(request);
    buildPipelineLabsActorPayload(clampNumber(body.totalResults, 1, 50000, state.icp.lookalikeSearch.totalResults || 1000));
    addEvent("icp", "PipelineLabs Apify JSON generated from ICP seed leads.");
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/icp/lookalike-search") {
    const body = await readJson(request);
    const totalResults = clampNumber(body.totalResults, 1, 50000, state.icp.lookalikeSearch.totalResults || 1000);
    const limit = clampNumber(body.limit, 1, 500, Math.min(totalResults, 100));
    buildPipelineLabsActorPayload(totalResults);
    const result = await runIcpLookalikeSearch(limit);
    addEvent("icp", `${result.importedCount} lookalike leads imported from Apify.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/prospects/import") {
    const body = await readJson(request);
    const prospects = Array.isArray(body.prospects) ? body.prospects : [];
    const imported = prospects.map(normalizeProspect).filter((prospect) => prospect.name && prospect.company).slice(0, 500);
    if (!imported.length) {
      sendJson(response, 400, { error: "No valid prospects found. Name and company are required." });
      return;
    }

    const byKey = new Map(state.prospects.map((prospect) => [prospect.dedupeKey, prospect]));
    for (const prospect of imported) {
      byKey.set(prospect.dedupeKey, { ...(byKey.get(prospect.dedupeKey) ?? {}), ...prospect });
    }
    state.prospects = [...byKey.values()].sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
    addEvent("prospects", `${imported.length} prospect profiles imported.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/prospects/enrich") {
    const body = await readJson(request);
    const prospect = findProspect(body.prospectId);
    if (!prospect) {
      sendJson(response, 404, { error: "Prospect not found." });
      return;
    }

    prospect.contactDiscovery = await enrichProspectContacts(prospect);
    recordLeadResearch(prospect, {
      stage: "contact_enriched",
      summary: `${prospect.contactDiscovery.candidates.length} contact candidates reviewed for ${prospect.name}.`,
      contactDiscovery: prospect.contactDiscovery,
      warnings: prospect.contactDiscovery.warnings
    });
    prospect.status = "enriched";
    prospect.updatedAt = new Date().toISOString();
    addEvent("enrichment", `${prospect.name} contact discovery refreshed.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/prospects/linkedin-target") {
    const body = await readJson(request);
    const linkedinUrl = cleanText(body.linkedinUrl || "");
    if (!/^https:\/\/(www\.)?linkedin\.com\/in\/.+/i.test(linkedinUrl)) {
      sendJson(response, 400, { error: "Enter a LinkedIn profile URL like https://www.linkedin.com/in/name." });
      return;
    }

    const prospect = normalizeProspect({
      name: cleanText(body.name || nameFromLinkedInUrl(linkedinUrl)),
      title: cleanText(body.title || ""),
      company: cleanText(body.company || "Unknown account"),
      location: cleanText(body.location || ""),
      website: cleanText(body.website || ""),
      linkedin: linkedinUrl,
      notes: cleanText(body.notes || "Created from LinkedIn target URL.")
    });
    prospect.contactDiscovery = await enrichProspectContacts(prospect);
    recordLeadResearch(prospect, {
      stage: "contact_enriched",
      summary: `${prospect.contactDiscovery.candidates.length} contact candidates reviewed from LinkedIn target import.`,
      contactDiscovery: prospect.contactDiscovery,
      warnings: prospect.contactDiscovery.warnings
    });
    prospect.outreach = await prepareAndLogOutreach(prospect, "balanced", "LINKEDIN_CONNECTION_MESSAGE", {
      source: "linkedin-target-url"
    });
    prospect.status = "linkedin_ready";
    state.prospects = [prospect, ...state.prospects.filter((item) => item.dedupeKey !== prospect.dedupeKey)];
    addEvent("linkedin", `${prospect.name} imported from LinkedIn URL with message variations.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/prospects/prepare") {
    const body = await readJson(request);
    const prospect = findProspect(body.prospectId);
    if (!prospect) {
      sendJson(response, 404, { error: "Prospect not found." });
      return;
    }

    if (!prospect.contactDiscovery) {
      prospect.contactDiscovery = await enrichProspectContacts(prospect);
      recordLeadResearch(prospect, {
        stage: "contact_enriched",
        summary: `${prospect.contactDiscovery.candidates.length} contact candidates reviewed before outreach preparation.`,
        contactDiscovery: prospect.contactDiscovery,
        warnings: prospect.contactDiscovery.warnings
      });
    }

    const profile = body.profile === "premium" || body.profile === "economy" ? body.profile : "balanced";
    prospect.outreach = await prepareAndLogOutreach(prospect, profile, "SEQUENCE_GENERATION", {
      source: "manual-prepare"
    });
    prospect.status = "outreach_ready";
    prospect.updatedAt = new Date().toISOString();
    addEvent("outreach", `${prospect.name} outreach plan prepared.`);
    sendJson(response, 200, { ...publicState(), run: prospect.outreach.run });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/prospects/stage") {
    const body = await readJson(request);
    const prospect = findProspect(body.prospectId);
    if (!prospect) {
      sendJson(response, 404, { error: "Prospect not found." });
      return;
    }

    prospect.status = typeof body.status === "string" ? body.status.slice(0, 48) : prospect.status;
    prospect.updatedAt = new Date().toISOString();
    addEvent("prospects", `${prospect.name} moved to ${prospect.status}.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/prospects/interaction") {
    const body = await readJson(request);
    const prospect = findProspect(body.prospectId);
    if (!prospect) {
      sendJson(response, 404, { error: "Prospect not found." });
      return;
    }

    const interaction = normalizeInteraction(prospect.id, body);
    state.interactions.unshift(interaction);
    prospect.status = statusFromInteraction(interaction.type, prospect.status);
    prospect.updatedAt = new Date().toISOString();
    addEvent("interaction", `${interaction.type} logged for ${prospect.name}.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/prospects/call-analysis") {
    const body = await readJson(request);
    const prospect = findProspect(body.prospectId);
    if (!prospect) {
      sendJson(response, 404, { error: "Prospect not found." });
      return;
    }

    const transcript = cleanLongText(body.transcript || "");
    if (transcript.length < 40) {
      sendJson(response, 400, { error: "Paste a longer call transcript or notes so AI can analyze it." });
      return;
    }

    await attachCallAnalysis(prospect, transcript, "manual_paste");
    addEvent("call", `${prospect.name} call analyzed and next steps prepared.`);
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/webhooks/call-transcript") {
    const body = await readJson(request);
    const prospect = matchProspectForTranscript(body);
    if (!prospect) {
      sendJson(response, 404, { error: "No matching prospect found for this transcript." });
      return;
    }

    const transcript = cleanLongText(body.transcript || body.text || body.notes || "");
    if (transcript.length < 40) {
      sendJson(response, 400, { error: "Transcript payload is too short to analyze." });
      return;
    }

    const source = cleanText(body.source || state.integrations.transcripts.provider || "call_webhook");
    await attachCallAnalysis(prospect, transcript, source, cleanText(body.externalCallId || body.callId || ""));
    state.integrations.transcripts.lastIngestedAt = new Date().toISOString();
    state.integrations.transcripts.status = "receiving_calls";
    addEvent("call", `${prospect.name} call transcript ingested from ${source}.`);
    sendJson(response, 200, publicState());
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(appRoot, safePath);
  if (!filePath.startsWith(appRoot) || !existsSync(filePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, { "Content-Type": contentType(filePath) });
  createReadStream(filePath).pipe(response);
}

function publicState() {
  const usageSummary = summarizeUsage();
  const selectedProduct = currentProduct();
  return {
    workspaceId: state.workspaceId,
    environment: state.environment,
    openRouterEnabled: state.openRouterEnabled,
    hasOpenRouterKey: Boolean(state.vault),
    keyMetadata: state.keyMetadata,
    providerHealth: state.providerHealth,
    budgets: state.budgets,
    providerRule: state.providerRule,
    aiModelDefaults: state.aiModelDefaults,
    aiRuntime: {
      mode: state.openRouterEnabled && state.providerHealth.status === "healthy" ? "openrouter" : "mock",
      openRouterEnabled: state.openRouterEnabled,
      syncedOpenRouterModels: state.models.filter((model) => model.provider === "openrouter").length,
      enabledModels: state.models.filter((model) => model.enabled).length
    },
    integrations: {
      apify: redactIntegration(state.integrations.apify),
      crm: redactIntegration(state.integrations.crm),
      transcripts: redactIntegration(state.integrations.transcripts),
      notifications: redactIntegration(state.integrations.notifications),
      supabase: redactIntegration(state.integrations.supabase),
      postgres: redactIntegration(state.integrations.postgres)
    },
    models: state.models,
    tasks: state.tasks,
    agents: state.agents,
    agentRuns: state.agentRuns.slice(0, 30),
    icp: publicIcpState(),
    learning: publicLearningState(),
    products: state.products,
    selectedProductId: state.selectedProductId,
    selectedProduct,
    mcpSync: state.mcpSync,
    prospects: state.prospects.map((prospect) => ({
      ...prospect,
      interactions: interactionsForProspect(prospect.id),
      analysis: analyzeLead(prospect, selectedProduct)
    })),
    interactions: state.interactions,
    followUpTasks: state.followUpTasks,
    aiActions: state.aiActions.slice(0, 25),
    usage: state.usage,
    usageSummary,
    events: state.events.slice(0, 12)
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function contentType(filePath) {
  const ext = extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function encryptSecret(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    encryptedValue: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}

function decryptSecret(record) {
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.encryptedValue, "base64")), decipher.final()]).toString("utf8");
}

function seedModels() {
  const now = new Date().toISOString();
  return [
    sampleModel("mock/economy", "Economy Local", "mock", "economy", 32000, 0.05, 0.1, 420, 71, true, false),
    sampleModel("mock/balanced", "Balanced Local", "mock", "balanced", 64000, 0.4, 0.8, 780, 84, true, false),
    sampleModel("mock/premium", "Premium Reasoner", "mock", "premium", 128000, 4, 12, 1900, 93, true, true),
    {
      ...sampleModel("mock/fast-classifier", "Fast Classifier", "mock", "economy", 16000, 0.03, 0.08, 290, 67, true, false),
      structuredOutput: true
    },
    {
      ...sampleModel("mock/large-context", "Large Context Planner", "mock", "premium", 200000, 3, 9, 2300, 90, true, true),
      toolCalling: true
    }
  ].map((model) => ({ ...model, lastSynchronizedAt: now }));
}

function sampleModel(id, displayName, provider, tier, contextWindow, inputPrice, outputPrice, latencyMs, qualityScore, noTraining, zeroRetention) {
  return {
    id,
    displayName,
    provider,
    tier,
    contextWindow,
    inputPrice,
    outputPrice,
    latencyMs,
    qualityScore,
    reliabilityScore: 98,
    toolCalling: tier !== "economy",
    structuredOutput: true,
    streaming: true,
    promptCaching: tier !== "economy",
    noTraining,
    zeroRetention,
    enabled: id !== "mock/large-context",
    availability: "available",
    source: "mock"
  };
}

function seedTasks() {
  return taskTypes.map((taskType) => {
    const premium = [
      "ICP_ANALYSIS",
      "RELATIONSHIP_PATH_ANALYSIS",
      "INTRODUCTION_PATH_SCORING",
      "SALES_COACHING",
      "CAMPAIGN_ANALYSIS",
      "MCP_CONTEXT_SYNTHESIS"
    ].includes(taskType);
    const economy = [
      "CONTACT_DATA_CLASSIFICATION",
      "LANGUAGE_TRANSLATION",
      "CRM_NOTE_SUMMARY",
      "LINKEDIN_COMMENT",
      "WHATSAPP_DRAFT",
      "TELEGRAM_DRAFT",
      "CALL_OPENER",
      "VOICEMAIL_SCRIPT"
    ].includes(taskType);
    const qualityTier = premium ? "premium" : economy ? "economy" : "balanced";
    return {
      taskType,
      qualityTier,
      primaryModel: premium ? "mock/premium" : economy ? "mock/economy" : "mock/balanced",
      fallbackModels: premium ? ["mock/balanced", "mock/economy"] : economy ? ["mock/balanced"] : ["mock/economy", "mock/premium"],
      maxCostUsd: premium ? 0.25 : economy ? 0.01 : 0.05,
      maxLatencyMs: premium ? 30000 : economy ? 8000 : 15000,
      privacyLevel: ["CONTACT_DATA_CLASSIFICATION", "PERSON_RESEARCH_SUMMARY", "PROSPECT_QUALIFICATION"].includes(taskType)
        ? "no_training"
        : "standard",
      structuredOutput: !["COLD_EMAIL", "EMAIL_FOLLOW_UP", "LINKEDIN_FOLLOW_UP", "WHATSAPP_DRAFT", "TELEGRAM_DRAFT"].includes(taskType),
      toolCalling: ["CLAIM_VERIFICATION", "MCP_CONTEXT_SYNTHESIS"].includes(taskType)
    };
  });
}

function seedOutboundAgents() {
  return [
    {
      id: "define-icp",
      name: "Define ICP",
      purpose: "Analyzes offer, market, best customers, pain points, triggers, exclusions, and buyer personas.",
      model: "analysis",
      tools: ["products", "learning_database", "icp_seed_leads"],
      writes: ["icp_profile"],
      approval: "none"
    },
    {
      id: "research-account",
      name: "Research Account",
      purpose: "Researches target company events, needs, technologies, risks, and outreach angles.",
      model: "analysis",
      tools: ["crm", "mcp_context", "lead_notes"],
      writes: ["account_brief"],
      approval: "none"
    },
    {
      id: "map-buying-committee",
      name: "Map Buying Committee",
      purpose: "Finds decision-makers, influencers, champions, blockers, and warm introduction paths.",
      model: "analysis",
      tools: ["crm", "contacts", "relationship_context"],
      writes: ["buying_committee_map"],
      approval: "none"
    },
    {
      id: "enrich-contact",
      name: "Enrich Contact",
      purpose: "Coordinates Apollo, ZoomInfo, public sources, and Apify to complete and verify contact data.",
      model: "analysis",
      tools: ["apify", "crm", "public_sources"],
      writes: ["contact_discovery"],
      approval: "review_contact_data"
    },
    {
      id: "score-opportunity",
      name: "Score Opportunity",
      purpose: "Prioritizes accounts and contacts by fit, intent, timing, access, and expected deal value.",
      model: "analysis",
      tools: ["icp_profile", "history", "crm"],
      writes: ["opportunity_score"],
      approval: "none"
    },
    {
      id: "personalize-outreach",
      name: "Personalize Outreach",
      purpose: "Creates researched LinkedIn, email, call openers, follow-ups, and multichannel sequences.",
      model: "writing",
      tools: ["openrouter", "learning_database", "product_context", "contact_discovery"],
      writes: ["outreach_plan"],
      approval: "before_send"
    },
    {
      id: "plan-next-action",
      name: "Plan Next Action",
      purpose: "Reads complete account history and tells the salesperson exactly what to do next and why.",
      model: "analysis",
      tools: ["history", "crm", "outreach_plan"],
      writes: ["next_action"],
      approval: "none"
    },
    {
      id: "manage-sales-cycle",
      name: "Manage Sales Cycle",
      purpose: "Coordinates follow-ups, objections, meetings, stakeholders, CRM updates, and opportunity progression.",
      model: "analysis",
      tools: ["crm", "tasks", "call_transcripts"],
      writes: ["tasks", "crm_activity_recommendations"],
      approval: "before_crm_write"
    },
    {
      id: "learn-from-results",
      name: "Learn From Results",
      purpose: "Analyzes replies, meetings, conversions, losses, and successful messaging to improve the whole system.",
      model: "analysis",
      tools: ["learning_database", "crm_outcomes", "history"],
      writes: ["learning_playbook", "icp_profile"],
      approval: "none"
    },
    {
      id: "orchestrate-outbound",
      name: "Orchestrate Outbound",
      purpose: "Central controller that calls the correct skills in the correct order.",
      model: "analysis",
      tools: ["all_agents"],
      writes: ["pipeline_run"],
      approval: "step_dependent"
    }
  ];
}

function seedProducts() {
  const now = new Date().toISOString();
  return [
    {
      id: "outbound-sales-os",
      name: "Outbound Sales OS",
      category: "AI sales execution platform",
      positioning: "Turns prospect research, contact search, outreach drafting, and follow-up coaching into one fast workflow.",
      targetPersonas: ["VP Sales", "Head of Growth", "Revenue Operations", "Founder-led sales"],
      useCases: ["AI outbound preparation", "contact discovery review", "follow-up task creation", "sales coaching"],
      proofPoints: ["reduces manual research time", "prepares product-specific messages", "turns calls into next-step tasks"],
      differentiators: ["two-click lead preparation", "MCP product context sync", "CRM and call transcript context", "human review before send"],
      objections: ["already have a sequencer", "worried about AI quality", "contact data compliance"],
      examples: [
        {
          id: "ex-outbound-1",
          channel: "linkedin",
          persona: "VP Sales",
          label: "concise scaling pain",
          message: "Saw your team is scaling outbound. Curious how you are keeping research quality and sequence review consistent as volume grows.",
          createdAt: now
        }
      ],
      knowledge: [
        {
          id: "know-outbound-1",
          type: "lesson",
          title: "Core workflow",
          url: "",
          text: "Lead intake should move from LinkedIn profile to contact review, tailored messages, CRM activity logging, and follow-up task creation in as few clicks as possible.",
          tags: ["workflow", "positioning"],
          priority: 92,
          screenshot: null,
          createdAt: now
        },
        {
          id: "know-outbound-2",
          type: "platform_note",
          title: "Human review rule",
          url: "",
          text: "The product helps discover contact candidates and messenger check links, but the salesperson must review identity, permission, and source confidence before sending.",
          tags: ["compliance", "contact-data"],
          priority: 88,
          screenshot: null,
          createdAt: now
        }
      ],
      mcpContext: {
        version: "mcp-v3.4",
        freshness: "fresh",
        lastSyncedAt: now,
        sources: [
          { name: "Product positioning brief", type: "MCP doc", confidence: 96 },
          { name: "Sales playbook", type: "MCP knowledge", confidence: 91 },
          { name: "Approved objection handling", type: "MCP policy", confidence: 94 }
        ]
      }
    },
    {
      id: "ai-revops-copilot",
      name: "AI RevOps Copilot",
      category: "Revenue operations assistant",
      positioning: "Helps RevOps teams clean CRM notes, score leads, identify next actions, and keep reps moving.",
      targetPersonas: ["Revenue Operations", "Sales Operations", "CRM Admin", "GTM Analytics"],
      useCases: ["CRM note summarization", "lead scoring", "follow-up hygiene", "forecast hygiene"],
      proofPoints: ["standardizes CRM summaries", "flags low-confidence lead data", "connects scoring to follow-up actions"],
      differentiators: ["clean CRM summaries", "historical activity analysis", "clear next action recommendations"],
      objections: ["CRM already has AI", "data quality is messy", "lead scores are not trusted"],
      examples: [
        {
          id: "ex-revops-1",
          channel: "linkedin",
          persona: "Revenue Operations",
          label: "CRM hygiene angle",
          message: "Noticed your RevOps scope. I’m looking at how teams turn messy CRM notes into reliable next actions without adding admin work.",
          createdAt: now
        }
      ],
      knowledge: [
        {
          id: "know-revops-1",
          type: "lesson",
          title: "RevOps value",
          url: "",
          text: "Prioritize CRM hygiene, activity summaries, next-action clarity, and trusted lead scoring over generic AI productivity claims.",
          tags: ["revops", "positioning"],
          priority: 88,
          screenshot: null,
          createdAt: now
        }
      ],
      mcpContext: {
        version: "mcp-v2.8",
        freshness: "fresh",
        lastSyncedAt: now,
        sources: [
          { name: "RevOps ICP definition", type: "MCP doc", confidence: 93 },
          { name: "CRM workflow map", type: "MCP resource", confidence: 87 },
          { name: "Lead scoring examples", type: "MCP dataset", confidence: 89 }
        ]
      }
    },
    {
      id: "relationship-intelligence",
      name: "Relationship Intelligence Graph",
      category: "Warm intro and account mapping",
      positioning: "Finds relationship paths, scores introduction strength, and recommends account-entry actions.",
      targetPersonas: ["Enterprise AE", "Strategic Accounts", "Partnerships", "Founder"],
      useCases: ["relationship path analysis", "intro scoring", "account planning", "executive outreach"],
      proofPoints: ["ranks warm paths by strength", "separates evidence from guesses", "creates explainable account-entry plans"],
      differentiators: ["source-attributed relationship logic", "explainable account entry", "relationship context for outreach"],
      objections: ["relationship data is incomplete", "executive outreach must be precise", "warm intro asks are sensitive"],
      examples: [
        {
          id: "ex-rel-1",
          channel: "linkedin",
          persona: "Partnerships",
          label: "warm path angle",
          message: "I’m exploring how partnership teams identify credible warm paths into strategic accounts without over-claiming relationship strength.",
          createdAt: now
        }
      ],
      knowledge: [
        {
          id: "know-rel-1",
          type: "lesson",
          title: "Relationship evidence",
          url: "",
          text: "Messages must separate confirmed relationship paths from weak signals and should never over-claim warm introduction strength.",
          tags: ["relationships", "proof"],
          priority: 90,
          screenshot: null,
          createdAt: now
        }
      ],
      mcpContext: {
        version: "mcp-v1.9",
        freshness: "fresh",
        lastSyncedAt: now,
        sources: [
          { name: "Relationship graph schema", type: "MCP schema", confidence: 88 },
          { name: "Executive messaging guide", type: "MCP doc", confidence: 92 },
          { name: "Intro scoring rubric", type: "MCP policy", confidence: 90 }
        ]
      }
    }
  ];
}

function seedProspects() {
  return [
    normalizeProspect({
      id: "seed-maya-chen",
      name: "Maya Chen",
      title: "VP Revenue Operations",
      company: "Northstar Analytics",
      location: "Austin, TX",
      website: "northstaranalytics.example",
      linkedin: "https://www.linkedin.com/search/results/people/?keywords=Maya%20Chen%20Northstar%20Analytics",
      notes: "Scaling outbound motion after Series B. Uses HubSpot and Snowflake."
    }),
    normalizeProspect({
      id: "seed-daniel-brooks",
      name: "Daniel Brooks",
      title: "Head of Sales",
      company: "Clearline Logistics",
      location: "Chicago, IL",
      website: "clearlinelogistics.example",
      notes: "Hiring SDR team, likely interested in sequence governance and lead scoring."
    }),
    normalizeProspect({
      id: "seed-sofia-alvarez",
      name: "Sofia Alvarez",
      title: "Founder",
      company: "Brightpath Clinics",
      location: "Miami, FL",
      website: "brightpathclinics.example",
      notes: "Multi-location healthcare services. Avoid sensitive health assumptions."
    })
  ].map((prospect) => ({
    ...prospect,
    contactDiscovery: buildContactDiscovery(prospect)
  }));
}

function seedInteractions() {
  const now = Date.now();
  return [
    {
      id: "touch-1",
      prospectId: "seed-maya-chen",
      type: "linkedin_viewed",
      channel: "linkedin",
      outcome: "neutral",
      note: "Profile reviewed before connection request.",
      at: new Date(now - 26 * 60 * 60 * 1000).toISOString()
    },
    {
      id: "touch-2",
      prospectId: "seed-daniel-brooks",
      type: "email_sent",
      channel: "email",
      outcome: "opened",
      note: "First email sent from AI draft.",
      at: new Date(now - 54 * 60 * 60 * 1000).toISOString()
    },
    {
      id: "touch-3",
      prospectId: "seed-daniel-brooks",
      type: "linkedin_connected",
      channel: "linkedin",
      outcome: "positive",
      note: "Accepted connection.",
      at: new Date(now - 18 * 60 * 60 * 1000).toISOString()
    }
  ];
}

function seedHistoricalOutcomes() {
  return {
    baselineReachRate: 0.34,
    baselineCloseRate: 0.09,
    byPersona: {
      "Revenue Operations": { reach: 0.46, close: 0.15 },
      "VP Sales": { reach: 0.39, close: 0.13 },
      "Head of Sales": { reach: 0.36, close: 0.11 },
      Founder: { reach: 0.31, close: 0.08 },
      Partnerships: { reach: 0.42, close: 0.12 }
    },
    byInteraction: {
      linkedin_profile_viewed: { reach: 0.03, close: 0.005 },
      linkedin_viewed: { reach: 0.03, close: 0.005 },
      linkedin_post_liked: { reach: 0.04, close: 0.005 },
      linkedin_comment_planned: { reach: 0.05, close: 0.008 },
      linkedin_skill_endorsed: { reach: 0.03, close: 0.004 },
      linkedin_invite_sent: { reach: 0.09, close: 0.015 },
      linkedin_invite_accepted: { reach: 0.2, close: 0.05 },
      email_sent: { reach: 0.05, close: 0.01 },
      email_opened: { reach: 0.12, close: 0.03 },
      linkedin_connected: { reach: 0.18, close: 0.04 },
      linkedin_reply: { reach: 0.32, close: 0.09 },
      sms_sent: { reach: 0.09, close: 0.02 },
      whatsapp_sent: { reach: 0.11, close: 0.025 },
      telegram_sent: { reach: 0.08, close: 0.018 },
      follow_up_scheduled: { reach: 0.02, close: 0.008 },
      meeting_booked: { reach: 0.45, close: 0.24 },
      call_completed: { reach: 0.2, close: 0.07 },
      no_reply: { reach: -0.08, close: -0.03 }
    },
    byProductFit: {
      high: { reach: 0.1, close: 0.08 },
      medium: { reach: 0.04, close: 0.03 },
      developing: { reach: -0.03, close: -0.02 }
    }
  };
}

function normalizeProspect(input) {
  const now = new Date().toISOString();
  const name = cleanText(input.name || input.fullName || input.person || "");
  const company = cleanText(input.company || input.account || input.organization || "");
  const title = cleanText(input.title || input.role || input.jobTitle || "");
  const website = normalizeDomain(input.website || input.domain || input.companyWebsite || "");
  const prospect = {
    id: input.id || `prospect-${randomBytes(6).toString("hex")}`,
    dedupeKey: `${name.toLowerCase()}::${company.toLowerCase()}`,
    name,
    title,
    company,
    location: cleanText(input.location || input.city || ""),
    website,
    linkedin: cleanText(input.linkedin || input.linkedIn || ""),
    email: cleanText(input.email || ""),
    phone: cleanText(input.phone || ""),
    notes: cleanText(input.notes || input.context || ""),
    status: input.status || "new",
    score: Number.isFinite(Number(input.score)) ? Number(input.score) : scoreProspect({ name, company, title, notes: input.notes || "" }),
    owner: cleanText(input.owner || "AI Sales Workspace"),
    createdAt: input.createdAt || now,
    updatedAt: now,
    contactDiscovery: input.contactDiscovery || null,
    outreach: input.outreach || null,
    researchHistory: Array.isArray(input.researchHistory) ? input.researchHistory.slice(0, 12) : [],
    nextActionPlan: input.nextActionPlan || null,
    salesCadence: input.salesCadence || null,
    isIcpSeed: Boolean(input.isIcpSeed),
    agentResults: input.agentResults || {},
    crmSource: input.crmSource || null
  };
  return prospect;
}

function normalizeProduct(input) {
  const now = new Date().toISOString();
  const name = cleanText(input.name || "");
  const id = cleanText(input.id || slugify(name));
  return {
    id,
    name,
    category: cleanText(input.category || "Product"),
    positioning: cleanText(input.positioning || ""),
    targetPersonas: splitList(input.targetPersonas),
    useCases: splitList(input.useCases),
    proofPoints: splitList(input.proofPoints),
    differentiators: splitList(input.differentiators),
    objections: splitList(input.objections),
    examples: Array.isArray(input.examples) ? input.examples.map(normalizeOutreachExample) : [],
    knowledge: Array.isArray(input.knowledge) ? input.knowledge.map(normalizeProductKnowledge).filter(Boolean) : [],
    mcpContext: {
      version: cleanText(input.mcpVersion || "manual-v1"),
      freshness: "manual",
      lastSyncedAt: now,
      sources: [
        {
          name: "Manual product definition",
          type: "workspace input",
          confidence: 86
        }
      ]
    }
  };
}

function normalizeProductKnowledge(input) {
  if (!input || typeof input !== "object") return null;
  const screenshot = normalizeLearningScreenshot(input.screenshot);
  const url = normalizeProfileUrl(input.url || input.sourceUrl || "");
  const text = cleanLongText(input.text || input.lesson || input.notes || "");
  const title = cleanText(input.title || input.name || titleFromKnowledge(url, text, screenshot));
  return {
    id: input.id || `knowledge-${randomBytes(6).toString("hex")}`,
    type: normalizeKnowledgeType(input.type || (screenshot ? "screenshot" : url ? "link" : "lesson")),
    title,
    url,
    text: text.slice(0, 8000),
    tags: splitList(input.tags).slice(0, 12),
    priority: clampNumber(input.priority, 1, 100, screenshot ? 75 : 70),
    screenshot,
    createdAt: input.createdAt || new Date().toISOString()
  };
}

function normalizeKnowledgeType(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[\s-]+/g, "_");
  return ["link", "lesson", "platform_note", "screenshot", "faq", "case_study", "objection", "competitor"].includes(normalized)
    ? normalized
    : "lesson";
}

function titleFromKnowledge(url, text, screenshot) {
  if (url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./, "");
    } catch {
      return "Product link";
    }
  }
  if (screenshot) return screenshot.name || "Product screenshot";
  return text.split(/[.\n]/)[0]?.slice(0, 90) || "Product knowledge";
}

function normalizeOutreachExample(input) {
  return {
    id: input.id || `example-${randomBytes(6).toString("hex")}`,
    channel: cleanText(input.channel || "linkedin").toLowerCase(),
    persona: cleanText(input.persona || ""),
    label: cleanText(input.label || ""),
    message: cleanText(input.message || ""),
    outcome: cleanText(input.outcome || ""),
    createdAt: input.createdAt || new Date().toISOString()
  };
}

function normalizeLearningExample(input, product) {
  const screenshot = normalizeLearningScreenshot(input.screenshot);
  const messageText = cleanLongText(input.messageText || input.text || input.message || "");
  const profileUrl = normalizeProfileUrl(input.profileUrl || input.targetUrl || "");
  const sourceUrl = normalizeProfileUrl(input.sourceUrl || "");
  const channel = cleanText(input.channel || "linkedin").toLowerCase();
  const outcome = cleanText(input.outcome || "successful_reply");
  return {
    id: input.id || `learning-${randomBytes(6).toString("hex")}`,
    productId: product.id,
    productName: product.name,
    channel,
    assetType: screenshot && messageText ? "screenshot_text" : screenshot ? "screenshot" : sourceUrl || profileUrl ? "url" : "text",
    persona: cleanText(input.persona || ""),
    profileUrl,
    sourceUrl,
    messageText,
    notes: cleanLongText(input.notes || ""),
    outcome,
    outcomeScore: clampNumber(input.outcomeScore, 0, 100, outcomeScoreFromText(outcome)),
    tags: splitList(input.tags).slice(0, 12),
    screenshot,
    signals: null,
    createdAt: input.createdAt || new Date().toISOString(),
    learnedAt: null
  };
}

function normalizeLearningScreenshot(input) {
  if (!input || typeof input !== "object") return null;
  const dataUrl = String(input.dataUrl || "");
  if (!dataUrl.startsWith("data:image/") || dataUrl.length > 2_500_000) return null;
  return {
    name: cleanText(input.name || "outreach-screenshot"),
    type: cleanText(input.type || "image"),
    size: clampNumber(input.size, 0, 2_000_000, 0),
    dataUrl
  };
}

function normalizeProfileUrl(value) {
  const text = cleanText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.href.slice(0, 800);
  } catch {
    return text.slice(0, 800);
  }
}

function outcomeScoreFromText(value) {
  const text = String(value || "").toLowerCase();
  if (/won|closed|paid|contract|deal/.test(text)) return 100;
  if (/booked|meeting|demo|call scheduled|calendar/.test(text)) return 88;
  if (/reply|responded|interested|positive/.test(text)) return 76;
  if (/opened|clicked|accepted|connected/.test(text)) return 58;
  if (/no reply|ignored|bounced|unsubscribe|bad/.test(text)) return 20;
  return 70;
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value.map(cleanText).filter(Boolean);
  }
  return String(value || "")
    .split(/\n|,/)
    .map(cleanText)
    .filter(Boolean);
}

function slugify(value) {
  return String(value || "product")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || `product-${randomBytes(3).toString("hex")}`;
}

function currentProduct() {
  return state.products.find((product) => product.id === state.selectedProductId) ?? state.products[0];
}

function interactionsForProspect(prospectId) {
  return state.interactions
    .filter((interaction) => interaction.prospectId === prospectId)
    .sort((left, right) => new Date(right.at) - new Date(left.at));
}

function analyzeLead(prospect, product = currentProduct()) {
  const interactions = interactionsForProspect(prospect.id);
  const persona = bestPersonaMatch(prospect, product);
  const personaRates = state.historicalOutcomes.byPersona[persona] ?? {
    reach: state.historicalOutcomes.baselineReachRate,
    close: state.historicalOutcomes.baselineCloseRate
  };
  const productFit = productFitForProspect(prospect, product);
  const fitRates = state.historicalOutcomes.byProductFit[productFit.label];
  const touchLift = interactions.reduce((acc, interaction) => {
    const lift = state.historicalOutcomes.byInteraction[interaction.type] ?? state.historicalOutcomes.byInteraction[interaction.outcome] ?? { reach: 0, close: 0 };
    acc.reach += lift.reach;
    acc.close += lift.close;
    return acc;
  }, { reach: 0, close: 0 });

  const stalenessPenalty = latestInteractionDays(interactions) > 7 ? -0.06 : 0;
  const reachProbability = clampProbability(personaRates.reach + fitRates.reach + touchLift.reach + stalenessPenalty);
  const closeProbability = clampProbability(personaRates.close + fitRates.close + touchLift.close + (prospect.score - 70) / 500);
  const recommendedAction = recommendedActionFor(prospect, interactions, reachProbability, closeProbability);

  return {
    reachProbability: Math.round(reachProbability * 100),
    closeProbability: Math.round(closeProbability * 100),
    productFit: productFit.label,
    persona,
    recommendedAction,
    reasoning: [
      `${persona} historically reaches at ${Math.round(personaRates.reach * 100)}%.`,
      `${product.name} fit is ${productFit.label} because ${productFit.reason}.`,
      interactions.length ? `${interactions.length} prior interaction${interactions.length === 1 ? "" : "s"} changes the forecast.` : "No prior touches logged yet."
    ]
  };
}

function buildContactDiscovery(prospect) {
  const domain = normalizeDomain(prospect.website);
  const nameParts = prospect.name.toLowerCase().replace(/[^a-z\s-]/g, "").split(/\s+/).filter(Boolean);
  const first = nameParts[0] || "";
  const last = nameParts.at(-1) || "";
  const companyQuery = [prospect.name, prospect.company].filter(Boolean).join(" ");
  const candidates = [];

  if (prospect.email) {
    candidates.push({
      type: "email",
      value: prospect.email,
      confidence: 96,
      source: "uploaded profile",
      status: "verified_by_import"
    });
  }

  if (domain && first && last) {
    candidates.push(
      {
        type: "email",
        value: `${first}.${last}@${domain}`,
        confidence: 61,
        source: "business domain pattern",
        status: "needs_verification"
      },
      {
        type: "email",
        value: `${first[0]}${last}@${domain}`,
        confidence: 48,
        source: "business domain pattern",
        status: "needs_verification"
      }
    );
  }

  if (prospect.linkedin) {
    candidates.push({
      type: "linkedin",
      value: prospect.linkedin,
      confidence: 88,
      source: "uploaded profile",
      status: "review"
    });
  } else {
    candidates.push({
      type: "linkedin",
      value: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(companyQuery)}`,
      confidence: 58,
      source: "public search link",
      status: "review"
    });
  }

  candidates.push(
    {
      type: "facebook",
      value: `https://www.facebook.com/search/people/?q=${encodeURIComponent(companyQuery)}`,
      confidence: 42,
      source: "public Facebook people search",
      status: "review"
    },
    {
      type: "web",
      value: `https://www.google.com/search?q=${encodeURIComponent(`"${prospect.name}" "${prospect.company}" contact`)}`,
      confidence: 52,
      source: "public web search",
      status: "review"
    }
  );

  if (prospect.phone) {
    candidates.push({
      type: "phone",
      value: prospect.phone,
      confidence: 90,
      source: "uploaded profile",
      status: "verified_by_import"
    });
  }

  return {
    searchedAt: new Date().toISOString(),
    policy: "public_business_contact_data_only",
    candidates: mergeContactCandidates(addMessengerLinkCandidates(candidates)),
    warnings: [
      "Review social profiles before use.",
      "Do not infer private contact data from personal social activity.",
      "Facebook and messenger presence signals require manual match review.",
      "Phone, WhatsApp, and Telegram outreach require source and permission checks.",
      "Use suppression and permission checks before sending."
    ]
  };
}

async function enrichProspectContacts(prospect) {
  const discovery = buildContactDiscovery(prospect);
  const apifyConfigured = state.apifyVault && state.integrations.apify.configured;
  if (!apifyConfigured) {
    discovery.candidates = mergeContactCandidates(addMessengerLinkCandidates(discovery.candidates));
    discovery.scraperStatus = "mock_public_search";
    discovery.scraperNote = "Configure Apify token and actor IDs to run Apollo, ZoomInfo, LinkedIn, or contact-finder scrapers.";
    return discovery;
  }

  const actorInputs = [
    ["leadDatabase", state.integrations.apify.actorIds.leadDatabase, leadDatabaseScraperInput(prospect)],
    ["linkedinProfile", state.integrations.apify.actorIds.linkedinProfile, { linkedinUrl: prospect.linkedin, name: prospect.name, company: prospect.company }],
    ["contactFinder", state.integrations.apify.actorIds.contactFinder, { name: prospect.name, company: prospect.company, domain: prospect.website }],
    ["apollo", state.integrations.apify.actorIds.apollo, { name: prospect.name, company: prospect.company, linkedinUrl: prospect.linkedin }],
    ["zoominfo", state.integrations.apify.actorIds.zoominfo, { name: prospect.name, company: prospect.company, linkedinUrl: prospect.linkedin }],
    ["facebookProfile", state.integrations.apify.actorIds.facebookProfile, { name: prospect.name, company: prospect.company, location: prospect.location, linkedinUrl: prospect.linkedin }],
    ["emailPhoneFinder", state.integrations.apify.actorIds.emailPhoneFinder, { name: prospect.name, company: prospect.company, domain: prospect.website, linkedinUrl: prospect.linkedin }],
    ["phoneMessengerCheck", state.integrations.apify.actorIds.phoneMessengerCheck, { name: prospect.name, company: prospect.company, phones: knownPhoneCandidates(prospect), linkedinUrl: prospect.linkedin }]
  ].filter(([, actorId]) => actorId);

  if (!actorInputs.length) {
    discovery.candidates = mergeContactCandidates(addMessengerLinkCandidates(discovery.candidates));
    discovery.scraperStatus = "configured_without_actors";
    discovery.scraperNote = "Apify token is configured, but no actor IDs were provided.";
    return discovery;
  }

  const apifyCandidates = [];
  let actorsRun = 0;
  let skippedForTemplate = false;
  for (const [source, actorId, input] of actorInputs) {
    try {
      const renderedInput = apifyInputFor(source, prospect, input);
      const items = await runApifyActor(actorId, renderedInput, state.integrations.apify.maxChargeUsd);
      actorsRun += 1;
      apifyCandidates.push(...items.flatMap((item) => candidatesFromScraperItem(item, source)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("input template")) skippedForTemplate = true;
      discovery.warnings.push(`${source} scraper failed: ${message}`);
    }
  }

  discovery.candidates = mergeContactCandidates(addMessengerLinkCandidates([...apifyCandidates, ...discovery.candidates]));
  discovery.scraperStatus = apifyCandidates.length ? "apify_enriched" : skippedForTemplate ? "configured_needs_template" : "apify_no_results";
  discovery.scraperNote = actorsRun
    ? `${apifyCandidates.length} candidates returned from ${actorsRun} Apify actor${actorsRun === 1 ? "" : "s"}.`
    : skippedForTemplate
      ? "Apify is connected. Add the lead database input template before running the paid scraper."
      : "No Apify actors ran.";
  state.integrations.apify.lastRunAt = new Date().toISOString();
  state.integrations.apify.status = discovery.scraperStatus;
  return discovery;
}

function leadDatabaseScraperInput(prospect) {
  return {
    name: prospect.name,
    fullName: prospect.name,
    company: prospect.company,
    organization: prospect.company,
    title: prospect.title,
    location: prospect.location,
    domain: normalizeDomain(prospect.website),
    website: prospect.website,
    linkedinUrl: prospect.linkedin,
    profileUrl: prospect.linkedin,
    limit: 1,
    maxResults: 1
  };
}

function apifyInputFor(source, prospect, fallbackInput) {
  const template = state.integrations.apify.actorInputTemplates?.[source] || "";
  if (!template) {
    if (source === "leadDatabase") {
      throw new Error("Lead database actor is configured, but its JSON input template is missing.");
    }
    return fallbackInput;
  }
  return renderApifyInputTemplate(template, prospect, fallbackInput);
}

function renderApifyInputTemplate(template, prospect, fallbackInput) {
  let parsed;
  try {
    parsed = JSON.parse(template);
  } catch {
    throw new Error("Apify input template must be valid JSON.");
  }
  const variables = {
    ...fallbackInput,
    firstName: firstNameFor(prospect.name),
    lastName: lastNameFor(prospect.name),
    domain: normalizeDomain(prospect.website),
    phones: knownPhoneCandidates(prospect)
  };
  return replaceTemplateValues(parsed, variables);
}

function replaceTemplateValues(value, variables) {
  if (Array.isArray(value)) return value.map((item) => replaceTemplateValues(item, variables));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceTemplateValues(child, variables)]));
  }
  if (typeof value !== "string") return value;

  const exactToken = value.match(/^{{\s*([a-zA-Z0-9_]+)\s*}}$/);
  if (exactToken) {
    return variables[exactToken[1]] ?? "";
  }
  return value.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => String(variables[key] ?? ""));
}

async function runApifyActor(actorId, input, maxChargeUsd) {
  const token = decryptSecret(state.apifyVault);
  const safeActorId = actorId.split("/").map(encodeURIComponent).join("/").replaceAll("%7E", "~");
  const url = `https://api.apify.com/v2/acts/${safeActorId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&maxTotalChargeUsd=${encodeURIComponent(maxChargeUsd)}&clean=true`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(`Apify actor ${actorId} returned HTTP ${response.status}.`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function candidatesFromScraperItem(item, source) {
  const candidates = [];
  const fields = {
    email: extractContactValues(item, ["email", "emails", "workEmail", "businessEmail", "emailAddress", "primaryEmail"]),
    phone: extractContactValues(item, ["phone", "phones", "phoneNumbers", "mobilePhone", "directPhone", "phoneNumber", "mobile", "primaryPhone"]),
    linkedin: extractContactValues(item, ["linkedin", "linkedinUrl", "linkedinProfile", "profileUrl"]),
    facebook: extractContactValues(item, ["facebook", "facebookUrl", "facebookProfile", "fbUrl"]),
    website: extractContactValues(item, ["website", "companyWebsite", "domain"]),
    whatsapp: extractContactValues(item, ["whatsapp", "whatsappUrl", "whatsappAccount"]),
    telegram: extractContactValues(item, ["telegram", "telegramUrl", "telegramUsername", "telegramAccount"])
  };
  for (const [type, values] of Object.entries(fields)) {
    for (const value of values) {
      if (!value) continue;
      candidates.push({
        type,
        value: String(value),
        confidence: Number(item.confidence || item.score || 74),
        source: `apify:${source}`,
        status: candidateStatusFor(type, item, source),
        evidence: evidenceFromScraperItem(item, source)
      });
    }
  }
  candidates.push(...phoneAppSignalsFromScraperItem(item, source));
  candidates.push(...facebookMatchSignalsFromScraperItem(item, source));
  return candidates;
}

function extractContactValues(item, keys) {
  const values = [];
  for (const key of keys) {
    collectContactValues(item?.[key], values);
  }
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function collectContactValues(value, values) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectContactValues(item, values));
    return;
  }
  if (typeof value === "object") {
    for (const key of ["value", "email", "address", "url", "link", "profileUrl", "phone", "number", "username", "handle"]) {
      collectContactValues(value[key], values);
    }
    return;
  }
  values.push(value);
}

function knownPhoneCandidates(prospect) {
  const phones = [];
  if (prospect.phone) phones.push(prospect.phone);
  for (const candidate of prospect.contactDiscovery?.candidates || []) {
    if (candidate.type === "phone") phones.push(candidate.value);
  }
  return [...new Set(phones.map((phone) => String(phone).trim()).filter(Boolean))];
}

function candidateStatusFor(type, item, source) {
  if (type === "email" && (item.emailStatus === "verified" || item.verifiedEmail)) return "needs_permission_review";
  if (type === "phone" && (item.phoneStatus === "verified" || item.verifiedPhone)) return "needs_permission_review";
  if (type === "facebook") return source === "facebookProfile" ? "suggested_profile_review" : "review";
  if (type === "whatsapp" || type === "telegram" || type === "whatsapp_link" || type === "telegram_link") return "messenger_presence_review";
  return "review";
}

function evidenceFromScraperItem(item, source) {
  const evidence = [];
  if (item.locationMatch || item.sameGeo || item.geoMatch) evidence.push("geo_match");
  if (item.companyMatch || item.sameCompany) evidence.push("company_match");
  if (item.nameMatch || item.profileNameMatch) evidence.push("name_match");
  if (item.mutualConnections) evidence.push("mutual_connections");
  if (item.sourceUrl) evidence.push(String(item.sourceUrl).slice(0, 180));
  if (!evidence.length && source === "facebookProfile") evidence.push("requires_manual_profile_review");
  return evidence;
}

function phoneAppSignalsFromScraperItem(item, source) {
  const candidates = [];
  const phone = extractContactValues(item, ["phone", "phones", "phoneNumbers", "mobilePhone", "directPhone", "phoneNumber", "mobile"])[0];
  const signals = [
    ["whatsapp_presence", item.whatsappExists ?? item.hasWhatsapp ?? item.isWhatsapp],
    ["telegram_presence", item.telegramExists ?? item.hasTelegram ?? item.isTelegram]
  ];
  for (const [type, value] of signals) {
    if (value === undefined || value === null || value === "") continue;
    candidates.push({
      type,
      value: `${phone || "phone"}:${Boolean(value) ? "possible" : "not_found"}`,
      confidence: Number(item.confidence || item.score || (Boolean(value) ? 68 : 45)),
      source: `apify:${source}`,
      status: "messenger_presence_review",
      evidence: evidenceFromScraperItem(item, source)
    });
  }
  return candidates;
}

function addMessengerLinkCandidates(candidates) {
  const additions = [];
  for (const candidate of candidates) {
    if (candidate.type !== "phone") continue;
    const links = messengerLinksForPhone(candidate.value);
    if (!links) continue;
    additions.push(
      {
        type: "whatsapp_link",
        value: links.whatsapp,
        confidence: Math.min(Number(candidate.confidence || 58), 70),
        source: `${candidate.source || "phone candidate"} deep link`,
        status: "messenger_presence_review",
        evidence: ["derived_from_phone_candidate", "requires_manual_presence_check"]
      },
      {
        type: "telegram_link",
        value: links.telegram,
        confidence: Math.min(Number(candidate.confidence || 58), 66),
        source: `${candidate.source || "phone candidate"} deep link`,
        status: "messenger_presence_review",
        evidence: ["derived_from_phone_candidate", "requires_manual_presence_check"]
      }
    );
  }
  return [...candidates, ...additions];
}

function messengerLinksForPhone(phone) {
  const digits = normalizedPhoneDigits(phone);
  if (!digits) return null;
  return {
    whatsapp: `https://wa.me/${digits}`,
    telegram: `https://t.me/+${digits}`
  };
}

function normalizedPhoneDigits(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  return digits.length >= 7 && digits.length <= 16 ? digits : "";
}

function facebookMatchSignalsFromScraperItem(item, source) {
  if (source !== "facebookProfile") return [];
  const url = extractContactValues(item, ["facebook", "facebookUrl", "facebookProfile", "fbUrl", "profileUrl"])[0];
  if (!url) return [];
  const confidence = Number(item.confidence || item.score || 64);
  return [{
    type: "facebook_match",
    value: String(url),
    confidence,
    source: `apify:${source}`,
    status: confidence >= 80 ? "suggested_profile_review" : "low_confidence_review",
    evidence: evidenceFromScraperItem(item, source)
  }];
}

function mergeContactCandidates(candidates) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.type}:${String(candidate.value).toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || candidate.confidence > existing.confidence) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()].sort((left, right) => right.confidence - left.confidence);
}

function redactIntegration(integration) {
  return JSON.parse(JSON.stringify(integration));
}

function publicIcpState() {
  return {
    ...state.icp,
    seedLeadCount: state.icp.seedLeadIds.length,
    seedLeads: state.prospects
      .filter((prospect) => state.icp.seedLeadIds.includes(prospect.id))
      .slice(0, 40)
      .map((prospect) => ({
        id: prospect.id,
        name: prospect.name,
        title: prospect.title,
        company: prospect.company,
        location: prospect.location,
        website: prospect.website,
        linkedin: prospect.linkedin,
        notes: prospect.notes
      }))
  };
}

async function runOutboundAgent(agentId, options) {
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) {
    return agentRunRecord({ agentId, status: "blocked", summary: "Agent not found.", results: [], warnings: ["Choose a supported outbound agent."] });
  }
  if (agentId === "orchestrate-outbound") return runOutboundPipeline(options);

  const prospects = selectProspectsForAction(options.scope, options.selectedProspectId, options.limit);
  const results = [];
  const warnings = [];

  try {
    if (agentId === "define-icp") {
      const profile = rebuildIcpProfile();
      results.push({ type: agentId, message: profile.summary, data: profile });
    } else if (agentId === "learn-from-results") {
      await rebuildLearningPlaybook({ forceAi: true });
      rebuildIcpProfile();
      results.push({ type: agentId, message: "Learning playbook and ICP profile rebuilt.", data: { learning: state.learning.playbook, icp: state.icp.profile } });
    } else {
      if (!prospects.length) warnings.push("No leads matched this agent scope.");
      for (const prospect of prospects) {
        const result = await executeProspectAgent(agentId, prospect);
        prospect.agentResults ??= {};
        prospect.agentResults[agentId] = result;
        prospect.updatedAt = new Date().toISOString();
        results.push({ type: agentId, message: `${prospect.name}: ${result.summary}`, prospectId: prospect.id, data: result });
      }
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  const run = agentRunRecord({
    agentId,
    agentName: agent.name,
    status: warnings.length && !results.length ? "blocked" : "completed",
    summary: `${agent.name} completed ${results.length} result${results.length === 1 ? "" : "s"}.`,
    results,
    warnings
  });
  addEvent("agent", `${agent.name} ran with ${results.length} result${results.length === 1 ? "" : "s"}.`);
  return run;
}

async function executeProspectAgent(agentId, prospect) {
  if (agentId === "research-account") return researchAccountForProspect(prospect);
  if (agentId === "map-buying-committee") return mapBuyingCommitteeForProspect(prospect);
  if (agentId === "enrich-contact") {
    prospect.contactDiscovery = await enrichProspectContacts(prospect);
    recordLeadResearch(prospect, {
      stage: "contact_enriched",
      summary: `${prospect.contactDiscovery.candidates.length} contact candidates reviewed by Enrich Contact agent.`,
      contactDiscovery: prospect.contactDiscovery,
      warnings: prospect.contactDiscovery.warnings
    });
    prospect.status = "enriched";
    return {
      summary: `${prospect.contactDiscovery.candidates.length} contact candidates found.`,
      contactDiscovery: prospect.contactDiscovery
    };
  }
  if (agentId === "score-opportunity") {
    const analysis = analyzeLead(prospect);
    const icpFit = scoreIcpFit(prospect);
    return {
      summary: `${analysis.closeProbability}% close chance, ${icpFit.score}% ICP fit.`,
      analysis,
      icpFit
    };
  }
  if (agentId === "personalize-outreach") {
    if (!prospect.contactDiscovery) prospect.contactDiscovery = await enrichProspectContacts(prospect);
    prospect.outreach = await prepareAndLogOutreach(prospect, "balanced", "SEQUENCE_GENERATION", {
      source: "agent:personalize-outreach"
    });
    prospect.status = "outreach_ready";
    return {
      summary: `${prospect.outreach.messages.length} messages and ${prospect.outreach.linkedinVariations.length} LinkedIn variations prepared.`,
      outreach: prospect.outreach
    };
  }
  if (agentId === "plan-next-action") {
    const analysis = analyzeLead(prospect);
    const nextActionPlan = buildNextActionPlan(prospect, prospect.outreach || {}, currentProduct());
    prospect.nextActionPlan = nextActionPlan;
    return {
      summary: nextActionPlan.primaryAction || analysis.recommendedAction,
      nextAction: {
        label: nextActionPlan.primaryAction || analysis.recommendedAction,
        reason: nextActionPlan.reason || analysis.reasoning.join(" "),
        priority: analysis.closeProbability > 25 ? "high" : "medium",
        due: nextActionPlan.followUp?.due || "today",
        channelOrder: nextActionPlan.channelOrder
      }
    };
  }
  if (agentId === "manage-sales-cycle") {
    const analysis = analyzeLead(prospect);
    const task = {
      id: `task-${randomBytes(6).toString("hex")}`,
      prospectId: prospect.id,
      prospectName: prospect.name,
      productId: state.selectedProductId,
      type: "next_action",
      label: analysis.recommendedAction,
      due: dueTomorrowIso(),
      status: "open",
      source: "manage-sales-cycle",
      createdAt: new Date().toISOString()
    };
    state.followUpTasks.unshift(task);
    return {
      summary: `Task created: ${task.label}`,
      task,
      crmWrite: state.integrations.crm.configured ? "ready_for_push" : "crm_not_configured"
    };
  }
  return {
    summary: "Agent has no execution handler yet.",
    status: "not_implemented"
  };
}

async function runOutboundPipeline(options) {
  const steps = ["define-icp", "research-account", "map-buying-committee", "enrich-contact", "score-opportunity", "personalize-outreach", "plan-next-action"];
  const results = [];
  const warnings = [];
  for (const step of steps) {
    const run = await runOutboundAgent(step, options);
    results.push({ type: step, message: run.summary, data: run.results });
    warnings.push(...(run.warnings || []));
  }
  const run = agentRunRecord({
    agentId: "orchestrate-outbound",
    agentName: "Orchestrate Outbound",
    status: warnings.length ? "completed_with_warnings" : "completed",
    summary: `Outbound pipeline ran ${steps.length} agents.`,
    results,
    warnings
  });
  addEvent("agent", "Outbound pipeline completed.");
  return run;
}

function agentRunRecord({ agentId, agentName, status, summary, results, warnings }) {
  return {
    id: `agent-run-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
    agentId,
    agentName: agentName || titleCaseServer(agentId),
    status,
    summary,
    modelUsed: state.openRouterEnabled && state.providerHealth.status === "healthy" ? state.aiModelDefaults.analysisModel : "local-agent",
    results: results || [],
    warnings: warnings || []
  };
}

function agentRunToAiAction(run) {
  return {
    id: run.id,
    at: run.at,
    instruction: run.agentName,
    summary: run.summary,
    status: run.status,
    modelUsed: run.modelUsed,
    results: run.results,
    warnings: run.warnings
  };
}

function researchAccountForProspect(prospect) {
  const product = currentProduct();
  const notes = `${prospect.notes} ${prospect.title} ${prospect.company}`.toLowerCase();
  const triggers = [];
  if (/hiring|sdr|sales|outbound/.test(notes)) triggers.push("sales team growth");
  if (/series|funding|growth|scaling/.test(notes)) triggers.push("growth or funding motion");
  if (/hubspot|salesforce|crm|snowflake|apollo|zoominfo/.test(notes)) triggers.push("sales stack signal");
  if (!triggers.length) triggers.push("role and product-fit signal");
  const angles = product.useCases.slice(0, 3).map((useCase) => `${useCase} for ${prospect.company}`);
  return {
    summary: `${prospect.company} has ${triggers.join(", ")} signals.`,
    triggers,
    risks: ["Validate source recency before using claims.", "Avoid unsupported company-specific claims."],
    technologies: extractTechnologies(prospect.notes),
    outreachAngles: angles
  };
}

function mapBuyingCommitteeForProspect(prospect) {
  const sameCompany = state.prospects.filter((item) => item.company.toLowerCase() === prospect.company.toLowerCase());
  const committee = sameCompany.map((item) => ({
    name: item.name,
    title: item.title,
    role: buyingCommitteeRole(item.title),
    linkedin: item.linkedin
  }));
  if (!committee.some((item) => item.name === prospect.name)) {
    committee.unshift({ name: prospect.name, title: prospect.title, role: buyingCommitteeRole(prospect.title), linkedin: prospect.linkedin });
  }
  return {
    summary: `${committee.length} stakeholder${committee.length === 1 ? "" : "s"} mapped for ${prospect.company}.`,
    committee,
    warmPaths: prospect.linkedin ? ["LinkedIn profile review", "Mutual connections check"] : ["Find LinkedIn profile first"],
    blockers: ["No confirmed champion yet", "Contact data requires review"]
  };
}

function buyingCommitteeRole(title) {
  const text = String(title || "").toLowerCase();
  if (/founder|ceo|owner|president/.test(text)) return "economic_buyer";
  if (/vp|head|chief|revenue|sales|growth/.test(text)) return "decision_maker";
  if (/ops|operations|revops|crm/.test(text)) return "champion";
  if (/finance|legal|procurement|security/.test(text)) return "blocker_or_approver";
  return "influencer";
}

function extractTechnologies(text) {
  const known = ["Salesforce", "HubSpot", "Snowflake", "Apollo", "ZoomInfo", "Outreach", "Salesloft", "LinkedIn"];
  const lower = String(text || "").toLowerCase();
  return known.filter((item) => lower.includes(item.toLowerCase()));
}

function publicLearningState() {
  const examples = state.learning.examples.slice(0, 80).map((example) => ({
    ...example,
    screenshot: example.screenshot
      ? {
          ...example.screenshot,
          dataUrl: example.screenshot.dataUrl
        }
      : null
  }));
  return {
    ...state.learning,
    examples,
    stats: learningStats()
  };
}

function learningStats(productId = state.selectedProductId) {
  const examples = state.learning.examples;
  const productExamples = examples.filter((example) => example.productId === productId);
  const winningExamples = examples.filter((example) => example.outcomeScore >= 65);
  const productWins = productExamples.filter((example) => example.outcomeScore >= 65);
  const channels = countBy(winningExamples.map((example) => example.channel));
  return {
    totalExamples: examples.length,
    winningExamples: winningExamples.length,
    selectedProductExamples: productExamples.length,
    selectedProductWins: productWins.length,
    screenshotExamples: examples.filter((example) => example.screenshot).length,
    textExamples: examples.filter((example) => example.messageText).length,
    topChannel: Object.entries(channels).sort((left, right) => right[1] - left[1])[0]?.[0] || "none",
    lastTrainedAt: state.learning.lastTrainedAt,
    modelVersion: state.learning.modelVersion
  };
}

async function analyzeLearningExample(example, product) {
  const fallback = localLearningSignals(example);
  const canUseLiveAi = Boolean(state.vault && state.providerHealth.status === "healthy");
  if (!canUseLiveAi) return fallback;

  try {
    const content = [
      {
        type: "text",
        text: JSON.stringify({
          instruction: "Analyze this successful or failed outbound example. Extract reusable sales-writing patterns. If an image is included, read visible message text when possible. Return strict JSON.",
          requiredJsonShape: {
            whyWorked: "short explanation",
            patterns: ["specific reusable pattern"],
            hooks: ["opening hook"],
            ctas: ["call to action"],
            tone: ["tone descriptor"],
            avoid: ["thing to avoid"],
            reusableRule: "one rule future outreach should follow",
            confidence: 0
          },
          product: productForPrompt(product),
          example: learningExampleForPrompt(example)
        })
      }
    ];
    if (example.screenshot?.dataUrl) {
      content.push({ type: "image_url", image_url: { url: example.screenshot.dataUrl } });
    }

    const { data, run } = await callOpenRouterJson({
      model: state.aiModelDefaults.analysisModel,
      taskType: "MESSAGE_QUALITY_REVIEW",
      profile: "balanced",
      maxTokens: 1100,
      messages: [
        {
          role: "system",
          content: "You are an outbound sales learning engine. Return only strict JSON. Convert screenshots into concise writing signals when visible. Do not invent performance facts."
        },
        {
          role: "user",
          content
        }
      ]
    });
    return normalizeLearningSignals(data, fallback, run.modelUsed);
  } catch (error) {
    addEvent("learning", `Learning analysis used local fallback: ${error instanceof Error ? error.message : "AI analysis failed"}`);
    return fallback;
  }
}

function localLearningSignals(example) {
  const text = `${example.messageText} ${example.notes} ${example.tags.join(" ")}`.toLowerCase();
  const patterns = [];
  const hooks = [];
  const ctas = [];
  const tone = [];
  const avoid = [];

  if (/\bquick\b|\bshort\b|brief/.test(text)) tone.push("concise");
  if (/noticed|saw|congrats|your work|profile/.test(text)) hooks.push("personal observation");
  if (/pain|manual|time|pipeline|reply|book|meeting|follow-up/.test(text)) patterns.push("connect to active sales pain");
  if (/worth|open to|quick call|chat|connect|next week|calendar/.test(text)) ctas.push("low-friction next step");
  if (/case study|proof|reduced|saved|increased|example/.test(text)) patterns.push("specific proof before CTA");
  if (/long|too much|generic|spam|ignored|no reply/.test(text)) avoid.push("generic or heavy pitch");

  return {
    whyWorked: example.outcomeScore >= 65
      ? "Positive outcome example. Reuse the strongest hook, relevance, and CTA patterns."
      : "Lower-performing example. Keep it as a caution signal, not a winning template.",
    patterns: patterns.length ? [...new Set(patterns)] : ["clear product relevance"],
    hooks: hooks.length ? [...new Set(hooks)] : ["role and company relevance"],
    ctas: ctas.length ? [...new Set(ctas)] : ["simple next-step ask"],
    tone: tone.length ? [...new Set(tone)] : ["direct"],
    avoid: avoid.length ? [...new Set(avoid)] : ["unsupported claims"],
    reusableRule: example.outcomeScore >= 65
      ? "Start with a real signal, connect it to one product use case, then ask for one small next step."
      : "Do not over-index on this example until more positive outcomes support it.",
    confidence: Math.min(94, Math.max(45, example.outcomeScore)),
    modelUsed: "local-learning"
  };
}

function normalizeLearningSignals(data, fallback, modelUsed) {
  return {
    whyWorked: cleanText(data?.whyWorked || fallback.whyWorked),
    patterns: normalizeSignalList(data?.patterns, fallback.patterns),
    hooks: normalizeSignalList(data?.hooks, fallback.hooks),
    ctas: normalizeSignalList(data?.ctas, fallback.ctas),
    tone: normalizeSignalList(data?.tone, fallback.tone),
    avoid: normalizeSignalList(data?.avoid, fallback.avoid),
    reusableRule: cleanText(data?.reusableRule || fallback.reusableRule),
    confidence: clampNumber(data?.confidence, 0, 100, fallback.confidence),
    modelUsed: modelUsed || fallback.modelUsed
  };
}

function normalizeSignalList(value, fallback) {
  const list = Array.isArray(value) ? value : splitList(value);
  const cleaned = list.map(cleanText).filter(Boolean).slice(0, 8);
  return cleaned.length ? cleaned : fallback;
}

async function rebuildLearningPlaybook({ forceAi = false } = {}) {
  const examples = state.learning.examples;
  for (const example of examples) {
    example.learnedAt ??= new Date().toISOString();
  }
  const local = localLearningPlaybook(examples);
  const canUseLiveAi = forceAi && state.vault && state.providerHealth.status === "healthy" && examples.length;
  if (!canUseLiveAi) {
    state.learning.playbook = local;
    state.learning.lastTrainedAt = new Date().toISOString();
    state.learning.modelVersion = `learning-local-v${examples.length}`;
    return state.learning.playbook;
  }

  try {
    const { data, run } = await callOpenRouterJson({
      model: state.aiModelDefaults.analysisModel,
      taskType: "CAMPAIGN_ANALYSIS",
      profile: "balanced",
      maxTokens: 1300,
      messages: [
        {
          role: "system",
          content: "You are a sales ML playbook synthesizer. Turn uploaded outreach examples into compact reusable rules. Return only strict JSON."
        },
        {
          role: "user",
          content: JSON.stringify({
            instruction: "Synthesize the learning database into rules the outreach generator should use.",
            requiredJsonShape: {
              summary: "one sentence",
              winningPatterns: ["pattern"],
              channelTips: [{ channel: "linkedin", tip: "tip" }],
              reusableRules: ["rule"],
              nextDataNeeded: ["data gap"]
            },
            examples: examples.slice(0, 60).map((example) => ({
              productName: example.productName,
              channel: example.channel,
              persona: example.persona,
              outcome: example.outcome,
              outcomeScore: example.outcomeScore,
              tags: example.tags,
              messageText: example.messageText.slice(0, 800),
              notes: example.notes.slice(0, 600),
              signals: example.signals
            }))
          })
        }
      ]
    });
    state.learning.playbook = normalizeLearningPlaybook(data, local, run.modelUsed);
    state.learning.lastTrainedAt = new Date().toISOString();
    state.learning.modelVersion = `learning-ai-v${examples.length}`;
    return state.learning.playbook;
  } catch (error) {
    addEvent("learning", `Playbook rebuild used local fallback: ${error instanceof Error ? error.message : "AI synthesis failed"}`);
    state.learning.playbook = local;
    state.learning.lastTrainedAt = new Date().toISOString();
    state.learning.modelVersion = `learning-local-v${examples.length}`;
    return state.learning.playbook;
  }
}

function localLearningPlaybook(examples) {
  const wins = examples.filter((example) => example.outcomeScore >= 65);
  const pool = wins.length ? wins : examples;
  const patternCounts = countBy(pool.flatMap((example) => example.signals?.patterns || []));
  const hookCounts = countBy(pool.flatMap((example) => example.signals?.hooks || []));
  const ctaCounts = countBy(pool.flatMap((example) => example.signals?.ctas || []));
  const toneCounts = countBy(pool.flatMap((example) => example.signals?.tone || []));
  const avoidCounts = countBy(examples.flatMap((example) => example.signals?.avoid || []));
  const channelTips = Object.entries(countBy(pool.map((example) => example.channel))).slice(0, 5).map(([channel, count]) => ({
    channel,
    tip: `${count} useful example${count === 1 ? "" : "s"} saved. Mirror the strongest hook and keep the CTA low-friction.`
  }));

  return {
    status: examples.length ? "trained" : "empty",
    summary: examples.length
      ? `${wins.length} winning examples are shaping the current outbound playbook.`
      : "Feed successful outreach examples to train product-specific message patterns.",
    winningPatterns: [
      ...topEntries(patternCounts, 5),
      ...topEntries(hookCounts, 3).map((value) => `hook: ${value}`),
      ...topEntries(ctaCounts, 3).map((value) => `CTA: ${value}`)
    ].slice(0, 8),
    channelTips,
    reusableRules: [
      ...topEntries(toneCounts, 2).map((value) => `Use a ${value} tone when the lead context is thin.`),
      "Anchor every message in one visible prospect signal and one product use case.",
      "Use one CTA per message; avoid stacking multiple asks.",
      ...topEntries(avoidCounts, 2).map((value) => `Avoid: ${value}`)
    ].slice(0, 8),
    nextDataNeeded: examples.length < 10
      ? ["Add at least 10 successful replies across channels.", "Add booked-meeting follow-ups with outcome notes.", "Include the ICP profile URL beside each example."]
      : ["Add negative examples to sharpen what the model should avoid.", "Connect CRM outcomes so the playbook learns past reply rate."],
    updatedAt: new Date().toISOString()
  };
}

function normalizeLearningPlaybook(data, fallback, modelUsed) {
  return {
    status: "trained",
    summary: cleanText(data?.summary || fallback.summary),
    winningPatterns: normalizeSignalList(data?.winningPatterns, fallback.winningPatterns).slice(0, 10),
    channelTips: Array.isArray(data?.channelTips)
      ? data.channelTips.slice(0, 6).map((item) => ({
          channel: cleanText(item.channel || "general").slice(0, 32),
          tip: cleanText(item.tip || "")
        })).filter((item) => item.tip)
      : fallback.channelTips,
    reusableRules: normalizeSignalList(data?.reusableRules, fallback.reusableRules).slice(0, 10),
    nextDataNeeded: normalizeSignalList(data?.nextDataNeeded, fallback.nextDataNeeded).slice(0, 6),
    modelUsed,
    updatedAt: new Date().toISOString()
  };
}

function learningContextForProduct(productId) {
  const examples = state.learning.examples
    .filter((example) => example.productId === productId || example.outcomeScore >= 80)
    .filter((example) => example.outcomeScore >= 65)
    .slice(0, 8);
  return {
    playbook: state.learning.playbook,
    examples: examples.map((example) => ({
      productName: example.productName,
      channel: example.channel,
      persona: example.persona,
      outcome: example.outcome,
      outcomeScore: example.outcomeScore,
      messageText: example.messageText.slice(0, 700),
      notes: example.notes.slice(0, 400),
      signals: example.signals
    }))
  };
}

function learningExampleForPrompt(example) {
  return {
    productName: example.productName,
    channel: example.channel,
    assetType: example.assetType,
    persona: example.persona,
    profileUrl: example.profileUrl,
    sourceUrl: example.sourceUrl,
    messageText: example.messageText.slice(0, 2000),
    notes: example.notes.slice(0, 1200),
    outcome: example.outcome,
    outcomeScore: example.outcomeScore,
    tags: example.tags,
    screenshot: example.screenshot ? { name: example.screenshot.name, type: example.screenshot.type, size: example.screenshot.size } : null
  };
}

function countBy(values) {
  return values.filter(Boolean).reduce((acc, value) => {
    const key = cleanText(value).toLowerCase();
    if (!key) return acc;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function topEntries(counts, limit) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([key]) => key);
}

async function prepareOutreachWithAi(prospect, profile, taskType = "SEQUENCE_GENERATION") {
  const product = currentProduct();
  const canUseLiveAi = Boolean(state.vault && state.providerHealth.status === "healthy");
  const fallbackRoute = canUseLiveAi ? localFallbackRun(taskType, profile) : simulateRun(taskType, profile, "");
  const fallbackPlan = {
    ...buildOutreachPlan(prospect, profile, fallbackRoute, product),
    run: fallbackRoute
  };

  if (!canUseLiveAi) {
    return fallbackPlan;
  }

  try {
    const { data, run } = await callOpenRouterJson({
      model: state.aiModelDefaults.writingModel,
      taskType,
      profile,
      maxTokens: 900,
      messages: [
        {
          role: "system",
          content: "You are an expert B2B outbound sales writer. Return only strict JSON with escaped newlines inside string values. Do not use markdown. Do not invent private contact data. Keep claims grounded in the provided product context. Do not mention CRM metadata, folder IDs, import pages, owner names, internal status names, or any note that looks like operational metadata."
        },
        {
          role: "user",
          content: JSON.stringify({
            instruction: "Create product-specific outreach for this prospect. First touch should usually be LinkedIn warm-up plus an invitation. Include concise LinkedIn invite, LinkedIn follow-up, email, SMS, WhatsApp, Telegram, call opener, four LinkedIn variations, and practical next actions. SMS and messenger drafts must be short and only used after contact/permission review.",
            requiredJsonShape: {
              recommendedChannel: "linkedin | email | sms | whatsapp | telegram | manual_research",
              qualificationRationale: "short rationale",
              messages: [
                { channel: "linkedin_invite", body: "string" },
                { channel: "linkedin_follow_up", body: "string" },
                { channel: "email", subject: "string", body: "string" },
                { channel: "sms", body: "string" },
                { channel: "whatsapp", body: "string" },
                { channel: "telegram", body: "string" },
                { channel: "call", body: "string" }
              ],
              linkedinVariations: [
                { label: "connection invite", channel: "linkedin", body: "string" },
                { label: "contextual", channel: "linkedin", body: "string" },
                { label: "short follow-up", channel: "linkedin", body: "string" },
                { label: "direct", channel: "linkedin", body: "string" }
              ],
              actions: [
                { type: "linkedin_invite_sent", label: "string", due: "today", priority: "high | medium | low" },
                { type: "follow_up_scheduled", label: "string", due: "2-3 days", priority: "high | medium | low" }
              ],
              warmupActions: [
                { type: "linkedin_profile_viewed", label: "string", channel: "linkedin | facebook | email | phone", due: "today", priority: "high | medium | low" }
              ]
            },
            product: productForPrompt(product),
            outreachExamples: (product.examples || []).slice(0, 5),
            learningMemory: learningContextForProduct(product.id),
            prospect: prospectForPrompt(prospect),
            leadAnalysis: analyzeLead(prospect, product),
            contactCandidates: (prospect.contactDiscovery?.candidates || []).slice(0, 8)
          })
        }
      ]
    });
    return normalizeAiOutreachPlan(fallbackPlan, data, run);
  } catch (error) {
    const fallbackReason = error instanceof Error ? error.message : "generation failed";
    addEvent("provider", `OpenRouter outreach fallback: ${fallbackReason}`);
    return {
      ...fallbackPlan,
      provider: "fallback",
      fallbackReason
    };
  }
}

async function prepareAndLogOutreach(prospect, profile, taskType = "SEQUENCE_GENERATION", context = {}) {
  const outreach = await prepareOutreachWithAi(prospect, profile, taskType);
  const product = currentProduct();
  const nextActionPlan = buildNextActionPlan(prospect, outreach, product);
  const salesCadence = buildSalesCadence(prospect, outreach, product);
  const acceptanceTask = ensureAcceptanceFollowUpTask(prospect, product, nextActionPlan.followUp);
  const enrichedOutreach = {
    ...outreach,
    nextActionPlan,
    salesCadence,
    followUpTaskId: acceptanceTask.id
  };
  prospect.nextActionPlan = nextActionPlan;
  prospect.salesCadence = salesCadence;
  const metadata = personalizationActivityMetadata(prospect, enrichedOutreach, taskType, context);
  const { interaction } = await logAutomaticSalesActivity(prospect, {
    type: "outreach_prepared",
    channel: enrichedOutreach.recommendedChannel || "ai",
    outcome: "prepared",
    note: `Personalized outreach prepared for ${prospect.name} using ${enrichedOutreach.productName || product.name}.`,
    crmNote: buildPersonalizationCrmNote(prospect, enrichedOutreach, context),
    source: context.source || "outbound-os",
    metadata
  });

  const finalOutreach = {
    ...enrichedOutreach,
    crmActivity: {
      interactionId: interaction.id,
      syncStatus: interaction.crmSync?.status || "not_synced",
      warnings: interaction.crmSync?.warnings || []
    }
  };
  recordLeadResearch(prospect, {
    stage: "outreach_prepared",
    summary: `${finalOutreach.messages.length} channel drafts prepared and a LinkedIn acceptance check was scheduled.`,
    analysis: finalOutreach.analysis,
    outreach: finalOutreach,
    modelUsed: finalOutreach.modelUsed,
    provider: finalOutreach.provider,
    warnings: finalOutreach.fallbackReason ? [`OpenRouter fallback used: ${finalOutreach.fallbackReason}`] : []
  });
  return finalOutreach;
}

async function logAutomaticSalesActivity(prospect, input) {
  const interaction = normalizeInteraction(prospect.id, {
    type: input.type || "outreach_prepared",
    channel: input.channel || "ai",
    outcome: input.outcome || "prepared",
    note: input.note,
    metadata: input.metadata
  });
  state.interactions.unshift(interaction);
  prospect.status = statusFromInteraction(interaction.type, prospect.status);
  prospect.updatedAt = new Date().toISOString();

  const crmResult = await pushCrmActivityForProspects([prospect], {
    interactionType: interaction.type,
    channel: interaction.channel,
    outcome: interaction.outcome,
    note: input.crmNote || input.note || interaction.note,
    metadata: {
      ...input.metadata,
      source: input.source || "outbound-os",
      localInteractionId: interaction.id
    }
  });
  const pushed = Number(crmResult.results?.[0]?.pushed || 0);
  interaction.crmSync = {
    status: pushed > 0 && !(crmResult.warnings || []).length ? "synced" : "not_synced",
    attemptedAt: new Date().toISOString(),
    warnings: crmResult.warnings || []
  };

  if (interaction.crmSync.status === "synced") {
    addEvent("crm", `CRM activity logged for ${prospect.name}.`);
  } else {
    addEvent("crm", `CRM activity queued locally for ${prospect.name}; CRM sync needs attention.`);
    state.aiActions.unshift({
      id: `ai-${randomBytes(6).toString("hex")}`,
      at: new Date().toISOString(),
      instruction: `Sync CRM activity for ${prospect.name}`,
      summary: "Personalization activity was logged locally; CRM push needs attention.",
      status: "partial",
      modelUsed: "local-activity-logger",
      results: [{ type: "local_activity", message: `Logged outreach preparation for ${prospect.name}.` }],
      warnings: interaction.crmSync.warnings
    });
  }

  return { interaction, crmResult };
}

function personalizationActivityMetadata(prospect, outreach, taskType, context) {
  return {
    taskType,
    source: context.source || "outbound-os",
    productId: outreach.productId || state.selectedProductId,
    productName: outreach.productName || currentProduct().name,
    recommendedChannel: outreach.recommendedChannel || "",
    messageChannels: (outreach.messages || []).map((message) => message.channel).filter(Boolean).slice(0, 8),
    linkedinVariationCount: (outreach.linkedinVariations || []).length,
    contactCandidates: contactCandidatesForCrm(prospect),
    nextActions: (outreach.actions || []).map((action) => action.label).filter(Boolean).slice(0, 5)
  };
}

function buildPersonalizationCrmNote(prospect, outreach, context = {}) {
  const contactSummary = contactCandidatesForCrm(prospect)
    .map((candidate) => `${titleCaseServer(candidate.type)}: ${candidate.value} (${candidate.status})`)
    .join("; ");
  const messageChannels = (outreach.messages || []).map((message) => message.channel).filter(Boolean).join(", ");
  const nextAction = outreach.actions?.[0]?.label || analyzeLead(prospect).recommendedAction;
  return [
    `Outbound OS prepared personalized outreach for ${prospect.name} at ${prospect.company || "unknown company"}.`,
    `Product: ${outreach.productName || currentProduct().name}.`,
    `Source: ${context.source || "outbound-os"}.`,
    `Recommended channel: ${outreach.recommendedChannel || "review"}.`,
    messageChannels ? `Drafts prepared: ${messageChannels}.` : "",
    contactSummary ? `Contact candidates for review: ${contactSummary}.` : "Contact candidates for review: none yet.",
    `Next action: ${nextAction}.`
  ].filter(Boolean).join("\n");
}

function contactCandidatesForCrm(prospect) {
  const preferredTypes = ["email", "phone", "linkedin", "facebook_match", "facebook", "whatsapp_link", "telegram_link", "whatsapp", "telegram"];
  const candidates = prospect.contactDiscovery?.candidates || [];
  return preferredTypes
    .map((type) => candidates.find((candidate) => candidate.type === type))
    .filter(Boolean)
    .slice(0, 9)
    .map((candidate) => ({
      type: candidate.type,
      value: String(candidate.value || "").slice(0, 180),
      status: candidate.status || "review",
      confidence: candidate.confidence || null,
      source: candidate.source || ""
    }));
}

function buildOutreachPlan(prospect, profile, route, product = currentProduct()) {
  const pain = inferPainPoint(prospect);
  const channel = chooseBestChannel(prospect);
  const analysis = analyzeLead(prospect, product);
  const useCase = bestUseCaseFor(prospect, product);
  const proof = product.proofPoints[0] ?? "reduces manual outbound work";
  const differentiator = product.differentiators[0] ?? "AI-assisted sales execution";
  const knowledgeAngle = productKnowledgeForPrompt(product, 1)[0]?.lesson || "";
  const cta = profile === "premium" ? "open to a 12-minute working session next week" : "open to a quick conversation next week";
  const firstName = prospect.name.split(/\s+/)[0] || prospect.name;
  const company = prospect.company || "your team";
  const title = prospect.title || "your role";
  const useCaseText = lowerSalesPhrase(useCase);
  const painText = lowerSalesPhrase(pain);
  const differentiatorText = lowerSalesPhrase(differentiator);
  const safeSignal = publicPersonalizationSignal(prospect);
  const sourceLine = safeSignal ? `I noticed ${safeSignal.replace(/\.$/, "")}.` : `I was looking at ${company}'s go-to-market motion.`;
  const useDirectPhone = hasReviewedPhoneCandidate(prospect);
  const messengerHint = useDirectPhone ? "after confirming this is the right person and channel" : "only if a verified phone or messenger profile is added";

  return {
    preparedAt: new Date().toISOString(),
    profile,
    productId: product.id,
    productName: product.name,
    modelUsed: route.ok ? route.modelUsed : "mock/balanced",
    provider: route.ok ? route.provider : "mock",
    recommendedChannel: channel,
    analysis,
    qualification: {
      score: prospect.score,
      fit: analysis.productFit,
      rationale: `${title} at ${company} maps to ${useCase.toLowerCase()} for ${product.name}.`
    },
    messages: [
      {
        channel: "linkedin_invite",
        body: `Hi ${firstName}, noticed your work at ${company}. I’m researching how teams handle ${useCaseText}. Open to connecting?`
      },
      {
        channel: "linkedin_follow_up",
        body: `${firstName}, thanks for connecting. The reason I reached out: ${product.name} helps teams with ${useCaseText} without adding manual research/admin work. Is this something ${company} is trying to improve this quarter?`
      },
      {
        channel: "email",
        subject: `${company} and ${product.name}`,
        body: `Hi ${firstName},\n\n${sourceLine}\n\nFor teams dealing with ${painText}, ${product.name} is usually most useful around ${useCaseText}. The reason I thought of ${company}: ${proof}, with ${differentiatorText} underneath so the workflow stays controlled.${knowledgeAngle ? ` ${knowledgeAngle}` : ""}\n\nWould you be ${cta}?`
      },
      {
        channel: "sms",
        body: `Hi ${firstName}, quick one: I help teams improve ${useCaseText} with ${product.name}. Worth sending you the short workflow?`
      },
      {
        channel: "whatsapp",
        body: `Hi ${firstName}, this is a quick note ${messengerHint}. I’m looking at ${company}'s ${useCaseText} workflow and thought ${product.name} could be relevant. Worth sharing a short example?`
      },
      {
        channel: "telegram",
        body: `Hi ${firstName}, quick question ${messengerHint}: is ${useCaseText} something your team is actively improving? I can share a short ${product.name} workflow if useful.`
      },
      {
        channel: "call",
        body: `Lead with ${company}'s current motion, then ask how ${prospect.title || "the team"} handles ${useCaseText}, where the process breaks, and whether ${product.name}'s ${differentiatorText} would be useful.`
      }
    ],
    actions: [
      {
        type: "review_contact_data",
        label: "Review contact candidates",
        due: "today",
        priority: "high"
      },
      {
        type: "linkedin_profile_viewed",
        label: "Open LinkedIn profile and check recent public activity",
        due: "today",
        priority: "high"
      },
      {
        type: "linkedin_post_liked",
        label: "Like one relevant public post if it is natural",
        due: "today",
        priority: "medium"
      },
      {
        type: "linkedin_invite_sent",
        label: "Send LinkedIn invitation with the short message",
        due: "today",
        priority: "high"
      },
      {
        type: "follow_up_scheduled",
        label: "Check in 2-3 days: if accepted, send LinkedIn follow-up; if not, review email/SMS path",
        due: "2-3 days",
        priority: "high"
      },
      {
        type: "email_sent",
        label: "Use email as the second channel after LinkedIn warm-up",
        due: "after LinkedIn touch",
        priority: "medium"
      }
    ],
    complianceChecks: [
      "No unsupported claims added.",
      "Personal data is marked for review before use.",
      "Suppression and communication-permission checks required before send."
    ],
    warmupActions: buildWarmupActions(prospect),
    linkedinVariations: buildLinkedInOutreach(prospect, product, profile).variations
  };
}

function buildWarmupActions(prospect) {
  const candidates = prospect.contactDiscovery?.candidates || [];
  const hasFacebookMatch = candidates.some((candidate) => candidate.type === "facebook_match" || candidate.type === "facebook");
  const hasPhone = candidates.some((candidate) => candidate.type === "phone");
  const hasMessengerSignal = candidates.some((candidate) => candidate.type === "whatsapp_presence" || candidate.type === "telegram_presence" || candidate.type === "whatsapp_link" || candidate.type === "telegram_link" || candidate.type === "whatsapp" || candidate.type === "telegram");
  const actions = [
    {
      type: "linkedin_profile_viewed",
      label: "Review LinkedIn profile fit and recent public activity",
      channel: "linkedin",
      due: "today",
      priority: "high"
    },
    {
      type: "linkedin_post_liked",
      label: "Like or comment on a relevant public post before pitching",
      channel: "linkedin",
      due: "today",
      priority: "medium"
    },
    {
      type: "linkedin_comment_planned",
      label: "Draft a helpful comment only if a recent post gives a real angle",
      channel: "linkedin",
      due: "today",
      priority: "low"
    },
    {
      type: "linkedin_skill_endorsed",
      label: "Endorse a relevant skill only when the profile supports it",
      channel: "linkedin",
      due: "optional",
      priority: "low"
    },
    {
      type: "linkedin_invite_sent",
      label: "Send a short product-specific connection message",
      channel: "linkedin",
      due: "today",
      priority: "high"
    },
    {
      type: "follow_up_scheduled",
      label: "Set a 2-3 day task to check acceptance and send the next message",
      channel: "linkedin",
      due: "2-3 days",
      priority: "high"
    }
  ];
  if (hasFacebookMatch) {
    actions.push({
      type: "review_facebook_match",
      label: "Review suggested Facebook profile match before using it",
      channel: "facebook",
      due: "today",
      priority: "medium"
    });
  }
  if (hasPhone) {
    actions.push({
      type: "verify_phone_permission",
      label: "Verify phone source and permission before direct outreach",
      channel: "phone",
      due: "before call",
      priority: "high"
    });
  }
  if (hasMessengerSignal) {
    actions.push({
      type: "review_messenger_presence",
      label: "Review WhatsApp/Telegram signal before any messenger touch",
      channel: "phone",
      due: "before messenger",
      priority: "high"
    });
  }
  return actions;
}

function publicPersonalizationSignal(prospect) {
  const raw = cleanText(prospect.notes || "");
  if (!raw) return "";
  const blockedPatterns = [
    /\bcrm\b/i,
    /\bfolder\b/i,
    /\bpage\s+\d+/i,
    /\bstatus\b/i,
    /\bowner\b/i,
    /\bimported\b/i,
    /\badvantage\b/i,
    /\bnetlify\b/i,
    /\b(api token|api key|endpoint)\b/i,
    /\buuid\b/i,
    /\bid[:=]/i
  ];
  if (blockedPatterns.some((pattern) => pattern.test(raw))) return "";
  return raw
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\b[A-Fa-f0-9]{8}-[A-Fa-f0-9-]{13,}\b/g, "")
    .trim()
    .slice(0, 180);
}

function lowerSalesPhrase(value) {
  return cleanText(value || "")
    .toLowerCase()
    .replace(/\bai\b/g, "AI")
    .replace(/\bcrm\b/g, "CRM")
    .replace(/\bmcp\b/g, "MCP")
    .replace(/\bsdr\b/g, "SDR")
    .replace(/\bapi\b/g, "API")
    .replace(/\broi\b/g, "ROI");
}

function hasReviewedPhoneCandidate(prospect) {
  if (prospect.phone) return true;
  return (prospect.contactDiscovery?.candidates || []).some((candidate) =>
    candidate.type === "phone" && !String(candidate.status || "").includes("low_confidence")
  );
}

function contactAvailability(prospect) {
  const candidates = prospect.contactDiscovery?.candidates || [];
  const hasType = (type) => candidates.some((candidate) => candidate.type === type || candidate.type === `${type}_link` || candidate.type === `${type}_presence`);
  return {
    linkedin: Boolean(prospect.linkedin || hasType("linkedin")),
    email: Boolean(prospect.email || hasType("email")),
    phone: Boolean(prospect.phone || hasType("phone")),
    facebook: hasType("facebook") || hasType("facebook_match"),
    whatsapp: hasType("whatsapp"),
    telegram: hasType("telegram")
  };
}

function buildNextActionPlan(prospect, outreach, product = currentProduct()) {
  const interactions = interactionsForProspect(prospect.id);
  const types = new Set(interactions.map((interaction) => interaction.type));
  const availability = contactAvailability(prospect);
  const analysis = analyzeLead(prospect, product);
  const primaryAction = types.has("linkedin_invite_accepted") || types.has("linkedin_connected")
    ? "Send the LinkedIn follow-up with the product-specific value angle"
    : types.has("linkedin_invite_sent")
      ? "Check whether the LinkedIn invitation was accepted before the next touch"
      : "Warm the lead on LinkedIn, then send the short connection invitation";
  const followUpDue = types.has("linkedin_invite_sent") ? dueTomorrowIso() : dueInDaysIso(2);

  return {
    createdAt: new Date().toISOString(),
    productId: product.id,
    productName: product.name,
    primaryAction,
    reason: `${prospect.name} is a ${analysis.productFit} fit for ${product.name}. Start low-friction on LinkedIn, then use stronger channels only after the profile and contact evidence are reviewed.`,
    bestChannel: availability.linkedin ? "linkedin" : outreach.recommendedChannel || chooseBestChannel(prospect),
    preTouchActions: [
      "Open the LinkedIn profile and confirm this is the right person.",
      "Like one relevant public post if it genuinely matches the offer.",
      "Comment only when there is a useful non-generic point to add.",
      "Endorse a skill only if the profile clearly supports it."
    ],
    followUp: {
      label: "Check invite acceptance and send the next message",
      due: followUpDue,
      trigger: "2-3 days after invite, or immediately when the invite is accepted",
      ifAccepted: "Send the LinkedIn follow-up and log LinkedIn accepted/connected.",
      ifNotAccepted: availability.email ? "Use the email draft as the second channel." : "Review contact enrichment before switching channels."
    },
    channelOrder: [
      "linkedin_warmup",
      "linkedin_invite",
      "linkedin_follow_up",
      availability.email ? "email" : "",
      availability.phone ? "sms" : "",
      availability.whatsapp ? "whatsapp" : "",
      availability.telegram ? "telegram" : "",
      "call"
    ].filter(Boolean),
    score: {
      reachProbability: analysis.reachProbability,
      closeProbability: analysis.closeProbability,
      contactConfidence: bestContactConfidenceServer(prospect)
    }
  };
}

function buildSalesCadence(prospect, outreach, product = currentProduct()) {
  const due2 = dueInDaysIso(2);
  const due3 = dueInDaysIso(3);
  const due4 = dueInDaysIso(4);
  const availability = contactAvailability(prospect);
  return {
    productId: product.id,
    productName: product.name,
    generatedAt: new Date().toISOString(),
    steps: [
      {
        day: "today",
        channel: "linkedin",
        type: "linkedin_profile_viewed",
        label: "Verify profile, company, and public activity",
        messageChannel: "",
        manualReview: true
      },
      {
        day: "today",
        channel: "linkedin",
        type: "linkedin_invite_sent",
        label: "Send the LinkedIn invitation",
        messageChannel: "linkedin_invite",
        manualReview: true
      },
      {
        day: "2-3 days",
        due: due2,
        channel: "linkedin",
        type: "linkedin_invite_accepted",
        label: "If accepted, send the LinkedIn follow-up",
        messageChannel: "linkedin_follow_up",
        manualReview: true
      },
      {
        day: "3 days",
        due: due3,
        channel: availability.email ? "email" : "research",
        type: availability.email ? "email_sent" : "review_contact_data",
        label: availability.email ? "If no LinkedIn acceptance, use the tailored email" : "If no acceptance, enrich or review alternate contacts",
        messageChannel: availability.email ? "email" : "",
        manualReview: true
      },
      {
        day: "4 days",
        due: due4,
        channel: availability.whatsapp ? "whatsapp" : availability.phone ? "sms" : availability.telegram ? "telegram" : "research",
        type: availability.whatsapp ? "whatsapp_sent" : availability.phone ? "sms_sent" : availability.telegram ? "telegram_sent" : "review_contact_data",
        label: availability.whatsapp || availability.phone || availability.telegram
          ? "Use a short direct-channel follow-up after source and permission review"
          : "Keep researching verified direct contact data before using messenger channels",
        messageChannel: availability.whatsapp ? "whatsapp" : availability.phone ? "sms" : availability.telegram ? "telegram" : "",
        manualReview: true
      }
    ],
    summary: `${prospect.name} should be warmed up and invited first, then followed up in 2-3 days based on acceptance and available contact data.`
  };
}

function ensureAcceptanceFollowUpTask(prospect, product, followUp = {}) {
  const existing = state.followUpTasks.find((task) =>
    task.prospectId === prospect.id && task.source === "linkedin_acceptance_check" && task.status !== "done"
  );
  if (existing) {
    existing.due = followUp.due || existing.due;
    existing.label = followUp.label || existing.label;
    existing.updatedAt = new Date().toISOString();
    return existing;
  }
  const task = {
    id: `task-${randomBytes(6).toString("hex")}`,
    prospectId: prospect.id,
    prospectName: prospect.name,
    productId: product.id,
    type: "linkedin_acceptance_check",
    label: followUp.label || `Check whether ${prospect.name} accepted the LinkedIn invitation`,
    due: followUp.due || dueInDaysIso(2),
    status: "open",
    source: "linkedin_acceptance_check",
    createdAt: new Date().toISOString(),
    notificationChannel: state.integrations.notifications.channel,
    notificationTarget: state.integrations.notifications.target
  };
  state.followUpTasks.unshift(task);
  return task;
}

function recordLeadResearch(prospect, input = {}) {
  const product = currentProduct();
  const contactDiscovery = input.contactDiscovery || prospect.contactDiscovery || {};
  const analysis = input.analysis || analyzeLead(prospect, product);
  const record = {
    id: `research-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
    stage: cleanText(input.stage || "research"),
    productId: product.id,
    productName: product.name,
    summary: cleanText(input.summary || "Lead research updated."),
    score: prospect.score || 0,
    status: prospect.status || "review",
    modelUsed: cleanText(input.modelUsed || input.outreach?.modelUsed || ""),
    provider: cleanText(input.provider || input.outreach?.provider || "local"),
    contactSnapshot: contactSnapshotForProspect(prospect, contactDiscovery),
    analysis: {
      reachProbability: analysis.reachProbability || 0,
      closeProbability: analysis.closeProbability || 0,
      productFit: analysis.productFit || "",
      recommendedAction: analysis.recommendedAction || ""
    },
    nextAction: prospect.nextActionPlan?.primaryAction || "",
    warnings: normalizeStringArray(input.warnings || contactDiscovery.warnings || []).slice(0, 6)
  };
  const previous = Array.isArray(prospect.researchHistory) ? prospect.researchHistory : [];
  prospect.researchHistory = [record, ...previous].slice(0, 12);
}

function contactSnapshotForProspect(prospect, contactDiscovery = prospect.contactDiscovery || {}) {
  const availability = contactAvailability({ ...prospect, contactDiscovery });
  return {
    candidates: Array.isArray(contactDiscovery.candidates) ? contactDiscovery.candidates.length : 0,
    bestConfidence: bestContactConfidenceServer({ ...prospect, contactDiscovery }),
    linkedin: availability.linkedin,
    email: availability.email,
    phone: availability.phone,
    facebook: availability.facebook,
    whatsapp: availability.whatsapp,
    telegram: availability.telegram,
    scraperStatus: contactDiscovery.scraperStatus || ""
  };
}

function bestContactConfidenceServer(prospect) {
  const candidates = prospect?.contactDiscovery?.candidates || [];
  return candidates.length ? Math.max(...candidates.map((candidate) => Number(candidate.confidence) || 0)) : 0;
}

function normalizeAiOutreachPlan(fallbackPlan, data, run) {
  const messages = normalizeAiMessages(data?.messages, fallbackPlan.messages);
  const linkedinVariations = normalizeAiLinkedInVariations(data?.linkedinVariations, fallbackPlan.linkedinVariations);
  const actions = normalizeOutreachActions(data?.actions, fallbackPlan.actions || []);

  return {
    ...fallbackPlan,
    modelUsed: run.modelUsed,
    provider: run.provider,
    recommendedChannel: cleanText(data?.recommendedChannel || fallbackPlan.recommendedChannel).slice(0, 32),
    qualification: {
      ...fallbackPlan.qualification,
      rationale: cleanText(data?.qualificationRationale || fallbackPlan.qualification.rationale)
    },
    messages,
    linkedinVariations,
    actions,
    warmupActions: normalizeWarmupActions(data?.warmupActions, fallbackPlan.warmupActions || []),
    run
  };
}

function normalizeOutreachActions(actions, fallback) {
  if (!Array.isArray(actions) || !actions.length) return fallback;
  const normalized = actions.slice(0, 8).map((action) => ({
    type: cleanText(action.type || "next_action").slice(0, 64),
    label: cleanText(action.label || "Review next action"),
    due: cleanText(action.due || "today").slice(0, 64),
    priority: cleanText(action.priority || "medium").slice(0, 16)
  })).filter((action) => action.label);
  if (!normalized.length) return fallback;
  const byType = new Map((fallback || []).map((action) => [String(action.type || "").toLowerCase(), action]));
  for (const action of normalized) byType.set(String(action.type || "").toLowerCase(), action);
  return [...byType.values()].slice(0, 8);
}

function normalizeAiMessages(messages, fallback) {
  if (!Array.isArray(messages) || !messages.length) return fallback;
  const normalized = messages.slice(0, 8).map((message) => ({
    channel: cleanText(message.channel || "email").slice(0, 32),
    subject: message.subject ? cleanText(message.subject).slice(0, 140) : undefined,
    body: cleanLongText(message.body || "")
  })).filter((message) => message.body.length > 8);
  if (!normalized.length) return fallback;
  const byChannel = new Map((fallback || []).map((message) => [String(message.channel || "").toLowerCase(), message]));
  for (const message of normalized) {
    byChannel.set(String(message.channel || "").toLowerCase(), message);
  }
  return [...byChannel.values()].slice(0, 8);
}

function normalizeAiLinkedInVariations(variations, fallback) {
  if (!Array.isArray(variations) || !variations.length) return fallback;
  return variations.slice(0, 6).map((variation, index) => ({
    label: cleanText(variation.label || `variation ${index + 1}`).slice(0, 48),
    channel: "linkedin",
    body: cleanLongText(variation.body || "")
  })).filter((variation) => variation.body.length > 8);
}

function normalizeWarmupActions(actions, fallback) {
  if (!Array.isArray(actions) || !actions.length) return fallback;
  const normalized = actions.slice(0, 8).map((action) => ({
    type: cleanText(action.type || "warmup_action").slice(0, 64),
    label: cleanText(action.label || "Review profile and prepare touch"),
    channel: cleanText(action.channel || "linkedin").slice(0, 32),
    due: cleanText(action.due || "today").slice(0, 48),
    priority: cleanText(action.priority || "medium").slice(0, 16)
  })).filter((action) => action.label);
  if (!normalized.length) return fallback;
  const byType = new Map((fallback || []).map((action) => [String(action.type || "").toLowerCase(), action]));
  for (const action of normalized) byType.set(String(action.type || "").toLowerCase(), action);
  return [...byType.values()].slice(0, 10);
}

function buildLinkedInOutreach(prospect, product = currentProduct(), profile = "balanced") {
  const analysis = analyzeLead(prospect, product);
  const firstName = prospect.name.split(/\s+/)[0] || prospect.name;
  const company = prospect.company || "your team";
  const useCase = bestUseCaseFor(prospect, product);
  const useCaseText = lowerSalesPhrase(useCase);
  const examples = (product.examples ?? []).filter((example) => example.channel === "linkedin").slice(0, 3);
  const exampleStyle = examples[0]?.message ? ` Similar style reference: ${examples[0].message}` : "";
  const proof = product.proofPoints[0] ?? "reduce manual sales work";
  const differentiator = product.differentiators[0] ?? "controlled AI workflow";
  const differentiatorText = lowerSalesPhrase(differentiator);

  return {
    productId: product.id,
    productName: product.name,
    preparedAt: new Date().toISOString(),
    analysis,
    examplesUsed: examples.map((example) => example.id),
    variations: [
      {
        label: "connection invite",
        channel: "linkedin",
        body: `Hi ${firstName}, noticed your work at ${company}. I’m looking at how teams handle ${useCaseText} with ${product.name}. Open to connecting?`
      },
      {
        label: "contextual",
        channel: "linkedin",
        body: `Hi ${firstName}, saw the ${prospect.title || "go-to-market"} angle at ${company}. ${product.name} helps with ${useCaseText} and ${proof}. Curious if this is on your radar?`
      },
      {
        label: "short follow-up",
        channel: "linkedin",
        body: `${firstName}, quick follow-up. The relevant bit is ${differentiatorText} for ${useCaseText}.${exampleStyle ? " I kept this close to your saved example style." : ""}`
      },
      {
        label: profile === "premium" ? "executive" : "direct",
        channel: "linkedin",
        body: `If ${company} is trying to improve ${useCaseText}, I can share a concrete workflow for ${product.name}. Worth comparing notes?`
      }
    ]
  };
}

async function attachCallAnalysis(prospect, transcript, source = "manual_paste", externalCallId = "") {
  const product = currentProduct();
  let analysis = analyzeCallTranscript(prospect, transcript, product);
  if (state.vault && state.providerHealth.status === "healthy") {
    try {
      analysis = await analyzeCallTranscriptWithAi(prospect, transcript, product, analysis);
    } catch (error) {
      addEvent("provider", `OpenRouter call analysis fallback: ${error instanceof Error ? error.message : "analysis failed"}`);
    }
  }

  prospect.callAnalysis = {
    ...analysis,
    source,
    externalCallId
  };
  prospect.status = prospect.callAnalysis.followUpTask ? "follow_up_due" : "call_analyzed";
  prospect.updatedAt = new Date().toISOString();
  state.interactions.unshift(normalizeInteraction(prospect.id, {
    type: "call_completed",
    channel: "phone",
    outcome: prospect.callAnalysis.sentiment,
    note: prospect.callAnalysis.summary
  }));
  if (prospect.callAnalysis.followUpTask) {
    state.followUpTasks.unshift({
      ...prospect.callAnalysis.followUpTask,
      notificationChannel: state.integrations.notifications.channel,
      notificationTarget: state.integrations.notifications.target
    });
  }
  return prospect.callAnalysis;
}

async function analyzeCallTranscriptWithAi(prospect, transcript, product, fallback) {
  const { data, run } = await callOpenRouterJson({
    model: state.aiModelDefaults.analysisModel,
    taskType: "SALES_COACHING",
    profile: "economy",
    maxTokens: 1100,
    messages: [
      {
        role: "system",
        content: "You are a sales call coach. Return only strict JSON. Focus on concrete coaching, next steps, and CRM-ready notes."
      },
      {
        role: "user",
        content: JSON.stringify({
          instruction: "Analyze this sales call transcript for follow-up, call quality, objections, and next-step templates.",
          requiredJsonShape: {
            sentiment: "positive | neutral | negative",
            qualityScore: 0,
            summary: "short summary",
            objectionsDetected: ["string"],
            improvementTips: ["string"],
            followUpNeeded: true,
            nextStepTemplates: [
              { channel: "email", label: "post-call follow-up", body: "string" },
              { channel: "linkedin", label: "light follow-up", body: "string" },
              { channel: "crm", label: "CRM note", body: "string" }
            ]
          },
          product: productForPrompt(product),
          prospect: prospectForPrompt(prospect),
          transcript
        })
      }
    ]
  });
  const followUpNeeded = Boolean(data?.followUpNeeded) || Boolean(fallback.followUpTask);
  return {
    ...fallback,
    modelUsed: run.modelUsed,
    provider: run.provider,
    sentiment: ["positive", "neutral", "negative"].includes(data?.sentiment) ? data.sentiment : fallback.sentiment,
    qualityScore: clampNumber(data?.qualityScore, 0, 100, fallback.qualityScore),
    summary: cleanText(data?.summary || fallback.summary),
    objectionsDetected: normalizeStringArray(data?.objectionsDetected, fallback.objectionsDetected).slice(0, 5),
    improvementTips: normalizeStringArray(data?.improvementTips, fallback.improvementTips).slice(0, 6),
    nextStepTemplates: normalizeCallTemplates(data?.nextStepTemplates, fallback.nextStepTemplates),
    followUpTask: followUpNeeded ? fallback.followUpTask || createFollowUpTask(prospect, product) : null,
    run
  };
}

function matchProspectForTranscript(input) {
  const prospectId = cleanText(input.prospectId || "");
  if (prospectId) {
    const byId = findProspect(prospectId);
    if (byId) return byId;
  }

  const linkedin = cleanText(input.linkedin || input.linkedinUrl || "");
  if (linkedin) {
    const byLinkedIn = state.prospects.find((prospect) => prospect.linkedin.toLowerCase() === linkedin.toLowerCase());
    if (byLinkedIn) return byLinkedIn;
  }

  const email = cleanText(input.email || "").toLowerCase();
  if (email) {
    const byEmail = state.prospects.find((prospect) => prospect.email.toLowerCase() === email);
    if (byEmail) return byEmail;
  }

  const name = cleanText(input.name || input.person || "");
  const company = cleanText(input.company || input.account || "");
  if (name && company) {
    const dedupeKey = `${name.toLowerCase()}::${company.toLowerCase()}`;
    return state.prospects.find((prospect) => prospect.dedupeKey === dedupeKey);
  }

  return null;
}

function analyzeCallTranscript(prospect, transcript, product = currentProduct()) {
  const lower = transcript.toLowerCase();
  const firstName = prospect.name.split(/\s+/)[0] || prospect.name;
  const company = prospect.company || "the account";
  const useCase = bestUseCaseFor(prospect, product);
  const objections = product.objections.filter((objection) =>
    objection
      .toLowerCase()
      .split(/\s+/)
      .some((token) => token.length > 4 && lower.includes(token.replace(/[^a-z]/g, "")))
  );
  const sentiment = lower.includes("send") || lower.includes("next week") || lower.includes("interested") || lower.includes("follow up")
    ? "positive"
    : lower.includes("not interested") || lower.includes("no budget")
      ? "negative"
      : "neutral";
  const agreedFollowUp = lower.includes("follow up") || lower.includes("send me") || lower.includes("next week") || lower.includes("tomorrow");
  const qualityScore = callQualityScore(lower);
  const summary = `${firstName} discussed ${useCase.toLowerCase()} for ${company}. Sentiment is ${sentiment}; ${agreedFollowUp ? "a follow-up was implied or agreed." : "no explicit next step was detected."}`;
  const due = agreedFollowUp ? dueTomorrowIso() : null;
  const followUpTask = due ? createFollowUpTask(prospect, product, due) : null;

  return {
    analyzedAt: new Date().toISOString(),
    productName: product.name,
    transcript,
    sentiment,
    qualityScore,
    summary,
    objectionsDetected: objections.length ? objections : inferCallObjections(lower),
    improvementTips: callImprovementTips(lower, product),
    nextStepTemplates: [
      {
        channel: "email",
        label: "post-call follow-up",
        body: `Hi ${firstName},\n\nThanks for the conversation. Based on what we discussed around ${useCase.toLowerCase()}, ${product.name} may help by ${product.proofPoints[0] || "turning activity history into clear next steps"}.\n\nSuggested next step: I can send a short workflow and we can decide whether it is worth a deeper look.`
      },
      {
        channel: "linkedin",
        label: "light follow-up",
        body: `${firstName}, thanks for the chat. I’ll send the ${product.name} workflow we discussed around ${useCase.toLowerCase()}.`
      },
      {
        channel: "crm",
        label: "CRM note",
        body: `${summary} Recommended action: ${agreedFollowUp ? "send follow-up and schedule next step" : "clarify next step before sending more material"}.`
      }
    ],
    followUpTask
  };
}

function createFollowUpTask(prospect, product, due = dueTomorrowIso()) {
  return {
    id: `task-${randomBytes(6).toString("hex")}`,
    prospectId: prospect.id,
    prospectName: prospect.name,
    productId: product.id,
    type: "follow_up",
    label: `Follow up with ${prospect.name}`,
    due,
    status: "open",
    source: "call_analysis",
    createdAt: new Date().toISOString()
  };
}

function normalizeStringArray(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.map(cleanText).filter(Boolean);
  return cleaned.length ? cleaned : fallback;
}

function normalizeCallTemplates(value, fallback = []) {
  if (!Array.isArray(value) || !value.length) return fallback;
  const templates = value.slice(0, 4).map((template) => ({
    channel: cleanText(template.channel || "email").slice(0, 32),
    label: cleanText(template.label || "next step").slice(0, 80),
    body: cleanLongText(template.body || "")
  })).filter((template) => template.body.length > 8);
  return templates.length ? templates : fallback;
}

async function runAssistantAction({ instruction, scope, limit, selectedProspectId }) {
  const startedAt = new Date().toISOString();
  if (instruction.length < 4) {
    return {
      id: `ai-${randomBytes(6).toString("hex")}`,
      at: startedAt,
      instruction,
      summary: "No task provided",
      status: "blocked",
      modelUsed: "local",
      results: [],
      warnings: ["Type a task for the AI Operator."]
    };
  }

  const plan = await interpretAssistantInstruction(instruction, { scope, limit });
  const action = {
    id: `ai-${randomBytes(6).toString("hex")}`,
    at: startedAt,
    instruction,
    summary: plan.summary || "AI task executed",
    status: "completed",
    modelUsed: plan.modelUsed || "local",
    results: [],
    warnings: []
  };

  for (const step of (plan.actions || []).slice(0, 8)) {
    const result = await executeAssistantStep(step, { scope, limit, selectedProspectId });
    action.results.push(...(result.results || []));
    action.warnings.push(...(result.warnings || []));
  }

  if (!action.results.length && !action.warnings.length) {
    action.status = "blocked";
    action.warnings.push("No supported action was detected. Try import, sort, change status, log interaction, prepare outreach, enrich contacts, or push CRM activity.");
  } else if (action.warnings.length) {
    action.status = action.results.length ? "partial" : "blocked";
  }

  return action;
}

async function interpretAssistantInstruction(instruction, defaults) {
  if (state.vault && state.providerHealth.status === "healthy") {
    try {
      const { data, run } = await callOpenRouterJson({
        model: state.aiModelDefaults.analysisModel,
        taskType: "NEXT_BEST_ACTION",
        profile: "economy",
        maxTokens: 900,
        messages: [
          {
            role: "system",
            content: "Translate sales-ops instructions into safe JSON actions. Return only JSON. Allowed actions: import_crm_leads, sort_leads, set_status, log_interaction, prepare_outreach, enrich_contacts, push_crm_activity. Never invent unsupported actions."
          },
          {
            role: "user",
            content: JSON.stringify({
              instruction,
              defaults,
              availableStatuses: prospectStatuses(),
              interactionTypes: [
                "linkedin_profile_viewed",
                "linkedin_post_liked",
                "linkedin_comment_planned",
                "linkedin_skill_endorsed",
                "linkedin_invite_sent",
                "linkedin_invite_accepted",
                "linkedin_connected",
                "linkedin_reply",
                "email_sent",
                "email_opened",
                "sms_sent",
                "whatsapp_sent",
                "telegram_sent",
                "follow_up_scheduled",
                "meeting_booked",
                "no_reply",
                "call_completed"
              ],
              requiredJsonShape: {
                summary: "short",
                actions: [
                  {
                    type: "sort_leads",
                    scope: "selected | all | new | outreach_ready | contacted | follow_up_due",
                    limit: 25,
                    sortBy: "score | reach | close | updated | company | status",
                    direction: "asc | desc",
                    status: "outreach_ready",
                    interactionType: "linkedin_invite_sent",
                    note: "string",
                    source: "supabase | custom_crm",
                    resource: "leads",
                    linkedinField: "linkedin_url"
                  }
                ]
              }
            })
          }
        ]
      });
      return {
        summary: cleanText(data?.summary || "AI task plan"),
        modelUsed: run.modelUsed,
        actions: normalizeAssistantActions(data?.actions, defaults)
      };
    } catch (error) {
      addEvent("provider", `AI Operator used local parser: ${error instanceof Error ? error.message : "planning failed"}`);
    }
  }
  return parseAssistantInstructionLocally(instruction, defaults);
}

function normalizeAssistantActions(actions, defaults) {
  if (!Array.isArray(actions) || !actions.length) return parseAssistantInstructionLocally("", defaults).actions;
  const allowed = new Set(["import_crm_leads", "sort_leads", "set_status", "log_interaction", "prepare_outreach", "enrich_contacts", "push_crm_activity"]);
  return actions
    .slice(0, 8)
    .map((action) => ({
      type: cleanText(action.type || ""),
      scope: cleanText(action.scope || defaults.scope),
      limit: clampNumber(action.limit, 1, 200, defaults.limit),
      sortBy: cleanText(action.sortBy || ""),
      direction: cleanText(action.direction || "desc"),
      status: normalizeProspectStatus(action.status || ""),
      interactionType: normalizeInteractionType(action.interactionType || ""),
      note: cleanText(action.note || ""),
      source: cleanText(action.source || "supabase"),
      resource: cleanText(action.resource || ""),
      linkedinField: cleanText(action.linkedinField || "")
    }))
    .filter((action) => allowed.has(action.type));
}

function parseAssistantInstructionLocally(instruction, defaults) {
  const text = instruction.toLowerCase();
  const actions = [];
  if (/import|pull|load|upload|sync/.test(text) && /crm|supabase|lead|linkedin/.test(text)) {
    actions.push({ type: "import_crm_leads", scope: defaults.scope, limit: inferredLimit(text, defaults.limit), source: text.includes("custom") ? "custom_crm" : "supabase", resource: "leads", linkedinField: "linkedin_url" });
  }
  if (/sort|rank|order/.test(text)) {
    actions.push({ type: "sort_leads", scope: defaults.scope, limit: defaults.limit, sortBy: inferSortBy(text), direction: text.includes("asc") ? "asc" : "desc" });
  }
  if (/status|move|mark|set/.test(text)) {
    const status = inferStatus(text);
    if (status) actions.push({ type: "set_status", scope: defaults.scope, limit: inferredLimit(text, defaults.limit), status });
  }
  if (/log|record|activity/.test(text) && /(linkedin|email|reply|meeting|no reply|call)/.test(text)) {
    actions.push({ type: "log_interaction", scope: defaults.scope, limit: inferredLimit(text, defaults.limit), interactionType: inferInteractionType(text), note: instruction });
  }
  if (/prepare|write|draft|outreach|attack|sequence|message/.test(text)) {
    actions.push({ type: "prepare_outreach", scope: defaults.scope, limit: inferredLimit(text, defaults.limit) });
  }
  if (/enrich|contact|find/.test(text)) {
    actions.push({ type: "enrich_contacts", scope: defaults.scope, limit: inferredLimit(text, defaults.limit) });
  }
  if (/crm/.test(text) && /push|send|sync|write/.test(text) && /activity|action|note|task/.test(text)) {
    actions.push({ type: "push_crm_activity", scope: defaults.scope, limit: inferredLimit(text, defaults.limit), note: instruction, interactionType: inferInteractionType(text) });
  }
  return {
    summary: actions.length ? "Local AI Operator plan" : "No supported local action detected",
    modelUsed: "local-parser",
    actions
  };
}

async function executeAssistantStep(step, defaults) {
  if (step.type === "import_crm_leads") {
    const action = await importCrmLeadsAction({
      source: step.source || "supabase",
      resource: step.resource || "",
      limit: step.limit || defaults.limit,
      linkedinField: step.linkedinField || ""
    }, false);
    return { results: action.results, warnings: action.warnings };
  }

  if (step.type === "sort_leads") {
    sortProspects(step.sortBy || "close", step.direction || "desc");
    return { results: [{ type: "sort_leads", message: `Sorted leads by ${step.sortBy || "close"} ${step.direction || "desc"}.` }], warnings: [] };
  }

  const prospects = selectProspectsForAction(step.scope || defaults.scope, defaults.selectedProspectId, step.limit || defaults.limit);
  if (!prospects.length) {
    return { results: [], warnings: [`No leads matched scope "${step.scope || defaults.scope}".`] };
  }

  if (step.type === "set_status") {
    const status = normalizeProspectStatus(step.status);
    if (!status) return { results: [], warnings: ["No valid status was provided."] };
    for (const prospect of prospects) {
      prospect.status = status;
      prospect.updatedAt = new Date().toISOString();
    }
    addEvent("assistant", `${prospects.length} leads moved to ${status}.`);
    return { results: [{ type: "set_status", message: `${prospects.length} leads moved to ${status}.` }], warnings: [] };
  }

  if (step.type === "log_interaction") {
    const interactionType = normalizeInteractionType(step.interactionType) || "note_added";
    for (const prospect of prospects) {
      const interaction = normalizeInteraction(prospect.id, { type: interactionType, note: step.note || labelFromInteraction(interactionType) });
      state.interactions.unshift(interaction);
      prospect.status = statusFromInteraction(interaction.type, prospect.status);
      prospect.updatedAt = new Date().toISOString();
    }
    addEvent("assistant", `${interactionType} logged for ${prospects.length} leads.`);
    return { results: [{ type: "log_interaction", message: `${interactionType} logged for ${prospects.length} leads.` }], warnings: [] };
  }

  if (step.type === "enrich_contacts") {
    for (const prospect of prospects.slice(0, 50)) {
      prospect.contactDiscovery = await enrichProspectContacts(prospect);
      recordLeadResearch(prospect, {
        stage: "contact_enriched",
        summary: `${prospect.contactDiscovery.candidates.length} contact candidates reviewed by AI Operator.`,
        contactDiscovery: prospect.contactDiscovery,
        warnings: prospect.contactDiscovery.warnings
      });
      prospect.status = "enriched";
      prospect.updatedAt = new Date().toISOString();
    }
    return { results: [{ type: "enrich_contacts", message: `Contact discovery refreshed for ${Math.min(prospects.length, 50)} leads.` }], warnings: prospects.length > 50 ? ["Limited enrichment to 50 leads for this run."] : [] };
  }

  if (step.type === "prepare_outreach") {
    const selected = prospects.slice(0, 10);
    for (const prospect of selected) {
      if (!prospect.contactDiscovery) prospect.contactDiscovery = await enrichProspectContacts(prospect);
      prospect.outreach = await prepareAndLogOutreach(prospect, "balanced", "SEQUENCE_GENERATION", {
        source: "ai-operator:prepare-outreach"
      });
      prospect.status = "outreach_ready";
      prospect.updatedAt = new Date().toISOString();
    }
    return { results: [{ type: "prepare_outreach", message: `Prepared outreach for ${selected.length} leads.` }], warnings: prospects.length > 10 ? ["Limited live AI writing to 10 leads for this run."] : [] };
  }

  if (step.type === "push_crm_activity") {
    return pushCrmActivityForProspects(prospects, {
      interactionType: normalizeInteractionType(step.interactionType) || "note_added",
      note: step.note || "Outbound OS activity"
    });
  }

  return { results: [], warnings: [`Unsupported action "${step.type}".`] };
}

async function importCrmLeadsAction(input, store = true) {
  const action = {
    id: `ai-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
    instruction: `Import LinkedIn leads from ${input.source || "CRM"}`,
    summary: "CRM lead import",
    status: "completed",
    modelUsed: "connector",
    results: [],
    warnings: []
  };

  try {
    const rows = await fetchCrmLeadRows(input);
    const normalized = normalizeCrmLeadRows(rows, input.linkedinField);
    const withLinkedIn = normalized.filter((lead) => lead.linkedin);
    const imported = importProspectsIntoState(withLinkedIn.length ? withLinkedIn : normalized);
    action.results.push({ type: "import_crm_leads", message: `${imported.importedCount} leads imported from ${input.source || "CRM"}.` });
    if (!withLinkedIn.length) action.warnings.push("No LinkedIn field was detected in imported rows; imported available lead profiles anyway.");
    if (rows.length > normalized.length) action.warnings.push(`${rows.length - normalized.length} CRM rows could not be mapped into leads.`);
  } catch (error) {
    action.status = "blocked";
    action.warnings.push(error instanceof Error ? error.message : "CRM lead import failed.");
  }

  if (store) state.aiActions.unshift(action);
  return action;
}

async function fetchCrmLeadRows(input) {
  const source = input.source === "custom_crm" ? "custom_crm" : "supabase";
  const resource = cleanText(input.resource || "leads").replace(/^\/+/, "");
  const limit = clampNumber(input.limit, 1, 500, 50);
  if (source === "supabase") {
    if (!state.integrations.supabase.url) throw new Error("Supabase URL is not configured.");
    if (!state.supabaseVault) throw new Error("Supabase API key is required before pulling CRM leads.");
    const apiKey = decryptSecret(state.supabaseVault);
    const url = supabaseRestUrl(resource, limit);
    const response = await fetch(url, {
      headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) throw new Error(`Supabase lead pull returned HTTP ${response.status}.`);
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  }

  if (!state.integrations.crm.baseUrl || !state.crmVault) throw new Error("CRM base URL and API token are required before pulling CRM leads.");
  const baseUrl = state.integrations.crm.baseUrl.replace(/\/+$/, "");
  const endpoint = resource || state.integrations.crm.leadEndpoint || "leads";
  const url = endpoint.startsWith("http") ? new URL(endpoint) : new URL(`${baseUrl}/${endpoint}`);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${decryptSecret(state.crmVault)}`, Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`CRM lead pull returned HTTP ${response.status}.`);
  const data = await response.json();
  return Array.isArray(data) ? data : data.data || data.leads || data.records || [];
}

function supabaseRestUrl(resource, limit) {
  const base = state.integrations.supabase.url.replace(/\/+$/, "");
  const [tablePart, queryPart = ""] = String(resource || "contacts").split("?");
  const table = cleanText(tablePart || "contacts").replace(/^\/+|\/+$/g, "") || "contacts";
  const url = new URL(`${base}/rest/v1/${encodeURIComponent(table)}`);
  const params = new URLSearchParams(queryPart);
  if (!params.has("select")) params.set("select", "*");
  if (!params.has("limit")) params.set("limit", String(limit));
  for (const [key, value] of params.entries()) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function normalizeCrmLeadRows(rows, linkedinField = "") {
  return (rows || [])
    .map((row) => {
      const linkedin = valueFromKeys(row, [linkedinField, "linkedin", "linkedin_url", "linkedinUrl", "linkedIn", "profile_url", "profileUrl"]);
      const name = valueFromKeys(row, ["name", "full_name", "fullName", "person", "contact_name", "lead_name"]);
      const company = valueFromKeys(row, ["company", "account", "organization", "company_name", "account_name"]);
      const crmStatus = valueFromKeys(row, ["lead_status", "status", "stage", "lifecycle_stage"]);
      return normalizeProspect({
        id: valueFromKeys(row, ["id", "lead_id", "crm_id"]),
        name,
        company,
        title: valueFromKeys(row, ["title", "job_title", "jobTitle", "role", "position"]),
        location: valueFromKeys(row, ["location", "city", "country"]),
        website: valueFromKeys(row, ["website", "domain", "company_website"]),
        linkedin,
        email: valueFromKeys(row, ["email", "work_email", "business_email"]),
        phone: valueFromKeys(row, ["phone", "mobile", "direct_phone"]),
        notes: valueFromKeys(row, ["notes", "description", "context"]) || "Imported from CRM.",
        status: statusFromCrmLeadStatus(crmStatus),
        crmSource: row
      });
    })
    .filter((prospect) => prospect.name && prospect.company);
}

function statusFromCrmLeadStatus(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return "new";
  if (normalized.includes("booked") || normalized.includes("meeting")) return "meeting_booked";
  if (normalized.includes("reply") || normalized.includes("engaged")) return "engaged";
  if (normalized.includes("progress") || normalized.includes("contact")) return "contacted";
  if (normalized.includes("qualification") || normalized.includes("review")) return "review";
  return normalizeProspectStatus(normalized) || "new";
}

function importProspectsIntoState(prospects) {
  const imported = prospects.map(normalizeProspect).filter((prospect) => prospect.name && prospect.company).slice(0, 500);
  const byKey = new Map(state.prospects.map((prospect) => [prospect.dedupeKey, prospect]));
  for (const prospect of imported) {
    byKey.set(prospect.dedupeKey, { ...(byKey.get(prospect.dedupeKey) ?? {}), ...prospect });
  }
  state.prospects = [...byKey.values()].sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
  addEvent("prospects", `${imported.length} prospect profiles imported.`);
  return { importedCount: imported.length };
}

function importIcpSeedLeads(prospects) {
  const imported = prospects
    .map((input) => normalizeProspect({ ...input, isIcpSeed: true, status: "icp_seed" }))
    .filter((prospect) => prospect.name && prospect.company)
    .slice(0, 500);
  const byKey = new Map(state.prospects.map((prospect) => [prospect.dedupeKey, prospect]));
  const seedIds = new Set(state.icp.seedLeadIds);
  for (const prospect of imported) {
    const merged = { ...(byKey.get(prospect.dedupeKey) ?? {}), ...prospect, isIcpSeed: true, status: "icp_seed" };
    byKey.set(prospect.dedupeKey, merged);
    seedIds.add(merged.id);
  }
  state.prospects = [...byKey.values()].sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
  state.icp.seedLeadIds = [...seedIds].filter((id) => state.prospects.some((prospect) => prospect.id === id));
  return { importedCount: imported.length };
}

function rebuildIcpProfile() {
  const seedLeads = state.prospects.filter((prospect) => state.icp.seedLeadIds.includes(prospect.id) || prospect.isIcpSeed);
  const product = currentProduct();
  const titles = topValues(seedLeads.map((prospect) => normalizeTitleForIcp(prospect.title)), 8);
  const seniorities = topValues(seedLeads.map((prospect) => seniorityFromTitle(prospect.title)), 5);
  const functions = topValues(seedLeads.map((prospect) => functionFromTitle(prospect.title)), 5);
  const countries = topValues(seedLeads.map((prospect) => countryFromLocation(prospect.location)), 5);
  const cities = topValues(seedLeads.map((prospect) => cityFromLocation(prospect.location)), 8);
  const domains = topValues(seedLeads.map((prospect) => prospect.website), 20);
  const industries = topValues(seedLeads.flatMap((prospect) => inferIndustries(prospect, product)), 6);
  const companyKeywords = topValues(seedLeads.flatMap((prospect) => inferCompanyKeywords(prospect, product)), 10);
  const companySizes = topValues(seedLeads.flatMap((prospect) => inferCompanySizeBuckets(prospect.notes)), 4);
  const exclusions = ["students", "recruiters", "consultants only", "personal email only"];
  state.icp.profile = {
    status: seedLeads.length ? "trained" : "empty",
    summary: seedLeads.length
      ? `${seedLeads.length} ICP seed leads trained lookalike filters around ${titles.slice(0, 3).join(", ") || product.targetPersonas.slice(0, 2).join(", ")}.`
      : "Upload ideal customer leads to build ICP filters.",
    seedLeadCount: seedLeads.length,
    titles: titles.length ? titles : product.targetPersonas.slice(0, 6),
    seniorities,
    functions,
    industries,
    companyKeywords,
    companySizes,
    countries,
    cities,
    domains,
    exclusions,
    updatedAt: new Date().toISOString()
  };
  return state.icp.profile;
}

function buildPipelineLabsActorPayload(totalResults = 1000) {
  const profile = state.icp.profile.status === "trained" ? state.icp.profile : rebuildIcpProfile();
  const payload = compactObject({
    totalResults,
    personTitleIncludes: profile.titles.slice(0, 8),
    personTitleExcludes: ["recruiter", "student", "assistant", "intern"],
    includeTitleVariants: true,
    seniorityIncludes: profile.seniorities.slice(0, 5),
    functionIncludes: profile.functions.slice(0, 5),
    roleMatchMode: "any",
    hasEmail: true,
    emailStatusIncludes: ["verified"],
    companyIndustryIncludes: profile.industries.slice(0, 6),
    companyKeywordIncludes: profile.companyKeywords.slice(0, 10),
    companyKeywordExcludes: ["recruiting", "staffing"],
    companyKeywordMode: "broad",
    companySizeIncludes: profile.companySizes.slice(0, 4),
    companyLocationCountryIncludes: profile.countries.slice(0, 5),
    companyLocationCityIncludes: profile.cities.slice(0, 8),
    companyDomainExcludes: profile.domains.slice(0, 20),
    companyDomainMatchMode: "strict",
    companyMatchMode: "any",
    dontSaveProgress: true
  });
  state.icp.lookalikeSearch = {
    ...state.icp.lookalikeSearch,
    status: profile.status === "trained" ? "json_ready" : "needs_seed_leads",
    totalResults,
    actorId: state.integrations.apify.actorIds.leadDatabase || state.icp.lookalikeSearch.actorId || "kVYdvNOefemtiDXO5",
    payload,
    generatedAt: new Date().toISOString(),
    warnings: profile.status === "trained" ? [] : ["Add ICP seed leads before running lookalike search."]
  };
  return payload;
}

async function runIcpLookalikeSearch(limit) {
  if (!state.apifyVault || !state.integrations.apify.configured) {
    state.icp.lookalikeSearch.status = "needs_apify";
    state.icp.lookalikeSearch.warnings = ["Configure Apify token before running lookalike search."];
    return { importedCount: 0 };
  }
  const actorId = state.integrations.apify.actorIds.leadDatabase || state.icp.lookalikeSearch.actorId;
  if (!actorId) {
    state.icp.lookalikeSearch.status = "needs_actor";
    state.icp.lookalikeSearch.warnings = ["Configure the PipelineLabs lead database actor before running search."];
    return { importedCount: 0 };
  }
  const payload = { ...(state.icp.lookalikeSearch.payload || buildPipelineLabsActorPayload(limit)), totalResults: limit };
  const items = await runApifyActor(actorId, payload, state.integrations.apify.maxChargeUsd);
  const prospects = normalizeCrmLeadRows(items, "linkedin").map((prospect) => ({
    ...prospect,
    status: "lookalike_found",
    notes: `${prospect.notes || "Imported from PipelineLabs Apify lookalike search."} ICP fit ${scoreIcpFit(prospect).score}%.`
  }));
  const result = importProspectsIntoState(prospects);
  state.icp.lookalikeSearch = {
    ...state.icp.lookalikeSearch,
    status: "ran",
    lastRunAt: new Date().toISOString(),
    lastImportCount: result.importedCount,
    warnings: []
  };
  return result;
}

function scoreIcpFit(prospect) {
  const profile = state.icp.profile.status === "trained" ? state.icp.profile : rebuildIcpProfile();
  if (profile.status !== "trained") return { score: 50, reasons: ["No trained ICP seed leads yet."] };
  const reasons = [];
  let score = 25;
  if (profile.titles.some((title) => titleMatch(prospect.title, title))) {
    score += 25;
    reasons.push("title matches ICP");
  }
  if (profile.functions.includes(functionFromTitle(prospect.title))) {
    score += 15;
    reasons.push("function matches ICP");
  }
  const locationCountry = countryFromLocation(prospect.location);
  if (locationCountry && profile.countries.includes(locationCountry)) {
    score += 10;
    reasons.push("country matches ICP");
  }
  const text = `${prospect.company} ${prospect.notes}`.toLowerCase();
  const matchingKeywords = profile.companyKeywords.filter((keyword) => text.includes(keyword.toLowerCase())).slice(0, 3);
  if (matchingKeywords.length) {
    score += 15;
    reasons.push(`keywords match: ${matchingKeywords.join(", ")}`);
  }
  if (profile.domains.includes(prospect.website)) {
    score += 10;
    reasons.push("same domain as seed account");
  }
  return { score: Math.min(100, score), reasons: reasons.length ? reasons : ["Partial ICP match only."] };
}

function normalizeTitleForIcp(title) {
  return cleanText(title)
    .replace(/\b(senior|sr\.?|junior|jr\.?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function seniorityFromTitle(title) {
  const text = String(title || "").toLowerCase();
  if (/founder|owner|co-founder/.test(text)) return "owner";
  if (/chief|ceo|cro|cmo|cto|coo|cfo|c-suite/.test(text)) return "c_suite";
  if (/\bvp\b|vice president/.test(text)) return "vp";
  if (/head|director/.test(text)) return "director";
  if (/manager|lead/.test(text)) return "manager";
  if (/senior|principal/.test(text)) return "senior";
  return "";
}

function functionFromTitle(title) {
  const text = String(title || "").toLowerCase();
  if (/sales|revenue|account executive|sdr|bdr|growth/.test(text)) return "sales";
  if (/marketing|demand|brand|content/.test(text)) return "marketing";
  if (/revops|operations|ops|crm|chief operating/.test(text)) return "operations";
  if (/engineering|technology|cto|product|data/.test(text)) return "engineering";
  if (/finance|cfo|accounting/.test(text)) return "finance";
  if (/hr|people|talent/.test(text)) return "human_resources";
  return "business_development";
}

function countryFromLocation(location) {
  const text = String(location || "").toLowerCase();
  if (/\buk\b|united kingdom|london|england/.test(text)) return "United Kingdom";
  if (/canada|toronto|vancouver/.test(text)) return "Canada";
  if (/ukraine|kyiv|kiev/.test(text)) return "Ukraine";
  if (/united states|usa|u\.s\.|new york|austin|chicago|miami|tx|ca|ny|fl|il/.test(text)) return "United States";
  return "";
}

function cityFromLocation(location) {
  const first = cleanText(location).split(",")[0] || "";
  return first.length > 2 && !/^(tx|ca|ny|fl|il|usa|us)$/i.test(first) ? first : "";
}

function inferIndustries(prospect, product) {
  const text = `${prospect.company} ${prospect.notes} ${product.category}`.toLowerCase();
  const industries = [];
  if (/software|saas|analytics|ai|data|technology|crm|platform/.test(text)) industries.push("Computer Software", "Information Technology & Services");
  if (/logistics|supply|transport/.test(text)) industries.push("Logistics & Supply Chain");
  if (/clinic|health|medical|hospital/.test(text)) industries.push("Hospital & Health Care");
  if (/finance|bank|invest/.test(text)) industries.push("Financial Services");
  if (/consult/.test(text)) industries.push("Management Consulting");
  return industries;
}

function inferCompanyKeywords(prospect, product) {
  const source = `${prospect.notes} ${prospect.company} ${product.useCases.join(" ")} ${product.positioning}`;
  const words = source
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4 && !["company", "teams", "using", "their", "manual", "workflow"].includes(word));
  return [...new Set(words)].slice(0, 10);
}

function inferCompanySizeBuckets(notes) {
  const text = String(notes || "").toLowerCase();
  if (/enterprise|1000|large/.test(text)) return ["1001-5000", "5001-10000"];
  if (/series b|series c|scaling|growth/.test(text)) return ["51-200", "201-500", "501-1000"];
  if (/founder|startup|seed/.test(text)) return ["1-10", "11-50"];
  return [];
}

function titleMatch(actual, expected) {
  const a = String(actual || "").toLowerCase();
  const e = String(expected || "").toLowerCase();
  return a.includes(e) || e.split(/\s+/).filter((part) => part.length > 2).some((part) => a.includes(part));
}

function topValues(values, limit) {
  const byKey = new Map();
  for (const value of values) {
    const canonical = titleForFilterValue(value);
    if (!canonical) continue;
    const key = canonical.toLowerCase();
    const existing = byKey.get(key);
    byKey.set(key, { value: canonical, count: (existing?.count || 0) + 1 });
  }
  return [...byKey.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, limit)
    .map((item) => item.value);
}

function titleForFilterValue(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  if (["c_suite", "vp", "director", "manager", "senior", "entry", "owner", "partner", "intern"].includes(raw)) return raw;
  if (["engineering", "sales", "marketing", "finance", "operations", "human_resources", "information_technology", "business_development", "support", "education", "consulting"].includes(raw)) return raw;
  if (/^\d/.test(raw) || raw.includes("_") || raw.includes("&")) return raw;
  return raw.split(/\s+/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function compactObject(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== "" && value !== null && value !== undefined;
  }));
}

function selectProspectsForAction(scope, selectedProspectId, limit) {
  const normalizedScope = cleanText(scope || "selected");
  let prospects = [];
  if (normalizedScope === "selected") {
    prospects = state.prospects.filter((prospect) => prospect.id === selectedProspectId);
  } else if (normalizedScope === "all") {
    prospects = state.prospects;
  } else {
    prospects = state.prospects.filter((prospect) => prospect.status === normalizedScope);
  }
  return prospects.slice(0, clampNumber(limit, 1, 200, 25));
}

function sortProspects(sortBy, direction = "desc") {
  const dir = direction === "asc" ? 1 : -1;
  state.prospects.sort((left, right) => {
    const leftAnalysis = analyzeLead(left);
    const rightAnalysis = analyzeLead(right);
    const values = {
      score: [left.score, right.score],
      reach: [leftAnalysis.reachProbability, rightAnalysis.reachProbability],
      close: [leftAnalysis.closeProbability, rightAnalysis.closeProbability],
      company: [left.company || "", right.company || ""],
      status: [left.status || "", right.status || ""],
      updated: [new Date(left.updatedAt).getTime(), new Date(right.updatedAt).getTime()]
    }[sortBy] || [leftAnalysis.closeProbability, rightAnalysis.closeProbability];
    if (typeof values[0] === "string") return values[0].localeCompare(values[1]) * dir;
    return (values[0] - values[1]) * dir;
  });
}

async function pushCrmActivityForProspects(prospects, input) {
  if (state.integrations.supabase.url && state.supabaseVault) {
    const supabaseResult = await pushSupabaseCrmActivities(prospects, input);
    if (supabaseResult.attempted) {
      return {
        results: supabaseResult.results,
        warnings: supabaseResult.warnings
      };
    }
  }

  if (!state.integrations.crm.baseUrl || !state.crmVault) {
    return { results: [], warnings: ["CRM activity push needs CRM base URL and API token in Settings."] };
  }
  const endpoint = state.integrations.crm.activityEndpoint || state.integrations.crm.activityObject || "activities";
  const baseUrl = state.integrations.crm.baseUrl.replace(/\/+$/, "");
  const url = endpoint.startsWith("http") ? endpoint : `${baseUrl}/${endpoint.replace(/^\/+/, "")}`;
  let pushed = 0;
  const warnings = [];
  for (const prospect of prospects.slice(0, 50)) {
    const activityAt = new Date().toISOString();
    const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${decryptSecret(state.crmVault)}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(compactObject({
        prospectId: prospect.id,
        crmRecord: crmRecordIdentifiers(prospect),
        name: prospect.name,
        company: prospect.company,
        linkedin: prospect.linkedin,
        email: prospect.email,
        phone: prospect.phone,
        status: prospect.status,
        score: prospect.score,
        type: input.interactionType,
        channel: input.channel || channelFromType(input.interactionType || ""),
        outcome: input.outcome || outcomeFromType(input.interactionType || ""),
        note: input.note,
        productId: metadata.productId || state.selectedProductId,
        productName: metadata.productName || currentProduct().name,
        metadata,
        at: activityAt
      }))
    });
    if (response.ok) pushed += 1;
    else warnings.push(`${prospect.name}: CRM HTTP ${response.status}`);
  }
  return {
    results: [{ type: "push_crm_activity", message: `${pushed} CRM activities pushed.`, pushed }],
    warnings
  };
}

async function pushSupabaseCrmActivities(prospects, input) {
  const apiKey = decryptSecret(state.supabaseVault);
  const url = `${state.integrations.supabase.url.replace(/\/+$/, "")}/rest/v1/activities`;
  let pushed = 0;
  let attempted = false;
  const warnings = [];
  for (const prospect of prospects.slice(0, 50)) {
    const crmRecord = crmRecordIdentifiers(prospect);
    const contactId = crmRecord.id || valueFromKeys(prospect.crmSource || {}, ["contact_id", "contactId"]);
    if (!contactId) {
      warnings.push(`${prospect.name}: no CRM contact id available for Supabase activity.`);
      continue;
    }
    attempted = true;
    const crmSource = prospect.crmSource && typeof prospect.crmSource === "object" ? prospect.crmSource : {};
    const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
    const payload = compactObject({
      contact_id: contactId,
      user_id: valueFromKeys(crmSource, ["owner_id", "user_id", "assigned_to"]),
      type: supabaseActivityType(input),
      content: crmActivityContent(prospect, input, metadata)
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(payload)
    });
    if (response.ok) pushed += 1;
    else warnings.push(`${prospect.name}: Supabase CRM activity HTTP ${response.status}`);
  }
  return {
    attempted,
    results: [{ type: "push_crm_activity", message: `${pushed} Supabase CRM activities pushed.`, pushed }],
    warnings
  };
}

function supabaseActivityType(input = {}) {
  const allowedTypes = new Set(["call", "email", "linkedin", "meeting", "note", "whatsapp"]);
  const rawValues = [
    input.channel,
    input.interactionType,
    input.type
  ].map((value) => cleanText(value).toLowerCase());

  for (const value of rawValues) {
    if (allowedTypes.has(value)) return value;
    if (value.includes("linkedin")) return "linkedin";
    if (value.includes("email")) return "email";
    if (value.includes("whatsapp")) return "whatsapp";
    if (value.includes("call") || value.includes("phone")) return "call";
    if (value.includes("meeting")) return "meeting";
  }

  return "note";
}

function crmActivityContent(prospect, input, metadata = {}) {
  return cleanLongText([
    input.note || "Outbound OS activity",
    `Lead: ${prospect.name}${prospect.company ? `, ${prospect.company}` : ""}`,
    metadata.productName ? `Product: ${metadata.productName}` : "",
    metadata.recommendedChannel ? `Channel: ${metadata.recommendedChannel}` : input.channel ? `Channel: ${input.channel}` : "",
    metadata.localInteractionId ? `Outbound OS interaction: ${metadata.localInteractionId}` : ""
  ].filter(Boolean).join("\n")).slice(0, 1800);
}

function crmRecordIdentifiers(prospect) {
  const source = prospect.crmSource && typeof prospect.crmSource === "object" ? prospect.crmSource : {};
  return compactObject({
    id: valueFromKeys(source, ["id", "record_id", "crm_id"]),
    leadId: valueFromKeys(source, ["lead_id", "leadId", "crm_lead_id"]),
    contactId: valueFromKeys(source, ["contact_id", "contactId", "crm_contact_id"]),
    accountId: valueFromKeys(source, ["account_id", "accountId", "company_id", "organization_id"]),
    externalId: valueFromKeys(source, ["external_id", "externalId"])
  });
}

function valueFromKeys(row, keys) {
  for (const key of keys.filter(Boolean)) {
    if (row && row[key] !== undefined && row[key] !== null && String(row[key]).trim()) return String(row[key]).trim();
  }
  return "";
}

function prospectStatuses() {
  return ["new", "enriched", "linkedin_ready", "outreach_ready", "contacted", "engaged", "call_analyzed", "follow_up_due", "meeting_booked", "review"];
}

function normalizeProspectStatus(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[\s-]+/g, "_");
  return prospectStatuses().includes(normalized) ? normalized : "";
}

function normalizeInteractionType(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[\s-]+/g, "_");
  return [
    "email_sent",
    "email_opened",
    "linkedin_profile_viewed",
    "linkedin_post_liked",
    "linkedin_comment_planned",
    "linkedin_skill_endorsed",
    "linkedin_invite_sent",
    "linkedin_invite_accepted",
    "linkedin_connected",
    "linkedin_reply",
    "sms_sent",
    "whatsapp_sent",
    "telegram_sent",
    "follow_up_scheduled",
    "research_completed",
    "contact_enriched",
    "meeting_booked",
    "no_reply",
    "call_completed",
    "note_added",
    "outreach_prepared",
    "personalization_requested"
  ].includes(normalized)
    ? normalized
    : "";
}

function inferredLimit(text, fallback) {
  const match = String(text).match(/\b(\d{1,3})\b/);
  return match ? clampNumber(Number(match[1]), 1, 200, fallback) : fallback;
}

function inferSortBy(text) {
  if (text.includes("reach")) return "reach";
  if (text.includes("close")) return "close";
  if (text.includes("score")) return "score";
  if (text.includes("company")) return "company";
  if (text.includes("status")) return "status";
  return "close";
}

function inferStatus(text) {
  if (text.includes("follow")) return "follow_up_due";
  if (text.includes("contacted")) return "contacted";
  if (text.includes("engaged") || text.includes("reply")) return "engaged";
  if (text.includes("meeting")) return "meeting_booked";
  if (text.includes("ready")) return "outreach_ready";
  if (text.includes("review")) return "review";
  if (text.includes("new")) return "new";
  return "";
}

function inferInteractionType(text) {
  if (text.includes("meeting")) return "meeting_booked";
  if (text.includes("no reply") || text.includes("no-reply")) return "no_reply";
  if (text.includes("whatsapp")) return "whatsapp_sent";
  if (text.includes("telegram")) return "telegram_sent";
  if (text.includes("sms") || text.includes("text message")) return "sms_sent";
  if (text.includes("accepted") && text.includes("invite")) return "linkedin_invite_accepted";
  if (text.includes("invite") || text.includes("connection request")) return "linkedin_invite_sent";
  if (text.includes("endorse")) return "linkedin_skill_endorsed";
  if (text.includes("comment")) return "linkedin_comment_planned";
  if (text.includes("like")) return "linkedin_post_liked";
  if (text.includes("view")) return "linkedin_profile_viewed";
  if (text.includes("reply")) return "linkedin_reply";
  if (text.includes("open")) return "email_opened";
  if (text.includes("email")) return "email_sent";
  if (text.includes("call")) return "call_completed";
  if (text.includes("linkedin")) return "linkedin_connected";
  return "note_added";
}

function callQualityScore(lowerTranscript) {
  let score = 58;
  if (lowerTranscript.includes("?")) score += 8;
  if (lowerTranscript.includes("pain") || lowerTranscript.includes("challenge") || lowerTranscript.includes("problem")) score += 8;
  if (lowerTranscript.includes("next step") || lowerTranscript.includes("follow up")) score += 12;
  if (lowerTranscript.includes("budget") || lowerTranscript.includes("timeline") || lowerTranscript.includes("decision")) score += 8;
  if (lowerTranscript.includes("demo") || lowerTranscript.includes("pilot")) score += 6;
  if (lowerTranscript.includes("feature dump")) score -= 8;
  return Math.max(10, Math.min(96, score));
}

function callImprovementTips(lowerTranscript, product) {
  const tips = [];
  if (!lowerTranscript.includes("?")) tips.push("Ask more discovery questions before pitching.");
  if (!lowerTranscript.includes("next step") && !lowerTranscript.includes("follow up")) tips.push("End with a clear agreed next step and owner.");
  if (!lowerTranscript.includes("timeline")) tips.push("Ask about timeline so follow-up urgency is grounded.");
  if (!lowerTranscript.includes("decision")) tips.push("Clarify who else is involved in the buying decision.");
  if (!lowerTranscript.includes(product.name.toLowerCase().split(" ")[0])) tips.push(`Tie the conversation back to ${product.name}'s strongest use case.`);
  return tips.length ? tips : ["Good structure. Next improvement: quantify pain and confirm the next calendar step."];
}

function inferCallObjections(lowerTranscript) {
  const objections = [];
  if (lowerTranscript.includes("budget")) objections.push("budget concern");
  if (lowerTranscript.includes("already")) objections.push("existing tool or process");
  if (lowerTranscript.includes("timing") || lowerTranscript.includes("later")) objections.push("timing");
  if (lowerTranscript.includes("data")) objections.push("data quality or integration concern");
  return objections.length ? objections : ["no clear objection detected"];
}

function dueTomorrowIso() {
  const due = new Date();
  due.setDate(due.getDate() + 1);
  due.setHours(9, 0, 0, 0);
  return due.toISOString();
}

function dueInDaysIso(days = 2, hour = 9) {
  const due = new Date();
  due.setDate(due.getDate() + clampNumber(days, 1, 30, 2));
  due.setHours(clampNumber(hour, 0, 23, 9), 0, 0, 0);
  return due.toISOString();
}

function findProspect(prospectId) {
  return state.prospects.find((prospect) => prospect.id === prospectId);
}

function normalizeInteraction(prospectId, input) {
  const type = cleanText(input.type || "note_added").slice(0, 64);
  const interaction = {
    id: `touch-${randomBytes(6).toString("hex")}`,
    prospectId,
    type,
    channel: cleanText(input.channel || channelFromType(type)).slice(0, 32),
    outcome: cleanText(input.outcome || outcomeFromType(type)).slice(0, 48),
    note: cleanText(input.note || labelFromInteraction(type)).slice(0, 500),
    at: new Date().toISOString()
  };
  if (input.metadata && typeof input.metadata === "object") {
    interaction.metadata = input.metadata;
  }
  return interaction;
}

function statusFromInteraction(type, currentStatus) {
  if (type === "meeting_booked") return "meeting_booked";
  if (type === "outreach_prepared" || type === "personalization_requested") return "outreach_ready";
  if (type === "contact_enriched" || type === "research_completed") return "enriched";
  if (type === "linkedin_reply" || type === "email_opened" || type === "linkedin_invite_accepted" || type === "linkedin_connected") return "engaged";
  if (["email_sent", "linkedin_invite_sent", "sms_sent", "whatsapp_sent", "telegram_sent"].includes(type)) return "contacted";
  if (type === "no_reply" || type === "follow_up_scheduled") return "follow_up_due";
  return currentStatus || "review";
}

function channelFromType(type) {
  if (type.startsWith("email")) return "email";
  if (type.startsWith("sms")) return "sms";
  if (type.startsWith("whatsapp")) return "whatsapp";
  if (type.startsWith("telegram")) return "telegram";
  if (type.startsWith("linkedin")) return "linkedin";
  if (type.includes("outreach") || type.includes("personalization")) return "ai";
  if (type.includes("research") || type.includes("enriched")) return "ai";
  if (type.includes("call")) return "phone";
  return "manual";
}

function outcomeFromType(type) {
  if (type === "outreach_prepared" || type === "personalization_requested") return "prepared";
  if (type === "linkedin_reply" || type === "meeting_booked" || type === "linkedin_invite_accepted" || type === "linkedin_connected") return "positive";
  if (type === "email_opened") return "opened";
  if (type === "no_reply") return "neutral";
  return "logged";
}

function labelFromInteraction(type) {
  return titleCaseServer(type);
}

function scoreProspect(prospect) {
  let score = 58;
  if (/vp|head|chief|founder|director/i.test(prospect.title)) score += 15;
  if (/sales|revenue|growth|marketing|operations/i.test(prospect.title)) score += 12;
  if (prospect.company) score += 5;
  if (prospect.notes) score += 8;
  return Math.min(96, score);
}

function bestPersonaMatch(prospect, product) {
  const text = `${prospect.title} ${prospect.notes}`.toLowerCase();
  const matched = product.targetPersonas.find((persona) =>
    persona
      .toLowerCase()
      .split(/\s+/)
      .some((token) => token.length > 2 && text.includes(token))
  );
  if (matched) return matched;
  if (text.includes("revops") || text.includes("operations")) return "Revenue Operations";
  if (text.includes("sales")) return "VP Sales";
  if (text.includes("founder")) return "Founder";
  if (text.includes("partner")) return "Partnerships";
  return product.targetPersonas[0] ?? "VP Sales";
}

function productFitForProspect(prospect, product) {
  const text = `${prospect.title} ${prospect.company} ${prospect.notes}`.toLowerCase();
  const matchedUseCases = product.useCases.filter((useCase) =>
    useCase
      .toLowerCase()
      .split(/\s+/)
      .some((token) => token.length > 4 && text.includes(token.replace(/ing$/, "")))
  );
  const persona = bestPersonaMatch(prospect, product);
  const personaMatch = product.targetPersonas.includes(persona);
  if (prospect.score >= 82 || (personaMatch && matchedUseCases.length)) {
    return { label: "high", reason: `${persona} aligns with ${matchedUseCases[0] || product.useCases[0]}` };
  }
  if (prospect.score >= 68 || personaMatch) {
    return { label: "medium", reason: `${persona} is adjacent to the product ICP` };
  }
  return { label: "developing", reason: "the available profile has limited product-specific evidence" };
}

function bestUseCaseFor(prospect, product) {
  const fit = productFitForProspect(prospect, product);
  const text = `${prospect.title} ${prospect.notes}`.toLowerCase();
  return product.useCases.find((useCase) =>
    useCase
      .toLowerCase()
      .split(/\s+/)
      .some((token) => token.length > 4 && text.includes(token.replace(/ing$/, "")))
  ) ?? product.useCases[0] ?? fit.reason;
}

function recommendedActionFor(prospect, interactions, reachProbability, closeProbability) {
  const types = new Set(interactions.map((interaction) => interaction.type));
  if (types.has("meeting_booked")) return "Prepare meeting notes, evidence, and product-specific discovery questions.";
  if (types.has("linkedin_reply")) return "Reply with a concise product-specific question and offer a short working session.";
  if (!prospect.contactDiscovery) return "Run contact discovery before drafting outreach.";
  if (!types.has("linkedin_profile_viewed") && !types.has("linkedin_viewed")) return "Open the LinkedIn profile and verify fit before first touch.";
  if (!types.has("linkedin_invite_sent") && !types.has("linkedin_connected") && !types.has("linkedin_invite_accepted")) return "Send the LinkedIn invitation and schedule the 2-3 day acceptance check.";
  if (types.has("linkedin_invite_sent") && !types.has("linkedin_invite_accepted") && !types.has("linkedin_connected")) return "Check whether the LinkedIn invitation was accepted before switching channels.";
  if ((types.has("linkedin_invite_accepted") || types.has("linkedin_connected")) && !types.has("linkedin_reply")) return "Send the LinkedIn follow-up with the tailored value angle.";
  if (!types.has("email_sent")) return "Use the tailored email as the next channel if LinkedIn has not produced a reply.";
  if (types.has("email_opened") && closeProbability > 0.18) return "Ask for a short meeting with a product-specific agenda.";
  if (types.has("no_reply")) return "Switch channel and use a lighter follow-up.";
  if (reachProbability < 0.28) return "Add one more evidence point before contacting.";
  return "Send first-touch email and schedule follow-up.";
}

function latestInteractionDays(interactions) {
  if (!interactions.length) return 0;
  const latest = Math.max(...interactions.map((interaction) => new Date(interaction.at).getTime()));
  return (Date.now() - latest) / 86_400_000;
}

function clampProbability(value) {
  return Math.max(0.03, Math.min(0.92, value));
}

function titleCaseServer(value) {
  return String(value)
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function incrementVersion(version) {
  const match = String(version).match(/^(.*?)(\d+)$/);
  if (!match) return `${version}.1`;
  return `${match[1]}${Number(match[2]) + 1}`;
}

function inferPainPoint(prospect) {
  const text = `${prospect.title} ${prospect.notes}`.toLowerCase();
  if (text.includes("revops") || text.includes("operations")) return "routing governance and CRM hygiene";
  if (text.includes("sales") || text.includes("sdr")) return "repeatable prospecting and follow-up consistency";
  if (text.includes("founder")) return "high-quality outreach without adding manual overhead";
  if (text.includes("health")) return "compliant personalization and careful claim review";
  return "research quality and outbound execution";
}

function chooseBestChannel(prospect) {
  if (prospect.linkedin || prospect.contactDiscovery?.candidates?.some((candidate) => candidate.type === "linkedin")) return "linkedin";
  if (prospect.email || prospect.contactDiscovery?.candidates?.some((candidate) => candidate.type === "email")) return "email";
  return "manual_research";
}

function productForPrompt(product) {
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    positioning: product.positioning,
    targetPersonas: product.targetPersonas,
    useCases: product.useCases,
    proofPoints: product.proofPoints,
    differentiators: product.differentiators,
    objections: product.objections,
    knowledge: productKnowledgeForPrompt(product)
  };
}

function productKnowledgeForPrompt(product, limit = 10) {
  return (product.knowledge || [])
    .slice()
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0) || new Date(right.createdAt) - new Date(left.createdAt))
    .slice(0, limit)
    .map((item) => ({
      type: item.type,
      title: item.title,
      url: item.url,
      lesson: cleanLongText(item.text || "").slice(0, 1200),
      tags: item.tags || [],
      priority: item.priority,
      screenshot: item.screenshot ? { name: item.screenshot.name, type: item.screenshot.type, available: true } : null
    }));
}

function prospectForPrompt(prospect) {
  return {
    id: prospect.id,
    name: prospect.name,
    title: prospect.title,
    company: prospect.company,
    location: prospect.location,
    website: prospect.website,
    linkedin: prospect.linkedin,
    notes: publicPersonalizationSignal(prospect),
    status: prospect.status,
    score: prospect.score
  };
}

function normalizeDomain(value) {
  const text = cleanText(value).replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
  return text.includes(".") ? text.toLowerCase() : "";
}

function normalizeUrl(value) {
  const text = cleanText(value);
  if (!text) return "";
  try {
    return new URL(text).origin;
  } catch {
    return "";
  }
}

function normalizeApifyActorId(value) {
  const text = cleanText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    const parts = url.pathname.split("/").filter(Boolean);
    const actorIndex = parts.indexOf("actors");
    return actorIndex >= 0 && parts[actorIndex + 1] ? parts[actorIndex + 1] : text;
  } catch {
    return text;
  }
}

function firstNameFor(name) {
  return cleanText(name).split(/\s+/).filter(Boolean)[0] || "";
}

function lastNameFor(name) {
  const parts = cleanText(name).split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.at(-1) : "";
}

function nameFromLinkedInUrl(value) {
  try {
    const url = new URL(value);
    const slug = url.pathname.split("/").filter(Boolean).at(1) || url.pathname.split("/").filter(Boolean).at(0) || "";
    return slug
      .replace(/-[a-z0-9]{5,}$/i, "")
      .split("-")
      .filter((part) => part && !/^\d+$/.test(part))
      .slice(0, 3)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "LinkedIn Target";
  } catch {
    return "LinkedIn Target";
  }
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 1200);
}

function cleanLongText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 30_000);
}

async function testSupabaseRest(url, apiKey) {
  const checked = { lastCheckedAt: new Date().toISOString() };
  if (!url) {
    return { ...checked, configured: false, status: "not_configured" };
  }
  if (!apiKey) {
    return { ...checked, configured: false, status: "needs_api_key" };
  }
  try {
    const response = await fetch(`${url}/rest/v1/`, {
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`
      }
    });
    return {
      ...checked,
      configured: response.ok,
      status: response.ok ? "connected" : `http_${response.status}`
    };
  } catch {
    return { ...checked, configured: false, status: "unreachable" };
  }
}

async function testPostgresTcp(host, port, hasPassword) {
  const checked = { lastCheckedAt: new Date().toISOString() };
  if (!host || !port) {
    return { ...checked, configured: false, status: "not_configured" };
  }

  const reachable = await new Promise((resolve) => {
    const socket = connectTcp({ host, port: Number(port), timeout: 5000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });

  if (!reachable) {
    return { ...checked, configured: false, status: "tcp_unreachable" };
  }
  return {
    ...checked,
    configured: hasPassword,
    status: hasPassword ? "tcp_open_credentials_saved" : "tcp_open_needs_password"
  };
}

function seedUsage() {
  const today = new Date();
  return Array.from({ length: 18 }, (_, index) => ({
    id: `usage-${index + 1}`,
    at: new Date(today.getTime() - index * 43 * 60 * 1000).toISOString(),
    taskType: taskTypes[index % taskTypes.length],
    modelId: index % 5 === 0 ? "mock/premium" : index % 2 === 0 ? "mock/economy" : "mock/balanced",
    provider: "mock",
    inputTokens: 700 + index * 45,
    outputTokens: 180 + index * 16,
    costUsd: Number((0.006 + index * 0.0037).toFixed(4)),
    latencyMs: 600 + index * 81,
    fallback: index % 6 === 0,
    schemaValidated: index % 4 !== 0
  }));
}

function initializeRuntimeConfigFromEnv() {
  const now = new Date().toISOString();
  const appEnv = process.env.APP_ENV || process.env.NODE_ENV;
  if (["production", "staging", "development"].includes(appEnv)) {
    state.environment = appEnv;
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY || "";
  if (openRouterKey.trim()) {
    state.vault = encryptSecret(openRouterKey.trim());
    state.openRouterEnabled = true;
    updateOpenRouterDefaults({
      analysisModel: process.env.OPENROUTER_ANALYSIS_MODEL,
      writingModel: process.env.OPENROUTER_WRITING_MODEL
    });
    state.keyMetadata = {
      provider: "openrouter",
      environment: state.environment,
      keyVersion: 1,
      rotatedAt: now,
      source: "server_environment"
    };
    state.providerHealth = {
      status: "configured_pending_test",
      latencyMs: 0,
      lastCheckedAt: now
    };
    addEvent("provider", "OpenRouter key loaded from server environment.");
  }

  const apifyToken = process.env.APIFY_API_TOKEN || "";
  if (apifyToken.trim()) {
    state.apifyVault = encryptSecret(apifyToken.trim());
    state.integrations.apify.configured = true;
    state.integrations.apify.status = "configured";
    state.integrations.apify.actorIds = {
      ...state.integrations.apify.actorIds,
      leadDatabase: normalizeApifyActorId(process.env.APIFY_LEAD_DATABASE_ACTOR_ID || state.integrations.apify.actorIds.leadDatabase),
      linkedinProfile: normalizeApifyActorId(process.env.APIFY_LINKEDIN_PROFILE_ACTOR_ID || state.integrations.apify.actorIds.linkedinProfile),
      contactFinder: normalizeApifyActorId(process.env.APIFY_CONTACT_FINDER_ACTOR_ID || state.integrations.apify.actorIds.contactFinder),
      apollo: normalizeApifyActorId(process.env.APIFY_APOLLO_ACTOR_ID || state.integrations.apify.actorIds.apollo),
      zoominfo: normalizeApifyActorId(process.env.APIFY_ZOOMINFO_ACTOR_ID || state.integrations.apify.actorIds.zoominfo),
      facebookProfile: normalizeApifyActorId(process.env.APIFY_FACEBOOK_PROFILE_ACTOR_ID || state.integrations.apify.actorIds.facebookProfile),
      emailPhoneFinder: normalizeApifyActorId(process.env.APIFY_EMAIL_PHONE_FINDER_ACTOR_ID || state.integrations.apify.actorIds.emailPhoneFinder),
      phoneMessengerCheck: normalizeApifyActorId(process.env.APIFY_PHONE_MESSENGER_CHECK_ACTOR_ID || state.integrations.apify.actorIds.phoneMessengerCheck)
    };
    state.integrations.apify.maxChargeUsd = clampNumber(process.env.APIFY_MAX_CHARGE_USD, 0.01, 50, state.integrations.apify.maxChargeUsd);
    state.integrations.apify.keyMetadata = {
      provider: "apify",
      keyVersion: 1,
      configuredAt: now,
      source: "server_environment"
    };
    addEvent("integration", "Apify configuration loaded from server environment.");
  }

  const mcpBaseUrl = normalizeUrl(process.env.MCP_PORTAL_BASE_URL || "");
  if (mcpBaseUrl || process.env.MCP_API_TOKEN) {
    state.mcpSync.baseUrl = mcpBaseUrl;
    state.mcpSync.resourceNamespace = cleanText(process.env.MCP_RESOURCE_NAMESPACE || state.mcpSync.resourceNamespace);
    state.mcpSync.status = mcpBaseUrl ? "configured" : "needs_url";
    state.mcpSync.lastSyncedAt = now;
    if (process.env.MCP_API_TOKEN) {
      state.mcpVault = encryptSecret(process.env.MCP_API_TOKEN);
      state.mcpSync.keyMetadata = {
        provider: "mcp",
        keyVersion: 1,
        configuredAt: now,
        source: "server_environment"
      };
    }
  }

  const crmBaseUrl = normalizeUrl(process.env.CRM_API_BASE_URL || "");
  if (crmBaseUrl || process.env.CRM_API_TOKEN) {
    state.integrations.crm.baseUrl = crmBaseUrl;
    state.integrations.crm.name = cleanText(process.env.CRM_NAME || state.integrations.crm.name);
    state.integrations.crm.leadEndpoint = cleanText(process.env.CRM_LEAD_ENDPOINT || state.integrations.crm.leadEndpoint);
    state.integrations.crm.activityEndpoint = cleanText(process.env.CRM_ACTIVITY_ENDPOINT || state.integrations.crm.activityEndpoint);
    state.integrations.crm.syncDirection = cleanText(process.env.CRM_SYNC_DIRECTION || state.integrations.crm.syncDirection);
    if (process.env.CRM_API_TOKEN) state.crmVault = encryptSecret(process.env.CRM_API_TOKEN);
    state.integrations.crm.configured = Boolean(state.crmVault && crmBaseUrl);
    state.integrations.crm.status = state.integrations.crm.configured ? "configured" : "needs_credentials";
    state.integrations.crm.keyMetadata = state.crmVault
      ? { provider: "crm", keyVersion: 1, configuredAt: now, source: "server_environment" }
      : state.integrations.crm.keyMetadata;
  }

  if (process.env.SUPABASE_URL || process.env.SUPABASE_API_KEY) {
    state.integrations.supabase.url = normalizeUrl(process.env.SUPABASE_URL || state.integrations.supabase.url);
    if (process.env.SUPABASE_API_KEY) state.supabaseVault = encryptSecret(process.env.SUPABASE_API_KEY);
    state.integrations.supabase.configured = Boolean(state.integrations.supabase.url && state.supabaseVault);
    state.integrations.supabase.status = state.integrations.supabase.configured ? "configured" : "needs_api_key";
    state.integrations.supabase.lastCheckedAt = now;
    state.integrations.supabase.keyMetadata = state.supabaseVault
      ? { provider: "supabase", keyVersion: 1, configuredAt: now, source: "server_environment" }
      : state.integrations.supabase.keyMetadata;
  }

  if (process.env.POSTGRES_HOST) {
    state.integrations.postgres.host = cleanText(process.env.POSTGRES_HOST);
    state.integrations.postgres.port = clampNumber(process.env.POSTGRES_PORT, 1, 65535, state.integrations.postgres.port);
    state.integrations.postgres.database = cleanText(process.env.POSTGRES_DATABASE || state.integrations.postgres.database);
    state.integrations.postgres.user = cleanText(process.env.POSTGRES_USER || state.integrations.postgres.user);
    if (process.env.POSTGRES_PASSWORD) state.postgresVault = encryptSecret(process.env.POSTGRES_PASSWORD);
    state.integrations.postgres.configured = Boolean(state.integrations.postgres.host && state.integrations.postgres.user && state.postgresVault);
    state.integrations.postgres.status = state.integrations.postgres.configured ? "configured" : "needs_password";
    state.integrations.postgres.lastCheckedAt = now;
    state.integrations.postgres.keyMetadata = state.postgresVault
      ? { provider: "postgres", keyVersion: 1, configuredAt: now, source: "server_environment" }
      : state.integrations.postgres.keyMetadata;
  }
}

async function warmRuntimeConnections() {
  if (!state.vault) return;
  await testOpenRouterConnection(decryptSecret(state.vault));
  if (state.providerHealth.status !== "healthy") return;
  await syncOpenRouterModels(decryptSecret(state.vault));
  enablePreferredOpenRouterModels();
}

function updateOpenRouterDefaults(input = {}) {
  const analysisModel = cleanText(input.analysisModel || input.haikuModel || state.aiModelDefaults.analysisModel || openRouterDefaults.analysisModel);
  const writingModel = cleanText(input.writingModel || input.sonnetModel || state.aiModelDefaults.writingModel || openRouterDefaults.writingModel);
  state.aiModelDefaults = {
    analysisModel: analysisModel || openRouterDefaults.analysisModel,
    writingModel: writingModel || openRouterDefaults.writingModel
  };
}

async function testOpenRouterConnection(apiKey) {
  const startedAt = performance.now();
  try {
    const openRouterResponse = await fetch("https://openrouter.ai/api/v1/models", {
      headers: openRouterHeaders(apiKey)
    });
    state.providerHealth = {
      status: openRouterResponse.ok ? "healthy" : `http_${openRouterResponse.status}`,
      latencyMs: Math.round(performance.now() - startedAt),
      lastCheckedAt: new Date().toISOString()
    };
    addEvent("provider", `OpenRouter connection test ${openRouterResponse.ok ? "passed" : "failed"}.`);
  } catch (error) {
    state.providerHealth = {
      status: "unreachable",
      latencyMs: Math.round(performance.now() - startedAt),
      lastCheckedAt: new Date().toISOString()
    };
    addEvent("provider", error instanceof Error ? error.message : "OpenRouter connection failed.");
  }
}

async function syncOpenRouterModels(apiKey) {
  try {
    const openRouterResponse = await fetch("https://openrouter.ai/api/v1/models", {
      headers: openRouterHeaders(apiKey)
    });
    if (!openRouterResponse.ok) {
      throw new Error(`OpenRouter returned HTTP ${openRouterResponse.status}.`);
    }
    const payload = await openRouterResponse.json();
    const synced = (payload.data ?? []).map(mapOpenRouterModel);
    const enabled = new Set(state.models.filter((model) => model.enabled).map((model) => model.id));
    state.models = mergeModels(state.models, synced).map((model) => ({
      ...model,
      enabled: enabled.has(model.id) || model.enabled
    }));
    addEvent("registry", `${synced.length} OpenRouter models synchronized.`);
  } catch (error) {
    addEvent("registry", error instanceof Error ? error.message : "Model synchronization failed.");
  }
}

function enablePreferredOpenRouterModels() {
  ensureOpenRouterModel(state.aiModelDefaults.analysisModel, "Anthropic: Claude Haiku 4.5", "economy", 1, 5);
  ensureOpenRouterModel(state.aiModelDefaults.writingModel, "Anthropic: Claude Sonnet 5", "premium", 2, 10);
  const preferred = new Set([state.aiModelDefaults.analysisModel, state.aiModelDefaults.writingModel]);
  state.models = state.models.map((model) => preferred.has(model.id) ? { ...model, enabled: true, availability: "available" } : model);
  for (const task of state.tasks) {
    if (analysisTaskTypes().has(task.taskType)) {
      task.primaryModel = state.aiModelDefaults.analysisModel;
      task.fallbackModels = [state.aiModelDefaults.writingModel, "mock/balanced"];
    }
    if (writingTaskTypes().has(task.taskType)) {
      task.primaryModel = state.aiModelDefaults.writingModel;
      task.fallbackModels = [state.aiModelDefaults.analysisModel, "mock/balanced"];
    }
  }
}

function ensureOpenRouterModel(id, displayName, tier, inputPrice, outputPrice) {
  if (state.models.some((model) => model.id === id)) return;
  state.models.push({
    id,
    displayName,
    provider: "openrouter",
    tier,
    contextWindow: id.includes("sonnet") ? 1000000 : 200000,
    inputPrice,
    outputPrice,
    latencyMs: 0,
    qualityScore: tier === "premium" ? 88 : 76,
    reliabilityScore: 90,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    promptCaching: true,
    noTraining: false,
    zeroRetention: false,
    enabled: true,
    availability: "available",
    source: "openrouter",
    lastSynchronizedAt: new Date().toISOString()
  });
}

function analysisTaskTypes() {
  return new Set([
    "ICP_ANALYSIS",
    "ACCOUNT_QUALIFICATION",
    "PROSPECT_QUALIFICATION",
    "COMPANY_RESEARCH_SUMMARY",
    "PERSON_RESEARCH_SUMMARY",
    "PAIN_POINT_HYPOTHESIS",
    "BUYING_TRIGGER_DETECTION",
    "CONTACT_DATA_CLASSIFICATION",
    "LEAD_SCORING",
    "MESSAGE_QUALITY_REVIEW",
    "CRM_NOTE_SUMMARY",
    "SALES_COACHING",
    "CAMPAIGN_ANALYSIS",
    "MCP_CONTEXT_SYNTHESIS"
  ]);
}

function writingTaskTypes() {
  return new Set([
    "LINKEDIN_CONNECTION_MESSAGE",
    "LINKEDIN_FOLLOW_UP",
    "LINKEDIN_COMMENT",
    "COLD_EMAIL",
    "EMAIL_FOLLOW_UP",
    "WHATSAPP_DRAFT",
    "TELEGRAM_DRAFT",
    "CALL_OPENER",
    "VOICEMAIL_SCRIPT",
    "OBJECTION_HANDLING",
    "SEQUENCE_GENERATION",
    "NEXT_BEST_ACTION"
  ]);
}

function openRouterHeaders(apiKey = decryptSecret(state.vault)) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "http://localhost",
    "X-Title": "Outbound Sales OS"
  };
}

async function callOpenRouterJson({ model, taskType, profile, messages, maxTokens = 1200 }) {
  const startedAt = performance.now();
  const requestBody = {
    model,
    messages,
    temperature: profile === "premium" ? 0.45 : 0.35,
    max_tokens: maxTokens,
    response_format: { type: "json_object" }
  };

  let payload;
  try {
    payload = await postOpenRouterChat(requestBody);
  } catch (error) {
    if (String(error?.message || "").includes("response_format")) {
      const retryBody = { ...requestBody };
      delete retryBody.response_format;
      payload = await postOpenRouterChat(retryBody);
    } else {
      throw error;
    }
  }

  const content = payload.choices?.[0]?.message?.content || "";
  const data = await parseOrRepairOpenRouterJson(content, { taskType, model });
  const inputTokens = Number(payload.usage?.prompt_tokens || payload.usage?.input_tokens || estimateTextTokens(messages.map(messageContentForTokens).join("\n")));
  const outputTokens = Number(payload.usage?.completion_tokens || payload.usage?.output_tokens || estimateTextTokens(content));
  const usage = recordOpenRouterUsage({
    taskType,
    modelId: model,
    inputTokens,
    outputTokens,
    latencyMs: Math.round(performance.now() - startedAt),
    schemaValidated: true
  });
  const run = {
    ok: true,
    modelUsed: model,
    provider: "openrouter",
    fallback: false,
    attempts: [],
    usage
  };
  addEvent("request", `${taskType} used ${model} through OpenRouter.`);
  return { data, run };
}

function messageContentForTokens(message) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part?.type === "text") return part.text || "";
      if (part?.type === "image_url") return "[image]";
      return JSON.stringify(part || {});
    }).join("\n");
  }
  return JSON.stringify(content || {});
}

async function parseOrRepairOpenRouterJson(content, context) {
  try {
    return parseJsonObject(content);
  } catch (parseError) {
    const repairPayload = await postOpenRouterChat({
      model: state.aiModelDefaults.analysisModel,
      messages: [
        {
          role: "system",
          content: "Repair malformed JSON. Return only valid strict JSON. Preserve all useful content. Use escaped newlines in strings."
        },
        {
          role: "user",
          content: JSON.stringify({
            task: context.taskType,
            sourceModel: context.model,
            malformedJson: String(content || "").slice(0, 12000),
            parseError: parseError instanceof Error ? parseError.message : String(parseError)
          })
        }
      ],
      temperature: 0,
      max_tokens: 1400,
      response_format: { type: "json_object" }
    });
    return parseJsonObject(repairPayload.choices?.[0]?.message?.content || "");
  }
}

async function postOpenRouterChat(body) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: openRouterHeaders(),
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter chat HTTP ${response.status}: ${text.slice(0, 220)}`);
  }
  return JSON.parse(text);
}

function parseJsonObject(text) {
  const cleaned = String(text || "").replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstObject = extractFirstJsonObject(cleaned);
    if (firstObject) return JSON.parse(firstObject);
    throw new Error("OpenRouter returned non-JSON content.");
  }
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return "";
}

function recordOpenRouterUsage({ taskType, modelId, inputTokens, outputTokens, latencyMs, schemaValidated }) {
  const model = state.models.find((item) => item.id === modelId) || {};
  const inputCost = (inputTokens / 1000000) * Number(model.inputPrice || 0);
  const outputCost = (outputTokens / 1000000) * Number(model.outputPrice || 0);
  const usage = {
    id: `usage-${state.usage.length + 1}`,
    at: new Date().toISOString(),
    taskType,
    modelId,
    provider: "openrouter",
    inputTokens,
    outputTokens,
    costUsd: Number((inputCost + outputCost).toFixed(6)),
    latencyMs,
    fallback: false,
    schemaValidated
  };
  state.usage.unshift(usage);
  return usage;
}

function estimateTextTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function mapOpenRouterModel(model) {
  const supported = new Set(model.supported_parameters ?? []);
  const id = model.id || "unknown";
  const prompt = Number.parseFloat(model.pricing?.prompt ?? "0") * 1000000;
  const completion = Number.parseFloat(model.pricing?.completion ?? "0") * 1000000;
  return {
    id,
    displayName: model.name || id,
    provider: "openrouter",
    tier: inferTier(id, prompt + completion),
    contextWindow: model.context_length || model.top_provider?.context_length || 4096,
    inputPrice: Number.isFinite(prompt) ? Number(prompt.toFixed(4)) : 0,
    outputPrice: Number.isFinite(completion) ? Number(completion.toFixed(4)) : 0,
    latencyMs: 0,
    qualityScore: inferQuality(id),
    reliabilityScore: 85,
    toolCalling: supported.has("tools") || supported.has("tool_choice"),
    structuredOutput: supported.has("response_format") || supported.has("structured_outputs"),
    streaming: true,
    promptCaching: supported.has("cache_control"),
    noTraining: false,
    zeroRetention: false,
    enabled: false,
    availability: "available",
    source: "openrouter",
    lastSynchronizedAt: new Date().toISOString()
  };
}

function inferTier(id, totalPrice) {
  if (/opus|o3|reasoning|pro|max/i.test(id) || totalPrice > 10) return "premium";
  if (/mini|flash|haiku|small|lite/i.test(id) || totalPrice < 1) return "economy";
  return "balanced";
}

function inferQuality(id) {
  if (/opus|o3|reasoning|pro|max/i.test(id)) return 92;
  if (/sonnet|gpt-4|gemini|llama/i.test(id)) return 84;
  return 72;
}

function mergeModels(current, incoming) {
  const byId = new Map(current.map((model) => [model.id, model]));
  for (const model of incoming) {
    byId.set(model.id, { ...(byId.get(model.id) ?? {}), ...model });
  }
  return [...byId.values()].sort((left, right) => right.qualityScore - left.qualityScore);
}

function localFallbackRun(taskType, profile) {
  return {
    ok: true,
    modelUsed: profile === "premium" ? "mock/premium" : profile === "economy" ? "mock/economy" : "mock/balanced",
    provider: "mock",
    fallback: true,
    attempts: [{ modelId: state.aiModelDefaults.writingModel, status: "fallback_available" }],
    usage: null,
    taskType
  };
}

function simulateRun(taskType, profile, preferredModel) {
  const task = state.tasks.find((item) => item.taskType === taskType) || state.tasks.find((item) => item.taskType === "COLD_EMAIL");
  const candidates = [preferredModel, task.primaryModel, ...task.fallbackModels].filter(Boolean);
  const attempts = [];
  let selected = null;
  for (const modelId of [...new Set(candidates)]) {
    const model = state.models.find((item) => item.id === modelId);
    if (!model) {
      attempts.push({ modelId, status: "missing" });
      continue;
    }
    if (!model.enabled || model.availability !== "available") {
      attempts.push({ modelId, status: "blocked" });
      continue;
    }
    if ((state.providerRule.requireZeroRetention || task.privacyLevel === "zero_retention") && !model.zeroRetention) {
      attempts.push({ modelId, status: "privacy_blocked" });
      continue;
    }
    if ((state.providerRule.requireNoTraining || task.privacyLevel === "no_training") && !model.noTraining) {
      attempts.push({ modelId, status: "privacy_blocked" });
      continue;
    }
    const estimatedCost = estimateRunCost(model, profile);
    if (estimatedCost > task.maxCostUsd && state.budgets.hardLimitEnabled) {
      attempts.push({ modelId, status: "cost_blocked", estimatedCost });
      continue;
    }
    selected = { model, estimatedCost };
    break;
  }

  if (!selected) {
    const result = {
      ok: false,
      message: "No approved model satisfied routing, privacy, and cost policy.",
      attempts
    };
    addEvent("request", result.message);
    return result;
  }

  const fallback = attempts.length > 0;
  const usage = {
    id: `usage-${state.usage.length + 1}`,
    at: new Date().toISOString(),
    taskType: task.taskType,
    modelId: selected.model.id,
    provider: selected.model.provider,
    inputTokens: profile === "premium" ? 2200 : profile === "economy" ? 580 : 1100,
    outputTokens: profile === "premium" ? 760 : profile === "economy" ? 170 : 380,
    costUsd: selected.estimatedCost,
    latencyMs: selected.model.latencyMs || Math.round(600 + Math.random() * 700),
    fallback,
    schemaValidated: task.structuredOutput
  };
  state.usage.unshift(usage);
  addEvent("request", `${task.taskType} used ${selected.model.displayName}${fallback ? " after fallback" : ""}.`);
  return {
    ok: true,
    modelUsed: selected.model.id,
    provider: selected.model.provider,
    fallback,
    attempts,
    usage
  };
}

function estimateRunCost(model, profile) {
  const inputTokens = profile === "premium" ? 2200 : profile === "economy" ? 580 : 1100;
  const outputTokens = profile === "premium" ? 760 : profile === "economy" ? 170 : 380;
  const inputCost = (inputTokens / 1000000) * model.inputPrice;
  const outputCost = (outputTokens / 1000000) * model.outputPrice;
  return Number((inputCost + outputCost).toFixed(6));
}

function summarizeUsage() {
  const totalCostUsd = state.usage.reduce((total, item) => total + item.costUsd, 0);
  const totalTokens = state.usage.reduce((total, item) => total + item.inputTokens + item.outputTokens, 0);
  const avgLatencyMs = Math.round(state.usage.reduce((total, item) => total + item.latencyMs, 0) / Math.max(1, state.usage.length));
  const fallbackRate = state.usage.filter((item) => item.fallback).length / Math.max(1, state.usage.length);
  const schemaRate = state.usage.filter((item) => item.schemaValidated).length / Math.max(1, state.usage.length);
  const spendByModel = state.usage.reduce((acc, item) => {
    acc[item.modelId] = Number(((acc[item.modelId] ?? 0) + item.costUsd).toFixed(4));
    return acc;
  }, {});
  return {
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    totalTokens,
    avgLatencyMs,
    fallbackRate,
    schemaRate,
    spendByModel,
    budgetUsedPercent: Math.min(100, (totalCostUsd / state.budgets.monthlyWorkspaceBudgetUsd) * 100)
  };
}

function addEvent(type, text) {
  state.events.unshift({ at: new Date().toISOString(), type, text });
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}
