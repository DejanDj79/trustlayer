import { useEffect, useMemo, useRef, useState } from "react";
import { requestJsonWithRetry } from "../lib/api";
import { formatNumber, riskBandFromScore } from "../lib/format";
import type { RiskTrendsResponse, TopToken, TokenRiskState } from "../types";

interface TableInsightsPanelProps {
  tokens: TopToken[];
  risks: Record<string, TokenRiskState>;
  showInitialSkeleton?: boolean;
  source: string;
  fallbackMode: boolean;
  selectedMint: string | null;
  onAnalyzeToken: (mint: string) => void;
}

type ChartTimeframe = "24h" | "7d";
const CHART_TIMEFRAME_OPTIONS = ["24h", "7d"] as const;
const TOKEN_CHART_FETCH_TIMEOUT_MS = 12000;
const TIMEFRAME_FALLBACK_CHAIN: Record<ChartTimeframe, ChartTimeframe[]> = {
  "24h": ["24h", "7d"],
  "7d": ["7d"]
};

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

function buildFlatRiskSeries(score: number | null | undefined): number[] {
  const value = Number(score);
  if (!Number.isFinite(value)) {
    return [];
  }
  const clamped = Math.max(0, Math.min(100, value));
  return [clamped, clamped];
}

function selectSparklineWindow(token: TopToken, timeframe: ChartTimeframe): number[] {
  const series = Array.isArray(token.sparkline7d)
    ? token.sparkline7d.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  if (series.length < 2) {
    return [];
  }
  if (timeframe === "7d") {
    return series;
  }
  const pointsForWindow = Math.max(2, Math.ceil((24 / 168) * series.length) + 1);
  return series.slice(-Math.min(series.length, pointsForWindow));
}

function clampRiskValue(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function seriesRange(series: number[]): number {
  const values = Array.isArray(series) ? series.filter((value) => Number.isFinite(value)) : [];
  if (values.length < 2) {
    return 0;
  }
  return Math.max(...values) - Math.min(...values);
}

function pickAdaptiveSparklineWindow(token: TopToken, timeframe: ChartTimeframe): number[] {
  const chain = TIMEFRAME_FALLBACK_CHAIN[timeframe] || [timeframe];
  for (const candidate of chain) {
    const points = selectSparklineWindow(token, candidate);
    if (points.length >= 2 && seriesRange(points) > 0) {
      return points;
    }
  }
  return selectSparklineWindow(token, timeframe);
}

function normalizePriceSeriesToRiskBand(priceSeries: number[], anchorScore: number): number[] {
  const min = Math.min(...priceSeries);
  const max = Math.max(...priceSeries);
  const span = Math.max(1e-9, max - min);
  const bandHalfSize = 12;
  return priceSeries.map((value) => {
    const normalized = (Number(value) - min) / span; // 0..1
    const centered = (normalized - 0.5) * 2; // -1..1
    return clampRiskValue(anchorScore + centered * bandHalfSize);
  });
}

function buildEstimatedRiskSeriesFromSparkline(
  token: TopToken,
  currentScore: number | null,
  timeframe: ChartTimeframe
): number[] {
  const baseScore = Number(currentScore);
  const anchorScore = Number.isFinite(baseScore) ? baseScore : 50;
  const priceSeries = pickAdaptiveSparklineWindow(token, timeframe);
  if (priceSeries.length < 2) {
    return buildFlatRiskSeries(anchorScore);
  }

  const last = Number(priceSeries[priceSeries.length - 1]);
  if (!Number.isFinite(last) || last <= 0 || seriesRange(priceSeries) <= 0) {
    return buildFlatRiskSeries(anchorScore);
  }

  // Anchor last point to current risk score and reconstruct prior points from relative moves.
  // This keeps shape dynamic while clearly acting as temporary estimation until real risk history grows.
  const projected = priceSeries.map((value) => {
    const relativePct = ((Number(value) - last) / last) * 100;
    return clampRiskValue(anchorScore + relativePct * 0.8);
  });
  if (seriesRange(projected) > 0) {
    return projected;
  }
  return normalizePriceSeriesToRiskBand(priceSeries, anchorScore);
}

function computeSeriesChangePct(series: number[]): number {
  if (!Array.isArray(series) || series.length < 2) {
    return 0;
  }
  const start = Number(series[0]);
  const end = Number(series[series.length - 1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0) {
    return 0;
  }
  return ((end - start) / start) * 100;
}

function formatSignedPercent(value: number | null | undefined): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "n/a";
  }
  return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(2)}%`;
}

function MiniPriceSparkline({
  prices,
  fallbackChangePct
}: {
  prices: number[];
  fallbackChangePct: number | null;
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
  const fallbackDirection = Number(fallbackChangePct || 0);
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
  const { tokens, risks, showInitialSkeleton = false, source, fallbackMode, selectedMint, onAnalyzeToken } = props;
  const [moverTimeframe, setMoverTimeframe] = useState<ChartTimeframe>("24h");
  const [riskTrendsByMint, setRiskTrendsByMint] = useState<
    Record<string, { points: number[]; changePct: number }>
  >({});
  const chartFetchNonceRef = useRef(0);

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

  const chartMints = useMemo(() => {
    const deduped = new Set<string>();
    for (const token of tokens) {
      deduped.add(token.mint);
      if (deduped.size >= 20) {
        break;
      }
    }
    return Array.from(deduped);
  }, [tokens]);
  const chartMintsQuery = chartMints.join(",");

  useEffect(() => {
    if (!chartMintsQuery) {
      setRiskTrendsByMint({});
      return;
    }

    const nonce = ++chartFetchNonceRef.current;
    setRiskTrendsByMint({});

    void requestJsonWithRetry<RiskTrendsResponse>(
      `/v1/risk-trends?timeframe=${encodeURIComponent(moverTimeframe)}&mints=${encodeURIComponent(chartMintsQuery)}`,
      {
        timeoutMs: TOKEN_CHART_FETCH_TIMEOUT_MS,
        retries: 1,
        retryDelayMs: 300
      }
    )
      .then((payload) => {
        if (nonce !== chartFetchNonceRef.current) {
          return;
        }
        const charts = Array.isArray(payload?.charts) ? payload.charts : [];
        const next: Record<string, { points: number[]; changePct: number }> = {};
        for (const item of charts) {
          const mint = String(item?.mint || "").trim();
          const points = Array.isArray(item?.points)
            ? item.points.map((value) => Number(value)).filter((value) => Number.isFinite(value))
            : [];
          const changeRaw = Number(item?.changePct);
          const changePct = Number.isFinite(changeRaw) ? changeRaw : 0;
          if (!mint) {
            continue;
          }
          next[mint] = {
            points,
            changePct
          };
        }
        setRiskTrendsByMint(next);
      })
      .catch(() => {
        if (nonce !== chartFetchNonceRef.current) {
          return;
        }
        setRiskTrendsByMint({});
      });
  }, [moverTimeframe, chartMintsQuery]);

  const trendByMint = useMemo(() => {
    const entries: Record<string, { points: number[]; changePct: number }> = {};
    for (const token of tokens) {
      const trend = riskTrendsByMint[token.mint];
      const realPoints = Array.isArray(trend?.points)
        ? trend.points.map((value) => Number(value)).filter((value) => Number.isFinite(value))
        : [];
      const readyRisk = risks[token.mint];
      const readyScore =
        readyRisk?.state === "ready" && Number.isFinite(Number(readyRisk.score))
          ? Number(readyRisk.score)
          : null;
      const hasRealTrend = realPoints.length >= 2;
      const hasRealTrendVariance = seriesRange(realPoints) > 0;
      const estimatedPoints = buildEstimatedRiskSeriesFromSparkline(token, readyScore, moverTimeframe);
      const points = hasRealTrend && hasRealTrendVariance ? realPoints : estimatedPoints;
      const rawChangePct =
        hasRealTrend && hasRealTrendVariance && Number.isFinite(Number(trend?.changePct))
          ? Number(trend?.changePct)
          : computeSeriesChangePct(points);
      entries[token.mint] = {
        points,
        changePct: Number.isFinite(rawChangePct) ? rawChangePct : 0
      };
    }
    return entries;
  }, [tokens, riskTrendsByMint, risks, moverTimeframe]);

  // Gainers/Losers membership is fixed from Top Tokens table (price 24h), independent of chart timeframe.
  const gainers = useMemo(
    () =>
      [...tokens]
        .filter((token) => Number.isFinite(Number(token.change24hPct)) && Number(token.change24hPct) >= 0)
        .sort((a, b) => Number(b.change24hPct) - Number(a.change24hPct))
        .slice(0, 5),
    [tokens]
  );
  const losers = useMemo(
    () =>
      [...tokens]
        .filter((token) => Number.isFinite(Number(token.change24hPct)) && Number(token.change24hPct) < 0)
        .sort((a, b) => Number(a.change24hPct) - Number(b.change24hPct))
        .slice(0, 5),
    [tokens]
  );

  if (showInitialSkeleton) {
    return (
      <section className="-mx-4 border-t border-tl-border bg-black py-4">
        <div className="px-4 animate-pulse">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="block h-6 w-40 bg-[#1f1f1f]" />
            <span className="block h-4 w-28 bg-[#1f1f1f]" />
          </div>

          <div className="grid gap-3 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <article key={`pulse-card-${index}`} className="bg-black px-3 py-3">
                <span className="mb-2 block h-4 w-24 bg-[#1f1f1f]" />
                <div className="grid grid-cols-2 gap-2">
                  <span className="block h-12 bg-[#1f1f1f]" />
                  <span className="block h-12 bg-[#1f1f1f]" />
                  <span className="block h-12 bg-[#1f1f1f]" />
                  <span className="block h-12 bg-[#1f1f1f]" />
                </div>
              </article>
            ))}
          </div>

          <article className="mt-3 bg-black px-3 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="block h-4 w-56 bg-[#1f1f1f]" />
              <span className="block h-5 w-16 bg-[#1f1f1f]" />
            </div>
            <span className="mb-3 block h-4 w-72 bg-[#1f1f1f]" />
            <div className="grid gap-3 xl:grid-cols-2">
              {Array.from({ length: 2 }).map((_, panelIndex) => (
                <article key={`pulse-list-${panelIndex}`} className="border border-tl-border bg-black px-2 py-2">
                  <span className="mb-2 block h-4 w-24 bg-[#1f1f1f]" />
                  <ul className="grid gap-1">
                    {Array.from({ length: 5 }).map((__, rowIndex) => (
                      <li key={`pulse-row-${panelIndex}-${rowIndex}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-2 py-1">
                        <span className="block h-4 w-28 bg-[#1f1f1f]" />
                        <span className="block h-8 w-16 bg-[#1f1f1f]" />
                        <span className="block h-8 w-16 bg-[#1f1f1f]" />
                        <span className="block h-8 w-24 bg-[#1f1f1f]" />
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </article>
        </div>
      </section>
    );
  }

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
          <article className=" bg-black px-3 py-3">
            <p className="mb-2 text-xs uppercase tracking-[0.08em] text-zinc-400">Coverage</p>
            <div className="grid grid-cols-2 gap-2">
              <StatPill label="Ready" value={formatNumber(readyCount)} tone="neutral" />
              <StatPill label="Pending" value={formatNumber(pendingCount)} tone="neutral" />
              <StatPill label="Errors" value={formatNumber(errorCount)} tone={errorCount > 0 ? "red" : "neutral"} />
              <StatPill label="Avg score" value={averageScore === null ? "n/a" : `${averageScore}%`} tone="neutral" />
            </div>
          </article>

          <article className=" bg-black px-3 py-3">
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

          <article className=" bg-black px-3 py-3">
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

        <article className="mt-3 bg-black px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm uppercase tracking-[0.08em] text-zinc-400">
              Risk Movers: Top Gainers & Top Losers
            </p>
            <div className="flex items-center gap-1">
              {CHART_TIMEFRAME_OPTIONS.map((timeframe) => (
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
          <p className="mb-3 text-xs text-amber-300">
            `Risk Δ%` and charts represent TrustLayer risk-score movement (0-100).
            `Price 24h %` is shown separately for market context.
          </p>
          <div className="grid gap-3 xl:grid-cols-2">
            <article className="border border-tl-border bg-black px-2 py-2">
              <p className="mb-1 px-1 text-sm font-semibold uppercase tracking-[0.06em] text-green-300">
                Top Gainers
              </p>
              {gainers.length === 0 ? (
                <p className="px-1 py-1 text-sm text-zinc-500">No gainers in current sample.</p>
              ) : (
                <ul className="grid gap-1">
                  {gainers.map((token) => {
                    const trend = trendByMint[token.mint];
                    const points = Array.isArray(trend?.points) ? trend.points : [];
                    const changePct = Number.isFinite(Number(trend?.changePct)) ? Number(trend?.changePct) : 0;
                    const change = Number(changePct || 0);
                    const isActive = selectedMint === token.mint;
                    const price24h = Number(token.change24hPct);
                    const riskToneClass = change >= 0 ? "text-green-400" : "text-red-400";
                    const priceToneClass = Number.isFinite(price24h)
                      ? price24h >= 0
                        ? "text-green-300"
                        : "text-red-300"
                      : "text-zinc-500";
                    return (
                      <li key={`gainer-${token.mint}`}>
                        <button
                          type="button"
                          onClick={() => onAnalyzeToken(token.mint)}
                          className={`grid w-full grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-2 py-1 text-left transition-colors duration-150 ${
                            isActive ? "bg-[#191a1a]" : "hover:bg-[#101010]"
                          }`}
                        >
                          <span className="truncate text-sm text-zinc-200">
                            {token.name || token.symbol || token.mint}
                          </span>
                          <span className="w-20 text-right">
                            <span className="block text-[10px] uppercase tracking-[0.06em] text-zinc-500">
                              Risk Δ
                            </span>
                            <span className={`text-sm font-semibold ${riskToneClass}`}>
                              {formatSignedPercent(change)}
                            </span>
                          </span>
                          <span className="w-20 text-right">
                            <span className="block text-[10px] uppercase tracking-[0.06em] text-zinc-500">
                              Price 24h
                            </span>
                            <span className={`text-sm font-semibold ${priceToneClass}`}>
                              {formatSignedPercent(token.change24hPct)}
                            </span>
                          </span>
                          <span className="justify-self-end">
                            <MiniPriceSparkline prices={points} fallbackChangePct={change} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>

            <article className="border border-tl-border bg-black px-2 py-2">
              <p className="mb-1 px-1 text-sm font-semibold uppercase tracking-[0.06em] text-red-400">
                Top Losers
              </p>
              {losers.length === 0 ? (
                <p className="px-1 py-1 text-sm text-zinc-500">No losers in current sample.</p>
              ) : (
                <ul className="grid gap-1">
                  {losers.map((token) => {
                    const trend = trendByMint[token.mint];
                    const points = Array.isArray(trend?.points) ? trend.points : [];
                    const changePct = Number.isFinite(Number(trend?.changePct)) ? Number(trend?.changePct) : 0;
                    const change = Number(changePct || 0);
                    const isActive = selectedMint === token.mint;
                    const price24h = Number(token.change24hPct);
                    const riskToneClass = change >= 0 ? "text-green-400" : "text-red-400";
                    const priceToneClass = Number.isFinite(price24h)
                      ? price24h >= 0
                        ? "text-green-300"
                        : "text-red-300"
                      : "text-zinc-500";
                    return (
                      <li key={`loser-${token.mint}`}>
                        <button
                          type="button"
                          onClick={() => onAnalyzeToken(token.mint)}
                          className={`grid w-full grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-2 py-1 text-left transition-colors duration-150 ${
                            isActive ? "bg-[#191a1a]" : "hover:bg-[#101010]"
                          }`}
                        >
                          <span className="truncate text-sm text-zinc-200">
                            {token.name || token.symbol || token.mint}
                          </span>
                          <span className="w-20 text-right">
                            <span className="block text-[10px] uppercase tracking-[0.06em] text-zinc-500">
                              Risk Δ
                            </span>
                            <span className={`text-sm font-semibold ${riskToneClass}`}>
                              {formatSignedPercent(change)}
                            </span>
                          </span>
                          <span className="w-20 text-right">
                            <span className="block text-[10px] uppercase tracking-[0.06em] text-zinc-500">
                              Price 24h
                            </span>
                            <span className={`text-sm font-semibold ${priceToneClass}`}>
                              {formatSignedPercent(token.change24hPct)}
                            </span>
                          </span>
                          <span className="justify-self-end">
                            <MiniPriceSparkline prices={points} fallbackChangePct={change} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          </div>
        </article>
      </div>
    </section>
  );
}
