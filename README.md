# TrustLayer (Sprint 1 Vertical Slice)

TrustLayer is a starter MVP for Solana token risk scoring.

## What exists now

- API service with:
  - `GET /health`
  - `GET /v1/score/:mint`
    - real RPC signals: mint/freeze authority, top 10 holder concentration
    - market signals from DexScreener: liquidity + 24h activity
    - automatic fallback mode if RPC or market source fails
- Web UI with:
  - mint input
  - score/status/reasons display
  - data source + fallback warning display
  - RPC Health block (provider-level diagnostics)

## Quick start

From your terminal:

```bash
cd /home/agar/trustlayer
npm run dev:api
```

In a second terminal:

```bash
cd /home/agar/trustlayer
npm run dev:web
```

Open:

- Web: `http://127.0.0.1:5173`
- API health: `http://127.0.0.1:8787/health`

Single-command option:

```bash
cd /home/agar/trustlayer
./scripts/dev_all.sh
```

`dev_all.sh` automatically loads `/home/agar/trustlayer/.env` if present.

## Notes

- This is intentionally dependency-light for fast iteration.
- Configure external sources via `.env.example`:
  - `SOLANA_RPC_URL` or `SOLANA_RPC_URLS` (multi-endpoint failover)
  - `DEXSCREENER_API_BASE`
- If you see frequent `RPC HTTP 429`, switch to a dedicated provider endpoint
  (Helius/QuickNode/Triton) and place it first in `SOLANA_RPC_URLS`.
- If requests feel too slow, tune:
  - `RPC_TIMEOUT_MS`
  - `RPC_MAX_RETRIES_PER_URL`
  - `RPC_CALL_BUDGET_MS`
- Holder-specific tuning:
  - `RPC_HOLDER_TIMEOUT_MS`
  - `RPC_HOLDER_MAX_RETRIES_PER_URL`
  - `RPC_HOLDER_BUDGET_MS`
  - `HOLDER_TOKEN_ACCOUNTS_FALLBACK_LIMIT`
  - `HOLDER_TOKEN_ACCOUNTS_TIMEOUT_MS`
  - `HOLDER_TOKEN_ACCOUNTS_BUDGET_MS`
  - `HOLDER_TOKEN_ACCOUNTS_MAX_PAGES`
  - `HOLDER_HEURISTIC_PENALTY`
  - `HOLDER_HEURISTIC_MAX_SCORE`
- Professional scoring behavior:
  - if largest-holders RPC fails, API automatically paginates `getTokenAccounts` (`page 1..N`)
  - output now includes holder sample coverage/pages in `signalDetails`
  - `status=green` is only allowed when confidence is `high`
  - `rpcHealth` includes provider diagnostics (`ok` / `degraded` / `failed`)
- Example with Alchemy first:
  - `SOLANA_RPC_URLS=https://solana-mainnet.g.alchemy.com/v2/YOUR_API_KEY,https://api.mainnet-beta.solana.com`
