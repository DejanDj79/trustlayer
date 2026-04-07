import { useState } from "react";
import {
  fallbackLogoUrlForMint,
  initials,
  riskBandFromScore,
  shortMint
} from "../lib/format";
import type {
  TokenRiskState,
  WatchlistAlertPreference,
  WatchlistItem
} from "../types";

interface WatchlistPanelProps {
  items: WatchlistItem[];
  risks: Record<string, TokenRiskState>;
  alertMints?: Set<string>;
  alertPreferences?: Record<string, WatchlistAlertPreference>;
  selectedMint: string | null;
  onAnalyzeMint: (mint: string) => void;
  onRemoveMint: (mint: string) => void;
  onToggleMute?: (mint: string) => void;
  onToggleSnooze?: (mint: string) => void;
  showHeader?: boolean;
  compact?: boolean;
}

function WatchlistLogo({ item }: { item: WatchlistItem }) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = (item.imageUrl || "").trim() || fallbackLogoUrlForMint(item.mint);
  const showImage = Boolean(imageUrl) && !imageFailed;
  return (
    <div
      className="relative grid h-8 w-8 place-items-center overflow-hidden rounded-full border border-tl-border bg-transparent text-[10px] font-extrabold text-tl-text"
      style={{ borderRadius: "9999px", clipPath: "circle(50% at 50% 50%)" }}
    >
      {!showImage ? <span>{initials(item.symbol, item.name)}</span> : null}
      {showImage ? (
        <img
          src={imageUrl}
          alt={`${item.name || item.symbol || "Token"} logo`}
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

function WatchRisk({ risk }: { risk: TokenRiskState | undefined }) {
  if (!risk || risk.state === "pending") {
    return <span className="text-xs text-tl-muted">...</span>;
  }
  if (risk.state === "error") {
    return <span className="text-xs text-red-400">n/a</span>;
  }
  const numericScore = Number(risk.score);
  const scoreText = Number.isFinite(numericScore) ? `${Math.round(numericScore)}%` : "n/a";
  const band = riskBandFromScore(numericScore);
  const colorClass = band === "green" ? "text-green-300" : band === "red" ? "text-red-500" : "text-amber-300";
  return <span className={`text-xs font-bold ${colorClass}`}>{scoreText}</span>;
}

export function WatchlistPanel({
  items,
  risks,
  alertMints,
  alertPreferences,
  selectedMint,
  onAnalyzeMint,
  onRemoveMint,
  onToggleMute,
  onToggleSnooze,
  showHeader = true,
  compact = false
}: WatchlistPanelProps) {
  return (
    <section className={compact ? "bg-transparent px-0 py-2" : "bg-transparent px-4 py-4"}>
      {showHeader ? (
        <>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="font-display text-base font-bold text-tl-text">Watchlist</h3>
            <p className="text-[11px] text-tl-muted">{items.length} token(s)</p>
          </div>
          <p className="mb-3 text-xs text-tl-muted">Auto-refresh score every 2 minutes.</p>
        </>
      ) : (
        <p className="mb-2 text-xs text-tl-muted">Auto-refresh score every 2 minutes.</p>
      )}

      {items.length === 0 ? (
        <div className="border border-tl-border bg-black px-3 py-3 text-xs text-tl-muted">
          Add tokens from the table or from the active analysis panel.
        </div>
      ) : (
        <ul className="grid gap-2">
          {items.map((item) => {
            const isSelected = selectedMint === item.mint;
            const hasAlert = alertMints?.has(item.mint) || false;
            const preference = alertPreferences?.[item.mint];
            const muted = Boolean(preference?.muted);
            const snoozedUntil = String(preference?.snoozedUntil || "").trim();
            const snoozedUntilMs = snoozedUntil ? new Date(snoozedUntil).getTime() : 0;
            const snoozed = Number.isFinite(snoozedUntilMs) && snoozedUntilMs > Date.now();
            return (
              <li
                key={item.mint}
                className={`border border-tl-border px-3 py-2 ${
                  isSelected ? "bg-[#202020]" : "bg-black"
                }`}
              >
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => onAnalyzeMint(item.mint)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <WatchlistLogo item={item} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-tl-text">
                          {item.name || "Unknown Token"}
                        </span>
                        <span className="block truncate text-xs text-tl-muted">
                          {item.symbol || "N/A"} · {shortMint(item.mint)}
                        </span>
                      </span>
                    </button>

                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      {muted ? (
                        <span className="rounded-sm border border-zinc-600/70 bg-zinc-900/70 px-1 py-0.5 text-[10px] font-semibold text-zinc-300">
                          Muted
                        </span>
                      ) : null}
                      {!muted && snoozed ? (
                        <span className="rounded-sm border border-sky-500/50 bg-sky-950/40 px-1 py-0.5 text-[10px] font-semibold text-sky-300">
                          Snoozed
                        </span>
                      ) : null}
                      {hasAlert ? (
                        <span className="rounded-sm border border-red-500/40 bg-red-950/40 px-1 py-0.5 text-[10px] font-semibold text-red-300">
                          Alert
                        </span>
                      ) : null}
                      <WatchRisk risk={risks[item.mint]} />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2 pl-0 sm:pl-10">
                    {onToggleMute ? (
                      <button
                        type="button"
                        onClick={() => onToggleMute(item.mint)}
                        className={`border px-2 py-1 text-[11px] ${
                          muted
                            ? "border-zinc-600 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                            : "border-tl-border bg-black text-zinc-300 hover:bg-[#111111]"
                        }`}
                      >
                        {muted ? "Unmute" : "Mute"}
                      </button>
                    ) : null}
                    {onToggleSnooze ? (
                      <button
                        type="button"
                        onClick={() => onToggleSnooze(item.mint)}
                        className={`border px-2 py-1 text-[11px] ${
                          !muted && snoozed
                            ? "border-sky-500/50 bg-sky-950/40 text-sky-300 hover:bg-sky-900/40"
                            : "border-tl-border bg-black text-zinc-300 hover:bg-[#111111]"
                        }`}
                      >
                        {!muted && snoozed ? "Unsnooze" : "Snooze 1h"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onRemoveMint(item.mint)}
                      className="border border-tl-border bg-black px-2 py-1 text-[11px] text-zinc-300 hover:bg-[#111111]"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
