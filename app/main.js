let state = null;
let selectedTaskType = "COLD_EMAIL";
let selectedProspectId = null;
let creatingNewProduct = false;
let pendingProductKnowledgeScreenshot = null;
let pendingLearningScreenshot = null;

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
  refreshIcons();
}

function renderTopbar() {
  const runtime = state.aiRuntime?.mode === "openrouter" ? "OpenRouter live" : "Mock AI";
  document.getElementById("workspaceMeta").textContent = `${runtime} · ${state.prospects?.length || 0} leads · ${state.followUpTasks?.length || 0} follow-ups`;
  document.getElementById("providerStatus").textContent = state.providerHealth.status;
  document.getElementById("healthPill").textContent = state.providerHealth.status;
  document.getElementById("keyState").textContent = state.hasOpenRouterKey
    ? `Key version ${state.keyMetadata.keyVersion} · ${state.keyMetadata.environment}`
    : "No key configured";
  fillSelect(document.getElementById("productSelect"), state.products, (product) => product.id, (product) => product.name, state.selectedProductId);
}

function renderProductContext() {
  const product = state.selectedProduct;
  if (!product) return;

  document.getElementById("activeProductName").textContent = product.name;
  document.getElementById("activeProductPositioning").textContent = product.positioning;
  document.getElementById("productPersonas").textContent = product.targetPersonas.slice(0, 3).join(", ");
  document.getElementById("productUseCase").textContent = product.useCases[0] || "-";
  document.getElementById("productProofPoint").textContent = product.proofPoints[0] || "-";
  document.getElementById("mcpSyncState").textContent = `MCP ${state.mcpSync.status}`;
  document.getElementById("mcpSourceList").innerHTML = product.mcpContext.sources
    .map(
      (source) => `
        <div class="mcp-source">
          <i data-lucide="file-check-2"></i>
          <span>${escapeHtml(source.name)}</span>
          <strong>${source.confidence}%</strong>
        </div>
      `
    )
    .join("");
}

function renderProductStudio() {
  const product = creatingNewProduct ? emptyProductDraft() : state.selectedProduct;
  if (!product) return;

  document.getElementById("productStudioSelected").textContent = creatingNewProduct ? "new product" : product.name;
  document.getElementById("productNameInput").value = product.name || "";
  document.getElementById("productCategoryInput").value = product.category || "";
  document.getElementById("productPositioningInput").value = product.positioning || "";
  document.getElementById("productPersonasInput").value = (product.targetPersonas || []).join("\n");
  document.getElementById("productUseCasesInput").value = (product.useCases || []).join("\n");
  document.getElementById("productProofInput").value = (product.proofPoints || []).join("\n");
  document.getElementById("productDifferentiatorsInput").value = (product.differentiators || []).join("\n");
  document.getElementById("productObjectionsInput").value = (product.objections || []).join("\n");
  document.getElementById("productKnowledgeStats").textContent = `${(product.knowledge || []).length} item${(product.knowledge || []).length === 1 ? "" : "s"}`;
  document.getElementById("productKnowledgeList").innerHTML = (product.knowledge || []).length
    ? product.knowledge.map(productKnowledgeRow).join("")
    : `<div class="empty-state">${creatingNewProduct ? "Save the product first, then add knowledge" : "No product knowledge uploaded yet"}</div>`;
  document.getElementById("exampleList").innerHTML = (product.examples || []).length
    ? product.examples.map(exampleRow).join("")
    : `<div class="empty-state">${creatingNewProduct ? "Save the product before adding examples" : "No examples loaded for this product"}</div>`;
  renderProductKnowledgeScreenshotPreview();
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
  document.getElementById("contactFinderActorInput").value = apify?.actorIds?.contactFinder || "";
  document.getElementById("apolloActorInput").value = apify?.actorIds?.apollo || "";
  document.getElementById("zoominfoActorInput").value = apify?.actorIds?.zoominfo || "";
  document.getElementById("facebookProfileActorInput").value = apify?.actorIds?.facebookProfile || "";
  document.getElementById("emailPhoneFinderActorInput").value = apify?.actorIds?.emailPhoneFinder || "";
  document.getElementById("phoneMessengerCheckActorInput").value = apify?.actorIds?.phoneMessengerCheck || "";
  document.getElementById("apifyMaxChargeInput").value = apify?.maxChargeUsd || 1.5;

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

  document.getElementById("learningStatusPill").textContent = playbook.status || "empty";
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
    <button class="prospect-card ${prospect.id === selectedProspectId ? "active" : ""}" data-prospect-id="${escapeAttr(prospect.id)}">
      <div class="avatar">${initials(prospect.name)}</div>
      <div>
        <strong>${escapeHtml(prospect.name)}</strong>
        <span>${escapeHtml([prospect.title, prospect.company].filter(Boolean).join(" · "))}</span>
        <small>${escapeHtml(prospect.location || "No location")} · ${escapeHtml(prospect.status)} · reach ${prospect.analysis?.reachProbability ?? 0}%</small>
      </div>
      <b>${prospect.score}</b>
    </button>
  `;
}

function renderSelectedProspect(prospect) {
  const enrichButton = document.getElementById("enrichProspectBtn");
  const prepareButton = document.getElementById("prepareOutreachBtn");
  if (enrichButton) enrichButton.disabled = !prospect;
  if (prepareButton) prepareButton.disabled = !prospect;

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
    document.getElementById("callAnalysis").innerHTML = `<div class="empty-state">Paste a transcript after a call</div>`;
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
  document.getElementById("callAnalysis").innerHTML = callAnalysisRows(prospect);
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

  setHtml("accountSignalList", accountSignalRows(prospect));
  setHtml("buyingCommitteeList", buyingCommitteeRows(prospect));
  setHtml("scoreBreakdown", scoreBreakdownRows(prospect));
  setHtml("nextActionSummary", nextActionRows(prospect));
  setHtml("salesCycleList", salesCycleRows(prospect));
  setHtml("sourceAuditList", sourceAuditRows(prospect));
  updateQuickCopies(prospect);
}

function renderLeadsPage() {
  const prospects = state.prospects || [];
  const ready = prospects.filter((prospect) => prospect.status === "outreach_ready" || prospect.status === "linkedin_ready").length;
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
      <td><button type="button" data-open-prospect-id="${escapeAttr(prospect.id)}"><i data-lucide="arrow-up-right"></i><span>Open</span></button></td>
    </tr>
  `;
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
  return committee.map((member) => `
    <article class="committee-card">
      <div class="avatar">${initials(member.name)}</div>
      <div>
        <strong>${escapeHtml(member.name)}</strong>
        <span>${escapeHtml([member.title, member.context].filter(Boolean).join(" · "))}</span>
      </div>
      <span class="pill">${escapeHtml(titleCase(member.role))}</span>
    </article>
  `).join("");
}

function committeeForProspect(prospect) {
  if (!prospect) return [];
  const sameCompany = (state.prospects || []).filter((item) => item.company?.toLowerCase() === prospect.company?.toLowerCase());
  const known = sameCompany.length ? sameCompany : [prospect];
  const rows = known.map((item) => ({
    name: item.name,
    title: item.title || "Unknown title",
    role: committeeRole(item.title),
    context: item.id === prospect.id ? "current lead" : "known in queue"
  }));
  rows.push({ name: "RevOps or Sales leader", title: "Suggested next person to research", role: "suggested", context: "not found yet" });
  return rows.slice(0, 5);
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
  const rows = [
    ["ICP fit", prospect.score || 0],
    ["Reach chance", analysis.reachProbability || 0],
    ["Close chance", analysis.closeProbability || 0],
    ["Contact confidence", bestContactConfidence(prospect)]
  ];
  return rows.map(([label, value]) => `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${value}%</strong>
      <div class="meter compact"><span style="width:${value}%"></span></div>
    </div>
  `).join("");
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
    { label: "Outreach prepared", value: prospect.outreach ? relativeTime(prospect.outreach.preparedAt || prospect.updatedAt) : "pending", state: prospect.outreach ? "done" : "pending" },
    { label: "Latest CRM action", value: (prospect.interactions || [])[0]?.type ? titleCase(prospect.interactions[0].type) : "none logged", state: (prospect.interactions || []).length ? "done" : "pending" }
  ];
  const cadenceItems = (prospect.salesCadence?.steps || []).slice(0, 5).map((step) => ({
    label: step.label,
    value: [step.day, step.channel, step.messageChannel ? `copy ${titleCase(step.messageChannel)}` : ""].filter(Boolean).join(" · "),
    state: (prospect.interactions || []).some((interaction) => interaction.type === step.type) ? "done" : "pending"
  }));
  const items = [...baseItems, ...cadenceItems];
  return items.map((item) => `
    <article class="cycle-row ${item.state}">
      <span></span>
      <div>
        <strong>${escapeHtml(item.label)}</strong>
        <small>${escapeHtml(item.value)}</small>
      </div>
    </article>
  `).join("");
}

function sourceAuditRows(prospect) {
  if (!prospect) return `<div class="empty-state">Sources appear after profile import and research</div>`;
  const productSources = state.selectedProduct?.mcpContext?.sources || [];
  const contactSources = prospect.contactDiscovery?.candidates || [];
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

function bestContactConfidence(prospect) {
  const candidates = prospect?.contactDiscovery?.candidates || [];
  return candidates.length ? Math.max(...candidates.map((candidate) => Number(candidate.confidence) || 0)) : 0;
}

function preferredChannel(prospect) {
  const candidates = prospect?.contactDiscovery?.candidates || [];
  if (prospect?.linkedin || candidates.some((candidate) => candidate.type === "linkedin")) return "linkedin";
  if (prospect?.email || candidates.some((candidate) => candidate.type === "email")) return "email";
  if (prospect?.phone || candidates.some((candidate) => candidate.type === "phone")) return "phone";
  return "linkedin";
}

function updateQuickCopies(prospect) {
  const messages = prospect?.outreach?.messages || [];
  const variations = prospect?.outreach?.linkedinVariations || [];
  setCopyText("copyLinkedinQuick", messages.find((message) => /linkedin_invite/i.test(message.channel))?.body || variations[0]?.body || messages.find((message) => /linkedin/i.test(message.channel))?.body || "");
  setCopyText("copyEmailQuick", messages.find((message) => /email/i.test(message.channel))?.body || "");
  setCopyText("copySmsQuick", messages.find((message) => /^sms$/i.test(message.channel))?.body || "");
  setCopyText("copyWhatsappQuick", messages.find((message) => /whatsapp/i.test(message.channel))?.body || "");
  setCopyText("copyTelegramQuick", messages.find((message) => /telegram/i.test(message.channel))?.body || "");
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
      (candidate) => `
        <article class="contact-card">
          <div>
            <span class="contact-type">${escapeHtml(candidate.type)}</span>
            <strong>${linkIfUrl(candidate.value)}</strong>
            <small>${escapeHtml(candidate.source)} · ${escapeHtml(candidate.status)}</small>
            ${candidate.evidence?.length ? `<div class="evidence-row">${candidate.evidence.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
          </div>
          <div class="confidence">
            <span>${candidate.confidence}%</span>
            <button data-copy-text="${escapeAttr(candidate.value)}" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>
          </div>
        </article>
      `
    )
    .join("");

  const warnings = discovery.warnings
    .map((warning) => `<span class="warning-chip">${escapeHtml(warning)}</span>`)
    .join("");
  return `${candidates}<div class="warning-row">${warnings}</div>`;
}

function outreachRows(prospect) {
  const outreach = prospect.outreach;
  if (!outreach) {
    return `<div class="empty-state">Prepare outreach to generate messages and actions</div>`;
  }

  const messages = (outreach.messages || [])
    .map(
      (message) => `
        <article class="message-card">
          <div class="message-heading">
            <span class="pill">${escapeHtml(message.channel)}</span>
            ${message.subject ? `<strong>${escapeHtml(message.subject)}</strong>` : ""}
            <button data-copy-text="${escapeAttr(message.body)}" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>
          </div>
          <pre>${escapeHtml(message.body)}</pre>
        </article>
      `
    )
    .join("");

  const variations = (outreach.linkedinVariations || [])
    .map(
      (variation) => `
        <article class="message-card linkedin-variation">
          <div class="message-heading">
            <span class="pill">${escapeHtml(variation.label)}</span>
            <strong>LinkedIn variation</strong>
            <button data-copy-text="${escapeAttr(variation.body)}" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>
          </div>
          <pre>${escapeHtml(variation.body)}</pre>
        </article>
      `
    )
    .join("");

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

  return `
    <div class="qualification-strip">
      <div><span>Product</span><strong>${escapeHtml(outreach.productName || state.selectedProduct?.name || "")}</strong></div>
      <div><span>Fit</span><strong>${escapeHtml(outreach.qualification?.fit || prospect.analysis?.productFit || "")}</strong></div>
      <div><span>Channel</span><strong>${escapeHtml(outreach.recommendedChannel)}</strong></div>
    </div>
    ${fallbackWarning}
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
            <button data-copy-text="${escapeAttr(template.body)}" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>
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
        <article class="task-alert">
          <i data-lucide="bell-ring"></i>
          <div>
            <strong>${escapeHtml(task.label)}</strong>
            <span>${new Date(task.due).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${escapeHtml(task.status)}</span>
          </div>
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

function setCopyText(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  element.dataset.copyText = value || "";
  element.disabled = !value;
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
  render();
  scrollLeadWorkspaceToTop();
}

function scrollLeadWorkspaceToTop() {
  document.getElementById("dashboard-overview")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

navItems.forEach((item) => {
  item.addEventListener("click", () => setView(item.dataset.view));
});

document.getElementById("chartMode").addEventListener("change", drawTrafficChart);
document.getElementById("modelSearch").addEventListener("input", renderModels);
document.getElementById("modelTierFilter").addEventListener("change", renderModels);
document.getElementById("prospectSearch").addEventListener("input", renderProspects);
document.getElementById("prospectStatusFilter").addEventListener("change", renderProspects);
document.getElementById("productSelect").addEventListener("change", async (event) => {
  creatingNewProduct = false;
  state = await api("/api/products/select", {
    method: "POST",
    body: JSON.stringify({ productId: event.target.value })
  });
  render();
});

document.getElementById("syncMcpBtn").addEventListener("click", async () => {
  state = await api("/api/products/sync-mcp", { method: "POST", body: "{}" });
  render();
});

document.getElementById("quickPrepareBtn").addEventListener("click", async () => {
  await researchAndPrepareSelected();
});

document.getElementById("runResearchTopBtn").addEventListener("click", async () => {
  await researchAndPrepareSelected();
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

  const openProspect = event.target.closest("[data-open-prospect-id]");
  if (openProspect) {
    selectedProspectId = openProspect.dataset.openProspectId;
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

  const prospectCardButton = event.target.closest("[data-prospect-id]");
  if (prospectCardButton) {
    selectedProspectId = prospectCardButton.dataset.prospectId;
    renderProspects();
    renderLeadWorkspaceExtras(state.prospects?.find((prospect) => prospect.id === selectedProspectId));
    refreshIcons();
  }

  const copyButton = event.target.closest("[data-copy-text]");
  if (copyButton) {
    await navigator.clipboard.writeText(copyButton.dataset.copyText || "");
    copyButton.innerHTML = `<i data-lucide="check"></i>`;
    refreshIcons();
    return;
  }

  const actionInteraction = event.target.closest("[data-interaction-type]");
  if (actionInteraction && selectedProspectId) {
    state = await api("/api/prospects/interaction", {
      method: "POST",
      body: JSON.stringify({ prospectId: selectedProspectId, type: actionInteraction.dataset.interactionType })
    });
    render();
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
  render();
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
  state = await api("/api/crm/import-leads", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  selectedProspectId = state.prospects[0]?.id || selectedProspectId;
  render();
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

document.getElementById("newProductBtn").addEventListener("click", () => {
  creatingNewProduct = true;
  renderProductStudio();
  refreshIcons();
});

document.getElementById("productForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const existingProduct = state.selectedProduct;
  state = await api("/api/products/upsert", {
    method: "POST",
    body: JSON.stringify({
      id: creatingNewProduct ? "" : existingProduct?.id,
      name: document.getElementById("productNameInput").value,
      category: document.getElementById("productCategoryInput").value,
      positioning: document.getElementById("productPositioningInput").value,
      targetPersonas: document.getElementById("productPersonasInput").value,
      useCases: document.getElementById("productUseCasesInput").value,
      proofPoints: document.getElementById("productProofInput").value,
      differentiators: document.getElementById("productDifferentiatorsInput").value,
      objections: document.getElementById("productObjectionsInput").value
    })
  });
  creatingNewProduct = false;
  render();
});

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
      persona: document.getElementById("examplePersonaInput").value,
      message: document.getElementById("exampleMessageInput").value,
      outcome: document.getElementById("exampleOutcomeInput").value
    })
  });
  document.getElementById("exampleMessageInput").value = "";
  document.getElementById("exampleOutcomeInput").value = "";
  render();
});

document.getElementById("productKnowledgeScreenshotInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    pendingProductKnowledgeScreenshot = null;
    renderProductKnowledgeScreenshotPreview();
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
  pendingProductKnowledgeScreenshot = {
    name: file.name,
    type: file.type,
    size: file.size,
    dataUrl: await fileToDataUrl(file)
  };
  renderProductKnowledgeScreenshotPreview();
});

document.getElementById("productKnowledgeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (creatingNewProduct) {
    document.getElementById("productKnowledgeList").innerHTML = `<div class="empty-state">Save the new product first, then add knowledge</div>`;
    return;
  }
  state = await api("/api/products/knowledge", {
    method: "POST",
    body: JSON.stringify({
      productId: state.selectedProductId,
      type: document.getElementById("knowledgeTypeInput").value,
      title: document.getElementById("knowledgeTitleInput").value,
      url: document.getElementById("knowledgeUrlInput").value,
      text: document.getElementById("knowledgeTextInput").value,
      tags: document.getElementById("knowledgeTagsInput").value,
      priority: Number(document.getElementById("knowledgePriorityInput").value),
      screenshot: pendingProductKnowledgeScreenshot
    })
  });
  pendingProductKnowledgeScreenshot = null;
  document.getElementById("productKnowledgeScreenshotInput").value = "";
  document.getElementById("knowledgeTitleInput").value = "";
  document.getElementById("knowledgeUrlInput").value = "";
  document.getElementById("knowledgeTextInput").value = "";
  document.getElementById("knowledgeTagsInput").value = "";
  document.getElementById("knowledgePriorityInput").value = 75;
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
      maxChargeUsd: Number(document.getElementById("apifyMaxChargeInput").value)
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
  state = await api("/api/prospects/enrich", {
    method: "POST",
    body: JSON.stringify({ prospectId: selectedProspectId })
  });
  render();
});

document.getElementById("prepareOutreachBtn").addEventListener("click", async () => {
  await researchAndPrepareSelected();
});

document.getElementById("callAnalysisForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedProspectId) return;
  const textarea = document.getElementById("callTranscriptInput");
  state = await api("/api/prospects/call-analysis", {
    method: "POST",
    body: JSON.stringify({
      prospectId: selectedProspectId,
      transcript: textarea.value
    })
  });
  textarea.value = "";
  render();
});

async function researchAndPrepareSelected() {
  if (!selectedProspectId) return;
  const profile = document.getElementById("outreachProfileSelect").value;
  state = await api("/api/prospects/enrich", {
    method: "POST",
    body: JSON.stringify({ prospectId: selectedProspectId })
  });
  state = await api("/api/prospects/prepare", {
    method: "POST",
    body: JSON.stringify({ prospectId: selectedProspectId, profile })
  });
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

document.getElementById("logInteractionBtn").addEventListener("click", async () => {
  if (!selectedProspectId) return;
  state = await api("/api/prospects/interaction", {
    method: "POST",
    body: JSON.stringify({
      prospectId: selectedProspectId,
      type: document.getElementById("interactionTypeSelect").value
    })
  });
  render();
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

await refresh();
