const API_BASE = "http://127.0.0.1:8787";
const REQUEST_TIMEOUT_MS = 30000;
const TOP_TOKENS_TIMEOUT_MS = 20000;

const form = document.getElementById("score-form");
const mintInput = document.getElementById("mint");
const submitButton = form.querySelector('button[type="submit"]');
const errorEl = document.getElementById("error");
const emptyState = document.getElementById("empty-state");
const loadingState = document.getElementById("loading-state");

const resultSection = document.getElementById("result");
const scoreRing = document.getElementById("score-ring");
const scoreValue = document.getElementById("score-value");
const statusLine = document.getElementById("status-line");
const sourceLine = document.getElementById("source-line");
const confidenceLine = document.getElementById("confidence-line");
const holderLine = document.getElementById("holder-line");

const metricLiquidity = document.getElementById("metric-liquidity");
const metricVolume = document.getElementById("metric-volume");
const metricTx = document.getElementById("metric-tx");
const metricPairs = document.getElementById("metric-pairs");

const reasonsList = document.getElementById("reasons");
const rpcHealthCard = document.getElementById("rpc-health-card");
const rpcHealthList = document.getElementById("rpc-health-list");
const warningsCard = document.getElementById("warnings-card");
const warningsList = document.getElementById("warnings");

const topTokensStatus = document.getElementById("top-tokens-status");
const topTokensBody = document.getElementById("top-tokens-body");
const refreshTopTokensButton = document.getElementById("refresh-top-tokens");

let topTokensLoadNonce = 0;

function hideResult() {
  resultSection.classList.add("hidden");
  resultSection.classList.remove("is-ready");
}

function showEmptyState() {
  emptyState.classList.remove("hidden");
}

function hideEmptyState() {
  emptyState.classList.add("hidden");
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
  hideResult();
  loadingState.classList.add("hidden");
  showEmptyState();
}

function hideError() {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Analyzing..." : "Analyze";
  loadingState.classList.toggle("hidden", !isLoading);
}

function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

function formatPrice(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  const maxDigits = value >= 1 ? 2 : 6;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: maxDigits
  }).format(value);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function shortMint(mint) {
  if (!mint || mint.length < 12) {
    return mint || "n/a";
  }
  return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function formatHolderSource(source) {
  if (source === "rpc") {
    return "largest-holders RPC";
  }
  if (source === "rpc-token-accounts-exact") {
    return "token accounts (exact)";
  }
  if (source === "rpc-token-accounts-estimate") {
    return "token accounts (estimate)";
  }
  if (source === "heuristic") {
    return "heuristic fallback";
  }
  return source || "unknown";
}

function formatRpcProviders(providers) {
  if (!Array.isArray(providers) || providers.length === 0) {
    return "";
  }
  const visible = providers.slice(0, 2).map((item) => {
    const endpoint = item?.endpoint || "rpc-endpoint";
    const attempt = Number(item?.attempt || 1);
    const message = item?.message || "unknown failure";
    return `${endpoint}#${attempt}: ${message}`;
  });
  const hiddenCount = Math.max(0, providers.length - visible.length);
  if (hiddenCount > 0) {
    visible.push(`+${hiddenCount} more`);
  }
  return visible.join(" | ");
}

function setStatusVisual(status) {
  const resolved = String(status || "yellow").toLowerCase();
  statusLine.className = `status-pill ${resolved}`;
  scoreRing.classList.remove("green", "yellow", "red");
  if (resolved === "green" || resolved === "yellow" || resolved === "red") {
    scoreRing.classList.add(resolved);
  } else {
    scoreRing.classList.add("yellow");
  }
}

function renderReasons(reasons) {
  reasonsList.innerHTML = "";
  for (const reason of reasons || []) {
    const li = document.createElement("li");
    li.className = "reason-item";
    const separator = reason.indexOf(":");
    if (separator > 0) {
      const title = document.createElement("span");
      title.className = "reason-title";
      title.textContent = reason.slice(0, separator + 1);
      const value = document.createElement("span");
      value.className = "reason-value";
      value.textContent = reason.slice(separator + 1).trim();
      li.appendChild(title);
      li.appendChild(value);
    } else {
      li.textContent = reason;
    }
    reasonsList.appendChild(li);
  }
}

function renderWarnings(warnings) {
  warningsList.innerHTML = "";
  warningsCard.classList.add("hidden");
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return;
  }
  for (const warning of warnings) {
    const li = document.createElement("li");
    li.textContent = warning;
    warningsList.appendChild(li);
  }
  warningsCard.classList.remove("hidden");
}

function renderRpcHealth(rpcHealth) {
  rpcHealthList.innerHTML = "";
  rpcHealthCard.classList.add("hidden");
  if (!rpcHealth || typeof rpcHealth !== "object") {
    return;
  }

  const checks = [
    { key: "largestHolders", label: "Largest holders RPC" },
    { key: "tokenAccountsFallback", label: "Token accounts fallback" },
    { key: "tokenSupply", label: "Token supply RPC" }
  ];

  let hasRows = false;
  for (const definition of checks) {
    const check = rpcHealth?.[definition.key];
    if (!check || typeof check !== "object") {
      continue;
    }
    hasRows = true;

    const statusLower = String(check.status || "unknown").toLowerCase();
    const statusUpper = statusLower.toUpperCase();

    const li = document.createElement("li");
    li.className = "rpc-item";

    const head = document.createElement("div");
    head.className = "rpc-head";

    const name = document.createElement("span");
    name.className = "rpc-name";
    name.textContent = definition.label;

    const badge = document.createElement("span");
    badge.className = `rpc-badge ${statusLower}`;
    badge.textContent = statusUpper;

    head.appendChild(name);
    head.appendChild(badge);
    li.appendChild(head);

    const details = [];
    if (Number.isFinite(check.pagesFetched) && check.pagesFetched > 0) {
      details.push(`pages: ${check.pagesFetched}`);
    }
    if (check.note) {
      details.push(check.note);
    }
    if (details.length > 0) {
      const note = document.createElement("p");
      note.className = "rpc-note";
      note.textContent = details.join(" | ");
      li.appendChild(note);
    }

    const providers = formatRpcProviders(check.providers);
    if (providers) {
      const providerLine = document.createElement("p");
      providerLine.className = "rpc-provider";
      providerLine.textContent = providers;
      li.appendChild(providerLine);
    }

    rpcHealthList.appendChild(li);
  }

  if (hasRows) {
    rpcHealthCard.classList.remove("hidden");
  }
}

function showResult(data) {
  hideError();
  hideEmptyState();
  loadingState.classList.add("hidden");

  const score = Number(data?.score || 0);
  const clampedScore = Math.max(0, Math.min(100, score));

  scoreValue.textContent = String(score);
  scoreRing.style.setProperty("--score-angle", `${(clampedScore * 3.6).toFixed(2)}deg`);
  setStatusVisual(data?.status);

  statusLine.textContent = String(data?.status || "unknown").toUpperCase();
  confidenceLine.textContent = `Confidence: ${(data?.scoreConfidence || "unknown").toUpperCase()}`;
  sourceLine.textContent = `Data source: ${data?.dataSource || "unknown"}`;

  const details = data?.signalDetails || {};
  const holderSource = details.holderConcentrationSource;
  const holderCoveragePct = details.holderSampleCoveragePct;
  const holderPagesFetched = details.holderPagesFetched;
  if (holderSource) {
    const parts = [`Holder source: ${formatHolderSource(holderSource)}`];
    if (Number.isFinite(holderCoveragePct)) {
      parts.push(`coverage ${holderCoveragePct.toFixed(1)}%`);
    }
    if (Number.isFinite(holderPagesFetched)) {
      parts.push(`${holderPagesFetched} page(s)`);
    }
    holderLine.textContent = parts.join(" | ");
    holderLine.classList.remove("hidden");
  } else {
    holderLine.textContent = "";
    holderLine.classList.add("hidden");
  }

  metricLiquidity.textContent = formatUsd(Number(details.liquidityUsd));
  metricVolume.textContent = formatUsd(Number(details.volume24hUsd));
  metricTx.textContent = formatNumber(Number(details.tx24h));
  metricPairs.textContent = formatNumber(Number(details.marketPairCount));

  renderReasons(data?.reasons);
  renderRpcHealth(data?.rpcHealth);
  renderWarnings(data?.warnings);

  resultSection.classList.remove("hidden");
  resultSection.classList.remove("is-ready");
  void resultSection.offsetWidth;
  resultSection.classList.add("is-ready");
}

async function requestJson(pathname, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}${pathname}`, {
      signal: controller.signal
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const detail = data?.error ? ` ${data.error}` : "";
      throw new Error(`Request failed (${response.status}).${detail}`);
    }

    if (!data || typeof data !== "object") {
      throw new Error("API returned an invalid response.");
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function analyzeMint(mint) {
  hideError();
  hideResult();
  hideEmptyState();
  setLoading(true);

  try {
    const data = await requestJson(`/v1/score/${encodeURIComponent(mint)}`, REQUEST_TIMEOUT_MS);
    showResult(data);
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutSeconds = Math.round(REQUEST_TIMEOUT_MS / 1000);
      showError(`Request timed out after ${timeoutSeconds}s. RPC providers are likely slow or rate-limited.`);
      return;
    }
    showError(error?.message || "Could not reach API. Start backend and retry.");
  } finally {
    setLoading(false);
  }
}

function createRiskBadge(scoreData) {
  const badge = document.createElement("span");
  if (!scoreData) {
    badge.className = "risk-badge pending";
    badge.textContent = "...";
    return badge;
  }
  const status = String(scoreData.status || "yellow").toLowerCase();
  badge.className = `risk-badge ${status}`;
  badge.textContent = `${scoreData.score} ${status.toUpperCase()}`;
  return badge;
}

function renderTopTokens(tokens, nonce) {
  topTokensBody.innerHTML = "";

  if (!Array.isArray(tokens) || tokens.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "table-empty";
    td.textContent = "No top token data available.";
    tr.appendChild(td);
    topTokensBody.appendChild(tr);
    return [];
  }

  const scoreTargets = [];

  for (const token of tokens) {
    const tr = document.createElement("tr");

    const rankTd = document.createElement("td");
    rankTd.textContent = Number.isFinite(token.rank) ? String(token.rank) : "-";

    const tokenTd = document.createElement("td");
    tokenTd.className = "token-cell";
    const symbol = document.createElement("span");
    symbol.className = "token-symbol";
    symbol.textContent = token.symbol || "N/A";
    const name = document.createElement("span");
    name.className = "token-name";
    name.textContent = `${token.name || "Unknown"} · ${shortMint(token.mint)}`;
    tokenTd.appendChild(symbol);
    tokenTd.appendChild(name);

    const priceTd = document.createElement("td");
    priceTd.textContent = formatPrice(Number(token.priceUsd));

    const changeTd = document.createElement("td");
    const change = Number(token.change24hPct);
    changeTd.textContent = formatPercent(change);
    if (Number.isFinite(change)) {
      changeTd.className = change >= 0 ? "change-positive" : "change-negative";
    }

    const marketCapTd = document.createElement("td");
    marketCapTd.textContent = formatUsd(Number(token.marketCapUsd));

    const actionTd = document.createElement("td");
    actionTd.className = "action-cell";

    const riskBadgeWrap = document.createElement("div");
    riskBadgeWrap.className = "risk-cell";
    riskBadgeWrap.appendChild(createRiskBadge(null));

    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className = "table-analyze-btn";
    actionButton.textContent = "Analyze";
    actionButton.addEventListener("click", () => {
      mintInput.value = token.mint;
      analyzeMint(token.mint);
    });

    actionTd.appendChild(riskBadgeWrap);
    actionTd.appendChild(actionButton);

    tr.appendChild(rankTd);
    tr.appendChild(tokenTd);
    tr.appendChild(priceTd);
    tr.appendChild(changeTd);
    tr.appendChild(marketCapTd);
    tr.appendChild(actionTd);

    topTokensBody.appendChild(tr);
    scoreTargets.push({ mint: token.mint, target: riskBadgeWrap, nonce });
  }

  return scoreTargets;
}

async function hydrateTopTokenScores(scoreTargets, nonce) {
  const subset = scoreTargets.slice(0, 12);
  await Promise.all(
    subset.map(async ({ mint, target }) => {
      try {
        const scoreData = await requestJson(`/v1/score/${encodeURIComponent(mint)}`, 15000);
        if (nonce !== topTokensLoadNonce) {
          return;
        }
        target.innerHTML = "";
        target.appendChild(createRiskBadge(scoreData));
      } catch {
        if (nonce !== topTokensLoadNonce) {
          return;
        }
        target.innerHTML = "";
        const fallbackBadge = document.createElement("span");
        fallbackBadge.className = "risk-badge pending";
        fallbackBadge.textContent = "n/a";
        target.appendChild(fallbackBadge);
      }
    })
  );
}

async function fetchTopTokens() {
  const nonce = ++topTokensLoadNonce;
  refreshTopTokensButton.disabled = true;
  topTokensStatus.classList.remove("error-text");
  topTokensStatus.textContent = "Loading top tokens...";

  try {
    const payload = await requestJson(`/v1/top-tokens?limit=20`, TOP_TOKENS_TIMEOUT_MS);
    if (nonce !== topTokensLoadNonce) {
      return;
    }

    const scoreTargets = renderTopTokens(payload.tokens || [], nonce);
    const source = payload?.source ? `Source: ${payload.source}` : "";
    const warningText = Array.isArray(payload?.warnings) && payload.warnings.length > 0 ? " (fallback mode)" : "";
    topTokensStatus.textContent = `${source}${warningText}`.trim() || "Top tokens loaded.";

    await hydrateTopTokenScores(scoreTargets, nonce);
  } catch (error) {
    if (nonce !== topTokensLoadNonce) {
      return;
    }
    topTokensBody.innerHTML = "";
    topTokensStatus.classList.add("error-text");
    topTokensStatus.textContent = `Could not load top tokens. ${error?.message || "Try refresh."}`;
  } finally {
    if (nonce === topTokensLoadNonce) {
      refreshTopTokensButton.disabled = false;
    }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const mint = (mintInput.value || "").trim();
  if (!mint) {
    showError("Paste a valid mint address before starting analysis.");
    return;
  }
  await analyzeMint(mint);
});

refreshTopTokensButton.addEventListener("click", () => {
  fetchTopTokens();
});

showEmptyState();
fetchTopTokens();
