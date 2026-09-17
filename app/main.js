let state = null;
let selectedTaskType = "COLD_EMAIL";
let selectedProspectId = null;
let creatingNewProduct = false;
let busyAction = "";
let busyMessage = "";
let uiNotice = "";
let pendingProductKnowledgeScreenshot = null;
let pendingLearningScreenshot = null;
let pendingKnowledgeInboxScreenshot = null;
let activeLeadSectionId = "dashboard-account";
let authState = null;
let authMode = "login";
let activeResearchJob = null;

const views = [...document.querySelectorAll(".view")];
const navItems = [...document.querySelectorAll(".nav-item")];

const formatUsd = (value) => `$${Number(value || 0).toFixed(4)}`;
const formatPct = (value) => `${Math.round((value || 0) * 100)}%`;
const titleCase = (value) =>
  value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== "/api/auth/status" && !path.startsWith("/api/auth/")) {
      authState = { authenticated: false, bootstrapRequired: Boolean(body.bootstrapRequired) };
      showAuthGate();
    }
    const failure = new Error(body.error || `Request failed with ${response.status}`);
    failure.status = response.status;
    failure.payload = body;
    throw failure;
  }
  return response.json();
}

async function refresh() {
  state = await api("/api/state");
  render();
}

function render() {
  renderTopbar();
  renderProductContext();
  renderProductStudio();
  renderAccount();
  renderLearningDatabase();
  renderIntegrations();
  renderProspects();
  renderLeadsPage();
  renderAssistant();
  renderAgents();
  renderOverview();
  renderModels();
  renderRouting();
  renderBudgets();
  renderPrivacy();
  renderEvaluation();
  renderBusyState();
  renderResearchProgress();
  refreshIcons();
}

function renderTopbar() {
  const runtime = state.aiRuntime?.mode === "openrouter" ? "OpenRouter live" : "Mock AI";
  document.getElementById("workspaceMeta").textContent = busyMessage || uiNotice || `${runtime} · ${state.prospects?.length || 0} leads · ${state.followUpTasks?.length || 0} follow-ups`;
  document.getElementById("providerStatus").textContent = state.providerHealth.status;
  document.getElementById("healthPill").textContent = state.providerHealth.status;
  document.getElementById("keyState").textContent = state.hasOpenRouterKey
    ? `Key version ${state.keyMetadata.keyVersion} · ${state.keyMetadata.environment}`
    : "No key configured";
  fillSelect(document.getElementById("productSelect"), state.products, (product) => product.id, (product) => product.name, state.selectedProductId);
}

async function bootApplication() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  if (hash.get("type") === "recovery" && hash.get("access_token")) {
    authMode = "reset";
    window.sessionStorage.setItem("outboundRecoveryToken", hash.get("access_token"));
  }
  authState = await api("/api/auth/status");
  if (!authState.authenticated) {
    if (authState.bootstrapRequired) authMode = "bootstrap";
    showAuthGate();
    return;
  }
  await enterWorkspace();
}

function showAuthGate() {
  document.getElementById("authGate").hidden = false;
  document.getElementById("appShell").hidden = true;
  renderAuthForm();
  refreshIcons();
}

async function enterWorkspace() {
  document.getElementById("authGate").hidden = true;
  document.getElementById("appShell").hidden = false;
  authState = await api("/api/auth/status");
  await refresh();
  const saved = rememberedView();
  if (saved) setView(saved);
}

function renderAuthForm() {
  const bootstrap = authMode === "bootstrap";
  const recover = authMode === "recover";
  const reset = authMode === "reset";
  setText("authEyebrow", bootstrap ? "Create workspace owner" : recover || reset ? "Account recovery" : "Secure workspace");
  setText("authTitle", bootstrap ? "Set up Outbound OS" : recover ? "Recover password" : reset ? "Choose a new password" : "Sign in");
  setText("authDescription", bootstrap ? "Create the first administrator account for your team." : recover ? "We will request a secure reset link from Supabase." : reset ? "Set a new password for your account." : "Use your company account to continue.");
  document.querySelector(".auth-name-field").hidden = !bootstrap;
  document.querySelector(".auth-email-field").hidden = reset;
  document.querySelector(".auth-password-field").hidden = recover;
  document.querySelector(".auth-confirm-field").hidden = !bootstrap && !reset;
  document.getElementById("authEmailInput").required = !reset;
  document.getElementById("authPasswordInput").required = !recover;
  document.getElementById("authConfirmInput").required = bootstrap || reset;
  document.getElementById("authNameInput").required = bootstrap;
  document.getElementById("authPasswordInput").autocomplete = bootstrap || reset ? "new-password" : "current-password";
  setText("authSubmitBtn", "");
  document.getElementById("authSubmitBtn").innerHTML = `<i data-lucide="${recover ? "mail" : reset ? "key-round" : bootstrap ? "shield-check" : "log-in"}"></i><span>${recover ? "Send reset link" : reset ? "Save new password" : bootstrap ? "Create workspace" : "Sign in"}</span>`;
  const modeButton = document.getElementById("authModeBtn");
  modeButton.hidden = bootstrap || reset;
  modeButton.textContent = recover ? "Back to sign in" : "Forgot password?";
}

function renderAccount() {
  const user = authState?.user;
  if (!user) return;
  setText("accountRolePill", user.role || "seller");
  document.getElementById("accountNameInput").value = user.name || "";
  document.getElementById("accountTitleInput").value = user.title || "";
  document.getElementById("accountEmailInput").value = user.email || "";
  const adminPanel = document.getElementById("adminTeamPanel");
  adminPanel.hidden = user.role !== "admin";
  setHtml("teamUserList", (authState.team || []).map((member) => `
    <article class="team-row"><div><strong>${escapeHtml(member.name)}</strong><span>${escapeHtml(member.email)}</span></div><span class="pill">${escapeHtml(member.role)}</span></article>
  `).join(""));
}

function renderProductContext() {
  const selected = state.prospects?.find((prospect) => prospect.id === selectedProspectId);
  setHtml("companyBriefContent", companyBriefRows(selected));
  setText("companyConfidencePill", companyConfidenceLabel(selected));
  setText("companyBriefMeta", selected?.company ? `${selected.company} account context for ${state.selectedProduct?.name || "selected product"}` : "What this company does, who they sell to, and why this lead may matter");
}

function renderProductStudio() {
  const product = creatingNewProduct ? emptyProductDraft() : state.selectedProduct;
  if (!product) return;

  const studioSelect = document.getElementById("productStudioProductSelect");
  if (studioSelect) fillSelect(studioSelect, state.products || [], (item) => item.id, (item) => item.name, state.selectedProductId);
  document.getElementById("productStudioSelected").textContent = product.name || "selected product";
  const deleteButton = document.getElementById("deleteProductBtn");
  if (deleteButton) deleteButton.disabled = creatingNewProduct || (state.products || []).length <= 1;
  const teachButtonText = document.querySelector("#productTeachBtn span");
  if (teachButtonText) teachButtonText.textContent = creatingNewProduct ? "Analyze & Create Product" : "Analyze & Update Product";
  renderProductMemory(product);
  document.getElementById("exampleList").innerHTML = (product.examples || []).length
    ? product.examples.map(exampleRow).join("")
    : `<div class="empty-state">No examples loaded for this product</div>`;
}

function renderProductMemory(product) {
  const memory = product.memory || {};
  const segments = memory.segments || {};
  setText("productMemoryStatus", `${memory.status || "not trained"} · ${Number(memory.confidence || 0)}%`);
  setHtml("productMemorySummary", `
    <div class="product-memory-card">
      <strong>${escapeHtml(product.name || "Product")}</strong>
      <p>${escapeHtml(memory.summary || product.positioning || "Paste product context to train the system memory.")}</p>
      <div class="mini-facts">
        <span>${escapeHtml(product.category || "Product")}</span>
        <span>${escapeHtml((product.targetPersonas || [])[0] || "buyer persona needed")}</span>
        <span>${escapeHtml((product.useCases || [])[0] || "use case needed")}</span>
      </div>
    </div>
  `);
  setHtml("productScoreList", (memory.scoring || []).length
    ? memory.scoring.map((item) => `
      <div class="product-score-row">
        <span>${escapeHtml(item.label)}</span>
        <strong>${Number(item.score || 0)}</strong>
        <small>${escapeHtml(item.rationale || "")}</small>
      </div>
    `).join("")
    : `<div class="empty-state">No scoring rubric yet. Paste product context to create one.</div>`);
  const segmentLabels = {
    idealCustomers: "Ideal Customers",
    buyerPersonas: "Buyer Personas",
    painPoints: "Pain Points",
    buyingTriggers: "Buying Triggers",
    exclusions: "Exclusions",
    salesAngles: "Sales Angles",
    proofPoints: "Proof",
    objections: "Objections",
    discoveryQuestions: "Discovery Questions",
    claimsToAvoid: "Claims To Avoid",
    qualificationCriteria: "Qualification Criteria"
  };
  setHtml("productMemorySegments", Object.entries(segmentLabels).map(([key, label]) => memorySegmentCard(label, segments[key] || [])).join(""));
  const knowledge = product.knowledge || [];
  setHtml("productKnowledgeList", knowledge.length
    ? knowledge.slice(0, 8).map(productKnowledgeRow).join("")
    : `<div class="empty-state">No saved product context updates yet</div>`);
}

function memorySegmentCard(label, values) {
  const items = (values || []).slice(0, 8);
  return `
    <article class="memory-segment-card">
      <strong>${escapeHtml(label)}</strong>
      ${items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p>Needs product data.</p>`}
    </article>
  `;
}

function renderIntegrations() {
  document.getElementById("aiRuntimeStatus").textContent = state.aiRuntime?.mode === "openrouter" ? "OpenRouter live" : "Mock AI";
  document.getElementById("openRouterModelCount").textContent = `${state.aiRuntime?.syncedOpenRouterModels || 0} synced`;
  document.getElementById("apifyStatus").textContent = state.integrations?.apify?.status || "not_configured";
  document.getElementById("contactEnrichmentStatus").textContent = state.integrations?.apify?.configured
    ? state.integrations.apify.enrichmentMode || "cost-capped Apify"
    : "not configured";
  document.getElementById("crmStatus").textContent = state.integrations?.crm?.status || "not_configured";
  document.getElementById("transcriptStatus").textContent = state.integrations?.transcripts?.status || "manual_paste";
  document.getElementById("notificationStatus").textContent = state.integrations?.notifications?.status || "in_app";
  document.getElementById("supabaseStatus").textContent = state.integrations?.supabase?.status || "not_configured";
  document.getElementById("postgresStatus").textContent = state.integrations?.postgres?.status || "not_configured";
  document.getElementById("knowledgeDatabaseStatus").textContent = state.integrations?.knowledgeDatabase?.status || "not_configured";

  document.getElementById("analysisModelInput").value = state.aiModelDefaults?.analysisModel || "anthropic/claude-haiku-4.5";
  document.getElementById("writingModelInput").value = state.aiModelDefaults?.writingModel || "anthropic/claude-sonnet-5";

  const apify = state.integrations?.apify;
  document.getElementById("leadDatabaseActorInput").value = apify?.actorIds?.leadDatabase || "";
  document.getElementById("leadDatabaseInputTemplate").value = apify?.actorInputTemplates?.leadDatabase || "";
  document.getElementById("linkedinActorInput").value = apify?.actorIds?.linkedinProfile || "";
  document.getElementById("contactFinderActorInput").value = apify?.actorIds?.contactFinder || "inexhaustible_glass/linkedin-email-finder";
  document.getElementById("apolloActorInput").value = apify?.actorIds?.apollo || "";
  document.getElementById("zoominfoActorInput").value = apify?.actorIds?.zoominfo || "";
  document.getElementById("facebookProfileActorInput").value = apify?.actorIds?.facebookProfile || "";
  document.getElementById("emailPhoneFinderActorInput").value = apify?.actorIds?.emailPhoneFinder || "";
  document.getElementById("phoneMessengerCheckActorInput").value = apify?.actorIds?.phoneMessengerCheck || "";
  document.getElementById("whatsappCheckerActorInput").value = apify?.actorIds?.whatsappChecker || "vtrdev/whatsapp-number-validator";
  document.getElementById("telegramCheckerActorInput").value = apify?.actorIds?.telegramChecker || "akula.marketing/telegram-get-phone-info";
  document.getElementById("companyPeopleActorInput").value = apify?.actorIds?.companyPeople || "harvestapi/linkedin-company-employees";
  document.getElementById("companyPeopleSecondaryActorInput").value = apify?.actorIds?.companyPeopleSecondary || "scraper-engine/linkedin-company-employees-scraper";
  document.getElementById("personEnrichmentActorInput").value = apify?.actorIds?.personEnrichment || "enrich-crm/enrich-crm-enrich-contact";
  document.getElementById("companyPeopleInputTemplate").value = apify?.actorInputTemplates?.companyPeople || "";
  document.getElementById("apifyMaxChargeInput").value = apify?.maxChargeUsd || 1.5;
  document.getElementById("apifyContactMaxChargeInput").value = apify?.contactMaxChargeUsd || 0.2;
  document.getElementById("apifyMaxActorsInput").value = apify?.maxActorsPerLead || 3;
  document.getElementById("apifyCacheDaysInput").value = apify?.cacheDays || 30;

  document.getElementById("mcpBaseUrlInput").value = state.mcpSync?.baseUrl || "";
  document.getElementById("mcpNamespaceInput").value = state.mcpSync?.resourceNamespace || "";

  const crm = state.integrations?.crm;
  document.getElementById("crmNameInput").value = crm?.name || "";
  document.getElementById("crmBaseUrlInput").value = crm?.baseUrl || "";
  document.getElementById("crmLeadObjectInput").value = crm?.leadObject || "Lead";
  document.getElementById("crmContactObjectInput").value = crm?.contactObject || "Contact";
  document.getElementById("crmActivityObjectInput").value = crm?.activityObject || "Activity";

  const supabase = state.integrations?.supabase;
  document.getElementById("supabaseUrlInput").value = supabase?.url || "";

  const postgres = state.integrations?.postgres;
  document.getElementById("pgHostInput").value = postgres?.host || "";
  document.getElementById("pgPortInput").value = postgres?.port || 55432;
  document.getElementById("pgDatabaseInput").value = postgres?.database || "";
  document.getElementById("pgUserInput").value = postgres?.user || "";

  const transcripts = state.integrations?.transcripts;
  document.getElementById("transcriptProviderInput").value = transcripts?.provider || "manual";
  document.getElementById("transcriptWebhookInput").value = transcripts?.webhookUrl || "";

  const notifications = state.integrations?.notifications;
  document.getElementById("notificationChannelInput").value = notifications?.channel || "in_app";
  document.getElementById("notificationTargetInput").value = notifications?.target || "";
}

function renderAssistant() {
  const runtime = state.aiRuntime?.mode === "openrouter" ? "OpenRouter live" : "Mock AI";
  document.getElementById("aiRuntimePill").textContent = runtime;
  document.getElementById("crmImportStatus").innerHTML = crmImportStatusRows();
  document.getElementById("assistantActionList").innerHTML = (state.aiActions || []).length
    ? state.aiActions.map(assistantActionRow).join("")
    : `<div class="empty-state">No AI actions executed yet</div>`;
}

function crmImportStatusRows() {
  const supabase = state.integrations?.supabase;
  const crm = state.integrations?.crm;
  return `
    <div class="connector-status-grid">
      <div><span>Supabase</span><strong>${escapeHtml(supabase?.status || "not_configured")}</strong></div>
      <div><span>CRM API</span><strong>${escapeHtml(crm?.status || "not_configured")}</strong></div>
      <div><span>Loaded leads</span><strong>${state.prospects?.length || 0}</strong></div>
    </div>
  `;
}

function assistantActionRow(action) {
  const results = (action.results || [])
    .slice(0, 8)
    .map((result) => `<li><strong>${escapeHtml(result.type || "action")}</strong><span>${escapeHtml(result.message || result.status || "")}</span></li>`)
    .join("");
  const warnings = (action.warnings || [])
    .map((warning) => `<span class="warning-chip">${escapeHtml(warning)}</span>`)
    .join("");
  return `
    <article class="assistant-action-card">
      <div class="assistant-action-heading">
        <div>
          <strong>${escapeHtml(action.summary || "AI action")}</strong>
          <span>${new Date(action.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${escapeHtml(action.status || "completed")}</span>
        </div>
        <span class="pill">${escapeHtml(action.modelUsed || "local")}</span>
      </div>
      <p>${escapeHtml(action.instruction || "")}</p>
      <ul>${results}</ul>
      <div class="warning-row">${warnings}</div>
    </article>
  `;
}

function renderAgents() {
  const select = document.getElementById("agentSelect");
  if (!select) return;
  fillSelect(select, state.agents || [], (agent) => agent.id, (agent) => agent.name, select.value || "orchestrate-outbound");
  document.getElementById("agentGrid").innerHTML = (state.agents || [])
    .map((agent) => `
      <article class="agent-card">
        <div>
          <strong>${escapeHtml(agent.name)}</strong>
          <span>${escapeHtml(agent.id)}</span>
        </div>
        <p>${escapeHtml(agent.purpose)}</p>
        <div class="cap-list">
          <span class="cap">${escapeHtml(agent.model)}</span>
          <span class="cap">${escapeHtml(agent.approval)}</span>
        </div>
      </article>
    `)
    .join("");
}

function renderLearningDatabase() {
  const learning = state.learning || {};
  const stats = learning.stats || {};
  const playbook = learning.playbook || {};
  const productSelect = document.getElementById("learningProductInput");
  if (productSelect) {
    fillSelect(productSelect, state.products || [], (product) => product.id, (product) => product.name, state.selectedProductId);
  }
  const inboxProductSelect = document.getElementById("knowledgeInboxProductInput");
  if (inboxProductSelect) {
    fillSelect(inboxProductSelect, state.products || [], (product) => product.id, (product) => product.name, state.selectedProductId);
  }

  document.getElementById("learningStatusPill").textContent = playbook.status || "empty";
  renderKnowledgeInboxResult(learning.lastInboxAnalysis);
  document.getElementById("learningExampleCount").textContent = stats.totalExamples || 0;
  document.getElementById("learningWinCount").textContent = stats.winningExamples || 0;
  document.getElementById("learningScreenshotCount").textContent = stats.screenshotExamples || 0;
  document.getElementById("learningTopChannel").textContent = titleCase(stats.topChannel || "none");
  document.getElementById("learningVersionPill").textContent = stats.modelVersion || learning.modelVersion || "learning-local-v1";
  document.getElementById("learningPlaybookSummary").innerHTML = `
    <strong>${escapeHtml(playbook.summary || "No learned patterns yet")}</strong>
    <span>${playbook.updatedAt ? `Updated ${new Date(playbook.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "Waiting for first example"}</span>
  `;
  document.getElementById("learningPatternList").innerHTML = listItems(playbook.winningPatterns, "No winning patterns yet");
  document.getElementById("learningRuleList").innerHTML = listItems(playbook.reusableRules, "No rules learned yet");
  document.getElementById("learningChannelTips").innerHTML = (playbook.channelTips || []).length
    ? playbook.channelTips.map((tip) => `
        <div class="channel-tip">
          <span class="pill">${escapeHtml(tip.channel)}</span>
          <strong>${escapeHtml(tip.tip)}</strong>
        </div>
      `).join("")
    : `<div class="empty-state">Channel tips appear after examples are saved</div>`;
  document.getElementById("learningExampleList").innerHTML = (learning.examples || []).length
    ? learning.examples.map(learningExampleRow).join("")
    : `<div class="empty-state">No training data yet</div>`;
  renderKnowledgeInboxScreenshotPreview();
  renderIcpDatabase();
}

function renderIcpDatabase() {
  const icp = state.icp || {};
  const profile = icp.profile || {};
  const lookalike = icp.lookalikeSearch || {};
  const payload = lookalike.payload || {};
  const prettyPayload = JSON.stringify(payload, null, 2);
  document.getElementById("icpStatusPill").textContent = profile.status || "empty";
  document.getElementById("icpProfileSummary").textContent = profile.summary || "Upload ICP leads to train lookalike filters.";
  document.getElementById("icpActorJson").textContent = prettyPayload;
  const copyButton = document.getElementById("copyIcpJsonBtn");
  copyButton.dataset.copyText = prettyPayload;
  const chips = [
    ["Seeds", icp.seedLeadCount || 0],
    ["Titles", (profile.titles || []).slice(0, 3).join(", ") || "-"],
    ["Seniority", (profile.seniorities || []).join(", ") || "-"],
    ["Functions", (profile.functions || []).join(", ") || "-"],
    ["Industries", (profile.industries || []).slice(0, 2).join(", ") || "-"],
    ["Search", lookalike.status || "not_ready"]
  ];
  document.getElementById("icpChipRow").innerHTML = chips
    .map(([label, value]) => `<span class="cap"><strong>${escapeHtml(label)}</strong> ${escapeHtml(value)}</span>`)
    .join("");
}

function listItems(items, emptyText) {
  return (items || []).length
    ? items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : `<li>${escapeHtml(emptyText)}</li>`;
}

function renderKnowledgeInboxResult(analysis) {
  const result = document.getElementById("knowledgeInboxResult");
  if (!result) return;
  setText("knowledgeInboxStatusPill", analysis ? "learned" : "ready");
  if (!analysis) {
    result.innerHTML = `<div class="empty-state">Paste or upload knowledge and the AI playbook will extract patterns, rules, and reusable sales context.</div>`;
    return;
  }
  const patterns = (analysis.patterns || []).slice(0, 5).map((item) => `<span class="cap">${escapeHtml(item)}</span>`).join("");
  const rules = (analysis.rules || []).slice(0, 4).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  result.innerHTML = `
    <article class="knowledge-inbox-card">
      <div>
        <span class="pill">${escapeHtml(analysis.productName || "Product")}</span>
        <strong>${escapeHtml(analysis.summary || "Knowledge analyzed and added to the playbook.")}</strong>
        <small>${analysis.updatedAt ? `Updated ${new Date(analysis.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : ""}</small>
      </div>
      <div class="cap-list">${patterns}</div>
      <ul>${rules}</ul>
    </article>
  `;
}

function learningExampleRow(example) {
  const image = example.screenshot?.dataUrl
    ? `<img src="${escapeAttr(example.screenshot.dataUrl)}" alt="${escapeAttr(example.screenshot.name || "Training screenshot")}" />`
    : `<div class="learning-thumb-placeholder"><i data-lucide="${example.profileUrl || example.sourceUrl ? "link" : "file-text"}"></i></div>`;
  const signals = example.signals
    ? [
        ...(example.signals.patterns || []).slice(0, 2),
        ...(example.signals.hooks || []).slice(0, 1),
        ...(example.signals.ctas || []).slice(0, 1)
      ].map((signal) => `<span class="cap">${escapeHtml(signal)}</span>`).join("")
    : "";
  return `
    <article class="learning-example-card">
      <div class="learning-thumb">${image}</div>
      <div>
        <div class="learning-example-heading">
          <span class="pill">${escapeHtml(example.channel)}</span>
          <strong>${escapeHtml(example.productName || "Product")}</strong>
          <small>${new Date(example.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</small>
        </div>
        <p>${escapeHtml(example.messageText || example.notes || example.profileUrl || example.sourceUrl || "Screenshot example")}</p>
        <div class="learning-meta-row">
          <span>${escapeHtml(example.persona || "persona open")}</span>
          <span>${escapeHtml(example.outcome || "outcome")}</span>
          <strong>${Number(example.outcomeScore || 0)}%</strong>
        </div>
        <div class="cap-list">${signals}</div>
      </div>
    </article>
  `;
}

function renderOverview() {
  const summary = state.usageSummary;
  document.getElementById("totalCost").textContent = formatUsd(summary.totalCostUsd);
  document.getElementById("tokenVolume").textContent = summary.totalTokens.toLocaleString();
  document.getElementById("avgLatency").textContent = `${summary.avgLatencyMs.toLocaleString()} ms`;
  document.getElementById("fallbackRate").textContent = formatPct(summary.fallbackRate);
  document.getElementById("schemaRate").textContent = formatPct(summary.schemaRate);
  document.getElementById("budgetMeter").style.width = `${Math.min(100, summary.budgetUsedPercent)}%`;

  const eventList = document.getElementById("eventList");
  eventList.innerHTML = state.events
    .map(
      (event) => `
        <div class="event">
          <time>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          <strong>${event.type}</strong>
          <span>${escapeHtml(event.text)}</span>
        </div>
      `
    )
    .join("");

  drawTrafficChart();
}

function drawTrafficChart() {
  const canvas = document.getElementById("trafficChart");
  const ctx = canvas.getContext("2d");
  const mode = document.getElementById("chartMode").value;
  const width = canvas.width;
  const height = canvas.height;
  const padding = 38;
  const data = state.usage
    .slice(0, 14)
    .reverse()
    .map((item) => ({
      label: new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      value: mode === "latency" ? item.latencyMs : mode === "tokens" ? item.inputTokens + item.outputTokens : item.costUsd
    }));

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#071426";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(143, 177, 207, 0.18)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const y = padding + ((height - padding * 2) / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
  }

  const max = Math.max(...data.map((item) => item.value), 1);
  const barWidth = (width - padding * 2) / data.length - 10;
  data.forEach((item, index) => {
    const x = padding + index * ((width - padding * 2) / data.length) + 5;
    const barHeight = Math.max(4, ((height - padding * 2) * item.value) / max);
    const y = height - padding - barHeight;
    ctx.fillStyle = index % 3 === 0 ? "#28d4bf" : index % 3 === 1 ? "#4f8cff" : "#f4bd50";
    ctx.fillRect(x, y, barWidth, barHeight);
    ctx.fillStyle = "#94a9be";
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(item.label, x - 4, height - 14);
  });
}

function renderModels() {
  const search = document.getElementById("modelSearch").value.trim().toLowerCase();
  const tier = document.getElementById("modelTierFilter").value;
  const models = state.models.filter((model) => {
    const matchesTier = tier === "all" || model.tier === tier;
    const matchesSearch = !search || `${model.id} ${model.displayName} ${model.provider}`.toLowerCase().includes(search);
    return matchesTier && matchesSearch;
  });

  document.getElementById("modelTable").innerHTML = models
    .map(
      (model) => `
        <tr>
          <td><strong>${escapeHtml(model.displayName)}</strong><span>${escapeHtml(model.id)}</span></td>
          <td><span class="pill">${model.tier}</span></td>
          <td>${Number(model.contextWindow).toLocaleString()}</td>
          <td><div class="cap-list">${capabilities(model).map((cap) => `<span class="cap">${cap}</span>`).join("")}</div></td>
          <td><strong>$${model.inputPrice} / $${model.outputPrice}</strong><span>input / output</span></td>
          <td>${model.qualityScore}%</td>
          <td>
            <button class="toggle" data-model-toggle="${escapeAttr(model.id)}" data-enabled="${!model.enabled}">
              <i data-lucide="${model.enabled ? "toggle-right" : "toggle-left"}"></i>
              <span>${model.enabled ? "Enabled" : "Disabled"}</span>
            </button>
          </td>
        </tr>
      `
    )
    .join("");
}

function renderRouting() {
  const models = state.models.filter((model) => model.enabled);
  const selected = state.tasks.find((task) => task.taskType === selectedTaskType) || state.tasks[0];
  selectedTaskType = selected.taskType;

  document.getElementById("taskList").innerHTML = state.tasks
    .map(
      (task) => `
        <button class="task-row ${task.taskType === selectedTaskType ? "active" : ""}" data-task-row="${task.taskType}">
          <div>
            <strong>${titleCase(task.taskType)}</strong>
            <span>${task.primaryModel} · ${task.privacyLevel}</span>
          </div>
          <span class="pill">${task.qualityTier}</span>
        </button>
      `
    )
    .join("");

  fillSelect(document.getElementById("taskSelect"), state.tasks, (task) => task.taskType, (task) => titleCase(task.taskType), selected.taskType);
  fillSelect(document.getElementById("primaryModelSelect"), models, (model) => model.id, (model) => model.displayName, selected.primaryModel);
  const fallbackSelect = document.getElementById("fallbackModelSelect");
  fallbackSelect.innerHTML = models
    .map((model) => `<option value="${escapeAttr(model.id)}" ${selected.fallbackModels.includes(model.id) ? "selected" : ""}>${escapeHtml(model.displayName)}</option>`)
    .join("");
  document.getElementById("taskCostInput").value = selected.maxCostUsd;
  document.getElementById("taskLatencyInput").value = selected.maxLatencyMs;
  document.getElementById("taskPrivacySelect").value = selected.privacyLevel;
  document.getElementById("selectedTaskTier").textContent = selected.qualityTier;

  fillSelect(document.getElementById("runTaskSelect"), state.tasks, (task) => task.taskType, (task) => titleCase(task.taskType), selectedTaskType);
  document.getElementById("runPreferredModelSelect").innerHTML =
    `<option value="">Automatic routing</option>` +
    state.models
      .filter((model) => model.enabled)
      .map((model) => `<option value="${escapeAttr(model.id)}">${escapeHtml(model.displayName)}</option>`)
      .join("");
}

function renderBudgets() {
  document.getElementById("monthlyBudgetInput").value = state.budgets.monthlyWorkspaceBudgetUsd;
  document.getElementById("dailyBudgetInput").value = state.budgets.dailyWorkspaceBudgetUsd;
  document.getElementById("userBudgetInput").value = state.budgets.perUserMonthlyBudgetUsd;
  document.getElementById("thresholdInput").value = state.budgets.warningThresholdPercent;
  document.getElementById("hardLimitInput").checked = state.budgets.hardLimitEnabled;

  const spend = Object.entries(state.usageSummary.spendByModel).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...spend.map(([, value]) => value), 1);
  document.getElementById("spendBars").innerHTML = spend
    .map(
      ([modelId, value]) => `
        <div class="bar-item">
          <div class="bar-meta"><strong>${escapeHtml(modelId)}</strong><span>${formatUsd(value)}</span></div>
          <div class="bar-track"><span style="width:${Math.max(4, (value / max) * 100)}%"></span></div>
        </div>
      `
    )
    .join("");
}

function renderPrivacy() {
  document.getElementById("providerPolicyInput").value = state.providerRule.policy;
  document.getElementById("providerFallbackInput").checked = state.providerRule.allowProviderFallbacks;
  document.getElementById("noTrainingInput").checked = state.providerRule.requireNoTraining;
  document.getElementById("zeroRetentionInput").checked = state.providerRule.requireZeroRetention;
}

function renderEvaluation() {
  const models = state.models.filter((model) => model.enabled).slice(0, 3);
  document.getElementById("comparisonGrid").innerHTML = models
    .map(
      (model, index) => `
        <article class="comparison-card">
          <div>
            <strong>${escapeHtml(model.displayName)}</strong>
            <p>${comparisonCopy(index)}</p>
          </div>
          <div>
            <div class="score-line"><span>Commercial relevance</span><strong>${model.qualityScore}%</strong></div>
            <div class="score-line"><span>Latency</span><strong>${model.latencyMs || 880} ms</strong></div>
            <div class="score-line"><span>Cost</span><strong>$${model.inputPrice}/${model.outputPrice}</strong></div>
          </div>
        </article>
      `
    )
    .join("");
}

function renderProspects() {
  if (!state.prospects?.length) {
    selectedProspectId = null;
  } else if (!selectedProspectId || !state.prospects.some((prospect) => prospect.id === selectedProspectId)) {
    selectedProspectId = state.prospects[0].id;
  }

  const search = document.getElementById("prospectSearch").value.trim().toLowerCase();
  const status = document.getElementById("prospectStatusFilter").value;
  const filtered = (state.prospects || []).filter((prospect) => {
    const haystack = `${prospect.name} ${prospect.title} ${prospect.company} ${prospect.location} ${prospect.notes}`.toLowerCase();
    const matchesSearch = !search || haystack.includes(search);
    const matchesStatus = status === "all" || prospect.status === status;
    return matchesSearch && matchesStatus;
  });

  document.getElementById("prospectCount").textContent = `${filtered.length} records`;
  document.getElementById("prospectList").innerHTML = filtered.length
    ? filtered.map((prospect) => prospectCard(prospect)).join("")
    : `<div class="empty-state">No matching prospects</div>`;

  const selected = state.prospects?.find((prospect) => prospect.id === selectedProspectId);
  renderSelectedProspect(selected);
}

function prospectCard(prospect) {
  return `
    <article class="prospect-queue-row ${prospect.id === selectedProspectId ? "active" : ""}">
      <button class="prospect-card" data-prospect-id="${escapeAttr(prospect.id)}">
        <div class="avatar">${initials(prospect.name)}</div>
        <div>
          <strong>${escapeHtml(prospect.name)}</strong>
          <span>${escapeHtml([prospect.title, prospect.company].filter(Boolean).join(" · "))}</span>
          <small>${escapeHtml(prospect.location || "No location")} · ${escapeHtml(prospect.status)} · reach ${prospect.analysis?.reachProbability ?? 0}%</small>
        </div>
        <b>${prospect.score}</b>
      </button>
      <button class="icon-button queue-remove danger-button" type="button" data-remove-prospect-id="${escapeAttr(prospect.id)}" title="Remove from queue" aria-label="Remove from queue">
        <i data-lucide="trash-2"></i>
      </button>
    </article>
  `;
}

function renderSelectedProspect(prospect) {
  const enrichButton = document.getElementById("enrichProspectBtn");
  const prepareButton = document.getElementById("prepareOutreachBtn");
  const analyzeButton = document.getElementById("analyzeIntelligenceBtn");
  const refreshButton = document.getElementById("refreshIntelligenceBtn");
  const analyzeQuickButton = document.getElementById("analyzeIntelligenceQuick");
  if (enrichButton) enrichButton.disabled = !prospect;
  if (prepareButton) prepareButton.disabled = !prospect;
  if (analyzeButton) analyzeButton.disabled = !prospect;
  if (refreshButton) refreshButton.disabled = !prospect;
  if (analyzeQuickButton) analyzeQuickButton.disabled = !prospect;

  if (!prospect) {
    document.getElementById("selectedProspectName").textContent = "Select a prospect";
    document.getElementById("selectedProspectMeta").textContent = "Contact discovery and AI outreach";
    document.getElementById("selectedProspectScore").textContent = "0";
    document.getElementById("selectedProspectStatus").textContent = "empty";
    document.getElementById("profileFields").innerHTML = "";
    document.getElementById("contactList").innerHTML = `<div class="empty-state">No prospect selected</div>`;
    document.getElementById("outreachContent").innerHTML = `<div class="empty-state">No outreach prepared</div>`;
    document.getElementById("leadAnalytics").innerHTML = "";
    document.getElementById("interactionList").innerHTML = `<div class="empty-state">No interactions logged</div>`;
    setHtml("taskInteractionList", `<div class="empty-state">No interactions logged</div>`);
    document.getElementById("taskNotificationList").innerHTML = `<div class="empty-state">No follow-up tasks</div>`;
    document.getElementById("outreachModel").textContent = "not prepared";
    renderLeadWorkspaceExtras(null);
    return;
  }

  document.getElementById("selectedProspectName").textContent = prospect.name;
  document.getElementById("selectedProspectMeta").textContent = [prospect.title, prospect.company, prospect.location].filter(Boolean).join(" · ");
  document.getElementById("selectedProspectScore").textContent = `${prospect.score}`;
  document.getElementById("selectedProspectStatus").textContent = prospect.status;
  document.getElementById("contactPolicy").textContent = prospect.contactDiscovery?.policy || "public review";
  document.getElementById("profileFields").innerHTML = profileFieldRows(prospect);
  document.getElementById("contactList").innerHTML = contactRows(prospect);
  document.getElementById("leadAnalytics").innerHTML = analyticsRows(prospect);
  document.getElementById("interactionList").innerHTML = interactionRows(prospect);
  setHtml("taskInteractionList", interactionRows(prospect));
  document.getElementById("taskNotificationList").innerHTML = taskNotificationRows(prospect);
  document.getElementById("outreachContent").innerHTML = outreachRows(prospect);
  document.getElementById("outreachModel").textContent = prospect.outreach?.modelUsed || "not prepared";
  renderLeadWorkspaceExtras(prospect);
}

function renderLeadWorkspaceExtras(prospect) {
  const prospects = state.prospects || [];
  const index = prospect ? prospects.findIndex((item) => item.id === prospect.id) : -1;
  const analysis = prospect?.analysis || { reachProbability: 0, closeProbability: 0, recommendedAction: "Run research", reasoning: [] };
  const confidence = bestContactConfidence(prospect);
  const latest = prospect?.updatedAt ? `Updated ${relativeTime(prospect.updatedAt)}` : "Research not run";

  setText("leadWorkspaceQueue", prospects.length ? `Lead ${index + 1 || 1} of ${prospects.length}` : "No leads loaded");
  setText("selectedLeadAvatar", prospect ? initials(prospect.name) : "OS");
  setText("leadWorkspaceCompany", prospect ? prospect.company || "Unknown account" : "Open a lead to start");
  setText("leadWorkspacePosition", prospect ? [prospect.title, prospect.location, prospect.website].filter(Boolean).join(" · ") || "No profile details yet" : "Add a LinkedIn URL, upload leads, or pull from CRM. The system prepares intelligence, contacts, messages, CRM logs, and next actions without auto-sending.");
  setText("leadWorkspaceFit", prospect ? `${titleCase(analysis.productFit || "unknown")} fit` : "No fit score yet");
  setText("leadWorkspaceUpdated", latest);
  setText("leadWorkspaceConfidence", prospect ? `${confidence}% best contact confidence` : "Awaiting evidence");
  setText("committeeCount", prospect ? `${committeeForProspect(prospect).length} contact${committeeForProspect(prospect).length === 1 ? "" : "s"}` : "0 contacts");

  setHtml("companyBriefContent", companyBriefRows(prospect));
  setText("companyConfidencePill", companyConfidenceLabel(prospect));
  setText("companyBriefMeta", prospect?.company ? `${prospect.company} account context for ${state.selectedProduct?.name || "selected product"}` : "What this company does, who they sell to, and why this lead may matter");
  setHtml("buyingCommitteeList", buyingCommitteeRows(prospect));
  setHtml("scoreBreakdown", scoreBreakdownRows(prospect));
  setHtml("nextActionSummary", nextActionRows(prospect));
  setHtml("salesCycleList", salesCycleRows(prospect));
  setHtml("intelligenceContent", intelligenceRows(prospect));
  setHtml("prospectingStrategyContent", prospectingStrategyRows(prospect));
  setText("intelligenceStatusPill", intelligenceStatusLabel(prospect));
  renderLeadSectionTabs();
  updateQuickCopies(prospect);
}

function renderLeadSectionTabs() {
  const sections = [...document.querySelectorAll(".lead-main-stack .lead-section")];
  if (!sections.some((section) => section.id === activeLeadSectionId)) activeLeadSectionId = "dashboard-account";
  document.querySelectorAll("[data-lead-tab]").forEach((button) => {
    const active = button.dataset.leadTab === activeLeadSectionId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  sections.forEach((section) => {
    const active = section.id === activeLeadSectionId;
    section.classList.toggle("active", active);
    section.setAttribute("aria-hidden", active ? "false" : "true");
  });
  const mobileSelect = document.getElementById("mobileLeadSectionSelect");
  if (mobileSelect) mobileSelect.value = activeLeadSectionId;
}

function renderLeadsPage() {
  const prospects = state.prospects || [];
  const ready = prospects.filter((prospect) => ["intelligence_ready", "outreach_ready", "linkedin_ready"].includes(prospect.status)).length;
  const active = prospects.filter((prospect) => ["contacted", "engaged", "follow_up_due", "meeting_booked"].includes(prospect.status)).length;
  const due = state.followUpTasks?.filter((task) => task.status !== "done").length || 0;
  setHtml("leadStatsStrip", `
    <div><span>Total leads</span><strong>${prospects.length}</strong></div>
    <div><span>Ready to contact</span><strong>${ready}</strong></div>
    <div><span>Active conversations</span><strong>${active}</strong></div>
    <div><span>Follow-ups</span><strong>${due}</strong></div>
  `);
  setHtml("leadTableBody", prospects.length
    ? prospects.map(leadTableRow).join("")
    : `<tr><td colspan="6"><div class="empty-state">No leads yet. Pull from CRM or add a LinkedIn target from Dashboard.</div></td></tr>`);
}

function leadTableRow(prospect) {
  const analysis = prospect.analysis || {};
  return `
    <tr>
      <td><strong>${escapeHtml(prospect.name)}</strong><span>${escapeHtml([prospect.title, prospect.company].filter(Boolean).join(" · "))}</span></td>
      <td><span class="pill">${escapeHtml(titleCase(prospect.status || "new"))}</span></td>
      <td><strong>${prospect.score || 0}</strong></td>
      <td><strong>${analysis.reachProbability || 0}%</strong></td>
      <td><span>${escapeHtml(analysis.recommendedAction || "Run research")}</span></td>
      <td>
        <div class="table-action-row">
          <button type="button" data-open-prospect-id="${escapeAttr(prospect.id)}"><i data-lucide="arrow-up-right"></i><span>Open</span></button>
          <button class="icon-button danger-button" type="button" data-remove-prospect-id="${escapeAttr(prospect.id)}" title="Remove lead" aria-label="Remove lead"><i data-lucide="trash-2"></i></button>
        </div>
      </td>
    </tr>
  `;
}

function companyConfidenceLabel(prospect) {
  if (!prospect) return "no research";
  const profile = prospect.companyProfile || prospect.leadIntelligence?.company_context;
  if (!profile) return "needs research";
  const confidence = Number(profile.confidence || 0);
  if (confidence >= 75) return `${confidence}% confidence`;
  if (confidence >= 45) return `${confidence}% needs review`;
  return "low company data";
}

function companyBriefRows(prospect) {
  if (!prospect) return `<div class="empty-state">Open a lead and run research to build company context.</div>`;
  const profile = prospect.companyProfile || prospect.leadIntelligence?.company_context || {};
  const confidence = Number(profile.confidence || 0);
  const description = profile.description || `${prospect.company || "This account"} needs company research before high-confidence outreach.`;
  const cards = [
    ["What they do", description],
    ["Company size", profile.size_estimate || "Unknown"],
    ["Audience", profile.audience || "Unknown"],
    ["Business model", profile.business_model || "Unknown"],
    ["Category", profile.category || "Needs research"],
    ["Why relevant", profile.why_relevant || prospect.analysis?.reasoning?.[0] || "Run research to build the angle."]
  ];
  const priorities = detailChipList(profile.likely_priorities, "No priorities inferred yet");
  const growth = detailChipList(profile.growth_signals, "No growth signals yet");
  const stack = detailChipList(profile.tech_stack, "No tech stack found yet");
  const unknowns = detailChipList(profile.unknowns, "No open company gaps");
  const links = (profile.research_links || []).slice(0, 4).map((item) => {
    const url = typeof item === "string" ? item : item.url;
    const label = typeof item === "string" ? shortUrl(item) : item.label || item.title || shortUrl(item.url || "");
    return url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>` : "";
  }).filter(Boolean).join("");
  const apps = profile.app_portfolio?.apps || prospect.appPortfolio?.apps || [];
  const appEvidence = profile.app_portfolio?.evidence || prospect.appPortfolio?.evidence || [];
  const appRows = apps.length ? apps.map((app) => `
    <article class="app-title-row">
      <div><strong>${escapeHtml(app.title)}</strong><span>${escapeHtml([app.os, app.category, app.publisher].filter(Boolean).join(" · "))}</span></div>
      <div class="app-facts"><span>${escapeHtml(app.geo || "GEO not verified")}</span><span>${escapeHtml(app.monetization || "Monetization not verified")}</span><span>${escapeHtml(app.recentRelease ? new Date(app.recentRelease).toLocaleDateString() : "Release date unknown")}</span></div>
      ${evidenceLinks(appEvidence.filter((source) => (app.evidenceSourceIds || []).includes(source.source_id)))}
    </article>
  `).join("") : `<div class="empty-state">No confidently matched store title yet. The research job records this as a gap instead of inventing one.</div>`;

  return `
    <div class="company-summary">
      ${cards.map(([label, value]) => `
        <article>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          ${companyClaimEvidence(profile, label, prospect)}
        </article>
      `).join("")}
    </div>
    <div class="company-detail-grid">
      <section>
        <strong>Likely Priorities</strong>
        <div class="cap-list">${priorities}</div>
      </section>
      <section>
        <strong>Growth Signals</strong>
        <div class="cap-list">${growth}</div>
      </section>
      <section>
        <strong>Tech and Tools</strong>
        <div class="cap-list">${stack}</div>
      </section>
      <section>
        <strong>Unknowns to Verify</strong>
        <div class="cap-list">${unknowns}</div>
      </section>
    </div>
    <section class="app-portfolio-section">
      <div class="subpanel-heading"><h3>Apps and Recent Releases</h3><span>title · OS · GEO · monetization · evidence</span></div>
      <div class="app-title-list">${appRows}</div>
    </section>
    <div class="company-research-footer">
      <span>Company context confidence: ${confidence}%</span>
      <div>${links || `<span>No research links yet</span>`}</div>
    </div>
  `;
}

function companyClaimEvidence(profile, label, prospect) {
  const mapping = { "What they do": "Company description", "Company size": "Company size", "Audience": "Audience and business model", "Business model": "Audience and business model", "Category": "Company category", "Why relevant": "Product relevance" };
  const claim = (profile.claim_evidence || []).find((item) => item.claim === mapping[label]);
  if (!claim) return "";
  const sources = [...(prospect.leadIntelligence?.sources || []), ...(prospect.appPortfolio?.evidence || [])]
    .filter((source) => (claim.source_ids || []).includes(source.source_id));
  return `<div class="claim-evidence"><i data-lucide="link-2"></i><span>${Number(claim.confidence || 0)}%</span>${evidenceLinks(sources, true)}</div>`;
}

function evidenceLinks(sources = [], compact = false) {
  const links = sources.slice(0, compact ? 2 : 5).map((source) => source.url
    ? `<a href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer" title="${escapeAttr(source.excerpt || source.evidence_excerpt || "")}">${escapeHtml(source.title || shortUrl(source.url))}</a>`
    : `<span title="${escapeAttr(source.excerpt || source.evidence_excerpt || "")}">${escapeHtml(source.title || source.source_id || "Internal source")}</span>`
  ).join("");
  return links ? `<div class="evidence-links">${links}</div>` : `<span class="evidence-missing">Evidence pending</span>`;
}

function detailChipList(items, emptyText) {
  const values = (items || []).filter(Boolean).slice(0, 6);
  return values.length
    ? values.map((item) => `<span class="cap">${escapeHtml(item)}</span>`).join("")
    : `<span class="cap muted">${escapeHtml(emptyText)}</span>`;
}

function accountSignalRows(prospect) {
  if (!prospect) return `<div class="empty-state">Run research to see account signals</div>`;
  const analysis = prospect.analysis || {};
  const publicNote = publicLeadNote(prospect.notes);
  const signals = [
    publicNote ? { label: "Lead context", value: publicNote, confidence: 78 } : null,
    prospect.contactDiscovery?.scraperNote ? { label: "Contact discovery", value: prospect.contactDiscovery.scraperNote, confidence: 70 } : null,
    ...(analysis.reasoning || []).map((value) => ({ label: "AI reasoning", value, confidence: 74 }))
  ].filter(Boolean);
  return signals.length
    ? signals.map((signal) => `
      <article class="research-signal">
        <i data-lucide="radar"></i>
        <div>
          <strong>${escapeHtml(signal.label)}</strong>
          <span>${escapeHtml(signal.value)}</span>
        </div>
        <b>${signal.confidence}%</b>
      </article>
    `).join("")
    : `<div class="empty-state">No account signals yet</div>`;
}

function buyingCommitteeRows(prospect) {
  if (!prospect) return `<div class="empty-state">Open a lead to map the buying committee</div>`;
  const committee = committeeForProspect(prospect);
  return `${companyPeopleDirectoryCard(prospect)}${committee.map((member) => `
    <article class="committee-card">
      <div class="avatar">${initials(member.name)}</div>
      <div>
        <strong>${member.linkedin ? `<a href="${escapeAttr(member.linkedin)}" target="_blank" rel="noreferrer">${escapeHtml(member.name)}</a>` : escapeHtml(member.name)}</strong>
        <span>${escapeHtml([member.title, member.context].filter(Boolean).join(" · "))}</span>
      </div>
      <span class="pill">${escapeHtml(member.confidence ? `${member.confidence}%` : titleCase(member.role))}</span>
    </article>
  `).join("")}`;
}

function companyPeopleDirectoryCard(prospect) {
  const url = companyLinkedInPeopleUrlForProspect(prospect);
  if (!url) return "";
  const storedSource = prospect.publicCompanyResearch?.linkedinCompanySource || "";
  const source = storedSource === "inferred_company_slug" || (!prospect.publicCompanyResearch?.linkedinPeopleUrl && !prospect.companyLinkedin)
    ? "inferred from company name"
    : "company LinkedIn";
  return `
    <article class="committee-directory-card">
      <div>
        <strong>LinkedIn company people</strong>
        <span>${escapeHtml(source)} · open to review employees and choose 1-2 relevant targets</span>
      </div>
      <a class="mini-button" href="${escapeAttr(url)}" target="_blank" rel="noreferrer"><i data-lucide="external-link"></i><span>Open People</span></a>
    </article>
  `;
}

function committeeForProspect(prospect) {
  if (!prospect) return [];
  const sameCompany = (state.prospects || []).filter((item) => item.company?.toLowerCase() === prospect.company?.toLowerCase());
  const known = sameCompany.filter((item) => isNamedPersonLead(item));
  const rows = known.map((item) => ({
    name: item.name,
    title: item.title || "Unknown title",
    role: committeeRole(item.title),
    context: item.id === prospect.id ? "current lead" : "known in queue",
    linkedin: item.linkedin || "",
    confidence: item.id === prospect.id ? 88 : 78
  }));
  rows.push(...(prospect.companyPeople || []).map((person) => ({
    name: person.name,
    title: person.title || "Unknown title",
    role: person.role || committeeRole(person.title),
    context: person.context || "found by company scrape",
    linkedin: person.linkedin || "",
    confidence: person.confidence || 64
  })));
  const suggestedBuyer = /adaction/i.test(state.selectedProduct?.name || "")
    ? "UA, Growth, Monetization or Product owner"
    : /black affiliate/i.test(state.selectedProduct?.name || "")
      ? "Affiliates, Partnerships or Acquisition owner"
      : "Product-relevant buyer";
  rows.push({ name: suggestedBuyer, title: "Suggested next person to research", role: "suggested", context: "not found yet", confidence: 45 });
  return mergeCommitteeRows(rows).slice(0, 8);
}

function mergeCommitteeRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    if (!row.name) continue;
    const key = row.linkedin?.toLowerCase() || `${row.name}:${row.title}`.toLowerCase();
    const existing = byKey.get(key);
    if (!existing || Number(row.confidence || 0) > Number(existing.confidence || 0)) byKey.set(key, row);
  }
  return [...byKey.values()].sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0));
}

function committeeRole(title) {
  const text = String(title || "").toLowerCase();
  if (/founder|ceo|owner|president/.test(text)) return "economic_buyer";
  if (/vp|head|chief|revenue|sales|growth/.test(text)) return "decision_maker";
  if (/ops|operations|revops|crm/.test(text)) return "champion";
  if (/finance|legal|procurement|security/.test(text)) return "approver";
  return "influencer";
}

function scoreBreakdownRows(prospect) {
  if (!prospect) return `<div class="empty-state">Scoring appears after a lead is selected</div>`;
  const analysis = prospect.analysis || {};
  const inputs = analysis.scoreInputs || {};
  const rows = [
    ["Lead score", prospect.score || 0, "final"],
    ["Readiness", inputs.readiness || 0, "driver"],
    ["Reach chance", analysis.reachProbability || 0, "probability"],
    ["Close chance", analysis.closeProbability || 0, "probability"],
    ["Company context", inputs.companyContext || 0, "driver"],
    ["Contact evidence", inputs.contactEvidence || bestContactConfidence(prospect), "driver"],
    ["Timing trigger", inputs.trigger || 0, "driver"],
    ["Product fit", inputs.fit || 0, "driver"],
    ["Penalty", inputs.penalty || 0, "penalty"]
  ];
  const scoreRows = rows.map(([label, value, type]) => `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${type === "penalty" ? `-${value}` : `${value}%`}</strong>
      <div class="meter compact ${type === "penalty" ? "penalty" : ""}"><span style="width:${Math.max(0, Math.min(100, Number(value) || 0))}%"></span></div>
    </div>
  `).join("");
  const model = state.scoringModel || {};
  return `${scoreRows}
    <article class="scoring-learning-card">
      <div><span>CRM outcome learning</span><strong>${escapeHtml(titleCase(model.status || "insufficient_data"))}</strong></div>
      <p>${Number(model.sampleSize || 0)} of ${Number(model.minimumSamples || 20)} resolved leads · ${Number(model.positiveOutcomes || 0)} positive · ${Number(model.negativeOutcomes || 0)} negative</p>
      <button type="button" id="retrainScoringBtn"><i data-lucide="refresh-cw"></i><span>Recalculate Weights</span></button>
    </article>`;
}

function nextActionRows(prospect) {
  if (!prospect) return `<div class="empty-state">Select a lead to see the next action</div>`;
  const analysis = prospect.analysis || {};
  const plan = prospect.nextActionPlan;
  const channel = prospect.outreach?.recommendedChannel || preferredChannel(prospect);
  if (plan) {
    const preTouch = (plan.preTouchActions || []).slice(0, 4).map((action) => `<span class="cap">${escapeHtml(action)}</span>`).join("");
    const channelOrder = (plan.channelOrder || []).slice(0, 7).map((item) => `<span>${escapeHtml(titleCase(item))}</span>`).join("");
    return `
      <article class="next-action-card">
        <i data-lucide="sparkles"></i>
        <div>
          <strong>${escapeHtml(plan.primaryAction || analysis.recommendedAction || "Run research and prepare outreach")}</strong>
          <span>Best channel: ${escapeHtml(plan.bestChannel || channel)} · Reach ${plan.score?.reachProbability || analysis.reachProbability || 0}% · Close ${plan.score?.closeProbability || analysis.closeProbability || 0}%</span>
          <p>${escapeHtml(plan.reason || (analysis.reasoning || []).join(" "))}</p>
          ${preTouch ? `<div class="next-action-caps">${preTouch}</div>` : ""}
          <div class="next-action-follow">
            <strong>${escapeHtml(plan.followUp?.label || "Follow up")}</strong>
            <span>${escapeHtml(plan.followUp?.trigger || "2-3 days after invite")} · ${plan.followUp?.due ? escapeHtml(new Date(plan.followUp.due).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })) : "scheduled"}</span>
          </div>
          ${channelOrder ? `<div class="channel-order">${channelOrder}</div>` : ""}
        </div>
      </article>
    `;
  }
  return `
    <article class="next-action-card">
      <i data-lucide="sparkles"></i>
      <div>
        <strong>${escapeHtml(analysis.recommendedAction || "Run research and prepare outreach")}</strong>
        <span>Best channel: ${escapeHtml(channel)} · Reach ${analysis.reachProbability || 0}% · Close ${analysis.closeProbability || 0}%</span>
        <p>${escapeHtml((analysis.reasoning || []).join(" "))}</p>
      </div>
    </article>
  `;
}

function salesCycleRows(prospect) {
  if (!prospect) return `<div class="empty-state">No lead selected</div>`;
  const baseItems = [
    { label: "Added to queue", value: relativeTime(prospect.createdAt), state: "done" },
    { label: "Research", value: prospect.contactDiscovery ? "completed" : "not run", state: prospect.contactDiscovery ? "done" : "pending" },
    { label: "Outreach prepared", value: prospect.outreach ? relativeTime(prospect.outreach.preparedAt || prospect.updatedAt) : "pending", state: prospect.outreach ? "done" : "pending", type: "outreach_prepared" },
    { label: "Latest CRM action", value: (prospect.interactions || [])[0]?.type ? titleCase(prospect.interactions[0].type) : "none logged", state: (prospect.interactions || []).length ? "done" : "pending" }
  ];
  const cadenceItems = (prospect.salesCadence?.steps || []).slice(0, 5).map((step) => ({
    label: step.label,
    value: [step.day, step.channel, step.messageChannel ? `copy ${titleCase(step.messageChannel)}` : ""].filter(Boolean).join(" · "),
    state: (prospect.interactions || []).some((interaction) => interaction.type === step.type) ? "done" : "pending",
    type: step.type
  }));
  const items = [...baseItems, ...cadenceItems];
  return items.map((item) => `
    <article class="cycle-row ${item.state}">
      <span></span>
      <div>
        <strong>${escapeHtml(item.label)}</strong>
        <small>${escapeHtml(item.value)}</small>
      </div>
      ${item.type && item.state !== "done" ? `<button type="button" data-interaction-type="${escapeAttr(item.type)}"><i data-lucide="check"></i><span>Done</span></button>` : ""}
    </article>
  `).join("");
}

function sourceAuditRows(prospect) {
  if (!prospect) return `<div class="empty-state">Sources appear after profile import and research</div>`;
  const productSources = state.selectedProduct?.mcpContext?.sources || [];
  const contactSources = prospect.contactDiscovery?.candidates || [];
  const intelSources = prospect.leadIntelligence?.sources || [];
  const researchRows = (prospect.researchHistory || []).slice(0, 5).map((record) => ({
    source: `Research memory · ${titleCase(record.stage || "research")}`,
    claim: `${record.summary || "Lead research stored."} ${record.contactSnapshot ? `Contacts: ${record.contactSnapshot.candidates || 0}, best confidence: ${record.contactSnapshot.bestConfidence || 0}%` : ""}`.trim(),
    confidence: record.analysis?.reachProbability || record.score || 0,
    status: record.at ? `stored ${relativeTime(record.at)}` : "stored"
  }));
  const rows = [
    { source: "Uploaded or CRM profile", claim: [prospect.name, prospect.company, prospect.title].filter(Boolean).join(" · "), confidence: 82, status: "workspace data" },
    ...researchRows,
    ...productSources.map((source) => ({ source: source.name, claim: source.type, confidence: source.confidence, status: "product context" })),
    ...intelSources.slice(0, 8).map((source) => ({ source: source.title || source.source_id, claim: source.evidence_excerpt || source.source_type, confidence: source.quality === "high" ? 90 : source.quality === "medium" ? 70 : 45, status: `${source.source_type || "source"} · ${source.claim_type || "claim"}` })),
    ...contactSources.map((candidate) => ({ source: candidate.source, claim: `${candidate.type}: ${candidate.value}`, confidence: candidate.confidence, status: candidate.status })),
    ...(prospect.contactDiscovery?.warnings || []).map((warning) => ({ source: "Enrichment warning", claim: warning, confidence: 0, status: "review required" }))
  ];
  return rows.map((row) => `
    <article class="source-row">
      <div>
        <strong>${escapeHtml(row.source || "Unknown source")}</strong>
        <span>${escapeHtml(row.claim || "No claim")}</span>
      </div>
      <small>${escapeHtml(row.status || "review")} · ${row.confidence || 0}%</small>
    </article>
  `).join("");
}

function intelligenceStatusLabel(prospect) {
  const intel = prospect?.leadIntelligence;
  if (!prospect) return "no lead";
  if (!intel) return "not analyzed";
  return `${titleCase(intel.status || "ready")} · ${intel.priority_wave || "no wave"}`;
}

function intelligenceRows(prospect) {
  if (!prospect) {
    return `<div class="empty-state">Select a lead to analyze account fit, sources, gaps, messages, and next action.</div>`;
  }
  const intel = prospect.leadIntelligence;
  if (!intel) {
    return `
      <div class="intelligence-empty">
        <i data-lucide="brain-circuit"></i>
        <div>
          <strong>No intelligence brief yet</strong>
          <span>Analyze once, then the account research is stored and reused when you return to this lead or another contact from the same account.</span>
        </div>
        <button class="primary-button" type="button" data-intel-analyze="fresh"><i data-lucide="sparkles"></i><span>Analyze Brief</span></button>
      </div>
    `;
  }

  const warnings = (intel.warnings || []).map((warning) => `<span class="warning-chip">${escapeHtml(warning)}</span>`).join("");
  const profile = [intel.analysis_profile_name, intel.schema_version, intel.prompt_version].filter(Boolean).join(" · ");
  const refreshed = intel.last_refreshed_at ? `Updated ${relativeTime(intel.last_refreshed_at)}` : "Stored";
  const scores = [
    ["Fit", intel.fit_score || 0],
    ["Priority", intel.priority_score || 0],
    ["Confidence", intel.overall_confidence || 0],
    ["Call ease", 100 - ((Number(intel.call_difficulty || 3) - 1) * 20)]
  ];
  const scoreCards = scores.map(([label, value]) => `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${Math.max(0, Math.min(100, Math.round(value)))}%</strong>
      <div class="meter compact"><span style="width:${Math.max(0, Math.min(100, Math.round(value)))}%"></span></div>
    </div>
  `).join("");
  const scoringInputs = (intel.scoring_inputs || []).map((input) => {
    const pct = input.max ? Math.round((Number(input.value || 0) / Number(input.max || 1)) * 100) : 0;
    return `
      <article class="intel-input-row ${input.penalty ? "penalty" : ""}">
        <div>
          <strong>${escapeHtml(input.label || input.key)}</strong>
          <span>${escapeHtml(input.rationale || "")}</span>
        </div>
        <b>${escapeHtml(input.penalty ? `-${input.value}` : `${input.value}/${input.max}`)}</b>
        <div class="meter compact"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>
      </article>
    `;
  }).join("");
  const nextSteps = (intel.next_steps || []).slice(0, 4).map((step, index) => `
    <article class="intel-step ${step.priority === "high" ? "urgent" : ""}">
      <div>
        <strong>${escapeHtml(step.action)}</strong>
        <span>${escapeHtml([step.priority, step.owner, step.rationale].filter(Boolean).join(" · "))}</span>
      </div>
      <button type="button" data-intel-task-index="${index}"><i data-lucide="bell-plus"></i><span>Task</span></button>
    </article>
  `).join("");
  const gaps = (intel.research_gaps || []).slice(0, 5).map((gap) => `
    <article class="intel-gap ${gap.status === "resolved" ? "resolved" : ""}">
      <div>
        <strong>${escapeHtml(gap.missing_field)}</strong>
        <span>${escapeHtml(gap.why_it_matters)}</span>
        <small>${escapeHtml(gap.recommended_resolution || "")}</small>
      </div>
      <button type="button" data-intel-review-action="mark_gap_resolved" data-intel-target-id="${escapeAttr(gap.id)}"><i data-lucide="check-circle-2"></i><span>Resolve</span></button>
    </article>
  `).join("");
  const messages = (intel.contact_personalization?.messages || intel.messages || []).slice(0, 5).map((message) => `
    <article class="message-card intel-message">
      <div class="message-heading">
        <span class="pill">${escapeHtml(titleCase(message.channel || "draft"))}</span>
        ${message.subject ? `<strong>${escapeHtml(message.subject)}</strong>` : ""}
        <button data-copy-text="${escapeAttr(message.body || "")}" data-copy-channel="${escapeAttr(message.channel || "draft")}" data-copy-label="Intelligence message" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>
      </div>
      <pre>${escapeHtml(message.body || "")}</pre>
      <small>${escapeHtml((message.personalization_basis || []).slice(0, 3).join(" · "))}</small>
    </article>
  `).join("");
  const contacts = (intel.recommended_contacts || []).slice(0, 4).map((contact) => `
    <article class="intel-contact">
      <strong>${escapeHtml(contact.full_name || contact.target_role || "Target role")}</strong>
      <span>${escapeHtml([contact.role, contact.persona, contact.verification_status].filter(Boolean).join(" · "))}</span>
      <small>${escapeHtml(contact.why_target || "")}</small>
    </article>
  `).join("");
  const objections = (intel.objections || []).slice(0, 4).map((item) => `
    <article class="intel-objection">
      <strong>${escapeHtml(item.objection)}</strong>
      <span>${escapeHtml(item.recommended_response)}</span>
      <small>${escapeHtml(item.qualification_question || item.proof_required || "")}</small>
    </article>
  `).join("");
  return `
    <div class="intelligence-hero">
      <div>
        <span class="pill">${escapeHtml(intel.priority_wave || "Wave")}</span>
        <h3>${escapeHtml(intel.executive_summary || "Intelligence brief ready")}</h3>
        <p>${escapeHtml(profile)} · ${escapeHtml(refreshed)}${intel.reusedFromAccount ? " · reused from account" : ""}</p>
      </div>
      <div class="intelligence-score-grid">${scoreCards}</div>
    </div>
    ${warnings ? `<div class="warning-row">${warnings}</div>` : ""}
    <div class="intelligence-grid">
      <section class="intel-card span-wide">
        <div class="intel-card-heading"><strong>Score Drivers</strong><span>Evidence-weighted, product-specific</span></div>
        <div class="intel-input-list">${scoringInputs || `<div class="empty-state">No scoring inputs</div>`}</div>
      </section>
      <section class="intel-card">
        <div class="intel-card-heading"><strong>Next Steps</strong><span>Seller actions only</span></div>
        <div class="intel-list">${nextSteps || `<div class="empty-state">No next steps</div>`}</div>
      </section>
      <section class="intel-card">
        <div class="intel-card-heading"><strong>Research Gaps</strong><span>Fix before high-confidence outreach</span></div>
        <div class="intel-list">${gaps || `<div class="empty-state">No open gaps</div>`}</div>
      </section>
      <section class="intel-card span-wide">
        <div class="intel-card-heading"><strong>Draft Messages</strong><span>Human review required before sending</span></div>
        <div class="message-list">${messages || `<div class="empty-state">No messages drafted</div>`}</div>
      </section>
      <section class="intel-card">
        <div class="intel-card-heading"><strong>Buying Path</strong><span>Who to reach next</span></div>
        <div class="intel-list">${contacts || `<div class="empty-state">No recommended contacts</div>`}</div>
      </section>
      <section class="intel-card">
        <div class="intel-card-heading"><strong>Objections</strong><span>Likely blockers</span></div>
        <div class="intel-list">${objections || `<div class="empty-state">No objections mapped</div>`}</div>
      </section>
    </div>
  `;
}

function prospectingStrategyRows(prospect) {
  if (!prospect) return `<div class="empty-state">Open a lead and run research to build the account strategy.</div>`;
  const strategy = prospect.leadIntelligence?.prospecting_strategy;
  if (!strategy) return `<div class="intelligence-empty"><i data-lucide="route"></i><div><strong>No account strategy yet</strong><span>Run research to create the A-M account brief, stakeholder routes, message, and conversation plan.</span></div><button class="primary-button" type="button" data-intel-analyze="fresh"><i data-lucide="sparkles"></i><span>Analyze</span></button></div>`;

  const decision = strategy.decision_summary || {};
  const assessment = strategy.executive_assessment || {};
  const gate = strategy.internal_readiness_gate || {};
  const channelStrategy = strategy.channel_strategy || {};
  const decisionRows = [
    ["Primary", decision.primary_contact],
    ["Second route", decision.secondary_contact],
    ["Conversation hook", decision.best_conversation_hook || decision.best_title],
    ["Pilot choice", decision.best_pilot_candidate || decision.best_title],
    ["Best question", decision.best_question]
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "Needs research")}</strong></div>`).join("");
  const gateChecks = (gate.checks || []).map((item) => `<div><span>${escapeHtml(item.check)}</span><strong>${escapeHtml(titleCase(item.status || "verify"))}</strong></div>`).join("");
  const gateActions = gate.policy_sensitive || gate.regulated_category ? `<div class="strategy-gate-actions"><button type="button" data-policy-decision="approved_conditions"><i data-lucide="shield-check"></i><span>Approve Conditions</span></button><button class="danger-button" type="button" data-policy-decision="parked"><i data-lucide="pause-circle"></i><span>Park Account</span></button></div>` : "";
  const knownFacts = (assessment.known_facts || []).map((item) => `<article class="strategy-row"><div><span class="claim-label fact">Known fact</span><strong>${escapeHtml(item.statement)}</strong>${strategyEvidence(prospect, item.source_ids)}</div></article>`).join("");
  const signals = (strategy.recent_signals || []).map((item) => `<article class="strategy-row"><div><span class="claim-label ${item.claim_type === "known_fact" ? "fact" : "hypothesis"}">${escapeHtml(titleCase(item.claim_type || "hypothesis"))}</span><strong>${escapeHtml(item.signal)}</strong><p>${escapeHtml(item.commercial_meaning || "")}</p>${strategyEvidence(prospect, item.source_ids)}</div><small>${escapeHtml(item.date_window || "Date unknown")} · ${Number(item.confidence || 0)}%</small></article>`).join("");
  const titles = (strategy.title_analysis || []).map((item) => `<article class="strategy-title-row"><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml([item.os, item.geo, item.monetization].filter(Boolean).join(" · "))}</span></div><dl><div><dt>Objective</dt><dd>${escapeHtml(item.likely_objective || "Unknown")}</dd></div><div><dt>KPI</dt><dd>${escapeHtml(item.likely_kpi || "Unknown")}</dd></div><div><dt>Risk</dt><dd>${escapeHtml(item.main_risk || "Unknown")}</dd></div><div><dt>Ask</dt><dd>${escapeHtml(item.discovery_question || "")}</dd></div></dl>${strategyEvidence(prospect, item.source_ids)}</article>`).join("");
  const hypotheses = (strategy.growth_hypotheses || []).map((item, index) => `<article class="strategy-hypothesis"><header><span>Hypothesis ${index + 1}</span><b>${Number(item.confidence || 0)}%</b></header><strong>${escapeHtml(item.hypothesis)}</strong><p><b>Evidence:</b> ${escapeHtml(item.evidence || "Not yet verified")}</p><p><b>Why it matters:</b> ${escapeHtml(item.why_it_matters || "")}</p><p><b>Ask:</b> ${escapeHtml(item.validation_question || "")}</p><p><b>AdAction angle:</b> ${escapeHtml(item.adaction_angle || "")}</p>${strategyEvidence(prospect, item.source_ids)}</article>`).join("");
  const stakeholders = (strategy.stakeholder_map || []).map((item, index) => `<article class="strategy-stakeholder"><header><span>${index + 1}</span><div><strong>${escapeHtml(item.full_name || item.target_role || "Unresolved stakeholder")}</strong><small>${escapeHtml([item.role, titleCase(item.deal_role || "")].filter(Boolean).join(" · "))}</small></div></header><dl><div><dt>Purpose</dt><dd>${escapeHtml(item.learn || item.why_contact || "")}</dd></div><div><dt>Personal hook</dt><dd>${escapeHtml(item.personal_hook || "Needs research")}</dd></div><div><dt>Business hook</dt><dd>${escapeHtml(item.business_hook || "")}</dd></div><div><dt>CTA</dt><dd>${escapeHtml(item.cta || "")}</dd></div><div><dt>Do not pitch yet</dt><dd>${escapeHtml(item.do_not_pitch_yet || "")}</dd></div></dl>${strategyEvidence(prospect, item.source_ids)}</article>`).join("");
  const firstTouch = strategy.recommended_first_touch || {};
  const messages = [firstTouch.linkedin ? ["LinkedIn", firstTouch.linkedin] : null, firstTouch.email ? ["Email", firstTouch.email] : null].filter(Boolean).map(([label, item]) => {
    const copyButton = gate.outreach_allowed
      ? `<button data-copy-text="${escapeAttr([item.subject, item.body].filter(Boolean).join("\n\n"))}" data-copy-channel="${label.toLowerCase()}" data-copy-label="Strategy ${label}" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>`
      : `<button type="button" disabled aria-disabled="true" title="Resolve the readiness gate before copying"><i data-lucide="lock-keyhole"></i></button>`;
    return `<article class="strategy-message ${gate.outreach_allowed ? "" : "blocked"}"><header><span class="pill">${label}</span><strong>${escapeHtml(item.subject || item.angle || "First touch")}</strong>${copyButton}</header><pre>${escapeHtml(item.body || "")}</pre>${(item.evidence || []).map((entry) => `<div class="message-evidence"><span class="claim-label ${entry.claim_type === "hypothesis" ? "hypothesis" : "fact"}">${escapeHtml(titleCase(entry.claim_type || "context"))}</span><p>${escapeHtml(entry.line)}</p>${strategyEvidence(prospect, entry.source_ids)}</div>`).join("") || strategyEvidence(prospect, item.source_ids)}</article>`;
  }).join("");
  const conversation = (strategy.conversation_tree || []).map((item) => `<article class="strategy-branch"><strong>If: ${escapeHtml(item.if_they_say)}</strong><p>${escapeHtml(item.respond_with)}</p><span>Next question: ${escapeHtml(item.next_question)}</span></article>`).join("");
  const transition = strategy.adaction_transition || {};
  const cta = strategy.consultation_cta || {};
  const sequence = (strategy.multi_thread_sequence || []).map((item) => `<article class="strategy-sequence-row"><b>${escapeHtml(item.day || "Next")}</b><div><strong>${escapeHtml(item.full_name || item.target_role || "Next stakeholder")}</strong><span>${escapeHtml(item.purpose || "")}</span><small>${escapeHtml([item.channel, item.thesis].filter(Boolean).join(" · "))}</small></div></article>`).join("");
  const risks = (strategy.risks || []).map((item) => `<article class="strategy-row"><div><strong>${escapeHtml(item.risk)}</strong><p>${escapeHtml(item.why_it_matters || "")}</p><span>${escapeHtml(item.handling || "")}</span>${strategyEvidence(prospect, item.source_ids)}</div></article>`).join("");
  const scores = Object.entries(strategy.account_scores || {}).map(([key, item]) => `<article class="strategy-score"><div><span>${escapeHtml(titleCase(key))}</span><strong>${Number(item.score || 0)}/10</strong></div><p>${escapeHtml(item.rationale || "")}</p></article>`).join("");

  return `<div class="strategy-decision-grid">${decisionRows}</div>
    <article class="strategy-gate ${gate.outreach_allowed ? "approved" : "blocked"}"><header><div><span>Internal Readiness Gate</span><strong>${escapeHtml(titleCase(gate.status || "standard verification"))}</strong></div><b>${gate.outreach_allowed ? "Outreach eligible" : "Hold outreach"}</b></header><p>${escapeHtml(gate.reason || "")}</p><div class="strategy-gate-checks">${gateChecks}</div>${strategyEvidence(prospect, gate.source_ids)}${gateActions}</article>
    <details class="strategy-section" open><summary><span>A</span><strong>Executive Account Assessment</strong></summary><div class="strategy-section-body"><h3>${escapeHtml(assessment.summary || "Assessment pending")}</h3><p>${escapeHtml(assessment.why_now || "")}</p>${knownFacts || `<div class="empty-state">No source-backed account fact yet.</div>`}<article class="strategy-channel"><span>Channel strategy</span><strong>${escapeHtml(channelStrategy.primary_route || "Choose after contact review")}</strong><p>${escapeHtml(channelStrategy.reason || "")}</p><small>${escapeHtml(channelStrategy.stop_rule || "")}</small></article></div></details>
    <details class="strategy-section"><summary><span>B</span><strong>Recent 30-90 Day Signals</strong></summary><div class="strategy-section-body strategy-list">${signals || `<div class="empty-state">No dated signals verified.</div>`}</div></details>
    <details class="strategy-section"><summary><span>C</span><strong>App and Title Analysis</strong></summary><div class="strategy-section-body strategy-list">${titles || `<div class="empty-state">No titles verified.</div>`}</div></details>
    <details class="strategy-section"><summary><span>D</span><strong>Growth Hypotheses</strong></summary><div class="strategy-section-body strategy-hypothesis-grid">${hypotheses || `<div class="empty-state">No hypotheses prepared.</div>`}</div></details>
    <details class="strategy-section"><summary><span>E-F</span><strong>Stakeholders and Person-First Angles</strong></summary><div class="strategy-section-body strategy-stakeholder-grid">${stakeholders || `<div class="empty-state">No named stakeholders found.</div>`}</div></details>
    <details class="strategy-section"><summary><span>G</span><strong>Recommended First Touch</strong></summary><div class="strategy-section-body strategy-message-grid">${messages}</div></details>
    <details class="strategy-section"><summary><span>H</span><strong>Follow-Up Conversation Tree</strong></summary><div class="strategy-section-body strategy-branch-grid">${conversation}</div></details>
    <details class="strategy-section"><summary><span>I-J</span><strong>AdAction Transition and Consultation CTA</strong></summary><div class="strategy-section-body strategy-transition-grid"><article><span>When to transition</span><p>${escapeHtml(transition.when_to_use || "")}</p><strong>${escapeHtml(transition.language || "")}</strong><small>${escapeHtml(transition.commercial_framework || "")}</small>${strategyEvidence(prospect, transition.source_ids)}</article><article><span>${escapeHtml(cta.positioning || "Consultation")}</span><strong>${escapeHtml(cta.ask || "")}</strong><p>${escapeHtml(cta.agenda || "")}</p></article></div></details>
    <details class="strategy-section"><summary><span>K</span><strong>Multi-Thread Sequence</strong></summary><div class="strategy-section-body strategy-list">${sequence}</div></details>
    <details class="strategy-section"><summary><span>L</span><strong>Risks and Objections</strong></summary><div class="strategy-section-body strategy-list">${risks}</div></details>
    <details class="strategy-section"><summary><span>M</span><strong>Overall Account Score</strong></summary><div class="strategy-section-body strategy-score-grid">${scores}</div></details>`;
}

function strategyEvidence(prospect, sourceIds = []) {
  const ids = new Set(sourceIds || []);
  const sources = [...(prospect?.leadIntelligence?.sources || []), ...(prospect?.appPortfolio?.evidence || [])]
    .filter((source) => ids.has(source.source_id));
  return sources.length ? evidenceLinks(sources, true) : `<span class="evidence-missing">Hypothesis or evidence pending</span>`;
}

function bestContactConfidence(prospect) {
  if (!isNamedPersonLead(prospect)) return 0;
  const candidates = prospect?.contactDiscovery?.candidates || [];
  return candidates.length ? Math.max(...candidates.map((candidate) => Number(candidate.confidence) || 0)) : 0;
}

function isNamedPersonLead(prospect = {}) {
  const name = String(prospect?.name || "").trim();
  const company = String(prospect?.company || "").trim();
  const linkedin = String(prospect?.linkedin || "");
  if (!name || (company && name.toLowerCase() === company.toLowerCase())) return false;
  if (/linkedin\.com\/company\//i.test(linkedin)) return false;
  return /linkedin\.com\/in\//i.test(linkedin) || name.split(/\s+/).filter(Boolean).length >= 2;
}

function preferredChannel(prospect) {
  const candidates = prospect?.contactDiscovery?.candidates || [];
  if (prospect?.linkedin || candidates.some((candidate) => candidate.type === "linkedin")) return "linkedin";
  if (approvedChannel(prospect || {}, "email")) return "email";
  if (approvedChannel(prospect || {}, "phone")) return "phone";
  return "linkedin";
}

function updateQuickCopies(prospect) {
  const messages = prospect?.outreach?.messages || [];
  const variations = prospect?.outreach?.linkedinVariations || [];
  setCopyText("copyLinkedinQuick", messages.find((message) => /linkedin_invite/i.test(message.channel))?.body || variations[0]?.body || messages.find((message) => /linkedin/i.test(message.channel))?.body || "", "linkedin", "LinkedIn quick copy");
  setCopyText("copyEmailQuick", approvedChannel(prospect || {}, "email") ? messages.find((message) => /email/i.test(message.channel))?.body || "" : "", "email", "Email quick copy");
  setCopyText("copySmsQuick", approvedChannel(prospect || {}, "sms") ? messages.find((message) => /^sms$/i.test(message.channel))?.body || "" : "", "sms", "SMS quick copy");
  setCopyText("copyWhatsappQuick", approvedChannel(prospect || {}, "whatsapp") ? messages.find((message) => /whatsapp/i.test(message.channel))?.body || "" : "", "whatsapp", "WhatsApp quick copy");
  setCopyText("copyTelegramQuick", approvedChannel(prospect || {}, "telegram") ? messages.find((message) => /telegram/i.test(message.channel))?.body || "" : "", "telegram", "Telegram quick copy");
}

function analyticsRows(prospect) {
  const analysis = prospect.analysis || { reachProbability: 0, closeProbability: 0, reasoning: [] };
  return `
    <article class="analysis-card">
      <div>
        <span>Reach chance</span>
        <strong>${analysis.reachProbability}%</strong>
        <div class="meter compact"><span style="width:${analysis.reachProbability}%"></span></div>
      </div>
      <div>
        <span>Close chance</span>
        <strong>${analysis.closeProbability}%</strong>
        <div class="meter compact accent"><span style="width:${analysis.closeProbability}%"></span></div>
      </div>
      <div class="analysis-reason">
        <span>AI next move</span>
        <strong>${escapeHtml(analysis.recommendedAction || "Prepare outreach")}</strong>
        <small>${(analysis.reasoning || []).map(escapeHtml).join(" ")}</small>
      </div>
    </article>
  `;
}

function profileFieldRows(prospect) {
  const publicNote = publicLeadNote(prospect.notes);
  const rows = [
    ["Title", prospect.title],
    ["Company", prospect.company],
    ["Location", prospect.location],
    ["Website", prospect.website],
    ["LinkedIn", prospect.linkedin],
    ["Email", prospect.email],
    ["Phone", prospect.phone],
    ["Notes", publicNote]
  ].filter(([, value]) => value);
  return rows
    .map(
      ([label, value]) => `
        <dt>${escapeHtml(label)}</dt>
        <dd>${linkIfUrl(value)}</dd>
      `
    )
    .join("");
}

function contactRows(prospect) {
  const discovery = prospect.contactDiscovery;
  if (!discovery?.candidates?.length) {
    return `<div class="empty-state">Contact discovery has not run</div>`;
  }

  const candidates = discovery.candidates
    .map(
      (candidate) => {
        const approvalRequired = contactApprovalRequired(candidate.type);
        const approved = candidate.approvalStatus === "approved";
        const rejected = candidate.approvalStatus === "rejected";
        const canApprove = candidate.approvalStatus === "pending";
        return `
        <article class="contact-card">
          <div>
            <span class="contact-type">${escapeHtml(candidate.type)}</span>
            <strong>${linkIfUrl(candidate.value)}</strong>
            <small>${escapeHtml(candidate.source)} · ${escapeHtml(candidate.status)}</small>
            ${approvalRequired ? `<span class="approval-state ${escapeAttr(candidate.approvalStatus || "verification_required")}">${escapeHtml(approved ? "Approved for outreach" : rejected ? "Rejected" : canApprove ? "Seller approval required" : "Verification required")}</span>` : ""}
            ${candidate.evidence?.length ? `<div class="evidence-row">${candidate.evidence.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
          </div>
          <div class="confidence">
            <span>${candidate.confidence}%</span>
            ${approvalRequired && !approved ? `<div class="approval-actions">${canApprove ? `<button type="button" data-contact-decision="approved" data-contact-type="${escapeAttr(candidate.type)}" data-contact-value="${escapeAttr(candidate.value)}"><i data-lucide="check"></i><span>Approve</span></button>` : ""}<button class="icon-button danger-button" type="button" data-contact-decision="rejected" data-contact-type="${escapeAttr(candidate.type)}" data-contact-value="${escapeAttr(candidate.value)}" title="Reject"><i data-lucide="x"></i></button></div>` : ""}
            <button data-copy-text="${approved || !approvalRequired ? escapeAttr(candidate.value) : ""}" data-copy-channel="${escapeAttr(candidate.type || "contact")}" data-copy-label="Contact data" title="${approved || !approvalRequired ? "Copy" : "Approve before use"}" aria-label="Copy" ${approved || !approvalRequired ? "" : "disabled"}><i data-lucide="copy"></i></button>
          </div>
        </article>
      `;
      }
    )
    .join("");

  const warnings = discovery.warnings
    .map((warning) => `<span class="warning-chip">${escapeHtml(warning)}</span>`)
    .join("");
  return `${candidates}<div class="warning-row">${warnings}</div>`;
}

function contactApprovalRequired(type = "") {
  return ["email", "phone", "sms", "whatsapp", "whatsapp_link", "telegram", "telegram_link"].includes(String(type).toLowerCase());
}

function approvedChannel(prospect, channel) {
  if (/linkedin/.test(channel)) return true;
  const normalized = channel === "sms" || channel === "call" ? "phone" : channel;
  return (prospect.contactDiscovery?.candidates || []).some((candidate) =>
    (candidate.type === normalized || candidate.type === `${normalized}_link` || candidate.type === `${normalized}_presence`)
      && candidate.approvalStatus === "approved"
      && !/not_found|rejected/i.test(String(candidate.status || ""))
  );
}

function outreachRows(prospect) {
  const outreach = prospect.outreach;
  if (!outreach) {
    return `<div class="empty-state">Prepare outreach to generate messages and actions</div>`;
  }

  const messages = (outreach.messages || [])
    .map(
      (message) => {
        const basis = (message.personalization_basis || message.basis || []).slice(0, 4).join(" · ");
        const canUse = approvedChannel(prospect, message.channel || "");
        return `
        <article class="message-card">
          <div class="message-heading">
            <span class="pill">${escapeHtml(message.channel)}</span>
            ${message.subject ? `<strong>${escapeHtml(message.subject)}</strong>` : ""}
            <button data-copy-text="${canUse ? escapeAttr(message.body) : ""}" data-copy-channel="${escapeAttr(message.channel || "draft")}" data-copy-label="Outreach message" title="${canUse ? "Copy" : "Approve contact first"}" aria-label="Copy" ${canUse ? "" : "disabled"}><i data-lucide="${canUse ? "copy" : "lock-keyhole"}"></i></button>
          </div>
          <pre>${escapeHtml(message.body)}</pre>
          ${basis ? `<small class="message-basis">${escapeHtml(basis)}</small>` : ""}
          ${evidenceLinks(message.evidence || [])}
        </article>
      `;
      }
    )
    .join("");

  const variations = (outreach.linkedinVariations || [])
    .map(
      (variation) => `
        <article class="message-card linkedin-variation">
          <div class="message-heading">
            <span class="pill">${escapeHtml(variation.label)}</span>
            <strong>LinkedIn variation</strong>
            <button data-copy-text="${escapeAttr(variation.body)}" data-copy-channel="linkedin" data-copy-label="LinkedIn variation" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>
          </div>
          <pre>${escapeHtml(variation.body)}</pre>
        </article>
      `
    )
    .join("");
  const angles = (outreach.messageAngles || []).map((angle, index) => `
    <article class="message-angle-card ${index === 0 ? "recommended" : ""}">
      <div class="message-angle-heading"><div><span class="pill">${index === 0 ? "Recommended" : escapeHtml(angle.label)}</span><strong>${escapeHtml(angle.label)}</strong></div><span class="angle-score">${Number(angle.score || 0)}/100</span></div>
      <p>${escapeHtml(angle.strategy || "")}</p>
      <pre>${escapeHtml(angle.body || "")}</pre>
      <div class="angle-footer"><span>${escapeHtml(angle.scoreReason || "")}</span><button data-copy-text="${escapeAttr(angle.body || "")}" data-copy-channel="linkedin" data-copy-label="${escapeAttr(angle.label || "Message angle")}"><i data-lucide="copy"></i><span>Copy</span></button></div>
      ${evidenceLinks(angle.evidence || [])}
    </article>
  `).join("");

  const actions = (outreach.actions || [])
    .map(
      (action) => `
        <button class="action-row" data-interaction-type="${escapeAttr(action.type)}">
          <i data-lucide="circle-dot"></i>
          <span>${escapeHtml(action.label)}</span>
          <strong>${escapeHtml(action.due)}</strong>
        </button>
      `
    )
    .join("");
  const warmupActions = (outreach.warmupActions || [])
    .map(
      (action) => `
        <article class="warmup-row">
          <i data-lucide="${warmupIcon(action.channel)}"></i>
          <div>
            <strong>${escapeHtml(action.label)}</strong>
            <span>${escapeHtml(action.channel)} · ${escapeHtml(action.due)} · ${escapeHtml(action.priority)}</span>
          </div>
        </article>
      `
    )
    .join("");
  const fallbackWarning = outreach.fallbackReason
    ? `<div class="outreach-warning"><i data-lucide="triangle-alert"></i><span>Live AI fallback used. ${escapeHtml(outreach.fallbackReason)}</span></div>`
    : "";
  const qualityWarnings = (outreach.qualityWarnings || [])
    .map((warning) => `<span>${escapeHtml(warning)}</span>`)
    .join("");
  const qualityWarningBlock = qualityWarnings
    ? `<div class="outreach-warning"><i data-lucide="shield-alert"></i><div>${qualityWarnings}</div></div>`
    : "";

  return `
    <div class="qualification-strip">
      <div><span>Product</span><strong>${escapeHtml(outreach.productName || state.selectedProduct?.name || "")}</strong></div>
      <div><span>Fit</span><strong>${escapeHtml(outreach.qualification?.fit || prospect.analysis?.productFit || "")}</strong></div>
      <div><span>Channel</span><strong>${escapeHtml(outreach.recommendedChannel)}</strong></div>
    </div>
    ${fallbackWarning}
    ${qualityWarningBlock}
    ${angles ? `<div class="message-angle-grid">${angles}</div>` : ""}
    <div class="message-list">${messages}</div>
    <div class="message-list">${variations}</div>
    ${warmupActions ? `<div class="warmup-list">${warmupActions}</div>` : ""}
    <div class="action-list">${actions}</div>
  `;
}

function warmupIcon(channel) {
  if (channel === "facebook") return "badge-check";
  if (channel === "phone") return "phone";
  if (channel === "email") return "mail";
  if (channel === "whatsapp") return "message-circle";
  if (channel === "telegram") return "send";
  if (channel === "sms") return "message-square-text";
  return "mouse-pointer-click";
}

function exampleRow(example) {
  return `
    <article class="example-card">
      <div>
        <span class="pill">${escapeHtml(example.channel)}</span>
        <strong>${escapeHtml(example.label || example.persona || "Example")}</strong>
        <p>${escapeHtml(example.message)}</p>
      </div>
      <small>${escapeHtml(example.outcome || "training context")}</small>
    </article>
  `;
}

function productKnowledgeRow(item) {
  const image = item.screenshot?.dataUrl
    ? `<img src="${escapeAttr(item.screenshot.dataUrl)}" alt="${escapeAttr(item.screenshot.name || "Product screenshot")}" />`
    : `<div class="knowledge-thumb-placeholder"><i data-lucide="${knowledgeIcon(item.type)}"></i></div>`;
  const tags = (item.tags || []).slice(0, 6).map((tag) => `<span class="cap">${escapeHtml(tag)}</span>`).join("");
  const body = item.text || item.url || item.screenshot?.name || "";
  return `
    <article class="knowledge-card">
      <div class="knowledge-thumb">${image}</div>
      <div>
        <div class="knowledge-card-heading">
          <span class="pill">${escapeHtml(titleCase(item.type || "lesson"))}</span>
          <strong>${escapeHtml(item.title || "Product knowledge")}</strong>
          <small>${Number(item.priority || 0)} priority</small>
        </div>
        <p>${linkIfUrl(body)}</p>
        ${item.url && item.text ? `<a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(shortUrl(item.url))}</a>` : ""}
        <div class="cap-list">${tags}</div>
      </div>
    </article>
  `;
}

function knowledgeIcon(type) {
  const icons = {
    link: "link",
    lesson: "book-open-check",
    product_context_update: "file-pen-line",
    platform_note: "panel-top",
    screenshot: "image",
    faq: "circle-help",
    case_study: "badge-check",
    objection: "shield-question",
    competitor: "swords"
  };
  return icons[type] || "file-text";
}

function emptyProductDraft() {
  return {
    id: "",
    name: "",
    category: "",
    positioning: "",
    targetPersonas: [],
    useCases: [],
    proofPoints: [],
    differentiators: [],
    objections: [],
    knowledge: [],
    examples: []
  };
}

function interactionRows(prospect) {
  const interactions = prospect.interactions || [];
  if (!interactions.length) {
    return `<div class="empty-state">No interactions logged</div>`;
  }

  return interactions
    .map(
      (interaction) => {
        const crmSync = interaction.crmSync?.status ? ` · CRM ${interaction.crmSync.status.replace(/_/g, " ")}` : "";
        return `
        <article class="timeline-item">
          <div class="timeline-dot"></div>
          <div>
            <strong>${titleCase(interaction.type)}</strong>
            <span>${escapeHtml(interaction.channel)} · ${escapeHtml(interaction.outcome)} · ${relativeTime(interaction.at)}${escapeHtml(crmSync)}</span>
            <small>${escapeHtml(interaction.note || "")}</small>
          </div>
        </article>
      `;
      }
    )
    .join("");
}

function callAnalysisRows(prospect) {
  const analysis = prospect.callAnalysis;
  if (!analysis) {
    return `<div class="empty-state">Paste a call transcript to get coaching, next templates, and a follow-up task</div>`;
  }

  const tips = (analysis.improvementTips || []).map((tip) => `<li>${escapeHtml(tip)}</li>`).join("");
  const templates = (analysis.nextStepTemplates || [])
    .map(
      (template) => `
        <article class="message-card">
          <div class="message-heading">
            <span class="pill">${escapeHtml(template.channel)}</span>
            <strong>${escapeHtml(template.label)}</strong>
            <button data-copy-text="${escapeAttr(template.body)}" data-copy-channel="${escapeAttr(template.channel || "follow_up")}" data-copy-label="${escapeAttr(template.label || "Follow-up template")}" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>
          </div>
          <pre>${escapeHtml(template.body)}</pre>
        </article>
      `
    )
    .join("");

  return `
    <div class="call-score-row">
      <div><span>Call quality</span><strong>${analysis.qualityScore}%</strong></div>
      <div><span>Sentiment</span><strong>${escapeHtml(analysis.sentiment)}</strong></div>
      <div><span>Product</span><strong>${escapeHtml(analysis.productName)}</strong></div>
    </div>
    <p class="call-summary">${escapeHtml(analysis.summary)}</p>
    <ul class="tip-list">${tips}</ul>
    <div class="message-list">${templates}</div>
  `;
}

function taskNotificationRows(prospect) {
  const tasks = (state.followUpTasks || []).filter((task) => task.prospectId === prospect?.id);
  if (!tasks.length) {
    return `<div class="empty-state">No agreed follow-up detected yet</div>`;
  }

  return tasks
    .map(
      (task) => `
        <article class="task-alert ${task.status === "done" ? "done" : ""}">
          <i data-lucide="bell-ring"></i>
          <div>
            <strong>${escapeHtml(task.label)}</strong>
            <span>${new Date(task.due).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${escapeHtml(task.status)}</span>
          </div>
          ${task.status === "done" ? "" : `<button type="button" data-task-complete-id="${escapeAttr(task.id)}"><i data-lucide="check"></i><span>Done</span></button>`}
        </article>
      `
    )
    .join("");
}

function capabilities(model) {
  return [
    model.structuredOutput ? "JSON" : "",
    model.toolCalling ? "Tools" : "",
    model.streaming ? "Stream" : "",
    model.promptCaching ? "Cache" : "",
    model.zeroRetention ? "ZDR" : model.noTraining ? "No training" : ""
  ].filter(Boolean);
}

function comparisonCopy(index) {
  return [
    "Concise, low-cost variant with dependable structure for routine outreach.",
    "Balanced draft with stronger personalization and conservative claims.",
    "More strategic framing for complex accounts and executive audiences."
  ][index % 3];
}

function fillSelect(select, items, valueFn, labelFn, selectedValue) {
  select.innerHTML = items
    .map((item) => {
      const value = valueFn(item);
      return `<option value="${escapeAttr(value)}" ${value === selectedValue ? "selected" : ""}>${escapeHtml(labelFn(item))}</option>`;
    })
    .join("");
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setHtml(id, html) {
  const element = document.getElementById(id);
  if (element) element.innerHTML = html;
}

function setCopyText(id, value, channel = "", label = "") {
  const element = document.getElementById(id);
  if (!element) return;
  element.dataset.copyText = value || "";
  if (channel) element.dataset.copyChannel = channel;
  if (label) element.dataset.copyLabel = label;
  element.disabled = !value;
}

function renderBusyState() {
  const anyBusy = Boolean(busyAction);
  setBusyButton("quickPrepareBtn", "research", "Running...");
  setBusyButton("runResearchTopBtn", "research", "Running...");
  setBusyButton("prepareOutreachBtn", "research", "Running...");
  setBusyButton("analyzeIntelligenceBtn", "intelligence", "Analyzing...");
  setBusyButton("refreshIntelligenceBtn", "intelligence", "Refreshing...");
  setBusyButton("analyzeIntelligenceQuick", "intelligence", "Analyzing...");
  setBusyButton("enrichProspectBtn", "enrich", "Refreshing...");
  setBusyButton("removeLeadQuick", "remove", "Removing...");
  setBusyButton("addLinkedinTargetBtn", "linkedin-import", "Adding...");
  setBusyButton("crmImportBtn", "crm-import", "Pulling...");
  setBusyButton("productTeachBtn", "product", "Studying...");
  document.querySelectorAll("[data-interaction-type], [data-task-complete-id], [data-remove-prospect-id]").forEach((button) => {
    button.disabled = anyBusy;
  });
}

function renderResearchProgress() {
  const panel = document.getElementById("researchProgressPanel");
  if (!panel) return;
  const savedJob = activeResearchJob || (state?.researchJobs || []).find((job) =>
    job.prospectId === selectedProspectId && ["queued", "running", "failed"].includes(job.status)
  );
  if (!savedJob) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  const stages = (savedJob.stages || []).map((stage) => `
    <div class="research-stage ${escapeAttr(stage.status || "pending")}">
      <i data-lucide="${stage.status === "complete" ? "check" : stage.status === "running" ? "loader-circle" : stage.status === "failed" ? "triangle-alert" : "circle"}"></i>
      <div><strong>${escapeHtml(stage.label)}</strong><span>${escapeHtml(stage.detail || titleCase(stage.status || "pending"))}</span></div>
    </div>
  `).join("");
  panel.innerHTML = `
    <div class="research-progress-heading">
      <div><span class="eyebrow">Background research</span><strong>${escapeHtml(savedJob.productName || "Selected product")} · ${escapeHtml(savedJob.prospectName || "Lead")}</strong></div>
      <span class="pill">${Number(savedJob.progress || 0)}%</span>
    </div>
    <div class="meter"><span style="width:${Number(savedJob.progress || 0)}%"></span></div>
    <div class="research-stage-list">${stages}</div>
    ${savedJob.error ? `<div class="outreach-warning"><i data-lucide="triangle-alert"></i><span>${escapeHtml(savedJob.error)}</span></div>` : ""}
  `;
}

function setBusyButton(id, actionName, activeText) {
  const button = document.getElementById(id);
  if (!button) return;
  if (!button.dataset.defaultHtml) button.dataset.defaultHtml = button.innerHTML;
  const active = busyAction === actionName;
  button.disabled = active || (Boolean(busyAction) && ["research", "intelligence", "enrich", "remove", "linkedin-import", "crm-import", "product"].includes(actionName));
  button.classList.toggle("is-loading", active);
  if (active) {
    const icon = actionName === "remove" ? "loader-circle" : "loader-circle";
    button.innerHTML = `<i data-lucide="${icon}"></i><span>${escapeHtml(activeText)}</span>`;
  } else {
    button.innerHTML = button.dataset.defaultHtml;
  }
}

async function runUiAction(actionName, message, work) {
  if (busyAction) return;
  busyAction = actionName;
  busyMessage = message;
  uiNotice = "";
  renderBusyState();
  refreshIcons();
  try {
    await work();
    uiNotice = {
      research: "Research refreshed. Outreach, score, company context, and next actions are updated.",
      enrich: "Contact data refreshed. Review confidence before using any phone or social profile.",
      "linkedin-import": "Lead added to the queue. Run Research when you are ready to enrich and prepare outreach.",
      "crm-import": "CRM leads pulled into the queue.",
      product: "Product memory saved. The system will use the updated context for scoring and outreach.",
      remove: "Lead removed from the queue."
    }[actionName] || "Action completed.";
  } catch (error) {
    uiNotice = error?.message || "Action failed. Please try again.";
  } finally {
    busyAction = "";
    busyMessage = "";
    render();
  }
}

const VIEW_MEMORY_KEY = "outboundActiveView";

/**
 * The tab survives a reload. Reopening on the dashboard threw away where
 * somebody was working, and the longer the tab takes to be useful — the warm-up
 * reloads two databases — the more that costs.
 *
 * Wrapped because storage throws in a private window and when site data is
 * blocked, and a workspace that cannot remember a tab must still open on one.
 */
function rememberView(viewName) {
  try { window.localStorage.setItem(VIEW_MEMORY_KEY, viewName); } catch {}
}

function rememberedView() {
  let saved = null;
  try { saved = window.localStorage.getItem(VIEW_MEMORY_KEY); } catch {}
  // Only a tab that still exists: a view removed in an update must not leave
  // somebody staring at a blank shell with no way back.
  return saved && document.getElementById(`view-${saved}`) ? saved : null;
}

function setView(viewName) {
  views.forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
  navItems.forEach((item) => item.classList.toggle("active", item.dataset.view === viewName));
  document.getElementById("pageTitle").textContent =
    {
      prospects: "Dashboard",
      leads: "Leads",
      warmup: "LinkedIn Warm-up",
      ai: "AI Operator",
      database: "Knowledge Base",
      products: "Products",
      account: "Account",
      integrations: "Settings",
      overview: "AI Orchestration Control",
      models: "Model Registry",
      routing: "Task Routing",
      budgets: "Budget Controls",
      privacy: "Privacy Policy",
      evaluation: "Model Evaluation"
    }[viewName] || "Outbound Sales OS";
  rememberView(viewName);

  if (viewName === "overview") {
    drawTrafficChart();
  }
  // Opening Products shows the selected product, but only into an empty box:
  // coming back to the tab must not throw away something half-typed.
  if (viewName === "products" && !document.getElementById("productContextInput")?.value) {
    fillProductEditor(state.selectedProduct);
  }
  // Loaded when the tab is opened rather than at boot: it talks to a different
  // database, and a workspace that never warms an account should not pay for it.
  if (viewName === "warmup") {
    loadWarmup();
  }
}

function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function linkIfUrl(value) {
  const text = String(value || "");
  if (/^https?:\/\//i.test(text)) {
    return `<a href="${escapeAttr(text)}" target="_blank" rel="noreferrer">${escapeHtml(shortUrl(text))}</a>`;
  }
  return escapeHtml(text);
}

function companyLinkedInPeopleUrlForProspect(prospect = {}) {
  return prospect.publicCompanyResearch?.linkedinPeopleUrl
    || linkedInCompanyPeopleUrl(prospect.companyLinkedin)
    || linkedInCompanyPeopleUrl(inferredLinkedInCompanyUrl(prospect.company));
}

function inferredLinkedInCompanyUrl(company) {
  const slug = String(company || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `https://www.linkedin.com/company/${slug}/` : "";
}

function normalizeLinkedInCompanyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    const companyIndex = parts.indexOf("company");
    if (companyIndex < 0 || !parts[companyIndex + 1]) return "";
    return `https://www.linkedin.com/company/${parts[companyIndex + 1]}/`;
  } catch {
    return "";
  }
}

function linkedInCompanyPeopleUrl(value) {
  const companyUrl = normalizeLinkedInCompanyUrl(value);
  return companyUrl ? `${companyUrl}people/` : "";
}

function shortUrl(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 64);
  } catch {
    return value;
  }
}

function publicLeadNote(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/\b(crm|folder|page\s+\d+|status|owner|imported|advantage|netlify|api token|api key|endpoint|uuid|id[:=])\b/i.test(raw)) return "";
  return raw
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\b[A-Fa-f0-9]{8}-[A-Fa-f0-9-]{13,}\b/g, "")
    .trim()
    .slice(0, 180);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function renderProductKnowledgeScreenshotPreview() {
  const preview = document.getElementById("productKnowledgeScreenshotPreview");
  const name = document.getElementById("productKnowledgeScreenshotName");
  if (!preview || !name) return;
  if (!pendingProductKnowledgeScreenshot) {
    preview.innerHTML = "";
    name.textContent = "PNG or JPG from product, demo, CRM, docs";
    return;
  }
  name.textContent = `${pendingProductKnowledgeScreenshot.name} · ${Math.round(pendingProductKnowledgeScreenshot.size / 1024)} KB`;
  preview.innerHTML = `
    <img src="${escapeAttr(pendingProductKnowledgeScreenshot.dataUrl)}" alt="${escapeAttr(pendingProductKnowledgeScreenshot.name)}" />
    <span>${escapeHtml(pendingProductKnowledgeScreenshot.name)}</span>
  `;
}

function renderLearningScreenshotPreview() {
  const preview = document.getElementById("learningScreenshotPreview");
  const name = document.getElementById("learningScreenshotName");
  if (!pendingLearningScreenshot) {
    preview.innerHTML = "";
    return;
  }
  name.textContent = `${pendingLearningScreenshot.name} · ${Math.round(pendingLearningScreenshot.size / 1024)} KB`;
  preview.innerHTML = `
    <img src="${escapeAttr(pendingLearningScreenshot.dataUrl)}" alt="${escapeAttr(pendingLearningScreenshot.name)}" />
    <span>${escapeHtml(pendingLearningScreenshot.name)}</span>
  `;
}

function renderKnowledgeInboxScreenshotPreview() {
  const preview = document.getElementById("knowledgeInboxScreenshotPreview");
  const name = document.getElementById("knowledgeInboxScreenshotName");
  if (!preview || !name) return;
  if (!pendingKnowledgeInboxScreenshot) {
    preview.innerHTML = "";
    name.textContent = "Optional PNG/JPG from platform, SMS, LinkedIn, CRM, or product docs";
    return;
  }
  name.textContent = `${pendingKnowledgeInboxScreenshot.name} · ${Math.round(pendingKnowledgeInboxScreenshot.size / 1024)} KB`;
  preview.innerHTML = `
    <img src="${escapeAttr(pendingKnowledgeInboxScreenshot.dataUrl)}" alt="${escapeAttr(pendingKnowledgeInboxScreenshot.name)}" />
    <span>${escapeHtml(pendingKnowledgeInboxScreenshot.name)}</span>
  `;
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function relativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "unknown";
  const diffMs = Date.now() - timestamp;
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function parseProfiles(text, fileName = "") {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (fileName.endsWith(".json") || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const rows = parseCsv(trimmed);
  const headers = rows.shift()?.map((header) => header.trim()) || [];
  return rows
    .filter((row) => row.some((cell) => cell.trim()))
    .map((row) =>
      Object.fromEntries(headers.map((header, index) => [header, row[index] || ""]))
    );
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function moveSelectedProspect(direction) {
  const prospects = state.prospects || [];
  if (!prospects.length) return;
  const currentIndex = Math.max(0, prospects.findIndex((prospect) => prospect.id === selectedProspectId));
  const nextIndex = (currentIndex + direction + prospects.length) % prospects.length;
  selectedProspectId = prospects[nextIndex].id;
  if (activeResearchJob?.prospectId !== selectedProspectId) activeResearchJob = null;
  activeLeadSectionId = "dashboard-account";
  render();
  scrollLeadWorkspaceToTop();
}

function scrollLeadWorkspaceToTop() {
  document.getElementById("dashboard-overview")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

navItems.forEach((item) => {
  item.addEventListener("click", () => setView(item.dataset.view));
});

document.getElementById("mobileLeadSectionSelect").addEventListener("change", (event) => {
  activeLeadSectionId = event.target.value || "dashboard-account";
  renderLeadSectionTabs();
  document.querySelector(".lead-section-nav")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("accountMenuBtn").addEventListener("click", () => setView("account"));

document.getElementById("authModeBtn").addEventListener("click", () => {
  authMode = authMode === "recover" ? "login" : "recover";
  setText("authMessage", "");
  renderAuthForm();
  refreshIcons();
});

document.getElementById("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("authEmailInput").value;
  const password = document.getElementById("authPasswordInput").value;
  const confirmation = document.getElementById("authConfirmInput").value;
  try {
    if ((authMode === "bootstrap" || authMode === "reset") && password !== confirmation) throw new Error("Passwords do not match.");
    if (authMode === "recover") {
      const result = await api("/api/auth/recover", { method: "POST", body: JSON.stringify({ email }) });
      setText("authMessage", result.message || "Reset link requested.");
      return;
    }
    if (authMode === "reset") {
      await api("/api/auth/complete-recovery", { method: "POST", body: JSON.stringify({ accessToken: window.sessionStorage.getItem("outboundRecoveryToken"), password }) });
      window.sessionStorage.removeItem("outboundRecoveryToken");
      window.history.replaceState({}, "", window.location.pathname);
      authMode = "login";
      setText("authMessage", "Password changed. Sign in with the new password.");
      renderAuthForm();
      return;
    }
    const endpoint = authMode === "bootstrap" ? "/api/auth/bootstrap" : "/api/auth/login";
    const result = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ name: document.getElementById("authNameInput").value, email, password })
    });
    authState = result.auth;
    await enterWorkspace();
  } catch (error) {
    setText("authMessage", error.message || "Could not sign in.");
  }
});

document.getElementById("accountProfileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/account/profile", { method: "POST", body: JSON.stringify({ name: document.getElementById("accountNameInput").value, title: document.getElementById("accountTitleInput").value }) });
  authState = await api("/api/auth/status");
  render();
});

document.getElementById("accountPasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.getElementById("accountPasswordInput").value;
  if (password !== document.getElementById("accountPasswordConfirmInput").value) {
    uiNotice = "Passwords do not match.";
    renderTopbar();
    return;
  }
  await api("/api/account/password", { method: "POST", body: JSON.stringify({ password }) });
  event.currentTarget.reset();
  uiNotice = "Password changed.";
  renderTopbar();
});

document.getElementById("teamUserForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api("/api/account/users", { method: "POST", body: JSON.stringify({ name: document.getElementById("teamUserNameInput").value, email: document.getElementById("teamUserEmailInput").value, password: document.getElementById("teamUserPasswordInput").value, role: document.getElementById("teamUserRoleInput").value }) });
  event.currentTarget.reset();
  authState = await api("/api/auth/status");
  uiNotice = result.existingAccount
    ? "Existing company account added. The seller should use their current password or recover it."
    : "Seller account created.";
  render();
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST", body: "{}" });
  authState = { authenticated: false, bootstrapRequired: false };
  authMode = "login";
  showAuthGate();
});

document.addEventListener("click", async (event) => {
  const contactDecision = event.target.closest("[data-contact-decision]");
  if (contactDecision && selectedProspectId) {
    await runUiAction("contact-approval", "Reviewing contact evidence and channel access...", async () => {
      state = await api("/api/prospects/contacts/approval", { method: "POST", body: JSON.stringify({ prospectId: selectedProspectId, type: contactDecision.dataset.contactType, value: contactDecision.dataset.contactValue, decision: contactDecision.dataset.contactDecision }) });
    });
    return;
  }
  if (event.target.closest("#retrainScoringBtn")) {
    state = await api("/api/scoring/retrain", { method: "POST", body: "{}" });
    render();
  }
});

document.getElementById("chartMode").addEventListener("change", drawTrafficChart);
document.getElementById("modelSearch").addEventListener("input", renderModels);
document.getElementById("modelTierFilter").addEventListener("change", renderModels);
document.getElementById("prospectSearch").addEventListener("input", renderProspects);
document.getElementById("prospectStatusFilter").addEventListener("change", renderProspects);
document.getElementById("productSelect").addEventListener("change", async (event) => {
  creatingNewProduct = false;
  await runUiAction("product", "Switching product context...", async () => {
    state = await api("/api/products/select", {
      method: "POST",
      body: JSON.stringify({ productId: event.target.value })
    });
  });
});

document.getElementById("productStudioProductSelect")?.addEventListener("change", async (event) => {
  creatingNewProduct = false;
  await runUiAction("product", "Switching product context...", async () => {
    state = await api("/api/products/select", {
      method: "POST",
      body: JSON.stringify({ productId: event.target.value })
    });
  });
  // Choosing a product shows it. This is what the Edit button used to be for,
  // and a chooser that leaves the box empty is a chooser that chose nothing.
  fillProductEditor(state.selectedProduct);
});

document.getElementById("syncMcpBtn").addEventListener("click", async () => {
  state = await api("/api/products/sync-mcp", { method: "POST", body: "{}" });
  render();
});

document.getElementById("quickPrepareBtn").addEventListener("click", async () => {
  await runUiAction("research", "Running lead research, enrichment, scoring, and outreach...", researchAndPrepareSelected);
});

document.getElementById("runResearchTopBtn").addEventListener("click", async () => {
  await runUiAction("research", "Running lead research, enrichment, scoring, and outreach...", researchAndPrepareSelected);
});

document.getElementById("analyzeIntelligenceBtn").addEventListener("click", async () => {
  await runUiAction("intelligence", "Building the account intelligence brief...", () => analyzeLeadIntelligence(false));
});

document.getElementById("refreshIntelligenceBtn").addEventListener("click", async () => {
  await runUiAction("intelligence", "Refreshing the account intelligence brief...", () => analyzeLeadIntelligence(true));
});

document.getElementById("analyzeIntelligenceQuick").addEventListener("click", async () => {
  await runUiAction("intelligence", "Building the account intelligence brief...", () => analyzeLeadIntelligence(false));
});

document.getElementById("prevLeadBtn").addEventListener("click", () => {
  moveSelectedProspect(-1);
});

document.getElementById("nextLeadBtn").addEventListener("click", () => {
  moveSelectedProspect(1);
});

document.getElementById("nextLeadRailBtn").addEventListener("click", () => {
  moveSelectedProspect(1);
});

document.addEventListener("click", async (event) => {
  const viewLink = event.target.closest("[data-view-link]");
  if (viewLink) {
    setView(viewLink.dataset.viewLink);
    return;
  }

  const leadTab = event.target.closest("[data-lead-tab]");
  if (leadTab) {
    activeLeadSectionId = leadTab.dataset.leadTab || "dashboard-account";
    renderLeadSectionTabs();
    document.querySelector(".lead-section-nav")?.scrollIntoView({ behavior: "smooth", block: "start" });
    refreshIcons();
    return;
  }

  const openProspect = event.target.closest("[data-open-prospect-id]");
  if (openProspect) {
    selectedProspectId = openProspect.dataset.openProspectId;
    if (activeResearchJob?.prospectId !== selectedProspectId) activeResearchJob = null;
    activeLeadSectionId = "dashboard-account";
    setView("prospects");
    render();
    scrollLeadWorkspaceToTop();
    return;
  }

  const assistantTemplate = event.target.closest("[data-assistant-template]");
  if (assistantTemplate) {
    document.getElementById("assistantTaskInput").value = assistantTemplate.dataset.assistantTemplate || "";
    setView("ai");
    return;
  }

  const inlineAnalyze = event.target.closest("[data-intel-analyze]");
  if (inlineAnalyze) {
    await runUiAction("intelligence", "Building the account intelligence brief...", () => analyzeLeadIntelligence(inlineAnalyze.dataset.intelAnalyze === "refresh"));
    return;
  }

  const intelligenceTask = event.target.closest("[data-intel-task-index]");
  if (intelligenceTask && selectedProspectId) {
    await runUiAction("task", "Creating follow-up task...", async () => {
      state = await api("/api/prospects/intelligence/create-task", {
        method: "POST",
        body: JSON.stringify({ prospectId: selectedProspectId, stepIndex: Number(intelligenceTask.dataset.intelTaskIndex || 0) })
      });
    });
    return;
  }

  const intelligenceReview = event.target.closest("[data-intel-review-action]");
  if (intelligenceReview && selectedProspectId) {
    await runUiAction("task", "Saving review update...", async () => {
      state = await api("/api/prospects/intelligence/review", {
        method: "POST",
        body: JSON.stringify({
          prospectId: selectedProspectId,
          action: intelligenceReview.dataset.intelReviewAction,
          targetId: intelligenceReview.dataset.intelTargetId
        })
      });
    });
    return;
  }

  const policyDecision = event.target.closest("[data-policy-decision]");
  if (policyDecision && selectedProspectId) {
    const status = policyDecision.dataset.policyDecision;
    const label = status === "parked" ? "Parking account..." : "Saving approved conditions...";
    await runUiAction("policy-decision", label, async () => {
      state = await api("/api/prospects/policy-decision", {
        method: "POST",
        body: JSON.stringify({ prospectId: selectedProspectId, status })
      });
    });
    uiNotice = status === "parked"
      ? "Account parked. Research and outreach remain on hold."
      : "Conditions approved. Run research again to rebuild the strategy under those conditions.";
    renderTopbar();
    return;
  }

  const removeProspect = event.target.closest("[data-remove-prospect-id]");
  if (removeProspect) {
    await removeProspectById(removeProspect.dataset.removeProspectId);
    return;
  }

  const prospectCardButton = event.target.closest("[data-prospect-id]");
  if (prospectCardButton) {
    selectedProspectId = prospectCardButton.dataset.prospectId;
    if (activeResearchJob?.prospectId !== selectedProspectId) activeResearchJob = null;
    activeLeadSectionId = "dashboard-account";
    renderProspects();
    renderLeadWorkspaceExtras(state.prospects?.find((prospect) => prospect.id === selectedProspectId));
    refreshIcons();
  }

  const copyButton = event.target.closest("[data-copy-text]");
  if (copyButton) {
    const copiedText = copyButton.dataset.copyText || "";
    await navigator.clipboard.writeText(copiedText);
    const originalHtml = copyButton.dataset.copyDefaultHtml || copyButton.innerHTML;
    copyButton.dataset.copyDefaultHtml = originalHtml;
    copyButton.innerHTML = `<i data-lucide="check"></i><span>Copied</span>`;
    refreshIcons();
    void logCopiedActivity(copyButton, copiedText);
    window.setTimeout(() => {
      copyButton.innerHTML = originalHtml;
      refreshIcons();
    }, 900);
    return;
  }

  const actionInteraction = event.target.closest("[data-interaction-type]");
  if (actionInteraction && selectedProspectId) {
    await logInteraction(actionInteraction.dataset.interactionType);
    return;
  }

  const completeTask = event.target.closest("[data-task-complete-id]");
  if (completeTask) {
    await runUiAction("task", "Marking follow-up complete...", async () => {
      state = await api("/api/follow-up-tasks/complete", {
        method: "POST",
        body: JSON.stringify({ taskId: completeTask.dataset.taskCompleteId })
      });
    });
    return;
  }

  const toggle = event.target.closest("[data-model-toggle]");
  if (toggle) {
    state = await api("/api/models/toggle", {
      method: "POST",
      body: JSON.stringify({ modelId: toggle.dataset.modelToggle, enabled: toggle.dataset.enabled === "true" })
    });
    render();
  }

  const taskRow = event.target.closest("[data-task-row]");
  if (taskRow) {
    selectedTaskType = taskRow.dataset.taskRow;
    renderRouting();
    refreshIcons();
  }
});

document.getElementById("sampleProspectsBtn").addEventListener("click", async () => {
  const prospects = [
    {
      name: "Nina Patel",
      title: "Director of Growth",
      company: "HelioGrid Energy",
      location: "Denver, CO",
      website: "heliogrid.example",
      notes: "Building a partner-sourced pipeline motion across regional energy installers."
    },
    {
      name: "Owen Miller",
      title: "Chief Commercial Officer",
      company: "SlateBridge Finance",
      location: "New York, NY",
      website: "slatebridge.example",
      notes: "Announced new SMB lending product and expanded account executive hiring."
    }
  ];
  state = await api("/api/prospects/import", {
    method: "POST",
    body: JSON.stringify({ prospects })
  });
  selectedProspectId = state.prospects[0]?.id || selectedProspectId;
  render();
});

document.getElementById("linkedinTargetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await runUiAction("linkedin-import", "Adding LinkedIn target to the queue...", async () => {
    state = await api("/api/prospects/linkedin-target", {
      method: "POST",
      body: JSON.stringify({
        linkedinUrl: document.getElementById("linkedinTargetUrlInput").value,
        name: document.getElementById("linkedinTargetNameInput").value,
        company: document.getElementById("linkedinTargetCompanyInput").value
      })
    });
    selectedProspectId = state.prospects[0]?.id || selectedProspectId;
    document.getElementById("linkedinTargetUrlInput").value = "";
    document.getElementById("linkedinTargetNameInput").value = "";
    document.getElementById("linkedinTargetCompanyInput").value = "";
  });
});

document.getElementById("assistantTaskForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("assistantTaskInput");
  await runAssistantTask({
    instruction: input.value,
    scope: document.getElementById("assistantScopeSelect").value,
    limit: Number(document.getElementById("assistantLimitInput").value),
    selectedProspectId
  });
  input.value = "";
});

document.getElementById("crmLeadPullForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    source: document.getElementById("crmPullSourceInput").value,
    resource: document.getElementById("crmPullResourceInput").value,
    limit: Number(document.getElementById("crmPullLimitInput").value),
    linkedinField: document.getElementById("crmPullLinkedInFieldInput").value
  };
  await runUiAction("crm-import", "Pulling leads from CRM...", async () => {
    state = await api("/api/crm/import-leads", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    selectedProspectId = state.prospects[0]?.id || selectedProspectId;
  });
});

document.getElementById("agentRunForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/agents/run", {
    method: "POST",
    body: JSON.stringify({
      agentId: document.getElementById("agentSelect").value,
      scope: document.getElementById("agentScopeSelect").value,
      limit: Number(document.getElementById("agentLimitInput").value),
      selectedProspectId,
      instruction: document.getElementById("agentInstructionInput").value
    })
  });
  render();
});

document.getElementById("runPipelineBtn").addEventListener("click", async () => {
  state = await api("/api/agents/pipeline", {
    method: "POST",
    body: JSON.stringify({
      scope: document.getElementById("agentScopeSelect").value,
      limit: Number(document.getElementById("agentLimitInput").value),
      selectedProspectId,
      instruction: document.getElementById("agentInstructionInput").value
    })
  });
  render();
});

document.getElementById("newProductBtn")?.addEventListener("click", () => {
  creatingNewProduct = true;
  clearProductTrainingField();
  renderProductStudio();
  refreshIcons();
});

document.getElementById("deleteProductBtn")?.addEventListener("click", async () => {
  const product = state.selectedProduct;
  if (!product) return;
  if (!window.confirm(`Delete ${product.name}? This removes its product memory, knowledge, and examples from Outbound OS.`)) return;
  await runUiAction("product", "Deleting product memory...", async () => {
    state = await api("/api/products/delete", {
      method: "POST",
      body: JSON.stringify({ productId: product.id })
    });
    creatingNewProduct = false;
    clearProductTrainingField();
  });
});

document.getElementById("productForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const structuredText = productTrainingText();
  await runUiAction("product", "Analyzing product text and updating system memory...", async () => {
    state = await api("/api/products/teach", {
      method: "POST",
      body: JSON.stringify({
        productId: creatingNewProduct ? "" : state.selectedProductId,
        text: structuredText,
        forceSelectedProduct: !creatingNewProduct,
        createNewProduct: creatingNewProduct
      })
    });
    // Show what was just saved rather than emptying the box. The box is the
    // product now, so clearing it after a save reads as the product having
    // gone — which was survivable when this was one field among seven.
    fillProductEditor(state.selectedProduct);
  });
  creatingNewProduct = false;
});

/**
 * What gets taught. One box, because the server only ever saw one string: the
 * six structured fields were concatenated into this same text under headings,
 * and on edit they were filled with the product own derived positioning,
 * personas and proof — so saving fed the analysis its own output back as input.
 */
function productTrainingText() {
  return String(document.getElementById("productContextInput").value || "").trim();
}

function clearProductTrainingField() {
  const element = document.getElementById("productContextInput");
  if (element) element.value = "";
}

/** The text this product was taught from, which is the only thing to edit. */
function fillProductEditor(product) {
  setFormValue("productContextInput", product?.rawContext || product?.positioning || "");
}

function setFormValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.value = value || "";
}

document.getElementById("exampleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (creatingNewProduct) {
    document.getElementById("exampleList").innerHTML = `<div class="empty-state">Save the new product first, then add examples</div>`;
    return;
  }
  state = await api("/api/products/examples", {
    method: "POST",
    body: JSON.stringify({
      productId: state.selectedProductId,
      channel: document.getElementById("exampleChannelInput").value,
      quality: document.getElementById("exampleQualityInput").value,
      persona: document.getElementById("examplePersonaInput").value,
      message: document.getElementById("exampleMessageInput").value,
      outcome: document.getElementById("exampleOutcomeInput").value
    })
  });
  document.getElementById("exampleMessageInput").value = "";
  document.getElementById("exampleOutcomeInput").value = "";
  render();
});

document.getElementById("mcpConfigForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/integrations/mcp/configure", {
    method: "POST",
    body: JSON.stringify({
      baseUrl: document.getElementById("mcpBaseUrlInput").value,
      resourceNamespace: document.getElementById("mcpNamespaceInput").value,
      apiToken: document.getElementById("mcpTokenInput").value
    })
  });
  document.getElementById("mcpTokenInput").value = "";
  render();
});

document.getElementById("openRouterConfigForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/openrouter/configure", {
    method: "POST",
    body: JSON.stringify({
      apiKey: document.getElementById("openRouterKeyInput").value,
      analysisModel: document.getElementById("analysisModelInput").value,
      writingModel: document.getElementById("writingModelInput").value
    })
  });
  document.getElementById("openRouterKeyInput").value = "";
  render();
});

document.getElementById("apifyConfigForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/integrations/apify/configure", {
    method: "POST",
    body: JSON.stringify({
      apiToken: document.getElementById("apifyTokenInput").value,
      leadDatabaseActorId: document.getElementById("leadDatabaseActorInput").value,
      leadDatabaseInputTemplate: document.getElementById("leadDatabaseInputTemplate").value,
      linkedinProfileActorId: document.getElementById("linkedinActorInput").value,
      contactFinderActorId: document.getElementById("contactFinderActorInput").value,
      apolloActorId: document.getElementById("apolloActorInput").value,
      zoominfoActorId: document.getElementById("zoominfoActorInput").value,
      facebookProfileActorId: document.getElementById("facebookProfileActorInput").value,
      emailPhoneFinderActorId: document.getElementById("emailPhoneFinderActorInput").value,
      phoneMessengerCheckActorId: document.getElementById("phoneMessengerCheckActorInput").value,
      whatsappCheckerActorId: document.getElementById("whatsappCheckerActorInput").value,
      telegramCheckerActorId: document.getElementById("telegramCheckerActorInput").value,
      companyPeopleActorId: document.getElementById("companyPeopleActorInput").value,
      companyPeopleSecondaryActorId: document.getElementById("companyPeopleSecondaryActorInput").value,
      personEnrichmentActorId: document.getElementById("personEnrichmentActorInput").value,
      companyPeopleInputTemplate: document.getElementById("companyPeopleInputTemplate").value,
      maxChargeUsd: Number(document.getElementById("apifyMaxChargeInput").value),
      contactMaxChargeUsd: Number(document.getElementById("apifyContactMaxChargeInput").value),
      maxActorsPerLead: Number(document.getElementById("apifyMaxActorsInput").value),
      cacheDays: Number(document.getElementById("apifyCacheDaysInput").value)
    })
  });
  document.getElementById("apifyTokenInput").value = "";
  render();
});

document.getElementById("crmConfigForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/integrations/crm/configure", {
    method: "POST",
    body: JSON.stringify({
      name: document.getElementById("crmNameInput").value,
      baseUrl: document.getElementById("crmBaseUrlInput").value,
      apiToken: document.getElementById("crmTokenInput").value,
      leadObject: document.getElementById("crmLeadObjectInput").value,
      contactObject: document.getElementById("crmContactObjectInput").value,
      activityObject: document.getElementById("crmActivityObjectInput").value
    })
  });
  document.getElementById("crmTokenInput").value = "";
  render();
});

document.getElementById("transcriptConfigForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/integrations/transcripts/configure", {
    method: "POST",
    body: JSON.stringify({
      provider: document.getElementById("transcriptProviderInput").value,
      webhookUrl: document.getElementById("transcriptWebhookInput").value,
      apiToken: document.getElementById("transcriptTokenInput").value,
      notificationChannel: document.getElementById("notificationChannelInput").value,
      notificationTarget: document.getElementById("notificationTargetInput").value
    })
  });
  document.getElementById("transcriptTokenInput").value = "";
  render();
});

document.getElementById("dataConfigForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/integrations/data/configure", {
    method: "POST",
    body: JSON.stringify({
      supabaseUrl: document.getElementById("supabaseUrlInput").value,
      supabaseApiKey: document.getElementById("supabaseApiKeyInput").value,
      pgHost: document.getElementById("pgHostInput").value,
      pgPort: Number(document.getElementById("pgPortInput").value),
      pgDatabase: document.getElementById("pgDatabaseInput").value,
      pgUser: document.getElementById("pgUserInput").value,
      pgPassword: document.getElementById("pgPasswordInput").value
    })
  });
  document.getElementById("supabaseApiKeyInput").value = "";
  document.getElementById("pgPasswordInput").value = "";
  render();
});

document.getElementById("knowledgeInboxScreenshotInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    pendingKnowledgeInboxScreenshot = null;
    renderKnowledgeInboxScreenshotPreview();
    return;
  }
  if (!file.type.startsWith("image/")) {
    window.alert("Upload a PNG or JPG screenshot.");
    event.target.value = "";
    return;
  }
  if (file.size > 2_000_000) {
    window.alert("Keep screenshots under 2 MB for this local prototype.");
    event.target.value = "";
    return;
  }
  pendingKnowledgeInboxScreenshot = {
    name: file.name,
    type: file.type,
    size: file.size,
    dataUrl: await fileToDataUrl(file)
  };
  renderKnowledgeInboxScreenshotPreview();
});

document.getElementById("knowledgeInboxForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = document.getElementById("knowledgeInboxTextInput").value;
  if (!text.trim() && !pendingKnowledgeInboxScreenshot) {
    setHtml("knowledgeInboxResult", `<div class="empty-state">Paste text, a URL, a lesson, or upload a screenshot first.</div>`);
    return;
  }
  await runUiAction("knowledge", "Analyzing knowledge and updating the AI playbook...", async () => {
    state = await api("/api/knowledge/feed", {
      method: "POST",
      body: JSON.stringify({
        productId: document.getElementById("knowledgeInboxProductInput").value,
        assetType: document.getElementById("knowledgeInboxTypeInput").value,
        channel: document.getElementById("knowledgeInboxTypeInput").value,
        messageText: text,
        notes: text,
        outcome: "knowledge_saved",
        outcomeScore: 75,
        tags: `knowledge,inbox,${document.getElementById("knowledgeInboxTypeInput").value}`,
        screenshot: pendingKnowledgeInboxScreenshot
      })
    });
    pendingKnowledgeInboxScreenshot = null;
    document.getElementById("knowledgeInboxScreenshotInput").value = "";
    document.getElementById("knowledgeInboxTextInput").value = "";
  });
});

document.getElementById("learningScreenshotInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    pendingLearningScreenshot = null;
    renderLearningScreenshotPreview();
    return;
  }
  if (!file.type.startsWith("image/")) {
    window.alert("Upload a PNG or JPG screenshot.");
    event.target.value = "";
    return;
  }
  if (file.size > 2_000_000) {
    window.alert("Keep screenshots under 2 MB for this local prototype.");
    event.target.value = "";
    return;
  }
  pendingLearningScreenshot = {
    name: file.name,
    type: file.type,
    size: file.size,
    dataUrl: await fileToDataUrl(file)
  };
  renderLearningScreenshotPreview();
});

document.getElementById("learningExampleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/learning/examples", {
    method: "POST",
    body: JSON.stringify({
      productId: document.getElementById("learningProductInput").value,
      channel: document.getElementById("learningChannelInput").value,
      persona: document.getElementById("learningPersonaInput").value,
      outcome: document.getElementById("learningOutcomeInput").value,
      outcomeScore: Number(document.getElementById("learningOutcomeScoreInput").value),
      profileUrl: document.getElementById("learningProfileUrlInput").value,
      messageText: document.getElementById("learningMessageInput").value,
      notes: document.getElementById("learningNotesInput").value,
      tags: document.getElementById("learningTagsInput").value,
      screenshot: pendingLearningScreenshot
    })
  });
  pendingLearningScreenshot = null;
  document.getElementById("learningScreenshotInput").value = "";
  document.getElementById("learningMessageInput").value = "";
  document.getElementById("learningNotesInput").value = "";
  document.getElementById("learningTagsInput").value = "";
  document.getElementById("learningProfileUrlInput").value = "";
  document.getElementById("learningOutcomeInput").value = "";
  document.getElementById("learningScreenshotName").textContent = "PNG or JPG from SMS, LinkedIn, WhatsApp, email, CRM";
  renderLearningScreenshotPreview();
  render();
});

document.getElementById("learningRetrainBtn").addEventListener("click", async () => {
  state = await api("/api/learning/retrain", { method: "POST", body: "{}" });
  render();
});

document.getElementById("icpSeedForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const textarea = document.getElementById("icpSeedTextInput");
  const prospects = parseProfiles(textarea.value);
  state = await api("/api/icp/seeds/import", {
    method: "POST",
    body: JSON.stringify({
      prospects,
      totalResults: Number(document.getElementById("icpTotalResultsInput").value)
    })
  });
  selectedProspectId = state.icp.seedLeads?.[0]?.id || selectedProspectId;
  textarea.value = "";
  render();
});

document.getElementById("icpGenerateJsonBtn").addEventListener("click", async () => {
  state = await api("/api/icp/lookalike-json", {
    method: "POST",
    body: JSON.stringify({ totalResults: Number(document.getElementById("icpTotalResultsInput").value) })
  });
  render();
});

document.getElementById("icpRunApifyBtn").addEventListener("click", async () => {
  if (!window.confirm("Run the configured Apify actor with the current ICP filters? This may use paid Apify credits.")) return;
  state = await api("/api/icp/lookalike-search", {
    method: "POST",
    body: JSON.stringify({
      totalResults: Number(document.getElementById("icpTotalResultsInput").value),
      limit: Math.min(Number(document.getElementById("icpTotalResultsInput").value) || 100, 100)
    })
  });
  selectedProspectId = state.prospects[0]?.id || selectedProspectId;
  render();
});

document.getElementById("profileFileInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const prospects = parseProfiles(text, file.name);
  state = await api("/api/prospects/import", {
    method: "POST",
    body: JSON.stringify({ prospects })
  });
  selectedProspectId = state.prospects[0]?.id || selectedProspectId;
  event.target.value = "";
  render();
});

document.getElementById("pasteProfilesForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const textarea = document.getElementById("profilesTextInput");
  const prospects = parseProfiles(textarea.value);
  state = await api("/api/prospects/import", {
    method: "POST",
    body: JSON.stringify({ prospects })
  });
  selectedProspectId = state.prospects[0]?.id || selectedProspectId;
  textarea.value = "";
  render();
});

document.getElementById("enrichProspectBtn").addEventListener("click", async () => {
  if (!selectedProspectId) return;
  await runUiAction("enrich", "Refreshing contact and messenger data...", async () => {
    state = await api("/api/prospects/enrich", {
      method: "POST",
      body: JSON.stringify({ prospectId: selectedProspectId, force: true })
    });
  });
});

document.getElementById("prepareOutreachBtn").addEventListener("click", async () => {
  await runUiAction("research", "Running lead research, enrichment, scoring, and outreach...", researchAndPrepareSelected);
});

async function analyzeLeadIntelligence(force = false) {
  if (!selectedProspectId) return;
  activeLeadSectionId = "dashboard-intelligence";
  state = await api("/api/prospects/intelligence/analyze", {
    method: "POST",
    body: JSON.stringify({
      prospectId: selectedProspectId,
      force,
      refreshReason: force ? "manual_refresh" : "seller_requested_brief"
    })
  });
  render();
  document.querySelector(".lead-section-nav")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function researchAndPrepareSelected() {
  if (!selectedProspectId) return;
  const profile = document.getElementById("outreachProfileSelect").value;
  const payload = await api("/api/research/jobs", {
    method: "POST",
    body: JSON.stringify({ prospectId: selectedProspectId, profile })
  });
  activeResearchJob = payload.job;
  renderResearchProgress();
  refreshIcons();
  const deadline = Date.now() + 5 * 60 * 1000;
  while (["queued", "running"].includes(activeResearchJob.status) && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    const update = await api(`/api/research/jobs/${encodeURIComponent(activeResearchJob.id)}`);
    activeResearchJob = update.job;
    const runningStage = activeResearchJob.stages?.find((stage) => stage.status === "running");
    busyMessage = runningStage ? `${runningStage.label} · ${activeResearchJob.progress}%` : `Research · ${activeResearchJob.progress}%`;
    renderTopbar();
    renderResearchProgress();
    refreshIcons();
  }
  if (activeResearchJob.status !== "complete") {
    throw new Error(activeResearchJob.error || "Research did not finish within five minutes.");
  }
  await refresh();
  activeLeadSectionId = "dashboard-account";
  render();
}

async function runAssistantTask(payload) {
  if (!payload.instruction?.trim()) {
    document.getElementById("assistantActionList").innerHTML = `<div class="empty-state">Type a task for the AI Operator</div>`;
    return;
  }
  state = await api("/api/assistant/task", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  selectedProspectId = state.prospects[0]?.id || selectedProspectId;
  render();
}

async function logInteraction(type) {
  if (!selectedProspectId || !type) return;
  await runUiAction("task", "Logging the action on this lead...", async () => {
    state = await api("/api/prospects/interaction", {
      method: "POST",
      body: JSON.stringify({ prospectId: selectedProspectId, type })
    });
  });
}

async function logCopiedActivity(button, copiedText) {
  if (!selectedProspectId || !String(copiedText || "").trim()) return;
  const channel = normalizeCopyChannel(button.dataset.copyChannel || inferCopyChannel(copiedText));
  const type = copiedInteractionType(channel);
  const label = button.dataset.copyLabel || "Copied outreach";
  const preview = cleanCopyPreview(copiedText);
  try {
    state = await api("/api/prospects/interaction", {
      method: "POST",
      body: JSON.stringify({
        prospectId: selectedProspectId,
        type,
        channel,
        outcome: "copied",
        note: `${label}: ${titleCase(channel)} copied in Outbound OS.`,
        source: "copy-button",
        metadata: {
          uiLabel: label,
          messagePreview: preview,
          copiedLength: String(copiedText || "").length
        }
      })
    });
    renderLeadWorkspaceExtras(state.prospects?.find((prospect) => prospect.id === selectedProspectId));
  } catch (error) {
    console.warn("Copy activity was not logged", error);
  }
}

function normalizeCopyChannel(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("linkedin")) return "linkedin";
  if (text.includes("email")) return "email";
  if (text.includes("whatsapp")) return "whatsapp";
  if (text.includes("telegram")) return "telegram";
  if (text.includes("sms") || text.includes("phone")) return text.includes("phone") ? "phone" : "sms";
  if (text.includes("call")) return "phone";
  if (text.includes("facebook")) return "facebook";
  return "outreach";
}

function copiedInteractionType(channel) {
  if (channel === "linkedin") return "linkedin_message_copied";
  if (channel === "email") return "email_message_copied";
  if (channel === "sms") return "sms_message_copied";
  if (channel === "whatsapp") return "whatsapp_message_copied";
  if (channel === "telegram") return "telegram_message_copied";
  if (channel === "phone") return "phone_script_copied";
  return "outreach_message_copied";
}

function inferCopyChannel(value) {
  const text = String(value || "").toLowerCase();
  if (/linkedin\.com|connect on linkedin|connection/.test(text)) return "linkedin";
  if (/whatsapp|wa\.me/.test(text)) return "whatsapp";
  if (/telegram|t\.me/.test(text)) return "telegram";
  if (/@/.test(text)) return "email";
  if (/\+?\d[\d\s().-]{7,}/.test(text)) return "phone";
  return "outreach";
}

function cleanCopyPreview(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

async function removeProspectById(prospectId = selectedProspectId) {
  if (!prospectId) return;
  await runUiAction("remove", "Removing lead from the queue...", async () => {
    state = await api("/api/prospects/remove", {
      method: "POST",
      body: JSON.stringify({ prospectId })
    });
    if (selectedProspectId === prospectId) {
      selectedProspectId = state.prospects?.[0]?.id || null;
    }
  });
}

document.getElementById("logInteractionBtn").addEventListener("click", async () => {
  if (!selectedProspectId) return;
  await logInteraction(document.getElementById("interactionTypeSelect").value);
});

document.getElementById("taskLogInteractionBtn").addEventListener("click", async () => {
  if (!selectedProspectId) return;
  await logInteraction(document.getElementById("taskInteractionTypeSelect").value);
});

document.getElementById("removeLeadQuick").addEventListener("click", async () => {
  await removeProspectById(selectedProspectId);
});

document.getElementById("keyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const apiKey = document.getElementById("apiKeyInput").value;
  const environment = document.getElementById("environmentInput").value;
  state = await api("/api/openrouter/key", {
    method: "POST",
    body: JSON.stringify({ apiKey, environment })
  });
  document.getElementById("apiKeyInput").value = "";
  render();
});

document.getElementById("testConnectionBtn").addEventListener("click", async () => {
  state = await api("/api/openrouter/test", { method: "POST", body: "{}" });
  render();
});

document.getElementById("revokeKeyBtn").addEventListener("click", async () => {
  state = await api("/api/openrouter/revoke", { method: "POST", body: "{}" });
  render();
});

document.getElementById("syncModelsBtn").addEventListener("click", async () => {
  state = await api("/api/openrouter/sync", { method: "POST", body: "{}" });
  render();
});

document.getElementById("taskSelect").addEventListener("change", (event) => {
  selectedTaskType = event.target.value;
  renderRouting();
  refreshIcons();
});

document.getElementById("routingForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const fallbackSelect = document.getElementById("fallbackModelSelect");
  const fallbackModels = [...fallbackSelect.selectedOptions].map((option) => option.value);
  state = await api("/api/tasks/update", {
    method: "POST",
    body: JSON.stringify({
      taskType: document.getElementById("taskSelect").value,
      primaryModel: document.getElementById("primaryModelSelect").value,
      fallbackModels,
      maxCostUsd: Number(document.getElementById("taskCostInput").value),
      maxLatencyMs: Number(document.getElementById("taskLatencyInput").value),
      privacyLevel: document.getElementById("taskPrivacySelect").value
    })
  });
  selectedTaskType = document.getElementById("taskSelect").value;
  render();
});

document.getElementById("budgetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/budgets/update", {
    method: "POST",
    body: JSON.stringify({
      monthlyWorkspaceBudgetUsd: Number(document.getElementById("monthlyBudgetInput").value),
      dailyWorkspaceBudgetUsd: Number(document.getElementById("dailyBudgetInput").value),
      perUserMonthlyBudgetUsd: Number(document.getElementById("userBudgetInput").value),
      warningThresholdPercent: Number(document.getElementById("thresholdInput").value),
      hardLimitEnabled: document.getElementById("hardLimitInput").checked
    })
  });
  render();
});

document.getElementById("privacyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state = await api("/api/provider-rule/update", {
    method: "POST",
    body: JSON.stringify({
      policy: document.getElementById("providerPolicyInput").value,
      allowProviderFallbacks: document.getElementById("providerFallbackInput").checked,
      requireNoTraining: document.getElementById("noTrainingInput").checked,
      requireZeroRetention: document.getElementById("zeroRetentionInput").checked
    })
  });
  render();
});

document.getElementById("runTaskBtn").addEventListener("click", () => {
  document.getElementById("runDialog").showModal();
  refreshIcons();
});

document.getElementById("runForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") {
    return;
  }
  event.preventDefault();
  const payload = await api("/api/tasks/run", {
    method: "POST",
    body: JSON.stringify({
      taskType: document.getElementById("runTaskSelect").value,
      profile: document.getElementById("runProfileSelect").value,
      preferredModel: document.getElementById("runPreferredModelSelect").value
    })
  });
  state = payload;
  document.getElementById("runOutput").textContent = payload.run.ok
    ? `Used ${payload.run.modelUsed} through ${payload.run.provider}. Cost ${formatUsd(payload.run.usage.costUsd)}.`
    : payload.run.message;
  render();
});

document.getElementById("compareBtn").addEventListener("click", () => {
  renderEvaluation();
});

await bootApplication();

/* ── LinkedIn warm-up ──────────────────────────────────────────────────────
 *
 * The list is Anty's profiles with this app's warm-up joined on, never the
 * other way round. Every number shown here — today's quota, what is left, when
 * the next session is due — comes from the server rather than being recomputed
 * in the browser, so the figure on screen is the figure an action is checked
 * against.
 */

const warmupState = {
  config: null,
  dashboard: null,
  profiles: [],
  selectedAccountId: null,
  selectedProfileId: null,
  detail: null,
  busy: false,
  error: "",
  // Campaigns: a folder, the filters that narrow it, the accounts that work it
  // and a product, each with the server's forecast for that combination. The
  // forecast is never recomputed here — a second copy of that arithmetic is a
  // second answer.
  folders: [],
  foldersReady: false,
  campaigns: [],
  campaignsReady: false,
  campaignsError: "",
  campaignNotice: "",
  selectedCampaignId: null,
  // The form is open on exactly one thing at a time: a new campaign (id null)
  // or an existing one. Nothing is a draft in two places.
  formOpen: false,
  formCampaignId: null,
  savingCampaign: false,
  pendingAccountIds: null,
  // Per account: what is claimed to it now, or the server's sentence saying why
  // nothing is. An empty box is never the answer here.
  queues: {},
  queueBusy: {},
  leads: [],
  leadsTotal: null,
  leadsTargeting: null,
  leadsPrompt: "",
  leadsError: "",
  leadsReady: false,
  // The inbox. `ready` is "the endpoint answered", `available` is "this server
  // has the endpoint at all" — a portal built before the inbox landed should
  // say so rather than claim nobody has written.
  inbox: {
    threads: [],
    unread: 0,
    sync: null,
    ready: false,
    available: true,
    error: "",
    unreadOnly: false,
    showAll: false,
    // The open thread, held as account + thread because a thread key is only
    // unique within the account it arrived on.
    openAccountId: null,
    openThreadKey: null,
    open: null,
    openError: "",
    openBusy: false
  },
  // Null is "not asked yet", which is not the same as zero: a badge that has
  // never been told a number must not claim there is nothing to read.
  unreadReplies: null
};

function warmupApi(path, options) {
  return api(`/api/warmup${path}`, options);
}

const WARMUP_STATUS_TONE = {
  warming: "tone-live",
  paused: "tone-warn",
  blocked: "tone-bad",
  needs_attention: "tone-warn",
  finished: "tone-done",
  excluded: "tone-muted",
  off: "tone-muted"
};

const WARMUP_STATUS_LABEL = {
  warming: "Warming",
  paused: "Paused",
  blocked: "Blocked",
  needs_attention: "Needs attention",
  finished: "Finished",
  excluded: "Excluded",
  off: "Off"
};

function warmupRelativeTime(iso) {
  if (!iso) return "—";
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (!Number.isFinite(minutes)) return "—";
  const time = new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (minutes <= 0) return time;
  if (minutes < 60) return `${time} · in ${minutes} min`;
  return `${time} · in ${Math.round(minutes / 60)} h`;
}

/** What the "next session" cell says, which follows the quota and not the clock. */
function warmupNextSessionCell(profile) {
  const next = profile.nextSession;
  if (profile.isRunningNow) return '<span class="warmup-due">open now</span>';
  if (!next) return "—";
  if (next.overdue) return '<span class="warmup-due">due now</span>';
  if (next.today) return warmupRelativeTime(next.at);
  return `tomorrow ${new Date(next.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function warmupConnectionsCell(profile) {
  const { today = 0, total = 0, quota = 0, startsDay = null } = profile.connections || {};
  if (quota > 0) return `${today}/${quota} <span class="warmup-subtle">· ${total} all time</span>`;
  if (startsDay) return `<span class="warmup-subtle">from day ${startsDay}</span>`;
  return `<span class="warmup-subtle">${total} all time</span>`;
}

function renderWarmupConfigNote() {
  const note = document.getElementById("warmupConfigNote");
  if (!note) return;
  const config = warmupState.config;
  const problems = [];

  if (warmupState.error) problems.push(escapeHtml(warmupState.error));
  if (config && !config.configured) {
    problems.push(`The Anty database is not configured — set ${escapeHtml(config.missing.join(", "))} on the server.`);
  }
  if (config?.configured && !config.teamConfigured) {
    problems.push("ANTY_TEAM_ID is not set, so every team's profiles are listed.");
  }
  if (config?.configured && !config.crmConfigured) {
    problems.push(`The lead queue is off — set ${escapeHtml(config.crmMissing.join(", "))} to send connection requests to named people.`);
  }
  if (config?.configured && !config.secretsConfigured) {
    problems.push("LINKEDIN_SECRET_KEY is not set, so account passwords cannot be stored.");
  }

  note.hidden = problems.length === 0;
  note.innerHTML = problems.map((problem) => `<p>${problem}</p>`).join("");
}

function renderWarmupStats() {
  const strip = document.getElementById("warmupStatsStrip");
  if (!strip) return;
  const dashboard = warmupState.dashboard;
  if (!dashboard) {
    strip.innerHTML = "";
    return;
  }

  const { totals, todayProgress } = dashboard;
  const window = warmupState.config?.window;
  const cards = [
    { label: "Warming", value: totals.warming },
    { label: "Paused", value: totals.paused },
    { label: "Finished", value: totals.completed },
    { label: "Not started", value: totals.idle },
    { label: "Today", value: `${todayProgress.done}/${todayProgress.planned}` },
    { label: "Session window", value: window ? `${window.label}${window.open ? "" : " · closed"}` : "—" }
  ];

  strip.innerHTML = cards
    .map((card) => `<div class="warmup-stat"><span>${escapeHtml(card.label)}</span><strong>${escapeHtml(String(card.value))}</strong></div>`)
    .join("");
}

/* ── Campaigns ─────────────────────────────────────────────────────────────
 *
 * A campaign is a folder, the filters that narrow it, the accounts that work it
 * and a product. The list is not the point of this panel; the sentence under
 * the selected row is. A folder of 22 088 contacts at about 22 requests a day
 * is three years of work, and a screen that shows that as "0 of 22 088" in a
 * table cell has presented three years as a progress bar. So the forecast keeps
 * the whole width it had when there was only one form, and every number on it
 * comes from the server.
 *
 * A campaign proposes; the warm-up disposes. Nothing here sets a pace — the
 * numbers are what the accounts' own warm-up days already allow.
 */

const WARMUP_EMPTY_FILTERS = { country: "", position: "", leadStatus: "", ownerId: "" };

const WARMUP_CAMPAIGN_TONE = {
  draft: "tone-muted",
  running: "tone-live",
  paused: "tone-warn",
  done: "tone-done"
};

/** What a campaign in this state is doing, said once rather than implied. */
const WARMUP_CAMPAIGN_STATE_NOTE = {
  draft: "A draft claims nobody. Start it and its accounts begin taking people from this folder.",
  running: "Running: whatever today's quota leaves over is offered to this campaign in the order below.",
  paused: "Paused. Its accounts spend their quota on the campaigns below it instead; nothing already claimed is lost.",
  done: "Marked done. Nothing more is claimed from it, and what was already sent stays as history."
};

function warmupFilterInputs() {
  return {
    country: document.getElementById("warmupFilterCountry"),
    position: document.getElementById("warmupFilterPosition"),
    leadStatus: document.getElementById("warmupFilterStatus"),
    ownerId: document.getElementById("warmupFilterOwner")
  };
}

/** What the form says right now, which is not always what is saved. */
function warmupFormValues() {
  const filters = { ...WARMUP_EMPTY_FILTERS };
  for (const [key, input] of Object.entries(warmupFilterInputs())) {
    filters[key] = (input?.value || "").trim();
  }
  return {
    name: (document.getElementById("warmupCampaignName")?.value || "").trim(),
    folderId: document.getElementById("warmupFolderSelect")?.value || "",
    productId: document.getElementById("warmupCampaignProduct")?.value || "",
    filters
  };
}

function warmupCampaignById(id) {
  return warmupState.campaigns.find((campaign) => campaign.id === id) || null;
}

function warmupSelectedCampaign() {
  return warmupCampaignById(warmupState.selectedCampaignId);
}

/** The campaign the open form is editing, or null when it is a new one. */
function warmupEditingCampaign() {
  return warmupState.formOpen ? warmupCampaignById(warmupState.formCampaignId) : null;
}

function warmupCampaignSaved(campaign) {
  return {
    name: campaign?.name || "",
    folderId: campaign?.folderId || "",
    productId: campaign?.productId || "",
    filters: { ...WARMUP_EMPTY_FILTERS, ...(campaign?.filters || {}) }
  };
}

/** Does the open form differ from the campaign it is editing? */
function warmupFormDirty() {
  if (!warmupState.formOpen || !warmupState.foldersReady) return false;
  const editing = warmupEditingCampaign();
  if (!editing) return true;
  const form = warmupFormValues();
  const saved = warmupCampaignSaved(editing);
  if (form.name !== saved.name || form.folderId !== saved.folderId || form.productId !== saved.productId) return true;
  return Object.keys(WARMUP_EMPTY_FILTERS).some((key) => form.filters[key] !== saved.filters[key]);
}

/** The accounts ticked against one campaign — the tick column follows this. */
function warmupCampaignAccountIds(campaign) {
  return new Set(campaign?.accountIds || []);
}

/** 12 038 rather than 12038: these are counts somebody has to weigh. */
function warmupCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return Math.round(number).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** A thousand days is not a figure anybody can feel; "2.7 years" is. */
function warmupDuration(days) {
  const number = Number(days);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (number < 45) return `${Math.round(number)} days`;
  if (number < 365) return `${Math.round(number / 30)} months`;
  return `${(number / 365).toFixed(1)} years`;
}

function warmupFolderName(folderId) {
  if (!folderId) return null;
  const listed = warmupState.folders.find((folder) => folder.id === folderId)?.name;
  if (listed) return listed;
  // A folder the CRM no longer lists is still the folder a campaign is pointed
  // at, and the name stored with the campaign is what answers for it.
  return warmupState.campaigns.find((campaign) => campaign.folderId === folderId && campaign.folderName)?.folderName || null;
}

function warmupProductName(productId) {
  if (!productId) return null;
  return (state?.products || []).find((product) => product.id === productId)?.name || null;
}

function renderWarmupFolderOptions(selectedId) {
  const select = document.getElementById("warmupFolderSelect");
  if (!select) return;
  const signature = `${warmupState.foldersReady}|${warmupState.folders.length}|${selectedId || ""}|${warmupState.campaignsError}`;
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;

  if (!warmupState.foldersReady) {
    select.innerHTML = `<option value="">${escapeHtml(warmupState.campaignsError ? "Folders unavailable" : "Loading folders...")}</option>`;
    select.disabled = true;
    return;
  }

  select.disabled = false;
  const options = [`<option value="">Pick a folder</option>`];
  const known = new Set();
  for (const folder of warmupState.folders) {
    known.add(folder.id);
    const count = warmupCount(folder.contactCount);
    const archived = folder.isArchived ? " · archived" : "";
    options.push(`<option value="${escapeAttr(folder.id)}" ${folder.id === selectedId ? "selected" : ""}>${escapeHtml(folder.name)} · ${escapeHtml(count)} contacts${archived}</option>`);
  }
  // A folder the list no longer carries (archived, or renamed away) is still
  // the folder this campaign is pointed at, so it stays selectable rather than
  // silently becoming "none".
  if (selectedId && !known.has(selectedId)) {
    const name = warmupEditingCampaign()?.folderName || warmupFolderName(selectedId) || selectedId;
    options.splice(1, 0, `<option value="${escapeAttr(selectedId)}" selected>${escapeHtml(name)} · not in the folder list</option>`);
  }
  select.innerHTML = options.join("");
}

/** Products are the workspace's own — one list, not a second copy of it. */
function renderWarmupProductOptions(selectedId) {
  const select = document.getElementById("warmupCampaignProduct");
  if (!select) return;
  const products = state?.products || [];
  const signature = `${products.length}|${selectedId || ""}`;
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;

  const options = [`<option value="" ${selectedId ? "" : "selected"}>No product</option>`];
  const known = new Set();
  for (const product of products) {
    known.add(product.id);
    options.push(`<option value="${escapeAttr(product.id)}" ${product.id === selectedId ? "selected" : ""}>${escapeHtml(product.name)}</option>`);
  }
  if (selectedId && !known.has(selectedId)) {
    options.push(`<option value="${escapeAttr(selectedId)}" selected>${escapeHtml(selectedId)} · not in this workspace</option>`);
  }
  select.innerHTML = options.join("");
}

/**
 * The forecast, in the words Phase 1 settled on. Four shapes: no API, nothing
 * targeted, a folder the ticked accounts can finish, and — the one that matters
 * — a folder they cannot. Returns the tone and the markup so a campaign can be
 * handed its own verdict without this being recomputed per row.
 */
function warmupForecastHtml(campaign, { stale = "" } = {}) {
  const forecast = campaign?.forecast || null;

  if (!forecast) {
    const reason = campaign?.forecastError
      || (campaign?.folderId ? "No forecast came back for this folder." : "This campaign has no folder yet.");
    return {
      tone: "is-muted",
      html: `<p class="warmup-forecast-line">${escapeHtml(reason)}</p>
        <p class="warmup-forecast-hint">${campaign?.folderId
          ? "Nothing says how long this folder would take until the server can count it, so treat this campaign as unchecked."
          : "Edit it and pick a folder — until then it has nothing to draw from."}</p>${stale}`
    };
  }

  const matching = Number(forecast.matching) || 0;
  const approached = Number(forecast.alreadyApproached) || 0;
  const remaining = Number(forecast.remaining) || 0;
  const perMonth = Number(forecast.reachedThisMonth) || 0;
  const peak = Number(forecast.perDayAtPeak) || 0;
  const now = Number(forecast.perDayNow) || 0;
  const chosen = Number(forecast.accountsChosen) || 0;
  const fullPass = warmupDuration(forecast.daysToFinish);

  const parts = [
    `<span>${warmupCount(matching)} in the folder</span>`,
    `<span>${warmupCount(approached)} already approached</span>`,
    `<strong>${warmupCount(peak)} a day</strong>`,
    `<span>~${warmupCount(perMonth)} in a month</span>`,
    remaining === 0
      ? `<span>nothing left to work through</span>`
      : fullPass
        ? `<span>a full pass ~${escapeHtml(fullPass)}</span>`
        : `<span>a full pass never finishes</span>`
  ];

  let tone = "is-ok";
  let hint = "";

  // A folder that matches nobody and a folder worked to the end are both "0
  // left", and they need opposite things done about them.
  if (matching === 0) {
    tone = "is-bad";
    hint = "Nothing in this folder passes these filters, so this campaign has nobody to work at all. Widen them, or point it at another folder.";
  } else if (chosen === 0) {
    tone = "is-bad";
    hint = `Nobody is working this campaign, so none of the ${warmupCount(remaining)} left get reached. Tick the accounts that should send from it in Profiles below.`;
  } else if (peak === 0) {
    tone = "is-bad";
    hint = `The ${chosen === 1 ? "ticked account has" : `${chosen} ticked accounts have`} no connection quota even at peak, so this campaign would never move. Tick an account that is actually warming.`;
  } else if (remaining === 0) {
    tone = "is-muted";
    hint = "Everyone this campaign matches has already been approached. Widen the filters or point it at another folder.";
  } else if (remaining > perMonth * 3) {
    tone = "is-bad";
    hint = `At that rate this folder is ${escapeHtml(fullPass || "more work than these accounts will ever get through")} of work — ${warmupCount(perMonth)} of the ${warmupCount(remaining)} left get reached in the first month and the rest simply sit there. Edit the campaign and narrow it by country, position or lead status until what is left is a list these accounts can finish.`;
  } else if (remaining > perMonth) {
    tone = "is-warn";
    hint = `${warmupCount(remaining)} left is more than one month of sending. It finishes in about ${escapeHtml(fullPass || "an unknown time")} — narrow the filters if that is longer than the campaign.`;
  }

  // Today and at peak are different promises, and the panel should not let the
  // better one stand for both.
  let today = "";
  if (peak && now === 0) {
    today = `<p class="warmup-forecast-today"><strong>Nothing goes out today.</strong> None of the ticked accounts may send a connection request yet — the strategy holds them back over the first days — so <strong>${warmupCount(peak)} a day</strong> is what they reach once every one of them is warm, not what happens now.</p>`;
  } else if (peak && now !== peak) {
    today = `<p class="warmup-forecast-today">Today it is <strong>${warmupCount(now)} a day</strong>, not ${warmupCount(peak)}: the rest of the ticked accounts are still climbing, paused or not warming yet.</p>`;
  }

  return {
    tone,
    html: `
      <p class="warmup-forecast-line">${parts.join('<span class="warmup-forecast-dot" aria-hidden="true">·</span>')}</p>
      ${hint ? `<p class="warmup-forecast-hint">${hint}</p>` : ""}
      ${today}
      ${stale}`
  };
}

function warmupTickedAccountsLine(campaign) {
  const ids = warmupCampaignAccountIds(campaign);
  if (!ids.size) return "No account is ticked, so this campaign sends nothing.";
  const names = [];
  for (const profile of warmupState.profiles) {
    if (profile.account && ids.has(profile.account.id)) names.push(profile.name);
  }
  const hidden = ids.size - names.length;
  if (!names.length) return `Worked by ${ids.size} account${ids.size === 1 ? "" : "s"} that this list does not show.`;
  const listed = escapeHtml(names.slice(0, 4).join(", "));
  const more = names.length > 4 ? ` +${names.length - 4} more` : "";
  return `Worked by ${listed}${more}${hidden > 0 ? ` · ${hidden} not in the list below` : ""}`;
}

/**
 * One row. It carries the scale of the campaign — sent of what is left — and
 * the tone of its forecast, so a folder nobody can finish is visible in the
 * list too. The sentence that says why still lives under the selected row.
 */
function warmupCampaignRowHtml(campaign, rank) {
  const selected = campaign.id === warmupState.selectedCampaignId;
  const { tone } = warmupForecastHtml(campaign);
  const progress = campaign.progress || {};
  const sent = Number(progress.sent) || 0;
  const queued = Number(progress.queued) || 0;
  const remaining = campaign.forecast ? Number(campaign.forecast.remaining) || 0 : null;
  const accounts = (campaign.accountIds || []).length;
  const folder = campaign.folderName || warmupFolderName(campaign.folderId) || (campaign.folderId ? "a folder the CRM does not list" : "no folder");
  const product = warmupProductName(campaign.productId);

  const meta = [
    escapeHtml(folder),
    `${accounts} account${accounts === 1 ? "" : "s"}`,
    product ? escapeHtml(product) : "no product"
  ];

  const controls = [];
  // The order is the only thing deciding which campaign an account actually
  // serves — the first running one with work takes the whole quota. So the rank
  // is not a tooltip on a label somebody cannot change; it is the readout of
  // the two arrows that set it.
  const index = warmupState.campaigns.indexOf(campaign);
  const rankLabel = rank
    ? `<strong title="Its accounts' quota is offered to running campaigns in this order, and the first with work takes it.">#${rank} in line</strong>`
    : `<em title="Where it sits in the order. It joins the line when it runs.">not in line</em>`;
  controls.push(`<span class="warmup-campaign-move">
    <button class="text-button" type="button" data-warmup-campaign-move="up" ${index <= 0 ? "disabled" : ""} title="Offer this campaign its accounts' quota earlier" aria-label="Move ${escapeAttr(campaign.name || "this campaign")} earlier in the order"><i data-lucide="chevron-up"></i></button>
    ${rankLabel}
    <button class="text-button" type="button" data-warmup-campaign-move="down" ${index < 0 || index >= warmupState.campaigns.length - 1 ? "disabled" : ""} title="Offer this campaign its accounts' quota later" aria-label="Move ${escapeAttr(campaign.name || "this campaign")} later in the order"><i data-lucide="chevron-down"></i></button>
  </span>`);
  if (campaign.state === "running") {
    controls.push(`<button class="text-button" type="button" data-warmup-campaign-state="paused" title="Stop claiming from this campaign"><i data-lucide="pause"></i><span>Pause</span></button>`);
  } else if (campaign.state !== "done") {
    controls.push(`<button class="text-button" type="button" data-warmup-campaign-state="running" title="Let its accounts claim from this campaign"><i data-lucide="play"></i><span>Start</span></button>`);
  }
  if (campaign.state !== "done") {
    controls.push(`<button class="text-button" type="button" data-warmup-campaign-state="done" title="Nothing more is claimed from it"><i data-lucide="check"></i><span>Done</span></button>`);
  } else {
    controls.push(`<button class="text-button" type="button" data-warmup-campaign-state="running" title="Let its accounts claim from it again"><i data-lucide="rotate-ccw"></i><span>Reopen</span></button>`);
  }
  controls.push(`<button class="text-button" type="button" data-warmup-campaign-edit><i data-lucide="pencil"></i><span>Edit</span></button>`);
  controls.push(`<button class="text-button warmup-campaign-delete" type="button" data-warmup-campaign-delete><i data-lucide="trash-2"></i><span>Delete</span></button>`);

  const count = remaining === null
    ? `<span class="warmup-campaign-count-unknown">${warmupCount(sent)} sent · what is left could not be counted</span>`
    : `<strong>${warmupCount(sent)}</strong><span>sent of ${warmupCount(remaining)} left</span>`;

  return `
    <article class="warmup-campaign-row ${tone} ${selected ? "is-selected" : ""}" data-warmup-campaign="${escapeAttr(campaign.id)}">
      <div class="warmup-campaign-who">
        <div class="warmup-campaign-name">
          <button class="warmup-campaign-select" type="button" data-warmup-campaign-select aria-pressed="${selected}">${escapeHtml(campaign.name || "Unnamed campaign")}</button>
          <span class="pill ${WARMUP_CAMPAIGN_TONE[campaign.state] || "tone-muted"}">${escapeHtml(campaign.state || "draft")}</span>
        </div>
        <div class="warmup-campaign-meta">${meta.join('<span class="warmup-forecast-dot" aria-hidden="true">·</span>')}</div>
      </div>
      <div class="warmup-campaign-count">
        ${count}
        ${queued ? `<span class="warmup-campaign-claimed">${warmupCount(queued)} claimed and not sent</span>` : ""}
        ${campaign.progressApproximate
          ? '<span class="warmup-campaign-approx" title="Another campaign shares an account and this folder, so its rows are counted here too. Telling them apart needs a column wl_outreach does not have.">counted across a shared account</span>'
          : ""}
      </div>
      <div class="warmup-campaign-actions">${controls.join("")}</div>
    </article>`;
}

function renderWarmupCampaignList() {
  const host = document.getElementById("warmupCampaignList");
  if (!host) return;

  if (warmupState.campaignsError) {
    host.innerHTML = `<div class="warmup-leads-prompt is-bad"><strong>${escapeHtml(warmupState.campaignsError)}</strong>
      <span>Nothing on this panel is saved while the server cannot answer, so the accounts keep claiming from whatever they were pointed at.</span></div>`;
    refreshIcons();
    return;
  }

  if (!warmupState.campaignsReady) {
    host.innerHTML = '<div class="empty-state">Loading campaigns...</div>';
    return;
  }

  if (!warmupState.campaigns.length) {
    host.innerHTML = `<div class="warmup-leads-prompt"><strong>No campaign yet.</strong>
      <span>A campaign is one folder, the accounts that work it and a product. Make one and this panel will say what it actually amounts to before anything is sent.</span></div>`;
    refreshIcons();
    return;
  }

  let rank = 0;
  host.innerHTML = warmupState.campaigns
    .map((campaign) => warmupCampaignRowHtml(campaign, campaign.state === "running" ? ++rank : 0))
    .join("");
  refreshIcons();
}

/**
 * The selected campaign's verdict, at the width it had when there was one form.
 * This is the part of the panel that must not shrink into a table cell.
 */
function renderWarmupCampaignDetail() {
  const host = document.getElementById("warmupCampaignDetail");
  if (!host) return;

  const campaign = warmupSelectedCampaign();
  if (!campaign) {
    host.innerHTML = warmupState.campaignsReady && warmupState.campaigns.length
      ? '<div class="empty-state">Pick a campaign to see what it amounts to.</div>'
      : "";
    return;
  }

  // The form is allowed to disagree with the campaign it is editing; the
  // forecast belongs to what is saved, and says so rather than looking current.
  const stale = warmupState.formOpen && warmupState.formCampaignId === campaign.id && warmupFormDirty()
    ? '<p class="warmup-forecast-stale">These numbers are for the saved campaign. Save to count what is on screen.</p>'
    : "";

  const { tone, html } = warmupForecastHtml(campaign, { stale });
  const note = WARMUP_CAMPAIGN_STATE_NOTE[campaign.state] || "";

  host.innerHTML = `
    <div class="warmup-forecast ${tone}">${html}</div>
    <div class="warmup-campaign-detail-foot">
      <p class="warmup-campaign-accounts">${warmupState.campaignNotice
        ? `<em class="warmup-campaign-problem">${escapeHtml(warmupState.campaignNotice)}</em>`
        : warmupTickedAccountsLine(campaign)}</p>
      ${note ? `<p class="warmup-campaign-state-note">${escapeHtml(note)}</p>` : ""}
    </div>`;
  refreshIcons();
}

function renderWarmupCampaignForm({ resetForm = false } = {}) {
  const form = document.getElementById("warmupCampaignForm");
  const saveButton = document.getElementById("warmupCampaignSaveBtn");
  const note = document.getElementById("warmupCampaignFormNote");
  if (!form || !saveButton) return;

  form.hidden = !warmupState.formOpen;
  if (!warmupState.formOpen) return;

  const editing = warmupEditingCampaign();
  const saved = warmupCampaignSaved(editing);
  if (resetForm) {
    const nameInput = document.getElementById("warmupCampaignName");
    if (nameInput) nameInput.value = saved.name;
    for (const [key, input] of Object.entries(warmupFilterInputs())) {
      if (input) input.value = saved.filters[key] || "";
    }
    // A new campaign starts on the product this workspace is already working.
    renderWarmupProductOptions(editing ? saved.productId : (state?.selectedProductId || ""));
    renderWarmupFolderOptions(saved.folderId);
  } else {
    renderWarmupProductOptions(document.getElementById("warmupCampaignProduct")?.value || saved.productId);
    renderWarmupFolderOptions(document.getElementById("warmupFolderSelect")?.value || saved.folderId);
  }

  for (const input of Object.values(warmupFilterInputs())) {
    if (input) input.disabled = !warmupState.foldersReady;
  }

  saveButton.disabled = !warmupState.campaignsReady || warmupState.savingCampaign;
  saveButton.querySelector("span").textContent = warmupState.savingCampaign
    ? "Saving..."
    : (editing ? "Save changes" : "Create campaign");

  if (note) {
    note.innerHTML = warmupState.campaignNotice
      ? `<em class="warmup-campaign-problem">${escapeHtml(warmupState.campaignNotice)}</em>`
      : (editing
        ? escapeHtml(`Editing ${editing.name || "this campaign"}. Which accounts work it is ticked in Profiles below, not here.`)
        : "A new campaign starts as a draft, last in line. Tick the accounts that work it in Profiles below, then start it.");
  }
}

function renderWarmupCampaigns({ resetForm = false } = {}) {
  const pill = document.getElementById("warmupCampaignsPill");
  const newButton = document.getElementById("warmupCampaignNewBtn");

  if (pill) {
    if (!warmupState.campaignsReady) {
      pill.className = "pill tone-muted";
      pill.textContent = warmupState.campaignsError ? "unavailable" : "loading";
    } else {
      const running = warmupState.campaigns.filter((campaign) => campaign.state === "running").length;
      pill.className = running ? "pill tone-live" : "pill tone-muted";
      pill.textContent = warmupState.campaigns.length
        ? `${warmupState.campaigns.length} campaign${warmupState.campaigns.length === 1 ? "" : "s"} · ${running} running`
        : "none yet";
    }
  }
  if (newButton) newButton.disabled = !warmupState.campaignsReady || !warmupState.foldersReady;

  renderWarmupCampaignForm({ resetForm });
  renderWarmupCampaignList();
  renderWarmupCampaignDetail();
  refreshIcons();
}

/* ── The queue ─────────────────────────────────────────────────────────────
 *
 * What is claimed to each account of the selected campaign right now. An
 * account whose connection quota has not opened yet — which this week is every
 * account — gets an empty list and a sentence saying why. The sentence is the
 * server's own; an empty box here would be the screen refusing to answer the
 * one question somebody opened it with.
 */

function warmupQueueState(accountId) {
  return warmupState.queues[accountId] || null;
}

function warmupQueueRowHtml(row, accountId, campaignId) {
  const link = warmupLeadLink(row.linkedin);
  const where = [row.position, row.company].filter(Boolean).join(" · ");
  const name = row.name || "Unnamed contact";
  // A queue belongs to an account, not to a campaign: an account that works two
  // campaigns holds both their claims in one list. Saying which campaign a
  // person came from is the difference between a list and a claim about where
  // these people are from.
  const elsewhere = row.campaignId && campaignId && row.campaignId !== campaignId
    ? `<span class="warmup-queue-elsewhere" title="Claimed by another campaign this account also works">${escapeHtml(row.campaignName || "another campaign")}</span>`
    : "";
  return `<li>
    <div class="warmup-lead-who">
      <strong>${escapeHtml(name)}</strong>
      ${where ? `<span class="warmup-subtle">${escapeHtml(where)}</span>` : ""}
      ${elsewhere}
    </div>
    ${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">profile</a>` : '<span class="warmup-subtle">no profile link</span>'}
    <button class="text-button warmup-queue-send" type="button"
      data-warmup-take="${escapeAttr(row.crmContactId || "")}"
      data-warmup-take-account="${escapeAttr(accountId)}"
      data-warmup-take-name="${escapeAttr(name)}"
      ${row.crmContactId ? "" : "disabled"}
      title="Records the request against this person. One person, one approach, for good.">Sent a request</button>
  </li>`;
}

function warmupQueueAccountHtml(accountId, campaignId) {
  const profile = warmupState.profiles.find((item) => item.account?.id === accountId) || null;
  const identity = profile?.identity || profile?.account?.identity || null;
  const queue = warmupQueueState(accountId);
  const busy = Boolean(warmupState.queueBusy[accountId]);

  const day = profile?.day ? `day ${profile.day}` : null;
  const connections = profile?.connections || {};
  const quotaLine = connections.quota > 0
    ? `${connections.today || 0}/${connections.quota} today`
    : (connections.startsDay ? `requests from day ${connections.startsDay}` : "no connection quota today");
  const meta = [day, quotaLine].filter(Boolean).join(" · ");

  let body;
  if (!queue) {
    body = '<div class="empty-state">Loading...</div>';
  } else if (queue.unavailable) {
    body = `<p class="warmup-queue-reason is-muted">${escapeHtml(queue.unavailable)}</p>`;
  } else if (queue.error) {
    body = `<p class="warmup-queue-reason is-bad">${escapeHtml(queue.error)}</p>`;
  } else if (queue.rows?.length) {
    body = `<ul class="warmup-leads warmup-queue-list">${queue.rows.map((row) => warmupQueueRowHtml(row, accountId, campaignId)).join("")}</ul>`;
  } else if (queue.reason) {
    // The server's sentence, verbatim. "Day 2 of 14 — connection requests start
    // on day 4" is the answer; an empty box is not.
    body = `<p class="warmup-queue-reason">${escapeHtml(queue.reason)}</p>`;
  } else {
    body = '<p class="warmup-queue-reason is-muted">Nothing is claimed to this account, and the server gave no reason for it.</p>';
  }

  const released = Number(queue?.released) || 0;
  const releasedNote = released
    ? `<p class="warmup-queue-released">${warmupCount(released)} claim${released === 1 ? "" : "s"} had gone stale and ${released === 1 ? "was" : "were"} let go — those people are back in the pool.</p>`
    : "";

  return `<article class="warmup-queue-account" data-warmup-queue-account="${escapeAttr(accountId)}">
    <header>
      <div class="warmup-queue-who">
        <strong>${escapeHtml(profile?.name || "An account this list does not show")}</strong>
        ${identity?.name ? `<span class="warmup-identity"><i data-lucide="badge-check"></i><span>${escapeHtml(identity.name)}</span></span>` : ""}
        ${meta ? `<span class="warmup-subtle">${escapeHtml(meta)}</span>` : ""}
      </div>
      <button class="text-button" type="button" data-warmup-claim="${escapeAttr(accountId)}" ${busy ? "disabled" : ""}>
        <i data-lucide="hand"></i><span>${busy ? "Claiming..." : "Claim now"}</span>
      </button>
    </header>
    ${releasedNote}
    ${body}
  </article>`;
}

function renderWarmupQueue() {
  const title = document.getElementById("warmupQueueTitle");
  const subtitle = document.getElementById("warmupQueueSubtitle");
  const body = document.getElementById("warmupQueueBody");
  if (!title || !subtitle || !body) return;

  const campaign = warmupSelectedCampaign();
  title.textContent = campaign ? `Queue · ${campaign.name || "Unnamed campaign"}` : "Queue";

  if (!campaign) {
    subtitle.textContent = "No campaign selected";
    body.innerHTML = '<div class="empty-state">Pick a campaign above to see what its accounts are holding.</div>';
    return;
  }

  const accountIds = campaign.accountIds || [];
  if (!accountIds.length) {
    subtitle.textContent = "Nobody works this campaign yet";
    body.innerHTML = `<div class="warmup-leads-prompt"><strong>No account is ticked against this campaign.</strong>
      <span>Tick one in Profiles below — an account can only claim from a campaign it works.</span></div>`;
    refreshIcons();
    return;
  }

  // A queue is an account's, so what is counted here is everything these
  // accounts hold — this campaign's claims and any other campaign's.
  const claimed = accountIds.reduce((total, id) => total + (warmupQueueState(id)?.rows?.length || 0), 0);
  const held = `${warmupCount(claimed)} held by ${accountIds.length} account${accountIds.length === 1 ? "" : "s"}`;
  subtitle.textContent = campaign.state === "running"
    ? `${held} · a claim holds a person, it does not send anything`
    : `This campaign is ${campaign.state}, so nothing new is claimed from it. ${held}.`;

  body.innerHTML = `<div class="warmup-queue-accounts">${accountIds.map((id) => warmupQueueAccountHtml(id, campaign.id)).join("")}</div>`;
  refreshIcons();
}

function warmupLeadLink(url) {
  const value = String(url || "");
  return /^https?:\/\//i.test(value) ? value : null;
}

function renderWarmupLeads() {
  const title = document.getElementById("warmupLeadsTitle");
  const subtitle = document.getElementById("warmupLeadsSubtitle");
  const body = document.getElementById("warmupLeadsBody");
  if (!title || !subtitle || !body) return;

  // The header names the folder: a queue that does not say where it comes from
  // is a list of strangers.
  const targeting = warmupState.leadsTargeting;
  const folderName = targeting?.folderName || warmupFolderName(targeting?.folderId);
  // A queue answering "nothing is targeted" must not carry a folder name in
  // its header — that would be two answers to the same question.
  title.textContent = folderName && !warmupState.leadsPrompt ? `Lead queue · ${folderName}` : "Lead queue";

  if (warmupState.leadsPrompt) {
    subtitle.textContent = "Nothing is targeted yet";
    body.innerHTML = `<div class="warmup-leads-prompt">
      <strong>${escapeHtml(warmupState.leadsPrompt)}</strong>
      <span>Make a campaign above and start it — this list is whatever its folder and filters match, before anything is claimed to an account.</span>
    </div>`;
    refreshIcons();
    return;
  }

  if (warmupState.leadsError) {
    subtitle.textContent = "The queue could not be read";
    body.innerHTML = `<div class="warmup-leads-prompt is-bad"><strong>${escapeHtml(warmupState.leadsError)}</strong>
      <span>The CRM not answering and nobody being left are different answers; this is the first one.</span></div>`;
    refreshIcons();
    return;
  }

  if (!warmupState.leadsReady) {
    subtitle.textContent = "The lead queue is not available on this server yet";
    body.innerHTML = '<div class="empty-state">Nothing to show until the queue endpoint answers.</div>';
    return;
  }

  subtitle.textContent = Number.isFinite(warmupState.leadsTotal)
    ? `${warmupCount(warmupState.leadsTotal)} match this folder and its filters · the next ${warmupState.leads.length} are listed, anyone already approached from any account left out`
    : "The next people this folder reaches, with anyone already approached from any account left out";

  if (!warmupState.leads.length) {
    body.innerHTML = '<div class="empty-state">Nobody is left in this folder under these filters.</div>';
    return;
  }

  body.innerHTML = `<ul class="warmup-leads">${warmupState.leads
    .map((lead) => {
      const link = warmupLeadLink(lead.linkedin);
      const where = [lead.position, lead.company].filter(Boolean).join(" · ");
      return `<li>
        <div class="warmup-lead-who">
          <strong>${escapeHtml(lead.name || "Unnamed contact")}</strong>
          ${where ? `<span class="warmup-subtle">${escapeHtml(where)}</span>` : ""}
        </div>
        <span class="warmup-subtle">${escapeHtml(lead.country || "—")}</span>
        ${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">profile</a>` : '<span class="warmup-subtle">no profile link</span>'}
      </li>`;
    })
    .join("")}</ul>`;
  refreshIcons();
}

function renderWarmupProfiles() {
  const body = document.getElementById("warmupProfileTableBody");
  if (!body) return;

  if (!warmupState.profiles.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty-state">No profiles match.</div></td></tr>';
    renderWarmupCampaignDetail();
    return;
  }

  // The tick column belongs to the selected campaign: an account works a
  // campaign, not "the targeting", and there is no second place that answers
  // which folder an account is on.
  const campaign = warmupSelectedCampaign();
  const ticked = warmupCampaignAccountIds(campaign);
  const tickable = Boolean(campaign) && warmupState.campaignsReady;
  const tickTitle = campaign
    ? `Work ${campaign.name || "this campaign"} from this account`
    : "Select a campaign above before choosing which accounts work it";

  body.innerHTML = warmupState.profiles
    .map((profile) => {
      const status = profile.status;
      const account = profile.account;
      // The person the browser is actually signed in as, which is not the same
      // string as the profile label somebody typed in Anty.
      const identity = profile.identity || account?.identity || null;
      return `
        <tr data-warmup-profile="${escapeHtml(profile.id)}" class="${profile.id === warmupState.selectedProfileId ? "is-selected" : ""}">
          <td class="warmup-tick">
            ${account
              ? `<input type="checkbox" data-warmup-account-tick="${escapeAttr(account.id)}" ${ticked.has(account.id) ? "checked" : ""} ${tickable ? "" : "disabled"} aria-label="Work the selected campaign from ${escapeAttr(profile.name)}" title="${escapeAttr(tickTitle)}" />`
              : '<span class="warmup-subtle" title="Not on warm-up yet, so it cannot be sent from">—</span>'}
          </td>
          <td>
            <strong>${escapeHtml(profile.name)}</strong>
            ${identity?.name
              ? `<div class="warmup-identity" title="Signed in as this person on the last agent login"><i data-lucide="badge-check"></i><span>${escapeHtml(identity.name)}${identity.slug ? ` · ${escapeHtml(identity.slug)}` : ""}</span></div>`
              : ""}
            <div class="warmup-subtle">${escapeHtml(profile.owner || "—")}${profile.proxy ? " · proxied" : " · no proxy"}</div>
          </td>
          <td><span class="pill ${WARMUP_STATUS_TONE[status] || "tone-muted"}">${escapeHtml(WARMUP_STATUS_LABEL[status] || status)}</span></td>
          <td>${escapeHtml(profile.day || "—")}</td>
          <td>${warmupConnectionsCell(profile)}</td>
          <td>${warmupNextSessionCell(profile)}</td>
          <td class="warmup-row-actions">
            ${account
              ? '<button class="text-button" type="button" data-warmup-open>Open</button>'
              : '<button class="primary-button" type="button" data-warmup-adopt>Warm up</button>'}
          </td>
        </tr>`;
    })
    .join("");

  renderWarmupCampaignDetail();
  refreshIcons();
}

function renderWarmupDetail() {
  const title = document.getElementById("warmupDetailTitle");
  const subtitle = document.getElementById("warmupDetailSubtitle");
  const body = document.getElementById("warmupDetailBody");
  if (!title || !body) return;

  const detail = warmupState.detail;
  if (!detail) {
    title.textContent = "No profile selected";
    subtitle.textContent = "Pick a profile to see its day, today's quota and its own log";
    body.innerHTML = '<div class="empty-state">Select a profile from the list.</div>';
    refreshIcons();
    return;
  }

  const account = detail.account;
  const warmup = account.warmup;
  title.textContent = account.label;
  subtitle.textContent = warmup
    ? `${warmup.strategyName} · day ${warmup.day} of ${warmup.totalDays}${warmup.phase ? ` · ${warmup.phase}` : ""}`
    : "Not warming yet";

  const actionRows = warmup && !warmup.finished
    ? (warmupState.config?.actionKinds || [])
        .map(({ kind, label }) => {
          const quota = warmup.quotas[kind] ?? 0;
          const done = warmup.done[kind] ?? 0;
          // A kind with no quota today is forbidden, not merely finished, so it
          // gets no button rather than a disabled-looking one.
          if (quota === 0) {
            return `<div class="warmup-action is-off"><span>${escapeHtml(label)}</span><em>not allowed today</em></div>`;
          }
          return `
            <div class="warmup-action">
              <span>${escapeHtml(label)}</span>
              <strong>${done}/${quota}</strong>
              <button class="text-button" type="button" data-warmup-record="${escapeHtml(kind)}" ${done >= quota ? "disabled" : ""}>Record one</button>
            </div>`;
        })
        .join("")
    : "";

  const controls = [];
  if (account.status === "excluded") {
    controls.push('<button class="text-button" type="button" data-warmup-control="include">Put back in the list</button>');
  } else if (!warmup || warmup.state === "completed" || !warmup.runId) {
    controls.push('<button class="primary-button" type="button" data-warmup-control="start">Start warm-up</button>');
    controls.push('<button class="text-button" type="button" data-warmup-control="exclude">Exclude</button>');
  } else if (warmup.state === "paused") {
    controls.push('<button class="primary-button" type="button" data-warmup-control="resume">Resume</button>');
    controls.push('<button class="danger-button" type="button" data-warmup-control="stop">Stop</button>');
  } else {
    controls.push('<button class="text-button" type="button" data-warmup-control="warning">Got a warning</button>');
    controls.push('<button class="danger-button" type="button" data-warmup-control="stop">Stop</button>');
  }

  const healthOptions = (warmupState.config?.healthValues || [])
    .map(({ value, label }) => `<option value="${escapeHtml(value)}" ${account.health === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");

  const rules = warmup?.rules?.length
    ? `<ul class="warmup-rules">${warmup.rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}</ul>`
    : "";

  const sessions = detail.sessions.length
    ? detail.sessions
        .slice(0, 8)
        .map((session) => {
          const did = Object.entries(session.actions || {}).map(([kind, count]) => `${kind}: ${count}`).join(", ");
          return `<li><strong>${new Date(session.startedAt).toLocaleString()}</strong> · ${
            session.endedAt ? `${session.durationMin} min` : "open"
          } · ${escapeHtml(session.source)}${did ? ` · ${escapeHtml(did)}` : ""}</li>`;
        })
        .join("")
    : "<li>No sessions recorded yet.</li>";

  const events = detail.events.length
    ? detail.events
        .slice(0, 12)
        .map((event) => `<li class="level-${escapeHtml(event.level)}"><span>${new Date(event.created_at).toLocaleString()}</span> ${escapeHtml(event.message)}</li>`)
        .join("")
    : "<li>Nothing logged yet.</li>";

  body.innerHTML = `
    <div class="warmup-detail-controls">${controls.join("")}</div>
    ${warmup?.pausedUntil ? `<p class="warmup-paused">Paused after a warning until ${escapeHtml(warmup.pausedUntil)}.</p>` : ""}
    ${actionRows ? `<div class="warmup-actions">${actionRows}</div>` : ""}
    ${rules}
    <div class="warmup-health">
      <label for="warmupHealthSelect">Health</label>
      <select id="warmupHealthSelect">${healthOptions}</select>
      <input id="warmupHealthNote" type="text" placeholder="What did you see?" value="${escapeHtml(account.healthNote || "")}" />
      <button class="text-button" type="button" data-warmup-health>Save</button>
    </div>
    <h3>Sessions</h3>
    <ul class="warmup-sessions">${sessions}</ul>
    <h3>Log</h3>
    <ul class="warmup-events">${events}</ul>
  `;
  refreshIcons();
}

/**
 * Folders and the campaigns, in one round. Both are allowed to be missing —
 * the server may not carry them yet — and the panel says so rather than
 * pretending there are no campaigns.
 */
async function loadWarmupCampaigns({ resetForm = true } = {}) {
  const [folders, campaigns] = await Promise.allSettled([
    warmupApi("/folders"),
    warmupApi("/campaigns")
  ]);

  const problems = [];
  if (folders.status === "fulfilled") {
    warmupState.folders = folders.value.folders || [];
    warmupState.foldersReady = true;
  } else {
    warmupState.foldersReady = false;
    problems.push(folders.reason?.status === 404
      ? "This server does not carry the folder list yet, so a folder cannot be picked here."
      : `The folder list could not be read: ${folders.reason?.message}`);
  }

  if (campaigns.status === "fulfilled") {
    warmupState.campaigns = campaigns.value.campaigns || [];
    warmupState.campaignsReady = true;
  } else {
    warmupState.campaignsReady = false;
    warmupState.campaigns = [];
    problems.push(campaigns.reason?.status === 404
      ? "This server does not carry campaigns yet, so nothing made here would be kept."
      : `The campaigns could not be read: ${campaigns.reason?.message}`);
  }
  warmupState.campaignsError = problems.join(" ");

  // A selection that no longer exists is not a selection. Falling back to the
  // first campaign keeps the forecast on screen rather than emptying the panel.
  if (!warmupCampaignById(warmupState.selectedCampaignId)) {
    warmupState.selectedCampaignId = warmupState.campaigns[0]?.id || null;
  }
  if (warmupState.formOpen && warmupState.formCampaignId && !warmupCampaignById(warmupState.formCampaignId)) {
    warmupState.formOpen = false;
    warmupState.formCampaignId = null;
  }

  renderWarmupCampaigns({ resetForm });
  renderWarmupProfiles();
}

/**
 * Show one campaign's own answer immediately. It is not the whole answer:
 * `progressApproximate` and the order ranks are about how campaigns relate to
 * each other, so a write that can change a folder or an account is followed by
 * a reload of the list rather than left as one fresh row among stale ones.
 */
function spliceWarmupCampaign(campaign) {
  if (!campaign?.id) return;
  const index = warmupState.campaigns.findIndex((item) => item.id === campaign.id);
  if (index === -1) warmupState.campaigns.push(campaign);
  else warmupState.campaigns[index] = campaign;
}

function openWarmupCampaignForm(campaignId = null) {
  warmupState.formOpen = true;
  warmupState.formCampaignId = campaignId;
  warmupState.campaignNotice = "";
  if (campaignId) warmupState.selectedCampaignId = campaignId;
  renderWarmupCampaigns({ resetForm: true });
  renderWarmupProfiles();
  renderWarmupQueue();
  document.getElementById("warmupCampaignName")?.focus();
}

function closeWarmupCampaignForm() {
  warmupState.formOpen = false;
  warmupState.formCampaignId = null;
  warmupState.campaignNotice = "";
  renderWarmupCampaigns();
}

async function saveWarmupCampaignForm() {
  if (!warmupState.campaignsReady || warmupState.savingCampaign) return;
  const form = warmupFormValues();
  const editing = warmupEditingCampaign();

  if (!form.folderId) {
    warmupState.campaignNotice = "Pick a folder first — a campaign has to draw from something.";
    renderWarmupCampaigns();
    return;
  }
  if (!form.name) {
    warmupState.campaignNotice = "Give it a name — a list of campaigns called nothing is a list nobody can read.";
    renderWarmupCampaigns();
    return;
  }

  warmupState.savingCampaign = true;
  warmupState.campaignNotice = "";
  renderWarmupCampaigns();

  let saved = false;
  try {
    const body = {
      name: form.name,
      folderId: form.folderId,
      filters: form.filters,
      productId: form.productId || null
    };
    const payload = editing
      ? await warmupApi("/campaigns", { method: "PATCH", body: JSON.stringify({ id: editing.id, ...body }) })
      : await warmupApi("/campaigns", { method: "POST", body: JSON.stringify(body) });
    const campaign = payload.campaign;
    if (campaign) {
      spliceWarmupCampaign(campaign);
      warmupState.selectedCampaignId = campaign.id;
    }
    saved = true;
  } catch (error) {
    // Kept in the panel rather than the page-wide note: this is about the
    // campaign somebody just wrote, not about the warm-up being broken.
    warmupState.campaignNotice = error.message;
  } finally {
    warmupState.savingCampaign = false;
  }

  if (saved) {
    warmupState.formOpen = false;
    warmupState.formCampaignId = null;
  }
  renderWarmupCampaigns({ resetForm: true });
  renderWarmupProfiles();
  if (saved) await loadWarmupCampaigns({ resetForm: false });
  await loadWarmupQueues();
  if (saved) await loadWarmupLeads();
}

/** Start, pause, reopen, mark done — all one PATCH of `state`. */
async function setWarmupCampaignState(campaignId, nextState) {
  const campaign = warmupCampaignById(campaignId);
  if (!campaign || campaign.state === nextState) return;
  try {
    const payload = await warmupApi("/campaigns", {
      method: "PATCH",
      body: JSON.stringify({ id: campaignId, state: nextState })
    });
    if (payload.campaign) spliceWarmupCampaign(payload.campaign);
    warmupState.campaignNotice = "";
  } catch (error) {
    warmupState.campaignNotice = error.message;
  }
  // The order ranks are relative, so one campaign starting renumbers the rest.
  await loadWarmupCampaigns({ resetForm: false });
  await loadWarmupQueues();
  await loadWarmupLeads();
}

/**
 * Moving a campaign one place up or down the order.
 *
 * `order` is a position, not a number to be compared: PATCHing it puts the
 * campaign at that index and renumbers the rest around it, so one write does
 * the whole move and the list stays a dense 0..n-1 with nothing sharing a
 * place. Past either end is that end, so a move from the last row needs no
 * clamping beyond the disabled button.
 *
 * Every other row's position changes too, which is why this reloads the list
 * rather than splicing the one campaign that came back.
 */
async function moveWarmupCampaign(campaignId, direction) {
  const index = warmupState.campaigns.findIndex((item) => item.id === campaignId);
  const target = index + (direction === "up" ? -1 : 1);
  if (index === -1 || target < 0 || target >= warmupState.campaigns.length) return;
  if (warmupState.savingCampaign) return;

  warmupState.savingCampaign = true;
  renderWarmupCampaigns();

  try {
    await warmupApi("/campaigns", {
      method: "PATCH",
      body: JSON.stringify({ id: campaignId, order: target })
    });
    warmupState.campaignNotice = "";
  } catch (error) {
    warmupState.campaignNotice = error.message;
  } finally {
    warmupState.savingCampaign = false;
  }

  await loadWarmupCampaigns({ resetForm: false });
  await loadWarmupQueues();
  await loadWarmupLeads();
}

/**
 * Deleting releases every claim its accounts hold; what was already sent stays,
 * because history is not the campaign's to delete. Both halves are said before
 * anything is removed.
 */
async function deleteWarmupCampaign(campaignId) {
  const campaign = warmupCampaignById(campaignId);
  if (!campaign) return;
  const queued = Number(campaign.progress?.queued) || 0;
  const sent = Number(campaign.progress?.sent) || 0;
  const consequence = [
    queued ? `${warmupCount(queued)} claimed but unsent ${queued === 1 ? "person goes" : "people go"} back in the pool` : "",
    sent ? `${warmupCount(sent)} already sent ${sent === 1 ? "stays" : "stay"} on record` : ""
  ].filter(Boolean).join(", ");
  if (!window.confirm(`Delete "${campaign.name || "this campaign"}"?${consequence ? `\n\n${consequence}.` : ""}`)) return;

  try {
    const payload = await warmupApi(`/campaigns?id=${encodeURIComponent(campaignId)}`, { method: "DELETE" });
    warmupState.campaigns = warmupState.campaigns.filter((item) => item.id !== campaignId);
    const released = Number(payload?.released) || 0;
    warmupState.campaignNotice = released
      ? `${warmupCount(released)} claimed ${released === 1 ? "person is" : "people are"} back in the pool.`
      : "";
    if (warmupState.selectedCampaignId === campaignId) {
      warmupState.selectedCampaignId = warmupState.campaigns[0]?.id || null;
    }
    if (warmupState.formCampaignId === campaignId) {
      warmupState.formOpen = false;
      warmupState.formCampaignId = null;
    }
  } catch (error) {
    warmupState.campaignNotice = error.message;
  }
  renderWarmupCampaigns();
  renderWarmupProfiles();
  await loadWarmupCampaigns({ resetForm: false });
  await loadWarmupQueues();
  await loadWarmupLeads();
}

function selectWarmupCampaign(campaignId) {
  if (warmupState.selectedCampaignId === campaignId) return;
  warmupState.selectedCampaignId = campaignId;
  warmupState.campaignNotice = "";
  // Editing one campaign while another is selected would leave the tick column
  // answering for a campaign the form is not about.
  if (warmupState.formOpen && warmupState.formCampaignId !== campaignId) {
    warmupState.formOpen = false;
    warmupState.formCampaignId = null;
  }
  renderWarmupCampaigns();
  renderWarmupProfiles();
  loadWarmupQueues();
  loadWarmupLeads();
}

/** Ticking an account is itself a save: the forecast has to follow the tick. */
function toggleWarmupAccount(accountId, on) {
  const campaign = warmupSelectedCampaign();
  if (!campaign) {
    warmupState.campaignNotice = "Select a campaign above first — an account works a campaign, not a folder on its own.";
    renderWarmupCampaigns();
    renderWarmupProfiles();
    return;
  }
  const ids = warmupCampaignAccountIds(campaign);
  if (on) ids.add(accountId);
  else ids.delete(accountId);
  const accountIds = Array.from(ids);

  // Shown before it is saved, then corrected by whatever comes back: a tick
  // that waits for a round trip reads as a click that did not land.
  spliceWarmupCampaign({ ...campaign, accountIds });
  saveWarmupCampaignAccounts(campaign.id, accountIds);
}

async function saveWarmupCampaignAccounts(campaignId, accountIds) {
  // A second tick while the first save is still in flight is not a lost click,
  // it is the next thing to save — otherwise ticking two accounts quickly
  // leaves the second one on screen and absent from the server.
  if (warmupState.savingCampaign) {
    warmupState.pendingAccountIds = { campaignId, accountIds };
    renderWarmupCampaigns();
    renderWarmupProfiles();
    return;
  }

  warmupState.savingCampaign = true;
  warmupState.campaignNotice = "";
  renderWarmupCampaigns();
  renderWarmupProfiles();

  try {
    const payload = await warmupApi("/campaigns", {
      method: "PATCH",
      body: JSON.stringify({ id: campaignId, accountIds })
    });
    if (payload.campaign) spliceWarmupCampaign(payload.campaign);
  } catch (error) {
    warmupState.campaignNotice = error.message;
    // Put back whatever the server still believes, rather than leaving a tick
    // on screen that nothing behind it agrees with.
    await loadWarmupCampaigns({ resetForm: false });
  } finally {
    warmupState.savingCampaign = false;
  }

  renderWarmupCampaigns();
  renderWarmupProfiles();

  if (warmupState.pendingAccountIds) {
    const next = warmupState.pendingAccountIds;
    warmupState.pendingAccountIds = null;
    await saveWarmupCampaignAccounts(next.campaignId, next.accountIds);
    return;
  }
  // An account joining a campaign can make another campaign's count
  // approximate, so the whole list is re-read once the ticks have settled.
  await loadWarmupCampaigns({ resetForm: false });
  await loadWarmupQueues();
}

/* ── Claiming ──────────────────────────────────────────────────────────────
 *
 * A claim allocates a person to an account; it spends no quota, and it is not
 * a send. What comes back when nothing can be claimed is a sentence, and that
 * sentence is the answer — it gets rendered where the list would have been.
 */

async function loadWarmupQueue(accountId) {
  try {
    const payload = await warmupApi(`/queue?accountId=${encodeURIComponent(accountId)}`);
    warmupState.queues[accountId] = {
      rows: payload.queue || payload.claimed || [],
      reason: payload.reason || "",
      error: "",
      unavailable: ""
    };
  } catch (error) {
    warmupState.queues[accountId] = {
      rows: [],
      reason: "",
      // A 409 is the server refusing this account outright — excluded, not
      // warming, paused. That is an answer too, and it carries only `error`.
      error: error.status === 404 ? "" : error.message,
      unavailable: error.status === 404
        ? "This server does not carry the claim queue yet, so nothing can be claimed from here."
        : ""
    };
  }
}

async function loadWarmupQueues() {
  const campaign = warmupSelectedCampaign();
  const accountIds = campaign?.accountIds || [];
  if (!accountIds.length) {
    renderWarmupQueue();
    return;
  }
  await Promise.all(accountIds.map((id) => loadWarmupQueue(id)));
  renderWarmupQueue();
}

async function claimWarmupQueue(accountId) {
  if (warmupState.queueBusy[accountId]) return;
  warmupState.queueBusy[accountId] = true;
  renderWarmupQueue();

  try {
    const payload = await warmupApi("/campaigns/claim", {
      method: "POST",
      body: JSON.stringify({ accountId })
    });
    const claimed = payload.claimed || [];
    const existing = warmupState.queues[accountId]?.rows || [];
    warmupState.queues[accountId] = {
      // Oldest first, as the queue itself is ordered.
      rows: existing.concat(claimed),
      reason: payload.reason || "",
      // Every claim first releases what expired. If that moved anything, the
      // queue just shrank under somebody's feet and they should hear why.
      released: Number(payload.released) || 0,
      error: "",
      unavailable: ""
    };
  } catch (error) {
    warmupState.queues[accountId] = {
      rows: warmupState.queues[accountId]?.rows || [],
      reason: "",
      error: error.status === 404
        ? "This server does not carry claiming yet."
        : error.message,
      unavailable: ""
    };
  } finally {
    warmupState.queueBusy[accountId] = false;
  }

  renderWarmupQueue();
  // Claiming changes what is left and what is held, so the row above has to
  // follow it.
  await loadWarmupCampaigns({ resetForm: false });
  renderWarmupQueue();
}

/**
 * The one place a request is recorded. It marks a real person as approached,
 * once and for good, so it asks first and says who.
 */
async function takeWarmupQueueLead(accountId, crmContactId, name) {
  if (!accountId || !crmContactId) return;
  if (!window.confirm(`Record a connection request to ${name || "this contact"}?\n\nThis marks them approached for every account and every campaign, permanently.`)) return;

  try {
    await warmupApi("/leads/take", {
      method: "POST",
      body: JSON.stringify({ accountId, crmContactId })
    });
    const queue = warmupState.queues[accountId];
    if (queue) {
      queue.rows = (queue.rows || []).filter((row) => row.crmContactId !== crmContactId);
    }
  } catch (error) {
    if (warmupState.queues[accountId]) warmupState.queues[accountId].error = error.message;
    else warmupState.queues[accountId] = { rows: [], reason: "", error: error.message, unavailable: "" };
  }

  renderWarmupQueue();
  await loadWarmup({ full: false });
}

async function loadWarmupLeads() {
  try {
    // The pool belongs to the campaign on screen. Left to itself the server
    // answers for the first running one, which is a different folder from the
    // one somebody is looking at as soon as there are two campaigns.
    const campaignId = warmupState.selectedCampaignId;
    const params = new URLSearchParams({ limit: "10" });
    if (campaignId) params.set("campaignId", campaignId);
    const payload = await warmupApi(`/leads?${params}`);
    warmupState.leads = payload.leads || [];
    warmupState.leadsTotal = Number.isFinite(payload.queueTotal) ? payload.queueTotal : null;
    warmupState.leadsTargeting = payload.campaign || payload.targeting || null;
    warmupState.leadsPrompt = "";
    warmupState.leadsError = "";
    warmupState.leadsReady = true;
  } catch (error) {
    warmupState.leads = [];
    warmupState.leadsTotal = null;
    warmupState.leadsPrompt = "";
    warmupState.leadsError = "";
    // 409 is the server saying there is no campaign yet. That is a prompt, and
    // drawing it in red would be calling the user's unfinished setup a fault.
    if (error.payload?.needsCampaign || error.payload?.needsTargeting || error.status === 409) {
      warmupState.leadsReady = true;
      warmupState.leadsPrompt = error.message || "Create a campaign before pulling leads";
    } else if (error.status === 404) {
      warmupState.leadsReady = false;
    } else {
      warmupState.leadsReady = true;
      warmupState.leadsError = error.message;
    }
  }
  renderWarmupLeads();
}

async function loadWarmupProfiles() {
  const search = document.getElementById("warmupSearchInput")?.value.trim() || "";
  const platform = document.getElementById("warmupPlatformSelect")?.value || "linkedin";
  const params = new URLSearchParams({ platform });
  if (search) params.set("q", search);

  const payload = await warmupApi(`/profiles?${params}`);
  warmupState.profiles = payload.profiles;
  renderWarmupProfiles();
}

async function loadWarmupAccountDetail(accountId) {
  if (!accountId) {
    warmupState.detail = null;
    renderWarmupDetail();
    return;
  }
  const [accountPayload, sessionsPayload, eventsPayload] = await Promise.all([
    warmupApi(`/accounts?id=${encodeURIComponent(accountId)}`),
    warmupApi(`/sessions?accountId=${encodeURIComponent(accountId)}`),
    warmupApi(`/events?accountId=${encodeURIComponent(accountId)}&limit=30`)
  ]);
  warmupState.detail = {
    account: accountPayload.account,
    sessions: sessionsPayload.sessions,
    events: eventsPayload.events
  };
  renderWarmupDetail();
}

async function loadWarmup({ full = true } = {}) {
  if (warmupState.busy) return;
  warmupState.busy = true;
  warmupState.error = "";
  try {
    if (full || !warmupState.config) {
      warmupState.config = await warmupApi("/config");
    }
    renderWarmupConfigNote();
    if (Number.isFinite(warmupState.config?.unreadReplies)) setWarmupUnread(warmupState.config.unreadReplies);
    if (!warmupState.config.configured) {
      warmupState.profiles = [];
      warmupState.foldersReady = false;
      warmupState.campaignsReady = false;
      warmupState.campaignsError = "The warm-up is not configured on this server, so there are no folders to build a campaign on.";
      // Nothing can have arrived on accounts this server cannot even reach, and
      // the config note above already says why. An inbox promising otherwise
      // would be a second, softer answer to the same question.
      warmupState.inbox.available = false;
      renderWarmupProfiles();
      renderWarmupStats();
      renderWarmupInbox();
      renderWarmupCampaigns();
      renderWarmupQueue();
      return;
    }

    // Reconciling Anty's "profile is running" flag with the sessions table is
    // what makes the Sessions column true; it is cheap and idempotent, so the
    // screen does it on every load rather than relying on somebody remembering.
    await warmupApi("/sync", { method: "POST" }).catch(() => null);

    warmupState.dashboard = await warmupApi("/dashboard");
    renderWarmupStats();
    // The inbox before the plan: it is the top panel, it depends on nothing
    // else here, and it is the one thing on this screen somebody else wrote.
    await loadWarmupInbox();
    // Campaigns first: the tick column in the profiles table is drawn from the
    // selected one, and the queue below is drawn from its accounts.
    await loadWarmupCampaigns({ resetForm: full });
    await loadWarmupProfiles();
    await loadWarmupQueues();
    await loadWarmupLeads();
    if (warmupState.selectedAccountId) await loadWarmupAccountDetail(warmupState.selectedAccountId);
  } catch (error) {
    warmupState.error = error.message;
    renderWarmupConfigNote();
  } finally {
    warmupState.busy = false;
    refreshIcons();
  }
}

async function warmupControl(action, extra = {}) {
  if (!warmupState.selectedAccountId) return;
  try {
    await warmupApi("/control", {
      method: "POST",
      body: JSON.stringify({ accountId: warmupState.selectedAccountId, action, ...extra })
    });
    await loadWarmup({ full: false });
  } catch (error) {
    warmupState.error = error.message;
    renderWarmupConfigNote();
  }
}

async function selectWarmupProfile(profileId) {
  const profile = warmupState.profiles.find((item) => item.id === profileId);
  if (!profile) return;
  warmupState.selectedProfileId = profileId;
  warmupState.selectedAccountId = profile.account?.id || null;
  renderWarmupProfiles();
  await loadWarmupAccountDetail(warmupState.selectedAccountId);
}

/** Put a profile on warm-up: create its account, then start the run. */
async function adoptWarmupProfile(profileId) {
  const profile = warmupState.profiles.find((item) => item.id === profileId);
  if (!profile) return;
  try {
    const created = await warmupApi("/accounts", {
      method: "POST",
      body: JSON.stringify({ label: profile.name, profileRemoteId: profile.id })
    });
    warmupState.selectedProfileId = profile.id;
    warmupState.selectedAccountId = created.account.id;
    await warmupControl("start");
  } catch (error) {
    warmupState.error = error.message;
    renderWarmupConfigNote();
  }
}

document.getElementById("warmupRefreshBtn")?.addEventListener("click", () => loadWarmup());
document.getElementById("warmupPlatformSelect")?.addEventListener("change", () => loadWarmupProfiles());
document.getElementById("warmupSearchInput")?.addEventListener("input", () => {
  clearTimeout(warmupState.searchTimer);
  warmupState.searchTimer = setTimeout(() => loadWarmupProfiles(), 250);
});

document.getElementById("warmupProfileTableBody")?.addEventListener("change", (event) => {
  const tick = event.target.closest("[data-warmup-account-tick]");
  if (!tick) return;
  toggleWarmupAccount(tick.dataset.warmupAccountTick, tick.checked);
});

document.getElementById("warmupProfileTableBody")?.addEventListener("click", (event) => {
  // Ticking an account is not the same gesture as opening it.
  if (event.target.closest("[data-warmup-account-tick]")) return;
  const row = event.target.closest("[data-warmup-profile]");
  if (!row) return;
  const profileId = row.dataset.warmupProfile;
  if (event.target.closest("[data-warmup-adopt]")) {
    adoptWarmupProfile(profileId);
    return;
  }
  selectWarmupProfile(profileId);
});

document.getElementById("warmupDetailBody")?.addEventListener("click", (event) => {
  const control = event.target.closest("[data-warmup-control]");
  if (control) {
    warmupControl(control.dataset.warmupControl);
    return;
  }
  const record = event.target.closest("[data-warmup-record]");
  if (record) {
    warmupControl("record", { kind: record.dataset.warmupRecord });
    return;
  }
  if (event.target.closest("[data-warmup-health]")) {
    const health = document.getElementById("warmupHealthSelect")?.value;
    const note = document.getElementById("warmupHealthNote")?.value || "";
    warmupApi("/accounts/health", {
      method: "POST",
      body: JSON.stringify({ accountId: warmupState.selectedAccountId, health, note })
    })
      .then(() => loadWarmup({ full: false }))
      .catch((error) => {
        warmupState.error = error.message;
        renderWarmupConfigNote();
      });
  }
});

/* The form only ever redraws the detail: it is what says the numbers on screen
   are for the saved campaign, not for what is being typed. */
function warmupCampaignFormTouched() {
  warmupState.campaignNotice = "";
  renderWarmupCampaignDetail();
  renderWarmupCampaignForm();
}

document.getElementById("warmupFolderSelect")?.addEventListener("change", warmupCampaignFormTouched);
document.getElementById("warmupCampaignProduct")?.addEventListener("change", warmupCampaignFormTouched);
document.getElementById("warmupCampaignName")?.addEventListener("input", warmupCampaignFormTouched);

for (const id of ["warmupFilterCountry", "warmupFilterPosition", "warmupFilterStatus", "warmupFilterOwner"]) {
  document.getElementById(id)?.addEventListener("input", warmupCampaignFormTouched);
}

document.getElementById("warmupCampaignNewBtn")?.addEventListener("click", () => openWarmupCampaignForm(null));
document.getElementById("warmupCampaignCancelBtn")?.addEventListener("click", () => closeWarmupCampaignForm());
document.getElementById("warmupCampaignForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveWarmupCampaignForm();
});

document.getElementById("warmupCampaignList")?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-warmup-campaign]");
  if (!row) return;
  const campaignId = row.dataset.warmupCampaign;

  const move = event.target.closest("[data-warmup-campaign-move]");
  if (move) {
    moveWarmupCampaign(campaignId, move.dataset.warmupCampaignMove);
    return;
  }

  const stateButton = event.target.closest("[data-warmup-campaign-state]");
  if (stateButton) {
    setWarmupCampaignState(campaignId, stateButton.dataset.warmupCampaignState);
    return;
  }
  if (event.target.closest("[data-warmup-campaign-edit]")) {
    openWarmupCampaignForm(campaignId);
    return;
  }
  if (event.target.closest("[data-warmup-campaign-delete]")) {
    deleteWarmupCampaign(campaignId);
    return;
  }
  selectWarmupCampaign(campaignId);
});

document.getElementById("warmupQueueBody")?.addEventListener("click", (event) => {
  const claim = event.target.closest("[data-warmup-claim]");
  if (claim) {
    claimWarmupQueue(claim.dataset.warmupClaim);
    return;
  }
  const take = event.target.closest("[data-warmup-take]");
  if (take) {
    takeWarmupQueueLead(take.dataset.warmupTakeAccount, take.dataset.warmupTake, take.dataset.warmupTakeName);
  }
});

document.getElementById("warmupQueueRefreshBtn")?.addEventListener("click", () => loadWarmupQueues());

document.getElementById("warmupLeadsRefreshBtn")?.addEventListener("click", () => loadWarmupLeads());

/* ── The inbox ─────────────────────────────────────────────────────────────
 *
 * Everything else on this screen is outbound: who will be approached, at what
 * rate, for how long. This panel is the only part that is somebody else
 * talking, which is why it sits above the campaigns rather than below them.
 *
 * Two rules govern it.
 *
 * The first is that message bodies are text typed by strangers on the
 * internet, and this is the one place in the app where hostile input arrives.
 * Every body, name and headline reaches the DOM through `escapeHtml`, and line
 * breaks are kept by CSS rather than by turning newlines into markup — so a
 * reply containing a script tag is read as the characters somebody typed and
 * can never be anything else.
 *
 * The second is that an empty inbox has two meanings that want opposite
 * reactions. Nothing arrived is fine. No account has synced means the agent is
 * not running, every reply on every account is currently invisible, and the
 * operator needs to know today. `lastSyncedAt` is what tells them apart, so a
 * panel that cannot read it says that too rather than guessing the calm one.
 */

/** A run is roughly daily, so a gap longer than this is a stopped agent. */
const WARMUP_SYNC_STALE_HOURS = 36;

/**
 * How many threads the panel shows before it offers the rest. The inbox leads
 * this screen; it is not supposed to swallow it. Twenty-two conversations at
 * full height push the campaigns panel and its forecast off the bottom of the
 * page, which is the same harm as shrinking them by a different route. Unread
 * sorts first, so the ones above the fold are the ones that were waiting.
 */
const WARMUP_INBOX_PREVIEW = 8;

const WARMUP_OUTREACH_TONE = {
  pending: "tone-muted",
  connected: "tone-live",
  replied: "tone-live",
  accepted: "tone-live",
  skipped: "tone-muted",
  failed: "tone-bad"
};

/** How long ago, said the way a person would say it. */
function warmupAgo(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 0) return new Date(then).toLocaleString();
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(then).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/** The same moment in full, for the tooltip behind the short version. */
function warmupStamp(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  return Number.isFinite(then) ? new Date(then).toLocaleString() : "";
}

function warmupHoursSince(iso) {
  const then = Date.parse(iso || "");
  if (!Number.isFinite(then)) return null;
  return (Date.now() - then) / 3600000;
}

/**
 * A stranger's message, escaped. The return value is HTML, so there is no
 * version of this text that reaches the DOM unescaped: newlines survive
 * because `.warmup-message-body` is `white-space: pre-wrap`, not because
 * anything here builds tags out of what was typed.
 */
function warmupBodyHtml(body) {
  return escapeHtml(String(body ?? ""));
}

/** The first line of a message, for a list row that has one line to spend. */
function warmupPreviewHtml(body, limit = 150) {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return '<em class="warmup-subtle">no text in this message</em>';
  const chars = Array.from(text);
  const clipped = chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
  return escapeHtml(clipped);
}

/**
 * A LinkedIn link built from a slug somebody else supplied. Anything that is
 * not plainly a slug or an http(s) URL gets no link at all — a person's own
 * profile is not worth inventing a destination for.
 */
function warmupProfileUrl(slug) {
  const value = String(slug || "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  return `https://www.linkedin.com/in/${value}`;
}

/**
 * The strings that are not names. The server folds all of these to "Unknown"
 * before they reach here and its matcher refuses that sentinel from both sides,
 * which is where the rule with teeth lives — a thread that cannot name somebody
 * must never be filed against a CRM contact. This list is the display half of
 * the same idea, kept because an older server, or one whose normaliser is
 * bypassed, would otherwise have "LinkedIn Member" printed as a surname on ten
 * rows that are ten different people. Whole string, trimmed, case-insensitive:
 * "Linda Memberly" is a person.
 */
const WARMUP_UNNAMED = new Set([
  "unknown",
  "linkedin member",
  "linkedin user",
  "deleted member",
  "deleted user",
  "member"
]);

function warmupParticipantUnnamed(participant) {
  // Runs of whitespace are collapsed before the comparison: the agent reads
  // these strings out of the DOM, where "LinkedIn Member" can arrive as
  // "LinkedIn\n      Member". Collapsing cannot swallow a real name — "Linda
  // Memberly" is still not in the set however it was spaced.
  const name = String(participant?.name || "").replace(/\s+/g, " ").trim();
  return !name || WARMUP_UNNAMED.has(name.toLowerCase());
}

/** Who wrote, or an honest admission that nobody here knows. */
function warmupParticipantName(participant) {
  if (warmupParticipantUnnamed(participant)) return "Somebody this thread does not name";
  return String(participant.name).trim();
}

/**
 * Why there is no name, which has two ordinary causes that look identical by
 * the time they reach this screen: LinkedIn withholding it on a restricted or
 * out-of-network profile, and the agent failing to read it. Worth saying,
 * because only the second one is a fault.
 */
function warmupParticipantNameAttr(participant) {
  return warmupParticipantUnnamed(participant)
    ? ' title="LinkedIn showed no name for this person — usually a restricted or out-of-network profile, sometimes a failed read. This thread is deliberately matched to nobody in the CRM."'
    : "";
}

/**
 * Which account a thread arrived on, by the person the browser is signed in as
 * rather than by the label somebody typed into Anty. When only the label is
 * known the row says that, because "arrived on Profile 7" and "arrived on Anna
 * Kovalenko" are not the same claim.
 */
function warmupThreadAccount(thread) {
  const identity = thread?.accountIdentity;
  const name = typeof identity === "string" ? identity.trim() : String(identity?.name || "").trim();
  if (name) return { name, exact: true };
  const label = String(thread?.accountLabel || "").trim();
  if (label) return { name: label, exact: false };
  return { name: "an account this portal cannot name", exact: false };
}

/**
 * What is known about syncing, from wherever it landed. The server carries the
 * summary at the top level — the only place it can be read when there are no
 * threads at all — and the contract also puts `lastSyncedAt` on each thread.
 * Read both, so the two halves of this phase can land in either order.
 */
function warmupInboxSync() {
  const inbox = warmupState.inbox;
  const sync = inbox.sync && typeof inbox.sync === "object" ? inbox.sync : null;

  let lastSyncedAt = sync?.lastSyncedAt || null;
  let fromThreads = false;
  for (const thread of inbox.threads) {
    const seen = thread?.lastSyncedAt;
    if (!seen) continue;
    if (!lastSyncedAt || Date.parse(seen) > Date.parse(lastSyncedAt)) {
      lastSyncedAt = seen;
      fromThreads = true;
    }
  }

  const accountsTotal = Number.isFinite(sync?.accountsTotal) ? sync.accountsTotal : null;
  const accountsSynced = Number.isFinite(sync?.accountsSynced) ? sync.accountsSynced : null;

  // "Never synced" is a claim, and it can only be made when the server actually
  // reports on syncing. Without that, the honest answer is that this is not
  // known — which is itself worth saying rather than dressing up as calm.
  const known = Boolean(sync) || fromThreads;
  const hours = warmupHoursSince(lastSyncedAt);

  return {
    known,
    lastSyncedAt,
    accountsTotal,
    accountsSynced,
    stale: Number.isFinite(hours) && hours > WARMUP_SYNC_STALE_HOURS
  };
}

/** The accounts that have never been read, said as a sentence or not at all. */
function warmupSyncGapHtml(sync) {
  if (sync.accountsTotal === null || sync.accountsSynced === null) return "";
  if (sync.accountsSynced >= sync.accountsTotal) return "";
  const missing = sync.accountsTotal - sync.accountsSynced;
  return `<div class="warmup-inbox-note is-warn">
    <strong>${warmupCount(missing)} of ${warmupCount(sync.accountsTotal)} account${sync.accountsTotal === 1 ? "" : "s"} ${missing === 1 ? "has" : "have"} never been read.</strong>
    <span>Whatever arrived on ${missing === 1 ? "it" : "them"} is not below and is not counted — this list is only as complete as the accounts the agent has actually opened.</span>
  </div>`;
}

/**
 * The empty inbox, which is the screen this panel will show most often until
 * the agent runs against real LinkedIn — so it is the part that has to be
 * right. Each branch says which of the two empties this is.
 */
function warmupInboxEmptyHtml() {
  const inbox = warmupState.inbox;

  if (inbox.unreadOnly) {
    return `<div class="warmup-inbox-note is-calm">
      <strong>Nothing unread.</strong>
      <span>Everything that arrived has been opened. <button class="warmup-inbox-link" type="button" data-warmup-inbox-showall>Show every thread</button> to read them again.</span>
    </div>`;
  }

  const sync = warmupInboxSync();

  if (!sync.known) {
    return `<div class="warmup-inbox-note is-warn">
      <strong>No replies — and this server does not say when the accounts were last read.</strong>
      <span>So this cannot tell an empty inbox from an agent that has never looked, and those are not the same thing: one is a quiet week, the other is every reply on every account going unseen. The sync time is what separates them.</span>
    </div>`;
  }

  if (!sync.lastSyncedAt) {
    return `<div class="warmup-inbox-note is-bad">
      <strong>No account has ever been read. This is not an empty inbox — it is an agent that has never looked.</strong>
      <span>The warm-up agent opens LinkedIn messaging at the end of each run and posts what it finds here. Nothing has ever posted, so a reply on any of these accounts is invisible to everybody except whoever opens that account by hand. Check that the agent is running and pointed at this portal, and that its token is set on both sides.</span>
    </div>`;
  }

  if (sync.stale) {
    return `<div class="warmup-inbox-note is-warn">
      <strong>Nothing has come in, and the last time anything looked was ${escapeHtml(warmupAgo(sync.lastSyncedAt))}.</strong>
      <span>The last read was ${escapeHtml(warmupStamp(sync.lastSyncedAt))}. The agent reads the accounts at the end of every run, so a gap this long is more likely a stopped agent than a quiet week — an inbox nobody is reading looks exactly like an inbox nobody has written to.</span>
    </div>`;
  }

  const coverage = sync.accountsTotal !== null && sync.accountsSynced !== null
    ? ` All ${warmupCount(sync.accountsSynced)} of ${warmupCount(sync.accountsTotal)} account${sync.accountsTotal === 1 ? "" : "s"} were read.`
    : "";

  return `<div class="warmup-inbox-note is-calm">
    <strong>Nothing has come in.</strong>
    <span>The accounts were last read ${escapeHtml(warmupAgo(sync.lastSyncedAt))}, and nobody has written back since.${escapeHtml(coverage)} This is an empty inbox rather than an unread one.</span>
  </div>`;
}

function warmupThreadRowHtml(thread) {
  const participant = thread.participant || {};
  const name = warmupParticipantName(participant);
  const account = warmupThreadAccount(thread);
  const last = thread.lastMessage || {};
  const inbound = last.direction !== "out";
  const count = Number(thread.messageCount) || 0;
  const status = String(thread.outreachStatus || "").trim();
  const accountTitle = account.exact
    ? "The person this account is signed in as"
    : "Anty's profile label — this portal does not know who this account is signed in as";

  return `
    <button class="warmup-thread ${thread.unread ? "is-unread" : ""}" type="button"
      data-warmup-thread="${escapeAttr(thread.threadKey || "")}"
      data-warmup-thread-account="${escapeAttr(thread.accountId || "")}">
      <span class="warmup-thread-mark" aria-hidden="true"></span>
      <span class="warmup-thread-who">
        <strong${warmupParticipantNameAttr(participant)}>${escapeHtml(name)}</strong>
        ${participant.headline ? `<span class="warmup-subtle">${escapeHtml(participant.headline)}</span>` : ""}
        <span class="warmup-identity" title="${escapeAttr(accountTitle)}">
          <i data-lucide="${account.exact ? "badge-check" : "circle-help"}"></i>
          <span>on ${escapeHtml(account.name)}</span>
        </span>
      </span>
      <span class="warmup-thread-preview">
        <span class="warmup-thread-from">${inbound ? "They" : "You"}:</span>
        ${warmupPreviewHtml(last.body)}
      </span>
      <span class="warmup-thread-meta">
        <time datetime="${escapeAttr(last.sentAt || "")}" title="${escapeAttr(warmupStamp(last.sentAt))}">${escapeHtml(warmupAgo(last.sentAt) || "—")}</time>
        <span class="warmup-subtle">${warmupCount(count)} message${count === 1 ? "" : "s"}</span>
        ${status ? `<span class="pill ${WARMUP_OUTREACH_TONE[status] || "tone-muted"}">${escapeHtml(status)}</span>` : ""}
        ${thread.unread ? '<span class="warmup-thread-unread">unread</span>' : ""}
      </span>
    </button>`;
}

function warmupMessageHtml(message, participantName, accountName) {
  const inbound = message.direction !== "out";
  const who = inbound ? (participantName || "They") : accountName;
  return `<li class="warmup-message ${inbound ? "is-in" : "is-out"}">
    <div class="warmup-message-head">
      <strong>${escapeHtml(who)}</strong>
      <time datetime="${escapeAttr(message.sentAt || "")}" title="${escapeAttr(warmupStamp(message.sentAt))}">${escapeHtml(warmupAgo(message.sentAt) || "—")}</time>
    </div>
    <div class="warmup-message-body">${warmupBodyHtml(message.body)}</div>
  </li>`;
}

/**
 * One conversation, oldest first. Above it the things that make a reply
 * actionable: who wrote, where to find them, which account holds the thread,
 * and where that person stands in the outreach they were part of.
 */
function warmupThreadViewHtml() {
  const inbox = warmupState.inbox;
  const back = '<button class="text-button warmup-thread-back" type="button" data-warmup-inbox-back><i data-lucide="arrow-left"></i><span>All replies</span></button>';

  if (inbox.openError) {
    return `${back}<div class="warmup-inbox-note is-bad">
      <strong>${escapeHtml(inbox.openError)}</strong>
      <span>The conversation could not be read. What is in the list is the last thing this portal was told about it.</span>
    </div>`;
  }
  if (!inbox.open) {
    return `${back}<div class="empty-state">Opening the conversation...</div>`;
  }

  const thread = inbox.open.thread || {};
  const participant = thread.participant || {};
  const name = warmupParticipantName(participant);
  const account = warmupThreadAccount(thread);
  const link = warmupProfileUrl(participant.slug);
  const status = String(thread.outreachStatus || "").trim();
  const messages = Array.isArray(inbox.open.messages) ? inbox.open.messages : [];
  const accountTitle = account.exact
    ? "The person this account is signed in as"
    : "Anty's profile label — this portal does not know who this account is signed in as";

  const head = `
    <div class="warmup-thread-head">
      ${back}
      <div class="warmup-thread-head-who">
        <strong${warmupParticipantNameAttr(participant)}>${escapeHtml(name)}</strong>
        ${participant.headline ? `<span class="warmup-subtle">${escapeHtml(participant.headline)}</span>` : ""}
        ${link
          ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer noopener"><i data-lucide="external-link"></i><span>their LinkedIn</span></a>`
          : '<span class="warmup-subtle">no profile link came with this thread</span>'}
      </div>
      <div class="warmup-thread-head-meta">
        <span class="warmup-identity" title="${escapeAttr(accountTitle)}">
          <i data-lucide="${account.exact ? "badge-check" : "circle-help"}"></i>
          <span>arrived on ${escapeHtml(account.name)}</span>
        </span>
        ${status
          ? `<span class="pill ${WARMUP_OUTREACH_TONE[status] || "tone-muted"}">${escapeHtml(status)}</span>`
          : '<span class="warmup-subtle">not matched to anyone this account approached</span>'}
      </div>
    </div>`;

  if (!messages.length) {
    return `${head}<div class="warmup-inbox-note is-warn">
      <strong>This thread has no messages stored.</strong>
      <span>The conversation was seen but nothing in it was read — on the agent's side that is what a rotted selector looks like.</span>
    </div>`;
  }

  return `${head}
    <ol class="warmup-messages">${messages.map((message) => warmupMessageHtml(message, name, account.name)).join("")}</ol>
    <p class="warmup-thread-foot">Reading is all this does. Replying goes out from a real account against a real person, so it needs its own quota treatment and is not in this phase — answer from the account itself.</p>`;
}

function renderWarmupInbox() {
  const title = document.getElementById("warmupInboxTitle");
  const subtitle = document.getElementById("warmupInboxSubtitle");
  const pill = document.getElementById("warmupInboxPill");
  const toggleLabel = document.getElementById("warmupInboxUnreadLabel");
  const toggle = document.getElementById("warmupInboxUnreadOnly");
  const body = document.getElementById("warmupInboxBody");
  if (!body || !title || !subtitle) return;

  const inbox = warmupState.inbox;
  if (toggle) toggle.checked = inbox.unreadOnly;
  renderWarmupNavBadge();

  // A thread is open: the panel becomes that conversation, and the controls
  // that belong to the list step out of the way rather than filter nothing.
  if (inbox.openThreadKey !== null) {
    const open = inbox.open?.thread?.participant;
    title.textContent = open ? `Inbox · ${warmupParticipantName(open)}` : "Inbox · one conversation";
    subtitle.textContent = "The conversation as the agent read it, oldest first";
    if (toggleLabel) toggleLabel.hidden = true;
    if (pill) pill.hidden = true;
    body.innerHTML = warmupThreadViewHtml();
    refreshIcons();
    return;
  }

  title.textContent = "Inbox";
  if (toggleLabel) toggleLabel.hidden = false;
  if (pill) pill.hidden = false;

  if (pill) {
    if (!inbox.available) {
      pill.className = "pill tone-muted";
      pill.textContent = "not on this server";
    } else if (inbox.error) {
      pill.className = "pill tone-bad";
      pill.textContent = "unavailable";
    } else if (!inbox.ready) {
      pill.className = "pill tone-muted";
      pill.textContent = "loading";
    } else if (inbox.unread > 0) {
      pill.className = "pill tone-live";
      pill.textContent = `${warmupCount(inbox.unread)} unread`;
    } else {
      // With nothing unread the pill stops counting and starts reporting on the
      // reading, because "nothing yet" beside a panel saying nothing has ever
      // looked is the calm half of the very distinction this panel exists for.
      const state = warmupInboxSync();
      if (state.known && !state.lastSyncedAt) {
        pill.className = "pill tone-bad";
        pill.textContent = "never read";
      } else if (state.stale) {
        pill.className = "pill tone-warn";
        pill.textContent = "not read lately";
      } else if (!state.known && !inbox.threads.length) {
        pill.className = "pill tone-warn";
        pill.textContent = "reading unknown";
      } else {
        pill.className = "pill tone-muted";
        pill.textContent = inbox.threads.length ? "all read" : "nothing yet";
      }
    }
  }

  if (!inbox.available) {
    subtitle.textContent = "The inbox is not on this server yet";
    body.innerHTML = `<div class="warmup-inbox-note is-warn">
      <strong>This server has no inbox endpoint.</strong>
      <span>Nothing is wrong with the accounts — this portal is simply older than the inbox. Nobody's reply is being lost, but nothing is reading for them either.</span>
    </div>`;
    refreshIcons();
    return;
  }

  if (inbox.error) {
    subtitle.textContent = "The inbox could not be read";
    body.innerHTML = `<div class="warmup-inbox-note is-bad">
      <strong>${escapeHtml(inbox.error)}</strong>
      <span>The inbox not answering and nobody having written are different answers; this is the first one.</span>
    </div>`;
    refreshIcons();
    return;
  }

  if (!inbox.ready) {
    subtitle.textContent = "Reading what came back";
    body.innerHTML = '<div class="empty-state">Loading the inbox...</div>';
    return;
  }

  const sync = warmupInboxSync();
  // Three answers, not two: read at a time, never read, and not reported. The
  // subtitle must not turn the third into the second.
  const read = sync.lastSyncedAt
    ? `accounts last read ${warmupAgo(sync.lastSyncedAt)}`
    : (sync.known ? "no account read yet" : "this server does not report when the accounts were read");

  if (!inbox.threads.length) {
    subtitle.textContent = inbox.unreadOnly ? "Unread only" : read;
    body.innerHTML = warmupInboxEmptyHtml();
    refreshIcons();
    return;
  }

  subtitle.textContent = `${warmupCount(inbox.threads.length)} conversation${inbox.threads.length === 1 ? "" : "s"}${inbox.unreadOnly ? " unread" : ""} · ${read}`;

  const shown = inbox.showAll ? inbox.threads : inbox.threads.slice(0, WARMUP_INBOX_PREVIEW);
  const hidden = inbox.threads.length - shown.length;
  // Collapsing must never hide a waiting reply quietly, so the button says how
  // many of what it is holding back are still unread.
  const hiddenUnread = hidden > 0
    ? inbox.threads.slice(shown.length).filter((thread) => thread.unread).length
    : 0;
  const more = hidden > 0
    ? `<button class="warmup-inbox-more" type="button" data-warmup-inbox-expand>Show ${warmupCount(hidden)} more conversation${hidden === 1 ? "" : "s"}${hiddenUnread ? ` · ${warmupCount(hiddenUnread)} still unread` : ""}</button>`
    : (inbox.showAll && inbox.threads.length > WARMUP_INBOX_PREVIEW
      ? '<button class="warmup-inbox-more" type="button" data-warmup-inbox-collapse>Show fewer</button>'
      : "");

  body.innerHTML = `${warmupSyncGapHtml(sync)}
    <div class="warmup-threads">${shown.map((thread) => warmupThreadRowHtml(thread)).join("")}</div>
    ${more}`;
  refreshIcons();
}

/* ── The badge ─────────────────────────────────────────────────────────────
 *
 * The count on the Warm-up nav item is the entire notification this phase
 * ships: the workspace's notification settings have channels for email and
 * Slack, none of them are wired to anything, and a badge that is true beats a
 * channel that silently does nothing.
 *
 * Which means it cannot wait for somebody to open the tab — a reply nobody is
 * told about is the problem being solved. So the count is read once at boot and
 * then on a slow timer, but only while the window is actually in front, and
 * never again on a server that says it has no warm-up configured.
 */

const WARMUP_BADGE_POLL_MS = 120000;
let warmupBadgeTimer = null;

function renderWarmupNavBadge() {
  const badge = document.getElementById("warmupNavBadge");
  if (!badge) return;
  const count = warmupState.unreadReplies;
  if (!Number.isFinite(count) || count <= 0) {
    badge.hidden = true;
    badge.textContent = "";
    return;
  }
  badge.hidden = false;
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.title = `${count} unread ${count === 1 ? "reply" : "replies"}`;
  badge.setAttribute("aria-label", badge.title);
}

function setWarmupUnread(count) {
  warmupState.unreadReplies = Number.isFinite(count) ? Math.max(0, count) : null;
  renderWarmupNavBadge();
}

function stopWarmupBadgePoll() {
  if (warmupBadgeTimer) clearInterval(warmupBadgeTimer);
  warmupBadgeTimer = null;
}

async function refreshWarmupBadge() {
  if (!authState?.authenticated) return;
  if (document.visibilityState === "hidden") return;
  try {
    const config = await warmupApi("/config");
    // A server with no warm-up will never have an unread reply, and should not
    // be asked again for the rest of the session.
    if (config && config.configured === false) {
      setWarmupUnread(0);
      stopWarmupBadgePoll();
      return;
    }
    if (Number.isFinite(config?.unreadReplies)) setWarmupUnread(config.unreadReplies);
  } catch (error) {
    // A portal without the count is not a portal with a wrong count: leave the
    // badge as it was, and stop pestering a server that has no such route.
    if (error?.status === 404) stopWarmupBadgePoll();
  }
}

function startWarmupBadge() {
  stopWarmupBadgePoll();
  warmupBadgeTimer = setInterval(() => refreshWarmupBadge(), WARMUP_BADGE_POLL_MS);
  refreshWarmupBadge();
}

/* ── Loading and opening ───────────────────────────────────────────────── */

async function loadWarmupInbox() {
  const inbox = warmupState.inbox;
  const params = new URLSearchParams();
  if (inbox.unreadOnly) params.set("unread", "1");
  const query = params.toString();

  try {
    const payload = await warmupApi(`/inbox${query ? `?${query}` : ""}`);
    inbox.threads = Array.isArray(payload.threads) ? payload.threads : [];
    inbox.unread = Number.isFinite(payload.unread) ? payload.unread : 0;
    inbox.sync = payload.sync && typeof payload.sync === "object" ? payload.sync : null;
    inbox.available = true;
    inbox.ready = true;
    inbox.error = "";
    setWarmupUnread(inbox.unread);
  } catch (error) {
    inbox.threads = [];
    inbox.sync = null;
    if (error?.status === 404) {
      // The endpoint is not built here. That is a different sentence from "the
      // inbox is empty", and drawing the empty one would be a lie.
      inbox.available = false;
      inbox.ready = false;
      inbox.error = "";
    } else {
      inbox.available = true;
      inbox.ready = true;
      inbox.error = error.message || "The inbox could not be read.";
    }
  }
  renderWarmupInbox();
}

function warmupThreadIsOpen(accountId, threadKey) {
  const inbox = warmupState.inbox;
  return inbox.openAccountId === accountId && inbox.openThreadKey === threadKey;
}

/** Opening a thread marks it read — that is what opening it means. */
async function markWarmupThreadRead(accountId, threadKey) {
  const thread = warmupState.inbox.threads.find(
    (row) => row.threadKey === threadKey && row.accountId === accountId
  );
  if (thread && !thread.unread) return;

  let payload = null;
  try {
    payload = await warmupApi("/inbox/read", {
      method: "POST",
      body: JSON.stringify({ threadKey, accountId })
    });
  } catch (error) {
    // Failing to mark it read leaves it unread, which is the safe direction: a
    // reply shown twice costs a glance, a reply hidden costs the reply.
    return;
  }

  if (thread) thread.unread = false;
  warmupState.inbox.unread = Math.max(0, (warmupState.inbox.unread || 0) - 1);
  // The mark comes back with the new global count, so the badge is the server's
  // number rather than this screen's arithmetic about it.
  if (Number.isFinite(payload?.unread)) {
    setWarmupUnread(payload.unread);
  } else if (Number.isFinite(warmupState.unreadReplies)) {
    setWarmupUnread(warmupState.unreadReplies - 1);
  }
}

async function openWarmupThread(accountId, threadKey) {
  const inbox = warmupState.inbox;
  inbox.openAccountId = accountId;
  inbox.openThreadKey = threadKey;
  inbox.open = null;
  inbox.openError = "";
  inbox.openBusy = true;
  renderWarmupInbox();

  try {
    const payload = await warmupApi(
      `/inbox/thread?threadKey=${encodeURIComponent(threadKey)}&accountId=${encodeURIComponent(accountId)}`
    );
    // The reader may have gone back, or opened something else, while this was
    // in flight. Whatever is open now wins.
    if (!warmupThreadIsOpen(accountId, threadKey)) return;
    inbox.open = { thread: payload.thread || {}, messages: payload.messages || [] };
    inbox.openError = "";
  } catch (error) {
    if (!warmupThreadIsOpen(accountId, threadKey)) return;
    // A 404 here means the thread, not the route — a row can be listed and then
    // be gone by the time somebody clicks it. Unless the list never answered
    // either, in which case it is the route after all.
    inbox.openError = error?.status === 404
      ? (inbox.available
        ? "This conversation is no longer stored on the server."
        : "This server cannot open a single thread yet.")
      : (error.message || "The conversation could not be read.");
  } finally {
    if (warmupThreadIsOpen(accountId, threadKey)) {
      inbox.openBusy = false;
      renderWarmupInbox();
    }
  }

  if (warmupThreadIsOpen(accountId, threadKey) && !inbox.openError) {
    await markWarmupThreadRead(accountId, threadKey);
    if (warmupThreadIsOpen(accountId, threadKey)) renderWarmupInbox();
  }
}

function closeWarmupThread() {
  const inbox = warmupState.inbox;
  inbox.openAccountId = null;
  inbox.openThreadKey = null;
  inbox.open = null;
  inbox.openError = "";
  inbox.openBusy = false;
  renderWarmupInbox();
}

document.getElementById("warmupInboxRefreshBtn")?.addEventListener("click", () => {
  const inbox = warmupState.inbox;
  if (inbox.openThreadKey !== null) {
    openWarmupThread(inbox.openAccountId, inbox.openThreadKey);
    return;
  }
  loadWarmupInbox();
});

document.getElementById("warmupInboxUnreadOnly")?.addEventListener("change", (event) => {
  warmupState.inbox.unreadOnly = Boolean(event.target.checked);
  warmupState.inbox.ready = false;
  renderWarmupInbox();
  loadWarmupInbox();
});

document.getElementById("warmupInboxBody")?.addEventListener("click", (event) => {
  if (event.target.closest("[data-warmup-inbox-back]")) {
    closeWarmupThread();
    return;
  }
  if (event.target.closest("[data-warmup-inbox-expand]")) {
    warmupState.inbox.showAll = true;
    renderWarmupInbox();
    return;
  }
  if (event.target.closest("[data-warmup-inbox-collapse]")) {
    warmupState.inbox.showAll = false;
    renderWarmupInbox();
    return;
  }
  if (event.target.closest("[data-warmup-inbox-showall]")) {
    warmupState.inbox.unreadOnly = false;
    warmupState.inbox.ready = false;
    renderWarmupInbox();
    loadWarmupInbox();
    return;
  }
  // A link inside a row is the link, not the row.
  if (event.target.closest("a")) return;
  const row = event.target.closest("[data-warmup-thread]");
  if (!row) return;
  openWarmupThread(row.dataset.warmupThreadAccount, row.dataset.warmupThread);
});

startWarmupBadge();
