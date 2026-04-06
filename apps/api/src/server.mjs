import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const BASE58_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEFAULT_SOLANA_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana"
];
const RPC_URL_ENV =
  process.env.SOLANA_RPC_URLS ||
  process.env.SOLANA_RPC_URL ||
  DEFAULT_SOLANA_RPC_URLS.join(",");
const SOLANA_RPC_URLS = RPC_URL_ENV.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 6000);
const RPC_MAX_RETRIES_PER_URL = Number(process.env.RPC_MAX_RETRIES_PER_URL || 1);
const RPC_RETRY_BASE_MS = Number(process.env.RPC_RETRY_BASE_MS || 250);
const RPC_CALL_BUDGET_MS = Number(process.env.RPC_CALL_BUDGET_MS || 9000);
const RPC_HOLDER_TIMEOUT_MS = Number(process.env.RPC_HOLDER_TIMEOUT_MS || 12000);
const RPC_HOLDER_MAX_RETRIES_PER_URL = Number(process.env.RPC_HOLDER_MAX_RETRIES_PER_URL || 0);
const RPC_HOLDER_BUDGET_MS = Number(process.env.RPC_HOLDER_BUDGET_MS || 20000);
const SCORE_CACHE_TTL_MS = Number(process.env.SCORE_CACHE_TTL_MS || 45000);
const SCORE_CACHE_MAX_ENTRIES = Number(process.env.SCORE_CACHE_MAX_ENTRIES || 200);
const SCORE_CACHE_ENABLED = SCORE_CACHE_TTL_MS > 0 && SCORE_CACHE_MAX_ENTRIES > 0;
const HOLDER_TOKEN_ACCOUNTS_FALLBACK_LIMIT = Number(
  process.env.HOLDER_TOKEN_ACCOUNTS_FALLBACK_LIMIT || 1000
);
const HOLDER_TOKEN_ACCOUNTS_TIMEOUT_MS = Number(
  process.env.HOLDER_TOKEN_ACCOUNTS_TIMEOUT_MS || 10000
);
const HOLDER_TOKEN_ACCOUNTS_BUDGET_MS = Number(
  process.env.HOLDER_TOKEN_ACCOUNTS_BUDGET_MS || 15000
);
const HOLDER_TOKEN_ACCOUNTS_MAX_PAGES = Number(
  process.env.HOLDER_TOKEN_ACCOUNTS_MAX_PAGES || 4
);
const HOLDER_HEURISTIC_PENALTY = Number(process.env.HOLDER_HEURISTIC_PENALTY || 15);
const HOLDER_HEURISTIC_MAX_SCORE = Number(process.env.HOLDER_HEURISTIC_MAX_SCORE || 69);
const HOLDER_HIGH_CONCENTRATION_PCT = Number(process.env.HOLDER_HIGH_CONCENTRATION_PCT || 70);
const HOLDER_CRITICAL_CONCENTRATION_PCT = Number(
  process.env.HOLDER_CRITICAL_CONCENTRATION_PCT || 85
);
const HOLDER_HIGH_CONCENTRATION_SCORE_CAP = Number(
  process.env.HOLDER_HIGH_CONCENTRATION_SCORE_CAP || 65
);
const HOLDER_CRITICAL_CONCENTRATION_SCORE_CAP = Number(
  process.env.HOLDER_CRITICAL_CONCENTRATION_SCORE_CAP || 55
);
const DEXSCREENER_API_BASE =
  process.env.DEXSCREENER_API_BASE || "https://api.dexscreener.com/latest/dex/tokens";
const MARKET_TIMEOUT_MS = Number(process.env.MARKET_TIMEOUT_MS || 5000);
const scoreCache = new Map();
const scoreBuildInFlight = new Map();

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body).toString(),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function validateMint(mint) {
  return BASE58_MINT_RE.test(mint);
}

function stableHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function scoreToStatus(score) {
  if (score >= 70) {
    return "green";
  }
  if (score >= 40) {
    return "yellow";
  }
  return "red";
}

function statusFromScoreAndConfidence(score, scoreConfidence) {
  if (score >= 70 && scoreConfidence !== "high") {
    return "yellow";
  }
  return scoreToStatus(score);
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeByThreshold(value, low, high) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= low) {
    return 0;
  }
  if (value >= high) {
    return 1;
  }
  return (value - low) / (high - low);
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

function sanitizeRpcEndpoint(endpoint) {
  try {
    const parsed = new URL(endpoint);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 0) {
      return parsed.host;
    }
    if (parts.length === 1) {
      return `${parsed.host}/${parts[0]}`;
    }
    return `${parsed.host}/${parts[0]}/*`;
  } catch {
    return "rpc-endpoint";
  }
}

function getCacheEntry(mint) {
  if (!SCORE_CACHE_ENABLED) {
    return null;
  }
  const entry = scoreCache.get(mint);
  if (!entry) {
    return null;
  }
  const ageMs = Date.now() - entry.cachedAt;
  if (ageMs >= SCORE_CACHE_TTL_MS) {
    scoreCache.delete(mint);
    return null;
  }
  return { entry, ageMs };
}

function setCacheEntry(mint, assessment) {
  if (!SCORE_CACHE_ENABLED) {
    return;
  }

  scoreCache.set(mint, {
    assessment,
    cachedAt: Date.now()
  });

  if (scoreCache.size <= SCORE_CACHE_MAX_ENTRIES) {
    return;
  }

  for (const key of scoreCache.keys()) {
    scoreCache.delete(key);
    if (scoreCache.size <= SCORE_CACHE_MAX_ENTRIES) {
      break;
    }
  }
}

function withCacheMeta(assessment, cacheMeta) {
  return {
    ...assessment,
    cache: cacheMeta
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableRpcError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("429") ||
    message.includes("503") ||
    message.includes("rate") ||
    message.includes("too many requests") ||
    message.includes("aborted") ||
    message.includes("timeout")
  );
}

function bigIntRatio(numerator, denominator, decimals = 4) {
  if (denominator <= 0n) {
    return 0;
  }
  const scale = 10n ** BigInt(decimals);
  const scaled = (numerator * scale) / denominator;
  return Number(scaled) / Number(scale);
}

function parseBigIntAmount(value) {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      return 0n;
    }
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    if (value.trim() === "") {
      return 0n;
    }
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function parseRpcFailuresFromMessage(message) {
  const parts = String(message || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  const failures = [];

  for (const part of parts) {
    const match = part.match(/^([^#|]+)#(\d+):\s*(.+)$/);
    if (!match) {
      continue;
    }
    failures.push({
      endpoint: match[1].trim(),
      attempt: Number(match[2]),
      message: match[3].trim()
    });
  }

  return failures;
}

function extractRpcFailures(error) {
  if (Array.isArray(error?.rpcFailures) && error.rpcFailures.length > 0) {
    return error.rpcFailures
      .map((item) => ({
        endpoint: String(item?.endpoint || "").trim(),
        attempt: Number(item?.attempt || 0),
        message: String(item?.message || "").trim()
      }))
      .filter((item) => item.endpoint && item.message);
  }
  return parseRpcFailuresFromMessage(error?.message);
}

function readMintSupplyRaw(mintInfo) {
  const candidates = [
    mintInfo?.supply,
    mintInfo?.supply?.amount,
    mintInfo?.tokenAmount?.amount,
    mintInfo?.token_amount?.amount
  ];
  for (const candidate of candidates) {
    const parsed = parseBigIntAmount(candidate);
    if (parsed > 0n) {
      return parsed;
    }
  }
  return 0n;
}

function readMintDecimals(mintInfo) {
  const candidates = [
    mintInfo?.decimals,
    mintInfo?.tokenAmount?.decimals,
    mintInfo?.token_amount?.decimals
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

function extractTokenAccountsFromResult(result) {
  if (Array.isArray(result?.token_accounts)) {
    return result.token_accounts;
  }
  if (Array.isArray(result?.tokenAccounts)) {
    return result.tokenAccounts;
  }
  if (Array.isArray(result?.value)) {
    return result.value;
  }
  if (Array.isArray(result)) {
    return result;
  }
  return [];
}

function extractTokenAccountsTotal(result) {
  const rawTotal =
    result?.total ?? result?.totalCount ?? result?.pagination?.total ?? result?.meta?.total ?? null;
  if (rawTotal === null || rawTotal === undefined || rawTotal === "") {
    return null;
  }
  const parsed = Number(rawTotal);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function readTokenAccountOwner(item) {
  return item?.owner || item?.account?.data?.parsed?.info?.owner || item?.account?.owner || null;
}

function readTokenAccountAmount(item) {
  const directRaw = parseBigIntAmount(item?.amount);
  if (directRaw > 0n) {
    return directRaw;
  }

  const camelRaw = parseBigIntAmount(item?.tokenAmount?.amount);
  if (camelRaw > 0n) {
    return camelRaw;
  }

  const snakeRaw = parseBigIntAmount(item?.token_amount?.amount);
  if (snakeRaw > 0n) {
    return snakeRaw;
  }

  return parseBigIntAmount(item?.account?.data?.parsed?.info?.tokenAmount?.amount);
}

function estimateTop10FromTokenAccounts(results, supplyRaw) {
  const pageResults = Array.isArray(results) ? results : [results];
  const amountByOwner = new Map();
  const seenAccounts = new Set();
  let sampledAccounts = 0;
  let totalAccounts = 0;
  let totalKnown = false;

  for (const pageResult of pageResults) {
    const tokenAccounts = extractTokenAccountsFromResult(pageResult);
    const pageTotal = extractTokenAccountsTotal(pageResult);
    if (Number.isFinite(pageTotal) && pageTotal > 0) {
      totalKnown = true;
      totalAccounts = Math.max(totalAccounts, pageTotal);
    }

    for (const item of tokenAccounts) {
      const accountId = item?.address || item?.pubkey || null;
      if (accountId) {
        if (seenAccounts.has(accountId)) {
          continue;
        }
        seenAccounts.add(accountId);
      }

      const owner = readTokenAccountOwner(item);
      if (!owner) {
        continue;
      }

      const rawAmount = readTokenAccountAmount(item);
      if (rawAmount <= 0n) {
        continue;
      }

      sampledAccounts += 1;
      const previous = amountByOwner.get(owner) || 0n;
      amountByOwner.set(owner, previous + rawAmount);
    }
  }

  if (amountByOwner.size === 0) {
    return null;
  }

  const sortedAmounts = Array.from(amountByOwner.values()).sort((a, b) => {
    if (a === b) {
      return 0;
    }
    return a > b ? -1 : 1;
  });
  const top10Raw = sortedAmounts.slice(0, 10).reduce((sum, value) => sum + value, 0n);
  const totalSampleRaw = sortedAmounts.reduce((sum, value) => sum + value, 0n);

  let denominatorRaw = supplyRaw;
  let concentrationMode = "supply";
  if (denominatorRaw <= 0n) {
    denominatorRaw = totalSampleRaw;
    concentrationMode = "sample-total";
  }
  if (denominatorRaw <= 0n) {
    return null;
  }

  if (totalKnown && totalAccounts > 0 && sampledAccounts > totalAccounts) {
    // Some providers return per-page "total"; if sampled exceeds it, treat total as unreliable.
    totalKnown = false;
  }

  const concentration = clamp(bigIntRatio(top10Raw, denominatorRaw), 0, 1);
  const isExact = totalKnown && totalAccounts > 0 ? sampledAccounts >= totalAccounts : false;
  const normalizedTotalAccounts = totalKnown && totalAccounts > 0 ? totalAccounts : null;
  const sampledCoverage =
    Number.isFinite(normalizedTotalAccounts) && normalizedTotalAccounts > 0
      ? sampledAccounts / normalizedTotalAccounts
      : null;

  return {
    concentration,
    sampledAccounts,
    totalAccounts: normalizedTotalAccounts,
    sampledCoverage,
    isExact,
    concentrationMode,
    totalKnown
  };
}

async function fetchHolderConcentrationFromTokenAccounts(mint, supplyRaw) {
  const results = [];
  const warnings = [];
  const failures = [];
  let sampledAcrossPages = 0;
  let knownTotalAccounts = null;
  const startedAt = Date.now();

  for (let page = 1; page <= HOLDER_TOKEN_ACCOUNTS_MAX_PAGES; page += 1) {
    const elapsed = Date.now() - startedAt;
    const remainingBudget = HOLDER_TOKEN_ACCOUNTS_BUDGET_MS - elapsed;
    if (remainingBudget <= 0) {
      warnings.push(
        `Token accounts pagination stopped after ${results.length} page(s): budget exceeded (${HOLDER_TOKEN_ACCOUNTS_BUDGET_MS}ms).`
      );
      break;
    }

    let pageResult;
    try {
      pageResult = await rpcCallAnyUrl(
        "getTokenAccounts",
        {
          page,
          limit: HOLDER_TOKEN_ACCOUNTS_FALLBACK_LIMIT,
          displayOptions: {},
          mint
        },
        {
          timeoutMs: Math.max(500, Math.min(HOLDER_TOKEN_ACCOUNTS_TIMEOUT_MS, remainingBudget)),
          maxRetriesPerUrl: 0,
          callBudgetMs: remainingBudget
        }
      );
    } catch (error) {
      const parsedFailures = extractRpcFailures(error);
      if (parsedFailures.length > 0) {
        failures.push(...parsedFailures);
      }
      if (results.length === 0) {
        const firstPageError = new Error(error.message);
        firstPageError.rpcFailures = parsedFailures;
        throw firstPageError;
      }
      warnings.push(
        `Token accounts pagination stopped after ${results.length} page(s): ${error.message}`
      );
      break;
    }

    const tokenAccounts = extractTokenAccountsFromResult(pageResult);
    const pageTotal = extractTokenAccountsTotal(pageResult);
    if (tokenAccounts.length === 0) {
      break;
    }

    results.push(pageResult);
    sampledAcrossPages += tokenAccounts.length;
    if (Number.isFinite(pageTotal) && pageTotal > 0) {
      knownTotalAccounts = pageTotal;
    }

    if (tokenAccounts.length < HOLDER_TOKEN_ACCOUNTS_FALLBACK_LIMIT) {
      break;
    }
  }

  if (
    results.length >= HOLDER_TOKEN_ACCOUNTS_MAX_PAGES &&
    (!Number.isFinite(knownTotalAccounts) || sampledAcrossPages < knownTotalAccounts)
  ) {
    warnings.push(
      `Token accounts pagination reached max pages (${HOLDER_TOKEN_ACCOUNTS_MAX_PAGES}).`
    );
  }

  const estimate = estimateTop10FromTokenAccounts(results, supplyRaw);
  if (!estimate) {
    return { estimate: null, warnings, failures, pagesFetched: results.length };
  }

  return {
    estimate: {
      ...estimate,
      pagesFetched: results.length
    },
    warnings,
    failures,
    pagesFetched: results.length
  };
}

function computeAuthorityRisk(mintAuthority, freezeAuthority) {
  // Mint authority is a stronger risk signal than freeze authority.
  let risk = 0;
  if (mintAuthority) {
    risk += 0.7;
  }
  if (freezeAuthority) {
    risk += 0.3;
  }
  return clamp(risk);
}

function computeScoreBreakdown(signals) {
  const holderSafety = (1 - signals.holderConcentration) * 35;
  const liquidityScore = signals.liquidityConfidence * 20;
  const authoritySafety = (1 - signals.authorityRisk) * 25;
  const metadataScore = signals.metadataConfidence * 10;
  const activityScore = signals.activityConfidence * 10;

  const score = Math.round(
    holderSafety + liquidityScore + authoritySafety + metadataScore + activityScore
  );

  return {
    score,
    parts: {
      holderSafety,
      liquidityScore,
      authoritySafety,
      metadataScore,
      activityScore
    }
  };
}

function applyHolderConcentrationGuardrails(score, holderConcentration) {
  const normalizedConcentration = clamp(holderConcentration, 0, 1);
  const concentrationPct = normalizedConcentration * 100;
  const highThreshold = clamp(HOLDER_HIGH_CONCENTRATION_PCT / 100, 0, 1);
  const criticalThreshold = clamp(HOLDER_CRITICAL_CONCENTRATION_PCT / 100, 0, 1);
  const highCap = Math.round(clamp(HOLDER_HIGH_CONCENTRATION_SCORE_CAP / 100, 0, 1) * 100);
  const criticalCap = Math.round(clamp(HOLDER_CRITICAL_CONCENTRATION_SCORE_CAP / 100, 0, 1) * 100);

  if (normalizedConcentration >= criticalThreshold && score > criticalCap) {
    return {
      score: criticalCap,
      applied: true,
      tier: "critical",
      cap: criticalCap,
      warning: `Score capped at ${criticalCap} because top holder concentration is ${concentrationPct.toFixed(
        1
      )}% (critical concentration guardrail).`
    };
  }

  if (normalizedConcentration >= highThreshold && score > highCap) {
    return {
      score: highCap,
      applied: true,
      tier: "high",
      cap: highCap,
      warning: `Score capped at ${highCap} because top holder concentration is ${concentrationPct.toFixed(
        1
      )}% (high concentration guardrail).`
    };
  }

  return {
    score,
    applied: false,
    tier: null,
    cap: null,
    warning: null
  };
}

function buildReasons(signals, rpcSignals, marketSignals) {
  const authorityState = [];
  let holderLabel = "Top holders concentration (heuristic)";
  if (rpcSignals.holderSource === "rpc") {
    holderLabel = "Top 10 holders concentration";
  } else if (rpcSignals.holderSource === "rpc-token-accounts-exact") {
    holderLabel = "Top 10 holders concentration (from token accounts)";
  } else if (rpcSignals.holderSource === "rpc-token-accounts-estimate") {
    holderLabel = "Top 10 holders concentration (estimated from token accounts)";
  }
  if (rpcSignals.authorityKnown === false) {
    authorityState.push("authority state unavailable (fallback mode)");
  } else {
    authorityState.push(rpcSignals.mintAuthority ? "mint authority enabled" : "mint authority removed");
    authorityState.push(
      rpcSignals.freezeAuthority ? "freeze authority enabled" : "freeze authority removed"
    );
  }

  const reasons = [
    `${holderLabel}: ${(signals.holderConcentration * 100).toFixed(1)}%`,
    `Authority controls: ${authorityState.join(", ")}`
  ];

  if (marketSignals?.isRealData) {
    reasons.push(
      `Liquidity estimate: ${formatUsd(marketSignals.totalLiquidityUsd)} across ${marketSignals.pairCount} pools`
    );
    reasons.push(
      `24h activity: ${formatUsd(marketSignals.totalVolume24h)} volume, ${marketSignals.totalTx24h} tx`
    );
  } else {
    reasons.push(`Liquidity confidence: ${(signals.liquidityConfidence * 100).toFixed(1)}% (heuristic)`);
    reasons.push(`Activity confidence: ${(signals.activityConfidence * 100).toFixed(1)}% (heuristic)`);
  }

  reasons.push(`Metadata confidence: ${(signals.metadataConfidence * 100).toFixed(1)}%`);
  return reasons;
}

function buildFallbackRiskAssessment(mint, warning) {
  const hash = stableHash(mint);
  const holderConcentration = clamp((hash % 100) / 100);
  const liquidityLevel = clamp(((hash >>> 3) % 100) / 100);
  const authorityRisk = clamp(((hash >>> 7) % 100) / 100);
  const metadataConfidence = clamp(((hash >>> 11) % 100) / 100);
  const activityLevel = clamp(((hash >>> 15) % 100) / 100);

  const score =
    Math.round(
      (1 - holderConcentration) * 30 +
        liquidityLevel * 20 +
        (1 - authorityRisk) * 20 +
        metadataConfidence * 15 +
        activityLevel * 15
    ) || 0;

  const reasons = buildReasons(
    {
      holderConcentration,
      liquidityConfidence: liquidityLevel,
      authorityRisk,
      metadataConfidence,
      activityConfidence: activityLevel
    },
    {
      authorityKnown: false,
      mintAuthority: null,
      freezeAuthority: null
    },
    {
      isRealData: false
    }
  );

  return {
    mint,
    score,
    status: statusFromScoreAndConfidence(score, "low"),
    scoreConfidence: "low",
    reasons,
    dataSource: "fallback",
    signalDetails: {
      mintAuthorityEnabled: null,
      freezeAuthorityEnabled: null,
      holderConcentrationPct: Number((holderConcentration * 100).toFixed(2)),
      holderConcentrationSource: "heuristic",
      holderSampledAccounts: null,
      holderTotalAccounts: null,
      holderSampleCoveragePct: null,
      holderPagesFetched: null,
      marketPairCount: null,
      liquidityUsd: null,
      volume24hUsd: null,
      tx24h: null,
      scoreConfidence: "low",
      scoreGuardrailApplied: false,
      scoreGuardrailTier: null,
      scoreGuardrailCap: null
    },
    rpcHealth: {
      tokenSupply: {
        status: "unknown",
        providers: [],
        note: "Fallback mode: Solana RPC unavailable."
      },
      largestHolders: {
        status: "unknown",
        providers: [],
        note: "Fallback mode: Solana RPC unavailable."
      },
      tokenAccountsFallback: {
        status: "unknown",
        providers: [],
        note: "Fallback mode: Solana RPC unavailable.",
        pagesFetched: 0
      }
    },
    warnings: [warning],
    generatedAt: new Date().toISOString()
  };
}

async function rpcCall(method, params) {
  return rpcCallWithOptions(method, params, {});
}

async function rpcCallOnUrl(rpcUrl, method, params, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`RPC HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(`RPC ${method}: ${payload.error.message}`);
    }

    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function rpcCallAnyUrl(method, params, options) {
  if (SOLANA_RPC_URLS.length === 0) {
    throw new Error("No SOLANA RPC URLs configured");
  }

  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : RPC_TIMEOUT_MS;
  const callBudgetMs =
    Number.isFinite(options?.callBudgetMs) && options.callBudgetMs > 0
      ? options.callBudgetMs
      : RPC_CALL_BUDGET_MS;
  const maxRetriesPerUrl =
    Number.isFinite(options?.maxRetriesPerUrl) && options.maxRetriesPerUrl >= 0
      ? options.maxRetriesPerUrl
      : RPC_HOLDER_MAX_RETRIES_PER_URL;
  const perUrlTimeoutMs = Math.max(500, Math.min(timeoutMs, callBudgetMs));
  const failures = [];
  const detailedFailures = [];

  const startedAt = Date.now();
  const maxPasses = maxRetriesPerUrl + 1;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (Date.now() - startedAt >= callBudgetMs) {
      failures.push(`budget exceeded (${callBudgetMs}ms)`);
      break;
    }

    const attempts = SOLANA_RPC_URLS.map((rpcUrl) =>
      rpcCallOnUrl(rpcUrl, method, params, perUrlTimeoutMs).catch((error) => {
        const failure = {
          endpoint: sanitizeRpcEndpoint(rpcUrl),
          attempt: pass + 1,
          message: error.message
        };
        const wrapped = new Error(`${failure.endpoint}#${failure.attempt}: ${failure.message}`);
        wrapped.rpcFailure = failure;
        throw wrapped;
      })
    );

    try {
      return await Promise.any(attempts);
    } catch (error) {
      const reasons = Array.isArray(error?.errors)
        ? error.errors
            .map((item) => {
              if (item?.rpcFailure) {
                detailedFailures.push(item.rpcFailure);
              }
              return item.message;
            })
            .filter(Boolean)
        : [];
      failures.push(...reasons);
      if (pass < maxPasses - 1) {
        await sleep(RPC_RETRY_BASE_MS * (pass + 1));
      }
    }
  }

  const aggregateError = new Error(
    `RPC ${method} failed across ${SOLANA_RPC_URLS.length} endpoint(s): ${failures.join(" | ")}`
  );
  aggregateError.rpcFailures = detailedFailures;
  throw aggregateError;
}

async function rpcCallWithOptions(method, params, options) {
  if (SOLANA_RPC_URLS.length === 0) {
    throw new Error("No SOLANA RPC URLs configured");
  }

  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : RPC_TIMEOUT_MS;
  const maxRetriesPerUrl =
    Number.isFinite(options?.maxRetriesPerUrl) && options.maxRetriesPerUrl >= 0
      ? options.maxRetriesPerUrl
      : RPC_MAX_RETRIES_PER_URL;
  const callBudgetMs =
    Number.isFinite(options?.callBudgetMs) && options.callBudgetMs > 0
      ? options.callBudgetMs
      : RPC_CALL_BUDGET_MS;

  const failures = [];
  const startedAt = Date.now();
  const nonRetryableUrls = new Set();
  const maxPasses = maxRetriesPerUrl + 1;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    for (const rpcUrl of SOLANA_RPC_URLS) {
      if (nonRetryableUrls.has(rpcUrl)) {
        continue;
      }

      if (Date.now() - startedAt >= callBudgetMs) {
        failures.push(`budget exceeded (${callBudgetMs}ms)`);
        throw new Error(
          `RPC ${method} failed across ${SOLANA_RPC_URLS.length} endpoint(s): ${failures.join(" | ")}`
        );
      }

      try {
        return await rpcCallOnUrl(rpcUrl, method, params, timeoutMs);
      } catch (error) {
        failures.push(`${sanitizeRpcEndpoint(rpcUrl)}#${pass + 1}: ${error.message}`);
        const retryable = isRetryableRpcError(error);
        const hasMorePasses = pass < maxPasses - 1;
        if (!retryable) {
          nonRetryableUrls.add(rpcUrl);
          continue;
        }
        if (hasMorePasses) {
          await sleep(RPC_RETRY_BASE_MS * (pass + 1));
        }
      }
    }
  }

  throw new Error(
    `RPC ${method} failed across ${SOLANA_RPC_URLS.length} endpoint(s): ${failures.join(" | ")}`
  );
}

async function fetchDexScreenerSignals(mint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MARKET_TIMEOUT_MS);
  try {
    const response = await fetch(`${DEXSCREENER_API_BASE}/${mint}`, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`DexScreener HTTP ${response.status}`);
    }

    const payload = await response.json();
    const allPairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
    const solanaPairs = allPairs.filter((pair) => pair?.chainId === "solana");
    if (solanaPairs.length === 0) {
      throw new Error("No Solana market pairs found");
    }

    const totalLiquidityUsd = solanaPairs.reduce(
      (sum, pair) => sum + Number(pair?.liquidity?.usd || 0),
      0
    );
    const totalVolume24h = solanaPairs.reduce((sum, pair) => sum + Number(pair?.volume?.h24 || 0), 0);
    const totalTx24h = solanaPairs.reduce((sum, pair) => {
      const buys = Number(pair?.txns?.h24?.buys || 0);
      const sells = Number(pair?.txns?.h24?.sells || 0);
      return sum + buys + sells;
    }, 0);

    const liquidityConfidence = clamp(normalizeByThreshold(totalLiquidityUsd, 10_000, 2_000_000));
    const volumeScore = normalizeByThreshold(totalVolume24h, 25_000, 1_000_000);
    const txScore = normalizeByThreshold(totalTx24h, 20, 2_000);
    const activityConfidence = clamp(volumeScore * 0.7 + txScore * 0.3);

    return {
      source: "dexscreener",
      isRealData: true,
      pairCount: solanaPairs.length,
      totalLiquidityUsd,
      totalVolume24h,
      totalTx24h,
      liquidityConfidence,
      activityConfidence
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchMintSignals(mint) {
  const mintResult = await rpcCall("getAccountInfo", [
    mint,
    { encoding: "jsonParsed", commitment: "confirmed" }
  ]);
  const mintInfo = mintResult?.value?.data?.parsed?.info;
  if (!mintInfo) {
    throw new Error("Mint not found");
  }

  const mintAuthority = mintInfo.mintAuthority || null;
  const freezeAuthority = mintInfo.freezeAuthority || null;
  let supplyRaw = readMintSupplyRaw(mintInfo);
  const decimals = readMintDecimals(mintInfo);

  let holderConcentration = clamp(((stableHash(mint) >>> 23) % 100) / 100);
  let holderSource = "heuristic";
  let holderSampledAccounts = null;
  let holderTotalAccounts = null;
  let holderSampledCoverage = null;
  let holderPagesFetched = null;
  const warnings = [];
  const rpcHealth = {
    tokenSupply: {
      status: "not-needed",
      providers: [],
      note: "Mint account already includes supply."
    },
    largestHolders: {
      status: "pending",
      providers: [],
      note: null
    },
    tokenAccountsFallback: {
      status: "not-used",
      providers: [],
      note: null,
      pagesFetched: 0
    }
  };

  if (supplyRaw <= 0n) {
    rpcHealth.tokenSupply.status = "attempted";
    rpcHealth.tokenSupply.note = "Mint supply missing in account info, trying getTokenSupply.";
    try {
      const supplyResult = await rpcCallAnyUrl(
        "getTokenSupply",
        [mint],
        {
          timeoutMs: RPC_TIMEOUT_MS,
          maxRetriesPerUrl: 0,
          callBudgetMs: RPC_CALL_BUDGET_MS
        }
      );
      const supplied = parseBigIntAmount(supplyResult?.value?.amount || supplyResult?.amount);
      if (supplied > 0n) {
        supplyRaw = supplied;
        rpcHealth.tokenSupply.status = "ok";
        rpcHealth.tokenSupply.note = "Mint supply resolved via getTokenSupply.";
      } else {
        rpcHealth.tokenSupply.status = "degraded";
        rpcHealth.tokenSupply.note = "getTokenSupply responded but without usable amount.";
      }
    } catch (error) {
      rpcHealth.tokenSupply.status = "failed";
      rpcHealth.tokenSupply.providers = extractRpcFailures(error);
      rpcHealth.tokenSupply.note = "getTokenSupply unavailable.";
      // Continue without hard-failing; holder fallback will transparently mark estimate mode.
    }
  }

  try {
    const largestAccountsResult = await rpcCallAnyUrl(
      "getTokenLargestAccounts",
      [mint],
      {
        timeoutMs: RPC_HOLDER_TIMEOUT_MS,
        maxRetriesPerUrl: RPC_HOLDER_MAX_RETRIES_PER_URL,
        callBudgetMs: RPC_HOLDER_BUDGET_MS
      }
    );
    const largestAccounts = largestAccountsResult?.value || [];
    const top10Raw = largestAccounts
      .slice(0, 10)
      .reduce((sum, account) => sum + BigInt(account.amount || "0"), 0n);

    if (supplyRaw > 0n) {
      holderConcentration = clamp(bigIntRatio(top10Raw, supplyRaw), 0, 1);
      holderSource = "rpc";
      rpcHealth.largestHolders.status = "ok";
      rpcHealth.largestHolders.note = "Top holders fetched via getTokenLargestAccounts.";
    } else {
      warnings.push("Using heuristic holder concentration because supply is zero/unknown.");
      rpcHealth.largestHolders.status = "degraded";
      rpcHealth.largestHolders.note = "Largest holders fetched but supply is unavailable.";
    }
  } catch (error) {
    warnings.push(`Largest holders endpoint unavailable: ${error.message}`);
    rpcHealth.largestHolders.status = "failed";
    rpcHealth.largestHolders.providers = extractRpcFailures(error);
    rpcHealth.largestHolders.note = "getTokenLargestAccounts failed across configured providers.";
    rpcHealth.tokenAccountsFallback.status = "used";
    rpcHealth.tokenAccountsFallback.note = "Using paginated getTokenAccounts fallback.";

    try {
      const fallbackResult = await fetchHolderConcentrationFromTokenAccounts(mint, supplyRaw);
      if (Array.isArray(fallbackResult?.warnings) && fallbackResult.warnings.length > 0) {
        warnings.push(...fallbackResult.warnings);
      }
      if (Array.isArray(fallbackResult?.failures) && fallbackResult.failures.length > 0) {
        rpcHealth.tokenAccountsFallback.providers = fallbackResult.failures;
      }
      rpcHealth.tokenAccountsFallback.pagesFetched = Number(
        fallbackResult?.pagesFetched || 0
      );
      const estimate = fallbackResult?.estimate || null;
      if (estimate) {
        holderConcentration = estimate.concentration;
        holderSampledAccounts = estimate.sampledAccounts;
        holderTotalAccounts = estimate.totalAccounts;
        holderSampledCoverage = estimate.sampledCoverage;
        holderPagesFetched = estimate.pagesFetched;
        rpcHealth.tokenAccountsFallback.pagesFetched = estimate.pagesFetched;
        const isExactFromSupply = estimate.isExact && estimate.concentrationMode === "supply";
        holderSource = isExactFromSupply ? "rpc-token-accounts-exact" : "rpc-token-accounts-estimate";
        if (estimate.concentrationMode === "sample-total") {
          warnings.push(
            `Holder concentration estimated from token accounts balances because mint supply is unavailable (${estimate.sampledAccounts} sampled accounts across ${estimate.pagesFetched} page(s)).`
          );
        } else if (estimate.isExact) {
          warnings.push(
            `Holder concentration derived from token accounts (${estimate.sampledAccounts} accounts across ${estimate.pagesFetched} page(s)).`
          );
        } else if (!estimate.totalKnown) {
          warnings.push(
            `Holder concentration estimated from token accounts sample: ${estimate.sampledAccounts} accounts across ${estimate.pagesFetched} page(s); endpoint did not provide total account count.`
          );
        } else {
          warnings.push(
            `Holder concentration estimated from token accounts sample: ${estimate.sampledAccounts}/${estimate.totalAccounts} accounts across ${estimate.pagesFetched} page(s) (${(
              estimate.sampledCoverage * 100
            ).toFixed(1)}% coverage).`
          );
        }
        rpcHealth.tokenAccountsFallback.status = "ok";
        rpcHealth.tokenAccountsFallback.note =
          "Holder concentration estimated from token accounts fallback.";
      } else {
        warnings.push("Using heuristic holder concentration: token accounts fallback returned no data.");
        rpcHealth.tokenAccountsFallback.status = "failed";
        rpcHealth.tokenAccountsFallback.note = "Token accounts fallback returned no usable data.";
      }
    } catch (fallbackError) {
      warnings.push(`Using heuristic holder concentration: ${fallbackError.message}`);
      rpcHealth.tokenAccountsFallback.status = "failed";
      rpcHealth.tokenAccountsFallback.providers = extractRpcFailures(fallbackError);
      rpcHealth.tokenAccountsFallback.note = "Token accounts fallback failed.";
    }
  }

  const authorityRisk = computeAuthorityRisk(mintAuthority, freezeAuthority);

  return {
    mintAuthority,
    freezeAuthority,
    supplyRaw,
    decimals,
    holderConcentration,
    holderSource,
    holderSampledAccounts,
    holderTotalAccounts,
    holderSampledCoverage,
    holderPagesFetched,
    authorityRisk,
    warnings,
    rpcHealth
  };
}

async function buildRiskAssessment(mint) {
  const hash = stableHash(mint);
  const fallbackLiquidityConfidence = clamp(((hash >>> 3) % 100) / 100);
  const fallbackActivityConfidence = clamp(((hash >>> 15) % 100) / 100);

  try {
    const rpcSignals = await fetchMintSignals(mint);
    const warnings = [];
    if (Array.isArray(rpcSignals.warnings) && rpcSignals.warnings.length > 0) {
      warnings.push(...rpcSignals.warnings);
    }

    let marketSignals = {
      source: "heuristic",
      isRealData: false,
      pairCount: null,
      totalLiquidityUsd: null,
      totalVolume24h: null,
      totalTx24h: null,
      liquidityConfidence: fallbackLiquidityConfidence,
      activityConfidence: fallbackActivityConfidence
    };

    try {
      marketSignals = await fetchDexScreenerSignals(mint);
    } catch (error) {
      warnings.push(`Using heuristic market signals: ${error.message}`);
    }

    const metadataConfidence = rpcSignals.decimals >= 0 && rpcSignals.decimals <= 12 ? 0.8 : 0.5;

    const signals = {
      holderConcentration: rpcSignals.holderConcentration,
      liquidityConfidence: marketSignals.liquidityConfidence,
      authorityRisk: rpcSignals.authorityRisk,
      metadataConfidence,
      activityConfidence: marketSignals.activityConfidence
    };
    let { score } = computeScoreBreakdown(signals);
    let scoreConfidence = "medium";
    let scoreGuardrailApplied = false;
    let scoreGuardrailTier = null;
    let scoreGuardrailCap = null;
    if (rpcSignals.holderSource === "rpc" || rpcSignals.holderSource === "rpc-token-accounts-exact") {
      scoreConfidence = "high";
    } else if (rpcSignals.holderSource === "rpc-token-accounts-estimate") {
      scoreConfidence = "medium";
      if (!Number.isFinite(rpcSignals.holderSampledCoverage)) {
        scoreConfidence = "low";
        warnings.push(
          "Score confidence reduced to low because token accounts sample coverage is unknown."
        );
      } else if (rpcSignals.holderSampledCoverage < 0.15) {
        scoreConfidence = "low";
        warnings.push(
          "Score confidence reduced to low because token accounts sample coverage is below 15%."
        );
      }
    } else {
      score = Math.max(0, score - HOLDER_HEURISTIC_PENALTY);
      warnings.push(
        `Score adjusted -${HOLDER_HEURISTIC_PENALTY} because holder concentration is heuristic.`
      );
      if (score > HOLDER_HEURISTIC_MAX_SCORE) {
        score = HOLDER_HEURISTIC_MAX_SCORE;
        warnings.push(
          `Score capped at ${HOLDER_HEURISTIC_MAX_SCORE} while holder concentration is heuristic.`
        );
      }
      scoreConfidence = "low";
    }

    const guardrail = applyHolderConcentrationGuardrails(score, signals.holderConcentration);
    if (guardrail.applied) {
      score = guardrail.score;
      scoreGuardrailApplied = true;
      scoreGuardrailTier = guardrail.tier;
      scoreGuardrailCap = guardrail.cap;
      warnings.push(guardrail.warning);
    }

    const reasons = buildReasons(signals, rpcSignals, marketSignals);
    const status = statusFromScoreAndConfidence(score, scoreConfidence);
    if (status !== scoreToStatus(score)) {
      warnings.push("Status downgraded to yellow because confidence is not high.");
    }

    return {
      mint,
      score,
      status,
      scoreConfidence,
      reasons,
      dataSource: marketSignals.isRealData ? "solana-rpc+dexscreener" : "solana-rpc+heuristics",
      signalDetails: {
        mintAuthorityEnabled: Boolean(rpcSignals.mintAuthority),
        freezeAuthorityEnabled: Boolean(rpcSignals.freezeAuthority),
        holderConcentrationPct: Number((signals.holderConcentration * 100).toFixed(2)),
        holderConcentrationSource: rpcSignals.holderSource || "unknown",
        holderSampledAccounts: Number.isFinite(rpcSignals.holderSampledAccounts)
          ? rpcSignals.holderSampledAccounts
          : null,
        holderTotalAccounts: Number.isFinite(rpcSignals.holderTotalAccounts)
          ? rpcSignals.holderTotalAccounts
          : null,
        holderSampleCoveragePct: Number.isFinite(rpcSignals.holderSampledCoverage)
          ? Number((rpcSignals.holderSampledCoverage * 100).toFixed(2))
          : null,
        holderPagesFetched: Number.isFinite(rpcSignals.holderPagesFetched)
          ? rpcSignals.holderPagesFetched
          : null,
        scoreConfidence,
        scoreGuardrailApplied,
        scoreGuardrailTier,
        scoreGuardrailCap,
        marketPairCount: marketSignals.pairCount,
        liquidityUsd: marketSignals.totalLiquidityUsd,
        volume24hUsd: marketSignals.totalVolume24h,
        tx24h: marketSignals.totalTx24h
      },
      rpcHealth: rpcSignals.rpcHealth || null,
      warnings,
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    return buildFallbackRiskAssessment(
      mint,
      `Using fallback signals because Solana RPC data failed: ${error.message}`
    );
  }
}

async function buildRiskAssessmentCached(mint) {
  const cached = getCacheEntry(mint);
  if (cached) {
    return withCacheMeta(cached.entry.assessment, {
      hit: true,
      ageMs: cached.ageMs,
      ttlMs: SCORE_CACHE_TTL_MS
    });
  }

  let inFlight = scoreBuildInFlight.get(mint);
  if (!inFlight) {
    inFlight = buildRiskAssessment(mint)
      .then((assessment) => {
        setCacheEntry(mint, assessment);
        return assessment;
      })
      .finally(() => {
        scoreBuildInFlight.delete(mint);
      });
    scoreBuildInFlight.set(mint, inFlight);
  }

  const assessment = await inFlight;
  return withCacheMeta(assessment, {
    hit: false,
    ageMs: 0,
    ttlMs: SCORE_CACHE_TTL_MS
  });
}

const server = http.createServer((req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      service: "trustlayer-api",
      timestamp: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      rpcProviders: SOLANA_RPC_URLS.map((endpoint) => sanitizeRpcEndpoint(endpoint)),
      cache: {
        enabled: SCORE_CACHE_ENABLED,
        ttlMs: SCORE_CACHE_TTL_MS,
        maxEntries: SCORE_CACHE_MAX_ENTRIES,
        entries: scoreCache.size,
        inFlightBuilds: scoreBuildInFlight.size
      }
    });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/v1/score/")) {
    const mint = decodeURIComponent(pathname.replace("/v1/score/", "").trim());
    if (!mint || !validateMint(mint)) {
      sendJson(res, 400, {
        error: "Invalid Solana mint address",
        hint: "Use a base58 address with 32-44 chars"
      });
      return;
    }
    buildRiskAssessmentCached(mint)
      .then((assessment) => {
        sendJson(res, 200, assessment);
      })
      .catch((error) => {
        sendJson(res, 500, {
          error: "Failed to build score",
          details: error.message
        });
      });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`TrustLayer API listening on http://${HOST}:${PORT}`);
});
