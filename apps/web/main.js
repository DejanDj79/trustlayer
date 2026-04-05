const API_BASE = "http://127.0.0.1:8787";

const form = document.getElementById("score-form");
const mintInput = document.getElementById("mint");
const resultSection = document.getElementById("result");
const statusLine = document.getElementById("status-line");
const sourceLine = document.getElementById("source-line");
const confidenceLine = document.getElementById("confidence-line");
const holderLine = document.getElementById("holder-line");
const rpcHealthCard = document.getElementById("rpc-health-card");
const rpcHealthList = document.getElementById("rpc-health-list");
const reasonsList = document.getElementById("reasons");
const warningsList = document.getElementById("warnings");
const errorEl = document.getElementById("error");
const submitButton = form.querySelector('button[type="submit"]');
const REQUEST_TIMEOUT_MS = 30000;

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function hideError() {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Checking..." : "Check Score";
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

  for (const checkDef of checks) {
    const check = rpcHealth?.[checkDef.key];
    if (!check || typeof check !== "object") {
      continue;
    }
    hasRows = true;
    const status = String(check.status || "unknown").toUpperCase();
    const note = check.note ? ` | ${check.note}` : "";
    const pages =
      Number.isFinite(check?.pagesFetched) && check.pagesFetched > 0
        ? ` | pages: ${check.pagesFetched}`
        : "";
    const providers = formatRpcProviders(check.providers);
    const providersText = providers ? ` | ${providers}` : "";

    const li = document.createElement("li");
    li.className = `rpc-status-${String(check.status || "unknown").toLowerCase()}`;
    li.textContent = `${checkDef.label}: ${status}${pages}${note}${providersText}`;
    rpcHealthList.appendChild(li);
  }

  if (hasRows) {
    rpcHealthCard.classList.remove("hidden");
  }
}

function showResult(data) {
  statusLine.textContent = `Score: ${data.score} (${data.status.toUpperCase()})`;
  statusLine.className = `status ${data.status}`;
  sourceLine.textContent = `Data source: ${data.dataSource || "unknown"}`;
  confidenceLine.textContent = `Confidence: ${(data.scoreConfidence || "unknown").toUpperCase()}`;

  const holderSource = data?.signalDetails?.holderConcentrationSource;
  const holderCoveragePct = data?.signalDetails?.holderSampleCoveragePct;
  const holderPagesFetched = data?.signalDetails?.holderPagesFetched;
  if (holderSource) {
    const holderParts = [`Holder source: ${formatHolderSource(holderSource)}`];
    if (Number.isFinite(holderCoveragePct)) {
      holderParts.push(`coverage ${holderCoveragePct.toFixed(1)}%`);
    }
    if (Number.isFinite(holderPagesFetched)) {
      holderParts.push(`${holderPagesFetched} page(s)`);
    }
    holderLine.textContent = holderParts.join(" | ");
    holderLine.classList.remove("hidden");
  } else {
    holderLine.textContent = "";
    holderLine.classList.add("hidden");
  }
  renderRpcHealth(data?.rpcHealth);

  reasonsList.innerHTML = "";
  warningsList.innerHTML = "";
  warningsList.classList.add("hidden");

  for (const reason of data.reasons) {
    const li = document.createElement("li");
    li.textContent = reason;
    reasonsList.appendChild(li);
  }

  if (Array.isArray(data.warnings) && data.warnings.length > 0) {
    for (const warning of data.warnings) {
      const li = document.createElement("li");
      li.textContent = warning;
      warningsList.appendChild(li);
    }
    warningsList.classList.remove("hidden");
  }

  resultSection.classList.remove("hidden");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideError();
  resultSection.classList.add("hidden");
  setLoading(true);

  const mint = (mintInput.value || "").trim();
  if (!mint) {
    showError("Please enter a mint address.");
    setLoading(false);
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}/v1/score/${encodeURIComponent(mint)}`, {
        signal: controller.signal
      });
      const data = await response.json();

      if (!response.ok) {
        showError(data.error || "Request failed");
        return;
      }

      showResult(data);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      showError("Request timed out. RPC providers are likely slow/rate-limited.");
      return;
    }
    showError("Could not reach API. Is API running on 127.0.0.1:8787?");
  } finally {
    setLoading(false);
  }
});
