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

function normalizeConfidence(value: string | null | undefined): "high" | "medium" | "low" | "unknown" {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  return "unknown";
}

function confidenceClass(confidence: "high" | "medium" | "low" | "unknown"): string {
  if (confidence === "high") {
    return "text-green-300";
  }
  if (confidence === "medium") {
    return "text-amber-300";
  }
  if (confidence === "low") {
    return "text-red-400";
  }
  return "text-zinc-500";
}

function formatScoreValue(value: number | null | undefined): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "n/a";
  }
  return `${numeric.toFixed(1)}%`;
}

function formatCompactUsd(value: number | null | undefined): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "n/a";
  }
  if (numeric >= 1_000_000_000) {
    return `$${(numeric / 1_000_000_000).toFixed(1)}B`;
  }
  if (numeric >= 1_000_000) {
    return `$${(numeric / 1_000_000).toFixed(1)}M`;
  }
  if (numeric >= 1_000) {
    return `$${(numeric / 1_000).toFixed(1)}K`;
  }
  return `$${numeric.toFixed(0)}`;
}

function statusColorClass(status: string | null | undefined): string {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "green") {
    return "border-green-400 bg-green-500/70";
  }
  if (normalized === "red") {
    return "border-red-400 bg-red-500/70";
  }
  return "border-amber-300 bg-amber-400/70";
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

  const riskChangeLeaderboard = useMemo(() => {
    const rows = tokens
      .map((token) => {
        const trend = trendByMint[token.mint];
        const points = Array.isArray(trend?.points) ? trend.points : [];
        const risk = risks[token.mint];
        const nowScoreFromTrend =
          points.length > 0 ? Number(points[points.length - 1]) : Number.NaN;
        const nowScoreFromRisk = Number(risk?.score);
        const nowScore = Number.isFinite(nowScoreFromTrend)
          ? nowScoreFromTrend
          : Number.isFinite(nowScoreFromRisk)
            ? nowScoreFromRisk
            : null;
        const previousScore = points.length >= 2 ? Number(points[0]) : null;
        const deltaScore =
          Number.isFinite(Number(nowScore)) && Number.isFinite(Number(previousScore))
            ? Number(nowScore) - Number(previousScore)
            : null;
        const confidence = normalizeConfidence(risk?.scoreConfidence);

        return {
          mint: token.mint,
          name: token.name || token.symbol || token.mint,
          nowScore,
          previousScore,
          deltaScore,
          confidence
        };
      })
      .filter((row) => Number.isFinite(Number(row.nowScore)));

    rows.sort((a, b) => {
      const absA = Math.abs(Number(a.deltaScore || 0));
      const absB = Math.abs(Number(b.deltaScore || 0));
      if (absB !== absA) {
        return absB - absA;
      }
      return String(a.name).localeCompare(String(b.name));
    });

    return rows.slice(0, 10);
  }, [tokens, trendByMint, risks]);

  const liquidityVsConcentration = useMemo(() => {
    const base = tokens
      .map((token) => {
        const risk = risks[token.mint];
        const details = risk?.signalDetails || {};
        const liquidityUsd = Number(details.liquidityUsd);
        const holderConcentrationPct = Number(details.holderConcentrationPct);
        if (
          risk?.state !== "ready" ||
          !Number.isFinite(liquidityUsd) ||
          liquidityUsd <= 0 ||
          !Number.isFinite(holderConcentrationPct)
        ) {
          return null;
        }
        return {
          mint: token.mint,
          symbol: token.symbol || "N/A",
          name: token.name || token.symbol || token.mint,
          liquidityUsd,
          holderConcentrationPct: Math.max(0, Math.min(100, holderConcentrationPct)),
          status: risk.status || "yellow"
        };
      })
      .filter((row): row is {
        mint: string;
        symbol: string;
        name: string;
        liquidityUsd: number;
        holderConcentrationPct: number;
        status: string;
      } => row !== null);

    if (base.length === 0) {
      return [];
    }

    const logValues = base.map((row) => Math.log10(Math.max(1, row.liquidityUsd)));
    const logMin = Math.min(...logValues);
    const logMax = Math.max(...logValues);
    const logSpan = Math.max(1e-9, logMax - logMin);

    return base
      .map((row) => {
        const xPct = ((Math.log10(Math.max(1, row.liquidityUsd)) - logMin) / logSpan) * 100;
        const yPct = 100 - row.holderConcentrationPct;
        return {
          ...row,
          xPct: Math.max(2, Math.min(98, xPct)),
          yPct: Math.max(2, Math.min(98, yPct))
        };
      })
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  }, [tokens, risks]);

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

          <article className="mt-3 border border-tl-border bg-black px-3 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="block h-4 w-56 bg-[#1f1f1f]" />
              <span className="block h-4 w-32 bg-[#1f1f1f]" />
            </div>
            <div className="mb-1 grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-3 px-2 py-1">
              <span className="block h-3 w-20 bg-[#1f1f1f]" />
              <span className="block h-3 w-16 bg-[#1f1f1f]" />
              <span className="block h-3 w-16 bg-[#1f1f1f]" />
              <span className="block h-3 w-16 bg-[#1f1f1f]" />
              <span className="block h-3 w-20 bg-[#1f1f1f]" />
            </div>
            <div className="grid gap-1">
              {Array.from({ length: 8 }).map((_, rowIndex) => (
                <div
                  key={`risk-leader-skeleton-${rowIndex}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-3 px-2 py-1"
                >
                  <span className="block h-4 w-40 bg-[#1f1f1f]" />
                  <span className="block h-4 w-14 bg-[#1f1f1f]" />
                  <span className="block h-4 w-14 bg-[#1f1f1f]" />
                  <span className="block h-4 w-14 bg-[#1f1f1f]" />
                  <span className="block h-4 w-18 bg-[#1f1f1f]" />
                </div>
              ))}
            </div>
          </article>

          <article className="mt-3 border border-tl-border bg-black px-3 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="block h-4 w-64 bg-[#1f1f1f]" />
              <span className="block h-4 w-36 bg-[#1f1f1f]" />
            </div>
            <span className="mb-2 block h-4 w-80 bg-[#1f1f1f]" />
            <div className="h-64 border border-tl-border bg-[#0b0b0b]" />
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

        <article className="mt-3 bg-black px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm uppercase tracking-[0.08em] text-zinc-300">
              Risk Change Leaderboard ({moverTimeframe})
            </p>
            <span className="text-[15px] text-zinc-500">Top absolute score movers</span>
          </div>
          <div className="mb-1 grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-3 border-b border-tl-border px-2 py-1 text-xs uppercase tracking-[0.08em] text-zinc-500">
            <span>Token</span>
            <span className="w-20 text-right">Now</span>
            <span className="w-20 text-right">Start</span>
            <span className="w-20 text-right">Delta</span>
            <span className="w-24 text-right">Confidence</span>
          </div>
          {riskChangeLeaderboard.length === 0 ? (
            <p className="text-sm text-zinc-500">Not enough scored tokens to build leaderboard.</p>
          ) : (
            <ul className="grid gap-1">
              {riskChangeLeaderboard.map((row) => {
                const delta = Number(row.deltaScore);
                const deltaClass =
                  Number.isFinite(delta) && delta > 0
                    ? "text-green-300"
                    : Number.isFinite(delta) && delta < 0
                      ? "text-red-400"
                      : "text-zinc-500";
                return (
                  <li key={`risk-leader-${row.mint}`}>
                    <button
                      type="button"
                      onClick={() => onAnalyzeToken(row.mint)}
                      className={`grid w-full grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-3 px-2 py-1 text-left transition-colors duration-150 ${
                        selectedMint === row.mint ? "bg-[#191a1a]" : "hover:bg-[#101010]"
                      }`}
                    >
                      <span className="truncate text-sm text-zinc-200">{row.name}</span>
                      <span className="w-20 text-right text-xs text-zinc-400">
                        {formatScoreValue(row.nowScore)}
                      </span>
                      <span className="w-20 text-right text-xs text-zinc-500">
                        {formatScoreValue(row.previousScore)}
                      </span>
                      <span className={`w-20 text-right text-xs font-semibold ${deltaClass}`}>
                        {Number.isFinite(delta) ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}` : "n/a"}
                      </span>
                      <span className={`w-24 text-right text-[13px] uppercase ${confidenceClass(row.confidence)}`}>
                        {row.confidence}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </article>

        <article className="mt-3 border border-tl-border bg-black px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm uppercase tracking-[0.08em] text-zinc-300">
              Liquidity vs Holder Concentration
            </p>
            <span className="text-[14px] text-zinc-500">Click a point to analyze token</span>
          </div>
          <p className="mb-2 text-xs text-zinc-500">
            Higher concentration means higher centralization risk.
          </p>
          {liquidityVsConcentration.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Not enough tokens with liquidity and holder concentration data for this view.
            </p>
          ) : (
            <>
              <div className="flex items-stretch gap-2">
                <div className="flex w-6 shrink-0 items-center justify-center text-[12px] uppercase tracking-[0.06em] text-zinc-500 [writing-mode:vertical-rl]">
                  Holder Concentration
                </div>
                <div className="relative h-64 flex-1 overflow-hidden border border-tl-border bg-[#0b0b0b]">
                  <div className="pointer-events-none absolute inset-0">
                    <div className="absolute left-0 top-1/3 h-px w-full bg-[#202020]" />
                    <div className="absolute left-0 top-2/3 h-px w-full bg-[#202020]" />
                    <div className="absolute left-1/3 top-0 h-full w-px bg-[#202020]" />
                    <div className="absolute left-2/3 top-0 h-full w-px bg-[#202020]" />
                  </div>
                  {liquidityVsConcentration.map((point) => (
                    <button
                      key={`liq-conc-${point.mint}`}
                      type="button"
                      onClick={() => onAnalyzeToken(point.mint)}
                      title={`${point.name} | Liquidity ${formatCompactUsd(point.liquidityUsd)} | Concentration ${point.holderConcentrationPct.toFixed(1)}%`}
                      className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 appearance-none border-0 bg-transparent p-0"
                      style={{
                        left: `${point.xPct}%`,
                        top: `${point.yPct}%`
                      }}
                    >
                      <span
                        className={`tl-circle block h-2 w-2 border ${statusColorClass(point.status)} ${
                          selectedMint === point.mint ? "ring-2 ring-white/70" : ""
                        }`}
                      />
                    </button>
                  ))}
                  <div className="pointer-events-none absolute bottom-1 left-2 text-[10px] uppercase tracking-[0.06em] text-zinc-500">
                    Lower Liquidity
                  </div>
                  <div className="pointer-events-none absolute bottom-1 right-2 text-[10px] uppercase tracking-[0.06em] text-zinc-500">
                    Higher Liquidity
                  </div>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-4 text-[13px] text-zinc-400">
                <span className="inline-flex items-center gap-1"><span className="tl-circle h-2 w-2 shrink-0 border border-green-400 bg-green-500/70" /> Low risk</span>
                <span className="inline-flex items-center gap-1"><span className="tl-circle h-2 w-2 shrink-0 border border-amber-300 bg-amber-400/70" /> Medium risk</span>
                <span className="inline-flex items-center gap-1"><span className="tl-circle h-2 w-2 shrink-0 border border-red-400 bg-red-500/70" /> High risk</span>
              </div>
            </>
          )}
        </article>
      </div>
    </section>
  );
}
