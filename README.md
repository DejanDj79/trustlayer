# TrustLayer (Sprint 1 MVP)

TrustLayer is a Solana token risk scoring MVP for hackathon demos.

## Current scope

- API (`apps/api`) with:
  - `GET /health`
  - `GET /v1/score/:mint`
  - `GET /v1/top-tokens?limit=20` (CoinGecko-backed market list + fallback)
  - multi-RPC failover and provider diagnostics
  - holder concentration fallback logic
  - confidence-aware status policy (`green` only with `high` confidence)
  - in-memory score cache + in-flight dedupe by mint
- Web app (`apps/web`) with:
  - mint input and analysis CTA
  - market table with top Solana tokens (CoinGecko/Coinbase-style UX)
  - score ring, status, confidence, signal breakdown
  - liquidity/volume/tx/pools metrics
  - RPC health and warning panels
  - empty/loading/error states for demo stability

## Quick start

```bash
cd /home/agar/trustlayer
npm run dev:api
```

In second terminal:

```bash
cd /home/agar/trustlayer
npm run dev:web
```

Open:

- Web: `http://127.0.0.1:5173`
- API health: `http://127.0.0.1:8787/health`

Single command:

```bash
cd /home/agar/trustlayer
./scripts/dev_all.sh
```

## Fast smoke check

```bash
cd /home/agar/trustlayer
./scripts/smoke_api.sh
```

Custom mint set:

```bash
cd /home/agar/trustlayer
./scripts/smoke_api.sh So11111111111111111111111111111111111111112 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

## Golden benchmark (scoring tuning)

Run baseline checks against `docs/golden_tokens_v1.csv`:

```bash
cd /home/agar/trustlayer
./scripts/benchmark_golden_tokens.sh
```

Custom file:

```bash
cd /home/agar/trustlayer
./scripts/benchmark_golden_tokens.sh /home/agar/trustlayer/docs/golden_tokens_v1.csv
```

## Environment knobs

Base RPC setup:

- `SOLANA_RPC_URL` or `SOLANA_RPC_URLS` (first endpoint should be your private RPC)
- `RPC_TIMEOUT_MS`
- `RPC_MAX_RETRIES_PER_URL`
- `RPC_CALL_BUDGET_MS`

Holder-specific tuning:

- `RPC_HOLDER_TIMEOUT_MS`
- `RPC_HOLDER_MAX_RETRIES_PER_URL`
- `RPC_HOLDER_BUDGET_MS`
- `HOLDER_TOKEN_ACCOUNTS_FALLBACK_LIMIT`
- `HOLDER_TOKEN_ACCOUNTS_TIMEOUT_MS`
- `HOLDER_TOKEN_ACCOUNTS_BUDGET_MS`
- `HOLDER_TOKEN_ACCOUNTS_MAX_PAGES`
- `HOLDER_HEURISTIC_PENALTY`
- `HOLDER_HEURISTIC_MAX_SCORE`
- `HOLDER_HIGH_CONCENTRATION_PCT`
- `HOLDER_CRITICAL_CONCENTRATION_PCT`
- `HOLDER_HIGH_CONCENTRATION_SCORE_CAP`
- `HOLDER_CRITICAL_CONCENTRATION_SCORE_CAP`

Cache controls:

- `SCORE_CACHE_TTL_MS` (default `45000`, set `0` to disable)
- `SCORE_CACHE_MAX_ENTRIES` (default `200`)

Market source:

- `DEXSCREENER_API_BASE`
- `MARKET_TIMEOUT_MS`

## Demo runbook (3-5 min)

1. Open web app and show initial empty state.
2. Score `So11111111111111111111111111111111111111112` and explain:
   - score + confidence
   - signal breakdown
   - RPC health diagnostics
3. Repeat same mint and show faster response (`cache.hit=true` in API response).
4. Score one more mint (`EPjFWdd5...`) to show non-cached path.
5. Call `/health` and show cache/rpc operational telemetry.

## Known limitations (current sprint)

- No on-chain program yet (API-only scoring service in this phase).
- Some RPC providers return limited/unavailable data for `getTokenLargestAccounts`.
- Token-account fallback can be slower than direct largest-holders RPC.
- Web app is currently vanilla JS (React + TypeScript migration planned in next phase).
