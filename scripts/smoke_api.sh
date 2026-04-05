#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:8787}"

if [ "$#" -gt 0 ]; then
  MINTS=("$@")
else
  MINTS=(
    "So11111111111111111111111111111111111111112"
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  )
fi

echo "[smoke] checking health: ${API_BASE}/health"
HEALTH_JSON="$(curl -fsS "${API_BASE}/health")"
node -e '
const health = JSON.parse(process.argv[1]);
if (health.status !== "ok") {
  throw new Error("health.status is not ok");
}
const providers = Array.isArray(health.rpcProviders) ? health.rpcProviders.length : 0;
console.log(`[smoke] health ok | providers=${providers} | cacheEntries=${health?.cache?.entries ?? 0}`);
' "$HEALTH_JSON"

for mint in "${MINTS[@]}"; do
  echo "[smoke] scoring mint: ${mint}"
  SCORE_JSON="$(curl -fsS "${API_BASE}/v1/score/${mint}")"
  node -e '
const payload = JSON.parse(process.argv[1]);
const required = ["mint", "score", "status", "reasons", "signalDetails", "generatedAt"];
for (const key of required) {
  if (!(key in payload)) {
    throw new Error(`missing key: ${key}`);
  }
}
if (!Array.isArray(payload.reasons) || payload.reasons.length === 0) {
  throw new Error("reasons should be non-empty array");
}
if (typeof payload.score !== "number" || payload.score < 0 || payload.score > 100) {
  throw new Error("score out of range");
}
const cacheHit = Boolean(payload?.cache?.hit);
const confidence = String(payload.scoreConfidence || "unknown");
console.log(`[smoke] ok | score=${payload.score} | status=${payload.status} | confidence=${confidence} | cacheHit=${cacheHit}`);
' "$SCORE_JSON"
done

echo "[smoke] all checks passed"
