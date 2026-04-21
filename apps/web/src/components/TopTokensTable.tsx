import { useEffect, useMemo, useState } from "react";
import {
  fallbackLogoUrlForMint,
  formatPercent,
  formatPrice,
  formatUsd,
  initials,
  riskBandFromScore,
  shortMint
} from "../lib/format";
import type { TopToken, TokenRiskState } from "../types";

interface TopTokensTableProps {
  tokens: TopToken[];
  risks: Record<string, TokenRiskState>;
  isLoading: boolean;
  showInitialSkeleton?: boolean;
  source: string;
  fallbackMode: boolean;
  errorMessage: string | null;
  generatedAt: string | null;
  cacheAgeMs: number | null;
  cacheTtlMs: number | null;
  selectedMint: string | null;
  onRefreshNow: () => void;
  onAnalyzeToken: (mint: string) => void;
  watchlistMints: Set<string>;
  onToggleWatchlist: (token: TopToken) => void;
}

function TokenLogo({ token }: { token: TopToken }) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = (token.imageUrl || "").trim() || fallbackLogoUrlForMint(token.mint);
  const showImage = Boolean(imageUrl) && !imageFailed;

  return (
    <div className="relative grid h-8 w-8 place-items-center overflow-hidden rounded-full bg-transparent text-xs font-extrabold text-tl-text ring-1 ring-tl-border/70">
      {!showImage ? <span>{initials(token.symbol, token.name)}</span> : null}
      {showImage ? (
        <img
          src={imageUrl}
          alt={`${token.name} logo`}
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
    </div>
  );
}

function LoadingSpinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 animate-spin border-2 border-zinc-700 border-t-zinc-200"
    />
  );
}

function FavoriteStarIcon({ active }: { active: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill={active ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3.75l2.5 5.06 5.58.81-4.04 3.94.95 5.56L12 16.5 7.01 19.12l.95-5.56-4.04-3.94 5.58-.81L12 3.75z" />
    </svg>
  );
}

function RiskBadge({ risk }: { risk: TokenRiskState | undefined }) {
  if (!risk || risk.state === "pending") {
    return <span className="inline-block h-4 w-12 animate-pulse bg-[#222222]" />;
  }
  if (risk.state === "error") {
    return <span className="text-xs text-tl-muted">n/a</span>;
  }

  const band = riskBandFromScore(risk.score);
  const colorClass = band === "green" ? "text-green-300" : band === "red" ? "text-red-500" : "text-amber-300";
  const numericScore = Number(risk.score);
  const scoreText = Number.isFinite(numericScore) ? `${Math.round(numericScore)}%` : "n/a";

  return <span className={`text-sm font-semibold ${colorClass}`}>{scoreText}</span>;
}

function coinGeckoUrlForToken(token: TopToken): string {
  const coinId = String(token.coingeckoId || "").trim();
  if (coinId) {
    return `https://www.coingecko.com/en/coins/${encodeURIComponent(coinId)}`;
  }
  const fallbackQuery = String(token.mint || token.symbol || token.name || "").trim();
  return `https://www.coingecko.com/en/search?query=${encodeURIComponent(fallbackQuery)}`;
}

function formatRelativeCacheAge(ageMs: number | null | undefined): string {
  const numeric = Number(ageMs);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return "n/a";
  }
  const seconds = Math.round(numeric / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function formatSyncTime(value: string | null | undefined): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return "n/a";
  }
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    return "n/a";
  }
  return parsed.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function TopTokensTable(props: TopTokensTableProps) {
  const {
    tokens,
    risks,
    isLoading,
    showInitialSkeleton = false,
    source,
    fallbackMode,
    errorMessage,
    generatedAt,
    cacheAgeMs,
    cacheTtlMs,
    selectedMint,
    onRefreshNow,
    onAnalyzeToken,
    watchlistMints,
    onToggleWatchlist
  } = props;
  const [visibleRowCount, setVisibleRowCount] = useState(0);
  const tokenListKey = useMemo(() => tokens.map((token) => token.mint).join("|"), [tokens]);

  useEffect(() => {
    if (showInitialSkeleton || tokens.length === 0) {
      setVisibleRowCount(0);
      return;
    }
    setVisibleRowCount(1);
    if (tokens.length === 1) {
      return;
    }
    let current = 1;
    const intervalId = window.setInterval(() => {
      current += 1;
      setVisibleRowCount((prev) => Math.max(prev, Math.min(tokens.length, current)));
      if (current >= tokens.length) {
        window.clearInterval(intervalId);
      }
    }, 45);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [showInitialSkeleton, tokenListKey, tokens.length]);

  return (
    <section className="-mx-4 bg-transparent py-4">
      <div className="mb-3 flex items-start justify-between gap-3 px-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-tl-text">Top Solana Tokens</h2>
          <p className="text-sm text-tl-muted">Market view inspired by exchange watchlists.</p>
        </div>

        <div className="text-right">
          <p className="text-xs uppercase tracking-[0.08em] text-tl-muted">
            Source: {source || "unknown"}
            {fallbackMode ? " (fallback mode)" : ""}
          </p>
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              onClick={onRefreshNow}
              disabled={isLoading}
              className="border border-tl-border bg-black px-2 py-1 text-[11px] text-zinc-300 transition-colors duration-150 hover:bg-[#101010] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Sync now
            </button>
          </div>
          {isLoading ? (
            <p className="mt-1 inline-flex items-center gap-2 text-sm text-tl-muted">
              <LoadingSpinner />
              Loading top tokens...
            </p>
          ) : (
            <p className="mt-1 text-xs text-tl-muted">Auto-refresh every 5 minutes</p>
          )}
          <p className="mt-1 text-xs text-tl-muted">
            Last sync: {formatSyncTime(generatedAt)} · cache age: {formatRelativeCacheAge(cacheAgeMs)}
            {" / "}
            {formatRelativeCacheAge(cacheTtlMs)}
          </p>
        </div>
      </div>

      {errorMessage ? (
        <p className="mx-4 mb-3 bg-red-950 px-3 py-2 text-xs text-red-500">{errorMessage}</p>
      ) : null}

      <div className="overflow-x-auto bg-black">
        <table className="min-w-[980px] w-full border-collapse">
          <thead className="border-y border-dashed border-tl-border">
            <tr className="bg-black text-left text-xs uppercase tracking-[0.06em] text-zinc-400">
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">Token</th>
              <th className="px-2 py-2">Price</th>
              <th className="px-2 py-2">Price 24h</th>
              <th className="px-2 py-2">MCap (Global)</th>
              <th className="px-2 py-2">Risk</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {showInitialSkeleton ? (
              Array.from({ length: Math.max(tokens.length, 12) }).map((_, index) => (
                <tr key={`skeleton-row-${index}`} className="animate-pulse text-sm text-tl-text">
                  <td className="px-2 py-2">
                    <span className="block h-4 w-6 bg-[#1f1f1f]" />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="block h-8 w-8 bg-[#1f1f1f]" />
                      <div className="min-w-0 space-y-1.5">
                        <span className="block h-4 w-28 bg-[#1f1f1f]" />
                        <span className="block h-3 w-36 bg-[#181818]" />
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <span className="block h-4 w-16 bg-[#1f1f1f]" />
                  </td>
                  <td className="px-2 py-2">
                    <span className="block h-4 w-14 bg-[#1f1f1f]" />
                  </td>
                  <td className="px-2 py-2">
                    <span className="block h-4 w-20 bg-[#1f1f1f]" />
                  </td>
                  <td className="px-2 py-2">
                    <span className="block h-4 w-12 bg-[#1f1f1f]" />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2">
                      <span className="block h-7 w-16 bg-[#1f1f1f]" />
                      <span className="block h-7 w-7 bg-[#1f1f1f]" />
                    </div>
                  </td>
                </tr>
              ))
            ) : tokens.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-2 py-4 text-center text-sm text-tl-muted">
                  No top token data available.
                </td>
              </tr>
            ) : (
              tokens.map((token, index) => {
                const change = token.change24hPct;
                const risk = risks[token.mint];
                const isSelected = selectedMint === token.mint;
                const inWatchlist = watchlistMints.has(token.mint);
                const isVisible = index < visibleRowCount;

                return (
                  <tr
                    key={token.mint}
                    aria-selected={isSelected}
                    onClick={() => onAnalyzeToken(token.mint)}
                    className={`cursor-pointer text-sm text-tl-text transition-all duration-300 ${
                      isVisible ? "opacity-100" : "pointer-events-none opacity-0"
                    } ${
                      isSelected ? "bg-[#191a1a]" : "hover:bg-[#111111]"
                    }`}
                  >
                    <td className="px-2 py-2">{Number.isFinite(token.rank) ? token.rank : "-"}</td>
                    <td className="px-2 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <TokenLogo token={token} />
                        <div className="min-w-0">
                          <p className="truncate font-bold">{token.name || "Unknown"}</p>
                          <p className="truncate text-xs text-tl-muted">
                            {token.symbol || "N/A"} · {shortMint(token.mint)}
                          </p>
                          <p className="truncate text-xs">
                            <a
                              href={coinGeckoUrlForToken(token)}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(event) => event.stopPropagation()}
                              className="text-sky-300 hover:underline"
                            >
                              Open on CoinGecko
                            </a>
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-2">{formatPrice(token.priceUsd)}</td>
                    <td
                      className={`px-2 py-2 font-bold ${
                        Number.isFinite(Number(change))
                          ? Number(change) >= 0
                            ? "text-green-400"
                            : "text-red-400"
                          : ""
                      }`}
                    >
                      {formatPercent(change)}
                    </td>
                    <td className="px-2 py-2">{formatUsd(token.marketCapUsd)}</td>
                    <td className="px-2 py-2">
                      <RiskBadge risk={risk} />
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onAnalyzeToken(token.mint);
                          }}
                          className="border border-tl-border bg-blue-950/60 px-3 py-1 text-xs font-bold text-blue-200 transition-colors duration-150 hover:bg-blue-900/70"
                        >
                          Analyze
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleWatchlist(token);
                          }}
                          aria-label={inWatchlist ? "Remove from favorites" : "Add to favorites"}
                          title={inWatchlist ? "Remove from favorites" : "Add to favorites"}
                          className={`grid h-7 w-7 place-items-center border transition-colors duration-150 ${
                            inWatchlist
                              ? "border-amber-500/40 bg-amber-950/40 text-amber-300 hover:text-amber-200"
                              : "border-tl-border bg-black text-zinc-500 hover:text-zinc-200"
                          }`}
                        >
                          <FavoriteStarIcon active={inWatchlist} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
