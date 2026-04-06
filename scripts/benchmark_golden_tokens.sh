#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:8787}"
GOLDEN_FILE="${1:-/home/agar/trustlayer/docs/golden_tokens_v1.csv}"

if [ ! -f "$GOLDEN_FILE" ]; then
  echo "[golden] missing file: $GOLDEN_FILE" >&2
  exit 2
fi

PASS_COUNT=0
FAIL_COUNT=0
TOTAL_COUNT=0

echo "[golden] using API: ${API_BASE}"
echo "[golden] using set: ${GOLDEN_FILE}"

while IFS=, read -r label mint min_score max_score expected_status notes; do
  # Skip comments and blank lines.
  if [[ -z "${label// }" ]] || [[ "${label:0:1}" == "#" ]]; then
    continue
  fi

  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  RESPONSE="$(curl -sS "${API_BASE}/v1/score/${mint}")"

  RESULT="$(node -e '
const [label, payloadRaw, minScoreRaw, maxScoreRaw, expectedStatusRaw] = process.argv.slice(1);
let payload;
try {
  payload = JSON.parse(payloadRaw);
} catch (error) {
  console.log(`FAIL|${label}|invalid-json|n/a|n/a|n/a|json-parse-error`);
  process.exit(0);
}

if (payload.error) {
  console.log(`FAIL|${label}|api-error|n/a|n/a|n/a|${payload.error}`);
  process.exit(0);
}

const score = Number(payload.score);
const status = String(payload.status || "unknown");
const confidence = String(payload.scoreConfidence || "unknown");
const source = String(payload.dataSource || "unknown");
const minScore = Number(minScoreRaw);
const maxScore = Number(maxScoreRaw);
const expectedStatus = String(expectedStatusRaw || "").trim().toLowerCase();

const checks = [];
if (!Number.isFinite(score)) {
  checks.push("score-not-number");
}
if (Number.isFinite(minScore) && score < minScore) {
  checks.push(`score<${minScore}`);
}
if (Number.isFinite(maxScore) && score > maxScore) {
  checks.push(`score>${maxScore}`);
}
if (expectedStatus && expectedStatus !== "*" && status.toLowerCase() !== expectedStatus) {
  checks.push(`status!=${expectedStatus}`);
}

const verdict = checks.length === 0 ? "PASS" : "FAIL";
const reason = checks.length === 0 ? "ok" : checks.join("+");
console.log(`${verdict}|${label}|${score}|${status}|${confidence}|${source}|${reason}`);
' "$label" "$RESPONSE" "$min_score" "$max_score" "$expected_status")"

  IFS="|" read -r verdict out_label out_score out_status out_conf out_source out_reason <<<"$RESULT"
  printf '[golden] %-4s | %-8s | score=%-3s | status=%-6s | conf=%-6s | source=%-24s | %s\n' \
    "$verdict" "$out_label" "$out_score" "$out_status" "$out_conf" "$out_source" "$out_reason"

  if [ "$verdict" = "PASS" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done <"$GOLDEN_FILE"

echo "[golden] summary: total=${TOTAL_COUNT} pass=${PASS_COUNT} fail=${FAIL_COUNT}"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
