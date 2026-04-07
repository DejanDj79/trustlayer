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
  const latestHistory = sortedHistory[sortedHistory.length - 1] || null;
  const previousHistory = sortedHistory[sortedHistory.length - 2] || null;
  const scoreDelta =
    latestHistory && previousHistory
      ? Number(latestHistory.score || 0) - Number(previousHistory.score || 0)
      : null;
  const historyPolyline =
    sortedHistory.length >= 2
      ? sortedHistory
          .map((point, index) => {
            const x = (index / (sortedHistory.length - 1)) * 100;
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
              Risk level and confidence are different signals: one is score severity, the other is data reliability.
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

              {historyLoading ? (
                <p className="text-xs text-tl-muted">Loading history...</p>
              ) : historyError ? (
                <p className="text-xs text-red-400">{historyError}</p>
              ) : sortedHistory.length < 2 ? (
                <p className="text-xs text-tl-muted">Need at least 2 points to draw timeline.</p>
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
                    <span>{sortedHistory.length} points</span>
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
                </>
              )}
            </div>
          </div>
        </div>
      </article>

      <div className="grid gap-3">
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
        <article className="bg-amber-950 px-4 py-4">
          <h3 className="font-display mb-2 text-base font-bold text-amber-200">Warnings</h3>
          <ul className="grid gap-2">
            {data.warnings.map((warning, index) => (
              <li key={`${warning}-${index}`} className="bg-[#1a1208] px-3 py-2 text-sm text-amber-200">
                {warning}
              </li>
            ))}
          </ul>
        </article>
      ) : null}
    </section>
  );
}
