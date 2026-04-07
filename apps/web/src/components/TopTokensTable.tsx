import { useState } from "react";
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
  source: string;
  fallbackMode: boolean;
  errorMessage: string | null;
  selectedMint: string | null;
  onAnalyzeToken: (mint: string) => void;
}

function TokenLogo({ token }: { token: TopToken }) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = (token.imageUrl || "").trim() || fallbackLogoUrlForMint(token.mint);
  const showImage = Boolean(imageUrl) && !imageFailed;

  return (
    <div
      className="relative grid h-8 w-8 place-items-center overflow-hidden rounded-full border border-tl-border bg-transparent text-xs font-extrabold text-tl-text"
      style={{ borderRadius: "9999px", clipPath: "circle(50% at 50% 50%)" }}
    >
      {!showImage ? <span>{initials(token.symbol, token.name)}</span> : null}
      {showImage ? (
        <img
          src={imageUrl}
          alt={`${token.name} logo`}
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
          className="absolute inset-0 h-full w-full rounded-full object-cover"
          style={{ borderRadius: "9999px", clipPath: "circle(50% at 50% 50%)" }}
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

function RiskBadge({ risk }: { risk: TokenRiskState | undefined }) {
  if (!risk || risk.state === "pending") {
    return <span className="text-xs text-tl-muted">...</span>;
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

export function TopTokensTable(props: TopTokensTableProps) {
  const { tokens, risks, isLoading, source, fallbackMode, errorMessage, selectedMint, onAnalyzeToken } = props;

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
          {isLoading ? (
            <p className="mt-1 inline-flex items-center gap-2 text-sm text-tl-muted">
              <LoadingSpinner />
              Loading top tokens...
            </p>
          ) : (
            <p className="mt-1 text-xs text-tl-muted">Auto-refresh every 5 minutes</p>
          )}
          <p className="mt-1 text-xs text-tl-muted">
            Legend: <span className="text-green-300">Green</span> low risk · <span className="text-amber-300">Yellow</span> medium risk · <span className="text-red-500">Red</span> high risk
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
              <th className="px-2 py-2">24h</th>
              <th className="px-2 py-2">Market Cap</th>
              <th className="px-2 py-2">Risk</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {tokens.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-2 py-4 text-center text-sm text-tl-muted">
                  No top token data available.
                </td>
              </tr>
            ) : (
              tokens.map((token) => {
                const change = token.change24hPct;
                const risk = risks[token.mint];
                const isSelected = selectedMint === token.mint;

                return (
                  <tr
                    key={token.mint}
                    aria-selected={isSelected}
                    onClick={() => onAnalyzeToken(token.mint)}
                    className={`text-sm text-tl-text transition-colors duration-150 cursor-pointer ${
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
