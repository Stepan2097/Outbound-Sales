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
    throw new Error(body.error || `Request failed with ${response.status}`);
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
  renderActiveLinkedinSelect();
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
  setHtml("linkedinIdentityList", (user.linkedinAccounts || []).length
    ? user.linkedinAccounts.map((account) => `
      <article class="identity-row ${account.id === user.activeLinkedinAccountId ? "active" : ""}">
        <div><strong>${escapeHtml(account.name)}</strong><a href="${escapeAttr(account.url)}" target="_blank" rel="noreferrer">${escapeHtml(shortUrl(account.url))}</a></div>
        <div>
          <button type="button" data-activate-linkedin="${escapeAttr(account.id)}" ${account.id === user.activeLinkedinAccountId ? "disabled" : ""}><i data-lucide="check"></i><span>${account.id === user.activeLinkedinAccountId ? "Active" : "Use"}</span></button>
          <button class="icon-button danger-button" type="button" data-delete-linkedin="${escapeAttr(account.id)}" title="Remove"><i data-lucide="trash-2"></i></button>
        </div>
      </article>`).join("")
    : `<div class="empty-state">Add the LinkedIn account this seller will use.</div>`);
  const adminPanel = document.getElementById("adminTeamPanel");
  adminPanel.hidden = user.role !== "admin";
  setHtml("teamUserList", (authState.team || []).map((member) => `
    <article class="team-row"><div><strong>${escapeHtml(member.name)}</strong><span>${escapeHtml(member.email)}</span></div><span class="pill">${escapeHtml(member.role)}</span></article>
  `).join(""));
}

function renderActiveLinkedinSelect() {
  const select = document.getElementById("activeLinkedinSelect");
  const user = authState?.user;
  if (!select || !user) return;
  const accounts = user.linkedinAccounts || [];
  select.innerHTML = accounts.length
    ? accounts.map((account) => `<option value="${escapeAttr(account.id)}" ${account.id === user.activeLinkedinAccountId ? "selected" : ""}>${escapeHtml(account.name)}</option>`).join("")
    : `<option value="">No LinkedIn sender</option>`;
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
  const editButton = document.getElementById("editProductBtn");
  if (editButton) editButton.disabled = creatingNewProduct || !state.selectedProduct;
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
  document.getElementById("crmStatus").textContent = state.integrations?.crm?.status || "not_configured";
  document.getElementById("transcriptStatus").textContent = state.integrations?.transcripts?.status || "manual_paste";
  document.getElementById("notificationStatus").textContent = state.integrations?.notifications?.status || "in_app";
  document.getElementById("supabaseStatus").textContent = state.integrations?.supabase?.status || "not_configured";
  document.getElementById("postgresStatus").textContent = state.integrations?.postgres?.status || "not_configured";

  document.getElementById("analysisModelInput").value = state.aiModelDefaults?.analysisModel || "anthropic/claude-haiku-4.5";
  document.getElementById("writingModelInput").value = state.aiModelDefaults?.writingModel || "anthropic/claude-sonnet-5";

  const apify = state.integrations?.apify;
  document.getElementById("leadDatabaseActorInput").value = apify?.actorIds?.leadDatabase || "";
  document.getElementById("leadDatabaseInputTemplate").value = apify?.actorInputTemplates?.leadDatabase || "";
  document.getElementById("linkedinActorInput").value = apify?.actorIds?.linkedinProfile || "";
  document.getElementById("contactFinderActorInput").value = apify?.actorIds?.contactFinder || "delicious_zebu/contact-info-scraper";
  document.getElementById("apolloActorInput").value = apify?.actorIds?.apollo || "";
  document.getElementById("zoominfoActorInput").value = apify?.actorIds?.zoominfo || "";
  document.getElementById("facebookProfileActorInput").value = apify?.actorIds?.facebookProfile || "";
  document.getElementById("emailPhoneFinderActorInput").value = apify?.actorIds?.emailPhoneFinder || "";
  document.getElementById("phoneMessengerCheckActorInput").value = apify?.actorIds?.phoneMessengerCheck || "";
  document.getElementById("whatsappCheckerActorInput").value = apify?.actorIds?.whatsappChecker || "vtrdev/whatsapp-number-validator";
  document.getElementById("telegramCheckerActorInput").value = apify?.actorIds?.telegramChecker || "akula.marketing/telegram-get-phone-info";
  document.getElementById("companyPeopleActorInput").value = apify?.actorIds?.companyPeople || "scraper-engine/linkedin-company-employees-scraper";
  document.getElementById("companyPeopleSecondaryActorInput").value = apify?.actorIds?.companyPeopleSecondary || "harvestapi/linkedin-company-employees";
  document.getElementById("personEnrichmentActorInput").value = apify?.actorIds?.personEnrichment || "ryanclinton/person-enrichment-lookup";
  document.getElementById("companyPeopleInputTemplate").value = apify?.actorInputTemplates?.companyPeople || "";
  document.getElementById("apifyMaxChargeInput").value = apify?.maxChargeUsd || 1.5;
  document.getElementById("apifyContactMaxChargeInput").value = apify?.contactMaxChargeUsd || 0.2;

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

function setView(viewName) {
  views.forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
  navItems.forEach((item) => item.classList.toggle("active", item.dataset.view === viewName));
  document.getElementById("pageTitle").textContent =
    {
      prospects: "Dashboard",
      leads: "Leads",
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
  if (viewName === "overview") {
    drawTrafficChart();
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

document.getElementById("activeLinkedinSelect").addEventListener("change", async (event) => {
  if (!event.target.value) return;
  await api("/api/account/linkedin/active", { method: "POST", body: JSON.stringify({ accountId: event.target.value }) });
  authState = await api("/api/auth/status");
  render();
});

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

document.getElementById("linkedinIdentityForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/account/linkedin", { method: "POST", body: JSON.stringify({ name: document.getElementById("linkedinIdentityNameInput").value, url: document.getElementById("linkedinIdentityUrlInput").value }) });
  event.currentTarget.reset();
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
  const activate = event.target.closest("[data-activate-linkedin]");
  if (activate) {
    await api("/api/account/linkedin/active", { method: "POST", body: JSON.stringify({ accountId: activate.dataset.activateLinkedin }) });
    authState = await api("/api/auth/status");
    render();
    return;
  }
  const remove = event.target.closest("[data-delete-linkedin]");
  if (remove) {
    await api("/api/account/linkedin/delete", { method: "POST", body: JSON.stringify({ accountId: remove.dataset.deleteLinkedin }) });
    authState = await api("/api/auth/status");
    render();
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

  const removeProspect = event.target.closest("[data-remove-prospect-id]");
  if (removeProspect) {
    await removeProspectById(removeProspect.dataset.removeProspectId);
    return;
  }

  const prospectCardButton = event.target.closest("[data-prospect-id]");
  if (prospectCardButton) {
    selectedProspectId = prospectCardButton.dataset.prospectId;
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
  clearStructuredProductTrainingFields();
  renderProductStudio();
  refreshIcons();
});

document.getElementById("editProductBtn")?.addEventListener("click", () => {
  creatingNewProduct = false;
  fillProductEditor(state.selectedProduct);
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
    clearStructuredProductTrainingFields();
  });
});

document.getElementById("productForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const structuredText = structuredProductTrainingText();
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
    clearStructuredProductTrainingFields();
  });
  creatingNewProduct = false;
});

function structuredProductTrainingText() {
  const sections = [
    ["General product context", document.getElementById("productContextInput").value],
    ["Offer and deliverables", document.getElementById("productOfferInput")?.value],
    ["ICP, buyers, and GEOs", document.getElementById("productIcpInput")?.value],
    ["Pricing and commercial model", document.getElementById("productPricingInput")?.value],
    ["Proof, cases, and approved claims", document.getElementById("productProofInput")?.value],
    ["Winning outreach examples to imitate", document.getElementById("productWinningExamplesInput")?.value],
    ["Bad outreach examples and claims to avoid", document.getElementById("productBadExamplesInput")?.value]
  ];
  return sections
    .map(([label, value]) => [label, String(value || "").trim()])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}:\n${value}`)
    .join("\n\n");
}

function clearStructuredProductTrainingFields() {
  [
    "productContextInput",
    "productOfferInput",
    "productIcpInput",
    "productPricingInput",
    "productProofInput",
    "productWinningExamplesInput",
    "productBadExamplesInput"
  ].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.value = "";
  });
}

function fillProductEditor(product) {
  if (!product) return;
  setFormValue("productContextInput", product.rawContext || product.positioning || "");
  setFormValue("productOfferInput", [product.positioning, ...(product.useCases || [])].filter(Boolean).join("\n"));
  setFormValue("productIcpInput", [
    ...(product.targetPersonas || []).map((item) => `Persona: ${item}`),
    ...((product.memory?.segments?.idealCustomers || []).map((item) => `Ideal customer: ${item}`))
  ].join("\n"));
  setFormValue("productPricingInput", product.memory?.segments?.pricing?.join("\n") || "");
  setFormValue("productProofInput", (product.proofPoints || []).join("\n"));
  setFormValue("productWinningExamplesInput", (product.examples || [])
    .filter((example) => example.quality === "winning")
    .slice(0, 6)
    .map((example) => example.message)
    .join("\n\n"));
  setFormValue("productBadExamplesInput", [
    ...(product.objections || []),
    ...((product.examples || []).filter((example) => example.quality === "bad").slice(0, 6).map((example) => example.message))
  ].filter(Boolean).join("\n\n"));
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
      contactMaxChargeUsd: Number(document.getElementById("apifyContactMaxChargeInput").value)
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
