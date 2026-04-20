#!/usr/bin/env node

const API_BASE = String(process.env.API_BASE || "http://127.0.0.1:8787").replace(/\/+$/, "");
const TOP_LIMIT = Math.max(5, Number(process.env.TOP_LIMIT || 20));
const SCORE_SAMPLE = Math.max(2, Number(process.env.SCORE_SAMPLE || 12));
const REQUEST_TIMEOUT_MS = Math.max(4000, Number(process.env.REQUEST_TIMEOUT_MS || 20000));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(pathname, { retries = 1 } = {}) {
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}${pathname}`, {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error ? `${payload.error}` : `HTTP ${response.status}`;
        throw new Error(`${pathname} failed: ${message}`);
      }
      if (!payload || typeof payload !== "object") {
        throw new Error(`${pathname} failed: invalid JSON payload`);
      }
      return payload;
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "AbortError";
      if (attempt >= retries) {
        throw new Error(`${pathname} failed after ${attempt + 1} attempt(s): ${error.message}`);
      }
      attempt += 1;
      await sleep(isTimeout ? 350 * attempt : 200 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function approxEqual(a, b, tolerance = 1.5) {
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

function summarizeRisk(score) {
  const normalized = Number(score);
  if (!Number.isFinite(normalized)) {
    return "unknown";
  }
  if (normalized >= 70) {
    return "green";
  }
  if (normalized >= 40) {
    return "yellow";
  }
  return "red";
}

async function run() {
  console.log(`[week3-qa] API_BASE=${API_BASE}`);
  console.log(`[week3-qa] timeout=${REQUEST_TIMEOUT_MS}ms topLimit=${TOP_LIMIT} sample=${SCORE_SAMPLE}`);

  const health = await requestJson("/health", { retries: 1 });
  assert(health.status === "ok", "health.status is not ok");
  console.log(
    `[week3-qa] health ok | providers=${Array.isArray(health.rpcProviders) ? health.rpcProviders.length : 0} | cacheEntries=${health?.cache?.entries ?? 0}`
  );

  const topTokens = await requestJson(`/v1/top-tokens?limit=${encodeURIComponent(String(TOP_LIMIT))}`, {
    retries: 1
  });
  const tokens = Array.isArray(topTokens.tokens) ? topTokens.tokens : [];
  assert(tokens.length >= 2, "top tokens response has fewer than 2 tokens");
  console.log(
    `[week3-qa] top tokens ok | count=${tokens.length} | source=${String(topTokens.source || "unknown")}`
  );

  const uniqueMints = [];
  const seenMints = new Set();
  for (const token of tokens) {
    const mint = String(token?.mint || "").trim();
    if (!mint || seenMints.has(mint)) {
      continue;
    }
    seenMints.add(mint);
    uniqueMints.push(mint);
    if (uniqueMints.length >= SCORE_SAMPLE) {
      break;
    }
  }
  assert(uniqueMints.length >= 2, "not enough unique mints for QA sample");

  const scoreSummary = {
    checked: 0,
    green: 0,
    yellow: 0,
    red: 0,
    heuristicWarnings: 0
  };

  for (const mint of uniqueMints) {
    const scorePayload = await requestJson(`/v1/score/${encodeURIComponent(mint)}`, {
      retries: 1
    });
    assert(String(scorePayload.mint || "") === mint, `score payload mint mismatch for ${mint}`);
    assert(isFiniteNumber(scorePayload.score), `score missing for ${mint}`);
    assert(Number(scorePayload.score) >= 0 && Number(scorePayload.score) <= 100, `score out of range for ${mint}`);
    assert(Array.isArray(scorePayload.reasons), `reasons is not array for ${mint}`);

    const breakdown = scorePayload.scoreBreakdown;
    assert(breakdown && typeof breakdown === "object", `scoreBreakdown missing for ${mint}`);
    assert(
      Number(breakdown.finalScore) === Number(scorePayload.score),
      `finalScore mismatch for ${mint}`
    );
    const components = Array.isArray(breakdown.components) ? breakdown.components : [];
    assert(components.length >= 5, `insufficient breakdown components for ${mint}`);
    const contributionSum = components.reduce(
      (sum, component) => sum + Number(component?.contribution || 0),
      0
    );
    assert(
      approxEqual(contributionSum, Number(breakdown.baseScoreRaw || 0)),
      `component sum mismatch for ${mint}`
    );

    const breakdownPayload = await requestJson(`/v1/score-breakdown/${encodeURIComponent(mint)}`, {
      retries: 1
    });
    assert(String(breakdownPayload.mint || "") === mint, `score-breakdown mint mismatch for ${mint}`);
    assert(
      Number(breakdownPayload.scoreBreakdown?.finalScore) === Number(scorePayload.score),
      `score-breakdown endpoint mismatch for ${mint}`
    );

    const riskBand = summarizeRisk(scorePayload.score);
    if (riskBand === "green") {
      scoreSummary.green += 1;
    } else if (riskBand === "yellow") {
      scoreSummary.yellow += 1;
    } else {
      scoreSummary.red += 1;
    }
    scoreSummary.checked += 1;

    const warnings = Array.isArray(scorePayload.warnings) ? scorePayload.warnings : [];
    if (warnings.some((warning) => String(warning).toLowerCase().includes("heuristic"))) {
      scoreSummary.heuristicWarnings += 1;
    }
  }

  const compareA = uniqueMints[0];
  const compareB = uniqueMints[1];
  const comparePayload = await requestJson(
    `/v1/compare?mintA=${encodeURIComponent(compareA)}&mintB=${encodeURIComponent(compareB)}`,
    { retries: 1 }
  );
  assert(comparePayload?.tokenA?.mint === compareA, "compare tokenA mint mismatch");
  assert(comparePayload?.tokenB?.mint === compareB, "compare tokenB mint mismatch");
  assert(
    isFiniteNumber(comparePayload?.comparison?.scoreDelta),
    "compare scoreDelta missing or invalid"
  );
  console.log("[week3-qa] compare endpoint ok");

  const searchQuery = String(tokens[0]?.symbol || "sol").trim();
  const searchPayload = await requestJson(
    `/v1/token-search?q=${encodeURIComponent(searchQuery)}&limit=8`,
    { retries: 1 }
  );
  assert(Array.isArray(searchPayload.tokens), "token-search tokens is not array");
  console.log(
    `[week3-qa] token-search ok | query="${searchQuery}" | hits=${searchPayload.tokens.length}`
  );

  for (const mint of uniqueMints.slice(0, 3)) {
    const historyPayload = await requestJson(`/v1/history/${encodeURIComponent(mint)}?limit=10`, {
      retries: 1
    });
    assert(Array.isArray(historyPayload.points), `history points is not array for ${mint}`);
    const profilePayload = await requestJson(`/v1/token/${encodeURIComponent(mint)}`, {
      retries: 1
    });
    assert(String(profilePayload.mint || "") === mint, `token profile mint mismatch for ${mint}`);
  }
  console.log("[week3-qa] history + token profile endpoints ok");

  console.log("[week3-qa] summary");
  console.log(
    JSON.stringify(
      {
        checkedMints: scoreSummary.checked,
        statusDistribution: {
          green: scoreSummary.green,
          yellow: scoreSummary.yellow,
          red: scoreSummary.red
        },
        heuristicWarningMints: scoreSummary.heuristicWarnings
      },
      null,
      2
    )
  );
  console.log("[week3-qa] PASS");
}

run().catch((error) => {
  console.error(`[week3-qa] FAIL: ${error.message}`);
  process.exitCode = 1;
});
