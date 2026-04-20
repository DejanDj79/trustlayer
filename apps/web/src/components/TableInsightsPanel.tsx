import { useState } from "react";
import { formatNumber, riskBandFromScore } from "../lib/format";
import type { TopToken, TokenRiskState } from "../types";

interface TableInsightsPanelProps {
  tokens: TopToken[];
  risks: Record<string, TokenRiskState>;
  source: string;
  fallbackMode: boolean;
  selectedMint: string | null;
  onAnalyzeToken: (mint: string) => void;
}

type ChartTimeframe = "24h" | "7d";

function StatPill({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone: "neutral" | "green" | "yellow" | "red";
}) {
  const toneClass =
    tone === "green"
      ? "border-green-600/60 bg-green-950/30 text-green-300"
      : tone === "yellow"
        ? "border-amber-500/60 bg-amber-950/30 text-amber-300"
        : tone === "red"
          ? "border-red-600/60 bg-red-950/30 text-red-300"
          : "border-tl-border bg-black text-zinc-300";

  return (
    <div className={`border px-2 py-1 ${toneClass}`}>
      <p className="text-[11px] uppercase tracking-[0.06em]">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
    </div>
  );
}

function selectPriceSeries(token: TopToken, timeframe: ChartTimeframe): number[] {
  const series = Array.isArray(token.sparkline7d)
    ? token.sparkline7d.filter((value) => Number.isFinite(Number(value))).map((value) => Number(value))
    : [];
  if (series.length === 0) {
    return [];
  }

  if (timeframe === "7d") {
    return series;
  }
  const dayPoints = Math.max(12, Math.round(series.length / 7));
  return series.slice(-dayPoints);
}

function MiniPriceSparkline({
  prices,
  change24hPct
}: {
  prices: number[];
  change24hPct: number | null;
}) {
  const series = Array.isArray(prices) ? prices.filter((value) => Number.isFinite(value)) : [];
  if (series.length < 2) {
    return (
      <svg viewBox="0 0 112 32" className="h-8 w-28">
        <line x1="2" y1="16" x2="110" y2="16" stroke="#2f2f2f" strokeWidth="1.4" />
      </svg>
    );
  }

  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = Math.max(1e-9, max - min);
  const trend = series[series.length - 1] - series[0];
  const fallbackDirection = Number(change24hPct || 0);
  const isUp = trend === 0 ? fallbackDirection >= 0 : trend > 0;
  const stroke = isUp ? "#22c55e" : "#ef4444";
  const strokePoints = series
    .map((value, index) => {
      const x = 2 + (index / Math.max(1, series.length - 1)) * 108;
      const normalized = (value - min) / span;
      const y = 28 - normalized * 24;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg viewBox="0 0 112 32" className="h-8 w-28">
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        points={strokePoints}
      />
    </svg>
  );
}

export function TableInsightsPanel(props: TableInsightsPanelProps) {
  const { tokens, risks, source, fallbackMode, selectedMint, onAnalyzeToken } = props;
  const [moverTimeframe, setMoverTimeframe] = useState<ChartTimeframe>("24h");

  const readyScores = tokens
    .map((token) => {
      const row = risks[token.mint];
      return row?.state === "ready" && Number.isFinite(Number(row.score)) ? Number(row.score) : null;
    })
    .filter((value): value is number => value !== null);

  const readyCount = readyScores.length;
  const pendingCount = tokens.filter((token) => risks[token.mint]?.state === "pending").length;
  const errorCount = tokens.filter((token) => risks[token.mint]?.state === "error").length;
  const averageScore =
    readyScores.length > 0
      ? Math.round(readyScores.reduce((sum, value) => sum + value, 0) / readyScores.length)
      : null;

  let greenCount = 0;
  let yellowCount = 0;
  let redCount = 0;
  for (const score of readyScores) {
    const band = riskBandFromScore(score);
    if (band === "green") {
      greenCount += 1;
    } else if (band === "red") {
      redCount += 1;
    } else {
      yellowCount += 1;
    }
  }

  const movers = [...tokens]
    .filter((token) => Number.isFinite(Number(token.change24hPct)))
    .sort((a, b) => Math.abs(Number(b.change24hPct)) - Math.abs(Number(a.change24hPct)))
    .slice(0, 6);

  return (
    <section className="-mx-4 border-t border-tl-border bg-black py-4">
      <div className="px-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="font-display text-lg font-semibold text-tl-text">Market Pulse</h3>
          <p className="text-xs uppercase tracking-[0.08em] text-tl-muted">
            Source: {source || "unknown"}
            {fallbackMode ? " (fallback)" : ""}
          </p>
        </div>

        <div className="grid gap-3 xl:grid-cols-3">
          <article className="border border-tl-border bg-black px-3 py-3">
            <p className="mb-2 text-xs uppercase tracking-[0.08em] text-zinc-400">Coverage</p>
            <div className="grid grid-cols-2 gap-2">
              <StatPill label="Ready" value={formatNumber(readyCount)} tone="neutral" />
              <StatPill label="Pending" value={formatNumber(pendingCount)} tone="neutral" />
              <StatPill label="Errors" value={formatNumber(errorCount)} tone={errorCount > 0 ? "red" : "neutral"} />
              <StatPill label="Avg score" value={averageScore === null ? "n/a" : `${averageScore}%`} tone="neutral" />
            </div>
          </article>

          <article className="border border-tl-border bg-black px-3 py-3">
            <p className="mb-2 text-xs uppercase tracking-[0.08em] text-zinc-400">Risk Mix</p>
            <div className="grid grid-cols-3 gap-2">
              <StatPill label="Green" value={formatNumber(greenCount)} tone="green" />
              <StatPill label="Yellow" value={formatNumber(yellowCount)} tone="yellow" />
              <StatPill label="Red" value={formatNumber(redCount)} tone="red" />
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              Mix is calculated from rows with resolved risk values.
            </p>
          </article>

          <article className="border border-tl-border bg-black px-3 py-3">
            <p className="mb-2 text-xs uppercase tracking-[0.08em] text-zinc-400">Risk Legend</p>
            <ul className="grid gap-1 text-sm text-zinc-300">
              <li className="flex items-center justify-between gap-2">
                <span>Low risk</span>
                <span className="text-green-300">70-100</span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span>Medium risk</span>
                <span className="text-amber-300">40-69</span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span>High risk</span>
                <span className="text-red-500">0-39</span>
              </li>
            </ul>
            <p className="mt-2 text-xs text-zinc-500">
              Table refreshes every 5 minutes.
            </p>
          </article>
        </div>

        <article className="mt-3 border border-tl-border bg-black px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.08em] text-zinc-400">Top Movers (24h change)</p>
            <div className="flex items-center gap-1">
              {(["24h", "7d"] as const).map((timeframe) => (
                <button
                  key={timeframe}
                  type="button"
                  onClick={() => setMoverTimeframe(timeframe)}
                  className={`border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    moverTimeframe === timeframe
                      ? "border-sky-500/50 bg-sky-950/40 text-sky-300"
                      : "border-tl-border bg-black text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {timeframe}
                </button>
              ))}
            </div>
          </div>
          {movers.length === 0 ? (
            <p className="text-sm text-zinc-500">No mover data available right now.</p>
          ) : (
            <ul className="grid gap-1">
              {movers.map((token) => {
                const change = Number(token.change24hPct || 0);
                const isActive = selectedMint === token.mint;
                const chartPrices = selectPriceSeries(token, moverTimeframe);
                return (
                  <li key={token.mint}>
                    <button
                      type="button"
                      onClick={() => onAnalyzeToken(token.mint)}
                      className={`grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-2 py-1 text-left transition-colors duration-150 ${
                        isActive ? "bg-[#191a1a]" : "hover:bg-[#101010]"
                      }`}
                    >
                      <span className="truncate text-sm text-zinc-200">
                        {token.name || token.symbol || token.mint}
                      </span>
                      <span
                        className={`w-16 text-right text-sm font-semibold ${
                          change >= 0 ? "text-green-400" : "text-red-400"
                        }`}
                      >
                        {change >= 0 ? "+" : ""}
                        {change.toFixed(2)}%
                      </span>
                      <span className="justify-self-end">
                        <MiniPriceSparkline prices={chartPrices} change24hPct={token.change24hPct} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      </div>
    </section>
  );
}
