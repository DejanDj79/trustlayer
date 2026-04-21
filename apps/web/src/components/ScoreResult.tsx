import { useState } from "react";
import { formatNumber, formatUsd, riskBandFromScore, riskLabelFromBand, statusClasses } from "../lib/format";
import type { RpcHealthItem, ScoreHistoryResponse, ScoreResponse } from "../types";

function formatHolderSource(source: string | null | undefined): string {
  if (source === "rpc") {
    return "largest-holders RPC";
  }
  if (source === "rpc-token-accounts-exact") {
    return "token accounts (exact)";
  }
  if (source === "rpc-token-accounts-estimate") {
    return "token accounts (estimate)";
  }
  if (source === "heuristic") {
    return "heuristic fallback";
  }
  return source || "unknown";
}

function providersSummary(item: RpcHealthItem | undefined): string {
  if (!item?.providers || item.providers.length === 0) {
    return "";
  }
  return item.providers
    .slice(0, 2)
    .map((provider) => `${provider.endpoint}#${provider.attempt}: ${provider.message}`)
    .join(" | ");
}

function movementSummary(delta: number): string {
  const abs = Math.abs(delta);
  if (abs < 3) {
    return "Score is mostly stable.";
  }
  if (abs < 8) {
    return "Score moved slightly.";
  }
  if (abs < 15) {
    return "Score moved moderately.";
  }
  return "Score moved sharply.";
}

function formatSignalValue(value: number | null | undefined, unit?: string | null): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "n/a";
  }
  if (unit === "pct") {
    return `${numeric.toFixed(2)}%`;
  }
  return numeric.toFixed(2);
}

interface ParsedWarningEndpoint {
  provider: string;
  message: string;
}

interface ParsedWarning {
  title: string;
  summary: string | null;
  endpoints: ParsedWarningEndpoint[];
  raw: string;
}

function parseWarning(rawWarning: string): ParsedWarning {
  const raw = String(rawWarning || "").trim();
  if (!raw) {
    return {
      title: "Warning",
      summary: null,
      endpoints: [],
      raw: ""
    };
  }

  const firstColon = raw.indexOf(": ");
  if (firstColon <= 0) {
    return {
      title: "Warning",
      summary: raw,
      endpoints: [],
      raw
    };
  }

  const title = raw.slice(0, firstColon).trim();
  const remainder = raw.slice(firstColon + 2).trim();
  const secondColon = remainder.indexOf(": ");
  const hasEndpointSummary =
    secondColon > 0 &&
    remainder.includes("endpoint(s)") &&
    remainder.includes(" | ");

  if (!hasEndpointSummary) {
    return {
      title,
      summary: remainder || null,
      endpoints: [],
      raw
    };
  }

  const summary = remainder.slice(0, secondColon).trim();
  const details = remainder.slice(secondColon + 2).trim();
  const endpoints = details
    .split(" | ")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^([^:]+):\s*(.+)$/);
      if (!match) {
        return {
          provider: "provider",
          message: entry
        };
      }
      return {
        provider: match[1].trim(),
        message: match[2].trim()
      };
    });

  return {
    title,
    summary: summary || null,
    endpoints,
    raw
  };
}

interface ScoreResultProps {
  data: ScoreResponse;
  isLoading: boolean;
  historyData?: ScoreHistoryResponse | null;
  historyLoading?: boolean;
  historyError?: string | null;
}

export function ScoreResult({
  data,
  isLoading,
  historyData,
  historyLoading = false,
  historyError = null
}: ScoreResultProps) {
  const [historyWindow, setHistoryWindow] = useState<"24h" | "7d">("24h");
  const [isGlossaryOpen, setIsGlossaryOpen] = useState(false);
  const [showWarningDiagnostics, setShowWarningDiagnostics] = useState(false);

  if (isLoading) {
    return (
      <section className="bg-transparent px-4 py-4">
        <p className="text-sm uppercase tracking-[0.06em] text-blue-300">Analyzing token...</p>
      </section>
    );
  }

  const score = Number(data.score || 0);
  const boundedScore = Math.max(0, Math.min(100, score));
  const riskBand = riskBandFromScore(score);
  const riskLabel = riskLabelFromBand(riskBand);
  const confidence = String(data.scoreConfidence || "unknown").toUpperCase();
  const details = data.signalDetails || {};
  const scoreBreakdown = data.scoreBreakdown || null;
  const breakdownComponents = Array.isArray(scoreBreakdown?.components)
    ? scoreBreakdown.components
    : [];
  const breakdownAdjustments = Array.isArray(scoreBreakdown?.adjustments)
    ? scoreBreakdown.adjustments
    : [];

  const quickStats = [
    { label: "Liquidity", value: formatUsd(details.liquidityUsd) },
    { label: "24h Volume", value: formatUsd(details.volume24hUsd) },
    { label: "24h Tx", value: formatNumber(details.tx24h) },
    { label: "Pools", value: formatNumber(details.marketPairCount) }
  ];
  const historyPoints = Array.isArray(historyData?.points) ? historyData.points : [];
  const sortedHistory = [...historyPoints].sort((a, b) => {
    const aTs = Date.parse(a.timestamp || "");
    const bTs = Date.parse(b.timestamp || "");
    return aTs - bTs;
  });
  const now = Date.now();
  const windowMs = historyWindow === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const filteredHistory = sortedHistory.filter((point) => {
    const ts = Date.parse(point.timestamp || "");
    return Number.isFinite(ts) && ts >= now - windowMs;
  });
  const latestHistory = filteredHistory[filteredHistory.length - 1] || null;
  const previousHistory = filteredHistory[filteredHistory.length - 2] || null;
  const scoreDelta =
    latestHistory && previousHistory
      ? Number(latestHistory.score || 0) - Number(previousHistory.score || 0)
      : null;
  const historyScores = filteredHistory
    .map((point) => Number(point.score))
    .filter((value) => Number.isFinite(value));
  const minHistoryScore = historyScores.length > 0 ? Math.min(...historyScores) : null;
  const maxHistoryScore = historyScores.length > 0 ? Math.max(...historyScores) : null;
  const currentHistoryScore =
    latestHistory && Number.isFinite(Number(latestHistory.score))
      ? Number(latestHistory.score)
      : null;
  const previousScore = previousHistory ? Number(previousHistory.score || 0) : null;
  const scoreDeltaNow = previousScore !== null ? score - previousScore : null;
  const previousBand = previousScore !== null ? riskBandFromScore(previousScore) : null;
  const historyPolyline =
    filteredHistory.length >= 2
      ? filteredHistory
          .map((point, index) => {
            const x = (index / (filteredHistory.length - 1)) * 100;
            const y = 100 - Math.max(0, Math.min(100, Number(point.score || 0)));
            return `${x.toFixed(2)},${y.toFixed(2)}`;
          })
          .join(" ")
      : "";

  return (
    <section className="grid gap-3">
      <article className="bg-transparent px-4 pb-10 pt-5">
        <div className="grid gap-8">
          <div
            className="relative mx-auto grid h-36 w-36 place-items-center"
            style={{
              background: `conic-gradient(${riskBand === "green" ? "#22c55e" : riskBand === "red" ? "#ef4444" : "#f59e0b"} ${(boundedScore * 3.6).toFixed(2)}deg, #2a2a2a 0deg)`
            }}
          >
            <div className="grid h-[calc(100%-14px)] w-[calc(100%-14px)] place-items-center bg-black">
              <p className="font-display text-5xl mt-6 font-extrabold leading-none text-tl-text">{score}</p>
              <p className="text-[11px] uppercase tracking-[0.06em] text-tl-muted">Risk Score</p>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-3">
              <p className={`inline-flex px-2 py-1 text-sm font-bold tracking-[0.05em] ${statusClasses(riskBand)}`}>
                Risk: {riskLabel}
              </p>
              <p className="text-sm text-tl-muted">Confidence: {confidence}</p>
            </div>
            <p className="mt-1 text-xs text-tl-muted">
              Higher score means lower risk. Risk level and confidence are different signals: one is
              score severity, the other is data reliability.
            </p>
            <p className="mt-1 text-sm text-tl-muted">Data source: {data.dataSource || "unknown"}</p>
            {details.holderConcentrationSource ? (
              <p className="text-sm text-tl-muted">
                Holder source: {formatHolderSource(details.holderConcentrationSource)}
                {Number.isFinite(Number(details.holderSampleCoveragePct))
                  ? ` | coverage ${Number(details.holderSampleCoveragePct).toFixed(1)}%`
                  : ""}
                {Number.isFinite(Number(details.holderPagesFetched))
                  ? ` | ${Number(details.holderPagesFetched)} page(s)`
                  : ""}
              </p>
            ) : null}

            <div className="mt-3 bg-black px-3 py-2">
              {quickStats.map((item, index) => (
                <div
                  key={item.label}
                  className={`flex items-center justify-between gap-3 py-2 ${
                    index < quickStats.length - 1 ? "border-b border-tl-border" : ""
                  }`}
                >
                  <p className="text-[11px] uppercase tracking-[0.06em] text-tl-muted">{item.label}</p>
                  <p className="text-right text-sm font-bold text-tl-text">{item.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-3 bg-black px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-[11px] uppercase tracking-[0.06em] text-tl-muted">Score History</p>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1">
                    {(["24h", "7d"] as const).map((windowKey) => (
                      <button
                        key={windowKey}
                        type="button"
                        onClick={() => setHistoryWindow(windowKey)}
                        className={`border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                          historyWindow === windowKey
                            ? "border-sky-500/50 bg-sky-950/40 text-sky-300"
                            : "border-tl-border bg-black text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        {windowKey}
                      </button>
                    ))}
                  </div>
                  {scoreDelta !== null ? (
                    <p
                      className={`text-xs font-bold ${
                        scoreDelta > 0 ? "text-green-300" : scoreDelta < 0 ? "text-red-400" : "text-tl-muted"
                      }`}
                    >
                      {scoreDelta > 0 ? "+" : ""}
                      {Math.round(scoreDelta)}
                    </p>
                  ) : null}
                </div>
              </div>

              {historyLoading ? (
                <p className="text-xs text-tl-muted">Loading history...</p>
              ) : historyError ? (
                <p className="text-xs text-red-400">{historyError}</p>
              ) : filteredHistory.length < 2 ? (
                <p className="text-xs text-tl-muted">
                  Need at least 2 points in selected {historyWindow} window.
                </p>
              ) : (
                <>
                  <div className="h-24 w-full border border-tl-border bg-[#050505] px-2 py-2">
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
                      <polyline
                        fill="none"
                        stroke="#60a5fa"
                        strokeWidth="2.2"
                        vectorEffect="non-scaling-stroke"
                        points={historyPolyline}
                      />
                    </svg>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-tl-muted">
                    <span>{filteredHistory.length} points ({historyWindow})</span>
                    <span>
                      Latest:{" "}
                      {latestHistory?.timestamp
                        ? new Date(latestHistory.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit"
                          })
                        : "n/a"}
                    </span>
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-tl-muted">
                    <span>Min: {minHistoryScore !== null ? Math.round(minHistoryScore) : "n/a"}</span>
                    <span className="text-center">
                      Current: {currentHistoryScore !== null ? Math.round(currentHistoryScore) : "n/a"}
                    </span>
                    <span className="text-right">
                      Max: {maxHistoryScore !== null ? Math.round(maxHistoryScore) : "n/a"}
                    </span>
                  </div>
                </>
              )}
            </div>

            <div className="mt-3 bg-black px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-[11px] uppercase tracking-[0.06em] text-tl-muted">Why Score Changed</p>
                {scoreDeltaNow !== null ? (
                  <p
                    className={`text-xs font-bold ${
                      scoreDeltaNow > 0
                        ? "text-red-400"
                        : scoreDeltaNow < 0
                          ? "text-green-300"
                          : "text-tl-muted"
                    }`}
                  >
                    {scoreDeltaNow > 0 ? "+" : ""}
                    {Math.round(scoreDeltaNow)} pts
                  </p>
                ) : null}
              </div>

              {scoreDeltaNow === null ? (
                <p className="text-xs text-tl-muted">
                  Need at least one previous snapshot to explain score movement.
                </p>
              ) : (
                <div className="grid gap-1 text-xs text-tl-muted">
                  <p>
                    Current score is {Math.round(score)} vs previous {Math.round(previousScore || 0)}.{" "}
                    {movementSummary(scoreDeltaNow)}
                  </p>
                  {previousBand ? (
                    <p>
                      Risk transition: {riskLabelFromBand(previousBand)} to {riskLabel}.
                    </p>
                  ) : null}
                  <p>Current confidence: {confidence.toLowerCase()}.</p>
                  {(data.reasons || []).length > 0 ? (
                    <p className="truncate">Top factor now: {(data.reasons || [])[0]}</p>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>
      </article>

      <div className="grid gap-3">
        <article className="bg-transparent px-4 py-2">
          <button
            type="button"
            onClick={() => setIsGlossaryOpen((current) => !current)}
            className="flex w-full items-center justify-between border border-tl-border bg-black px-3 py-2 text-left transition-colors duration-150 hover:bg-[#101010]"
          >
            <span className="font-display text-base font-bold text-tl-text">Quick Glossary</span>
            <span className="text-xs text-tl-muted">{isGlossaryOpen ? "Hide" : "Show"}</span>
          </button>
          {isGlossaryOpen ? (
            <ul className="grid border-x border-b border-tl-border bg-black px-3 py-2">
              {[
                "Mint authority: if enabled, token supply can still be increased.",
                "Freeze authority: if enabled, specific token accounts can be frozen.",
                "Holder concentration: how much supply is held by the largest wallets.",
                "Liquidity: available depth across tracked pools.",
                "Activity: recent volume and transaction activity proxies.",
                "Confidence: reliability of available data sources."
              ].map((item) => (
                <li key={item} className="border-b border-tl-border py-1.5 text-xs text-tl-muted last:border-b-0">
                  {item}
                </li>
              ))}
            </ul>
          ) : null}
        </article>

        <article className="bg-transparent px-4 py-4">
          <h3 className="font-display mb-2 text-base font-bold text-tl-text">Score Math</h3>
          {breakdownComponents.length === 0 ? (
            <p className="text-sm text-tl-muted">Score breakdown is unavailable for this response.</p>
          ) : (
            <>
              <ul className="grid gap-2">
                {breakdownComponents.map((component) => (
                  <li key={component.key} className="bg-black px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-tl-text">{component.label}</p>
                        <p className="text-xs text-tl-muted">
                          {component.signalLabel || "Signal"}:{" "}
                          {formatSignalValue(component.signalValue, component.signalUnit)} | weight{" "}
                          {component.weightPct}%
                        </p>
                      </div>
                      <p className="text-sm font-bold text-sky-300">
                        +{Number(component.contribution || 0).toFixed(2)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-2 border border-tl-border bg-black px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-3 text-tl-muted">
                  <p>Base score</p>
                  <p className="font-semibold text-tl-text">
                    {Math.round(Number(scoreBreakdown?.baseScore || 0))}{" "}
                    <span className="text-xs text-tl-muted">
                      ({Number(scoreBreakdown?.baseScoreRaw || 0).toFixed(2)} raw)
                    </span>
                  </p>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 text-tl-muted">
                  <p>Final score</p>
                  <p className="font-semibold text-tl-text">
                    {Math.round(Number(scoreBreakdown?.finalScore || score))}
                  </p>
                </div>
              </div>
              {breakdownAdjustments.length > 0 ? (
                <ul className="mt-2 grid gap-2">
                  {breakdownAdjustments.map((adjustment, index) => (
                    <li key={`${adjustment.key}-${index}`} className="bg-black px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm text-tl-text">{adjustment.label}</p>
                        <p
                          className={`text-sm font-semibold ${
                            Number(adjustment.delta) < 0
                              ? "text-red-300"
                              : Number(adjustment.delta) > 0
                                ? "text-green-300"
                                : "text-tl-muted"
                          }`}
                        >
                          {Number(adjustment.delta) > 0 ? "+" : ""}
                          {Number(adjustment.delta).toFixed(2)}
                        </p>
                      </div>
                      <p className="mt-1 text-xs text-tl-muted">
                        {Math.round(Number(adjustment.beforeScore || 0))}
                        {" -> "}
                        {Math.round(Number(adjustment.afterScore || 0))}
                      </p>
                      {adjustment.note ? (
                        <p className="mt-1 text-xs text-tl-muted break-words">{adjustment.note}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {scoreBreakdown?.statusDowngraded && scoreBreakdown.statusDowngradeReason ? (
                <p className="mt-2 text-xs text-amber-300 break-words">
                  {scoreBreakdown.statusDowngradeReason}
                </p>
              ) : null}
            </>
          )}
        </article>

        <article className="bg-transparent px-4 py-4">
          <h3 className="font-display mb-2 text-base font-bold text-tl-text">Signal Breakdown</h3>
          <ul className="grid gap-2">
            {(data.reasons || []).map((reason, index) => (
              <li key={`${reason}-${index}`} className="bg-black px-3 py-2 text-sm text-tl-text">
                {reason}
              </li>
            ))}
          </ul>
        </article>

        <article className="bg-transparent px-4 py-4">
          <h3 className="font-display mb-2 text-base font-bold text-tl-text">RPC Health</h3>
          <ul className="grid gap-2">
            {[
              { label: "Largest holders RPC", item: data.rpcHealth?.largestHolders },
              { label: "Token accounts fallback", item: data.rpcHealth?.tokenAccountsFallback },
              { label: "Token supply RPC", item: data.rpcHealth?.tokenSupply }
            ].map(({ label, item }) => (
              <li key={label} className="bg-black px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-tl-text">{label}</p>
                  <p className={`px-2 py-1 text-xs font-bold ${statusClasses(item?.status || "yellow")}`}>
                    {String(item?.status || "unknown").toUpperCase()}
                  </p>
                </div>
                {item?.note ? <p className="mt-1 text-xs text-tl-muted">{item.note}</p> : null}
                {providersSummary(item) ? <p className="mt-1 text-xs text-tl-muted">{providersSummary(item)}</p> : null}
              </li>
            ))}
          </ul>
        </article>
      </div>

      {Array.isArray(data.warnings) && data.warnings.length > 0 ? (
        <article className="border border-[#6e590f] bg-[#3a3006]/45 px-4 py-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="font-display text-lg font-bold text-[#f2dc8c]">Warnings</h3>
            <button
              type="button"
              onClick={() => setShowWarningDiagnostics((current) => !current)}
              className="border border-[#6e590f] bg-[#2c2507]/70 px-2 py-1 text-xs text-[#f2dc8c] hover:bg-[#332a08]"
            >
              {showWarningDiagnostics ? "Hide provider diagnostics" : "Show provider diagnostics"}
            </button>
          </div>
          <ul className="grid gap-3">
            {data.warnings.map((warning, index) => {
              const parsed = parseWarning(warning);
              return (
                <li
                  key={`${warning}-${index}`}
                  className="border border-[#5f4e0d] bg-[#2c2507]/70 px-3 py-2"
                >
                  <p className="text-base font-semibold text-[#f2dc8c]">{parsed.title}</p>
                  {parsed.summary ? (
                    <p className="mt-1 text-sm leading-snug text-[#e8d487] break-words">
                      {parsed.summary}
                    </p>
                  ) : null}
                  {parsed.endpoints.length > 0 && showWarningDiagnostics ? (
                    <ul className="mt-2 grid gap-1.5 pl-4">
                      {parsed.endpoints.map((endpoint, endpointIndex) => (
                        <li
                          key={`${endpoint.provider}-${endpointIndex}`}
                          className="list-item list-disc marker:text-[#f2dc8c]"
                        >
                          <p className="text-sm leading-snug text-[#dcc57a] break-words">
                            <span className="font-semibold text-[#f2dc8c] break-all">
                              {endpoint.provider}
                            </span>
                            : {endpoint.message}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : parsed.endpoints.length > 0 ? (
                    <p className="mt-2 text-xs text-[#dcc57a]">
                      Provider diagnostics hidden. Expand to inspect endpoint-level failures.
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </article>
      ) : null}
    </section>
  );
}
