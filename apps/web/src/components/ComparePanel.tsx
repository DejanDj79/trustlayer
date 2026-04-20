import { useEffect, useRef, useState } from "react";
import {
  fallbackLogoUrlForMint,
  formatNumber,
  formatUsd,
  initials,
  riskBandFromScore,
  riskLabelFromBand,
  shortMint,
  statusClasses
} from "../lib/format";
import type { CompareResponse, TokenSearchItem } from "../types";

interface ComparePanelProps {
  activeMint: string;
  compareMint: string;
  onCompareMintChange: (value: string) => void;
  suggestions: TokenSearchItem[];
  onSelectSuggestion: (token: TokenSearchItem) => void;
  onCompare: () => Promise<void> | void;
  isLoading: boolean;
  errorMessage: string | null;
  data: CompareResponse | null;
  onAnalyzeMint: (mint: string) => void;
  compact?: boolean;
  showHeader?: boolean;
}

function CompareTokenLogo(props: { mint: string; symbol?: string | null; name?: string | null; imageUrl?: string | null }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [imageIndex, setImageIndex] = useState(0);
  const primaryImageUrl = (props.imageUrl || "").trim();
  const fallbackImageUrl = fallbackLogoUrlForMint(props.mint);
  const imageCandidates = [primaryImageUrl, fallbackImageUrl].filter(
    (url, index, array) => Boolean(url) && array.indexOf(url) === index
  );
  const imageUrl = imageCandidates[imageIndex] || "";
  useEffect(() => {
    setImageFailed(false);
    setImageIndex(0);
  }, [props.mint, primaryImageUrl, fallbackImageUrl]);
  const showImage = Boolean(imageUrl) && !imageFailed;
  return (
    <div className="relative grid h-8 w-8 place-items-center overflow-hidden rounded-full bg-transparent text-[10px] font-extrabold text-tl-text ring-1 ring-tl-border/70">
      {!showImage ? <span>{initials(props.symbol, props.name)}</span> : null}
      {showImage ? (
        <img
          src={imageUrl}
          alt={`${props.name || props.symbol || "Token"} logo`}
          loading="lazy"
          decoding="async"
          onError={() => {
            if (imageIndex + 1 < imageCandidates.length) {
              setImageIndex((current) => current + 1);
              return;
            }
            setImageFailed(true);
          }}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
    </div>
  );
}

function fmtHolder(value: unknown): string {
  const pct = Number(value);
  if (!Number.isFinite(pct)) {
    return "n/a";
  }
  return `${pct.toFixed(1)}%`;
}

export function ComparePanel(props: ComparePanelProps) {
  const {
    activeMint,
    compareMint,
    onCompareMintChange,
    suggestions,
    onSelectSuggestion,
    onCompare,
    isLoading,
    errorMessage,
    data,
    onAnalyzeMint,
    compact = false,
    showHeader = true
  } = props;
  const [inputFocused, setInputFocused] = useState(false);
  const blurTimerRef = useRef<number | null>(null);
  const showSuggestions = inputFocused && compareMint.trim() && suggestions.length > 0;

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) {
        window.clearTimeout(blurTimerRef.current);
      }
    };
  }, []);

  const renderTokenCard = (token: CompareResponse["tokenA"], title: string) => {
    const assessment = token.assessment || null;
    const score = Number(assessment?.score || 0);
    const band = riskBandFromScore(score);
    const details = assessment?.signalDetails || {};
    const confidence = String(assessment?.scoreConfidence || "unknown").toUpperCase();
    return (
      <article className="min-w-0 border border-tl-border bg-black px-3 py-3">
        <p className="mb-2 text-[11px] uppercase tracking-[0.06em] text-tl-muted">{title}</p>
        <div className="flex min-w-0 items-center gap-2">
          <CompareTokenLogo
            mint={token.mint}
            symbol={token.symbol || null}
            name={token.name || null}
            imageUrl={token.imageUrl || null}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-tl-text">{token.name || "Unknown token"}</p>
            <p className="truncate text-xs text-tl-muted">
              {token.symbol || "N/A"} · {shortMint(token.mint)}
            </p>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <p className={`inline-flex px-2 py-1 text-[11px] font-bold tracking-[0.05em] ${statusClasses(band)}`}>
            {riskLabelFromBand(band)}
          </p>
          <p className="text-sm font-extrabold text-tl-text">{Math.round(score)}</p>
        </div>
        <p className="mt-1 text-[11px] text-tl-muted">Confidence: {confidence}</p>

        <div className="mt-2 grid gap-1 border border-tl-border bg-[#050505] px-2 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-tl-muted">Top holders</span>
            <span className="font-semibold text-tl-text">{fmtHolder(details.holderConcentrationPct)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-tl-muted">Liquidity</span>
            <span className="font-semibold text-tl-text">{formatUsd(details.liquidityUsd)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-tl-muted">24h Volume</span>
            <span className="font-semibold text-tl-text">{formatUsd(details.volume24hUsd)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-tl-muted">24h Tx</span>
            <span className="font-semibold text-tl-text">{formatNumber(details.tx24h)}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onAnalyzeMint(token.mint)}
          className="mt-2 w-full border border-tl-border bg-black px-2 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-[#101010]"
        >
          Analyze This Token
        </button>
      </article>
    );
  };

  return (
    <section className={compact ? "bg-transparent px-0 pb-0 pt-1" : "bg-transparent px-4 pb-4 pt-2"}>
      <div className="border border-tl-border bg-black px-3 py-3">
        {showHeader ? (
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="font-display text-base font-bold text-tl-text">Compare Mode</h3>
            <p className="text-[11px] text-tl-muted">A vs B risk snapshot</p>
          </div>
        ) : (
          <p className="mb-2 text-[11px] text-tl-muted">A vs B risk snapshot</p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onCompare();
          }}
          className="grid gap-2"
        >
          <div className="relative">
            <input
              value={compareMint}
              onChange={(event) => onCompareMintChange(event.target.value)}
              onFocus={() => {
                if (blurTimerRef.current) {
                  window.clearTimeout(blurTimerRef.current);
                  blurTimerRef.current = null;
                }
                setInputFocused(true);
              }}
              onBlur={() => {
                blurTimerRef.current = window.setTimeout(() => {
                  setInputFocused(false);
                }, 120);
              }}
              placeholder="Token B mint, name, or symbol"
              aria-label="Token B mint, name, or symbol"
              autoComplete="off"
              className="w-full min-w-0 border border-tl-border bg-[#050505] px-3 py-2 text-sm text-tl-text outline-none focus:outline focus:outline-1 focus:outline-blue-400"
            />
            {showSuggestions ? (
              <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto border border-tl-border bg-[#050505]">
                {suggestions.map((token) => (
                  <li key={token.mint}>
                    <button
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        if (blurTimerRef.current) {
                          window.clearTimeout(blurTimerRef.current);
                          blurTimerRef.current = null;
                        }
                        setInputFocused(false);
                        onSelectSuggestion(token);
                      }}
                      className="flex w-full items-center justify-between gap-3 border-b border-tl-border px-3 py-2 text-left hover:bg-[#111111]"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-tl-text">
                          {token.name || "Unknown Token"}
                        </span>
                        <span className="block truncate text-xs text-tl-muted">
                          {token.symbol || "N/A"}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] text-tl-muted">{token.mint.slice(0, 6)}...</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <button
            type="submit"
            disabled={isLoading || !activeMint}
            className="w-full border border-tl-border bg-blue-950/60 px-3 py-2 text-xs font-bold uppercase text-blue-200 hover:bg-blue-900/70 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? "Comparing..." : "Compare Tokens"}
          </button>
        </form>
        {errorMessage ? <p className="mt-2 text-xs text-red-400">{errorMessage}</p> : null}
      </div>

      {isLoading ? (
        <div className="mt-2 border border-tl-border bg-black px-3 py-3">
          <p className="text-xs text-tl-muted">Building compare snapshot...</p>
          <div className="mt-2 grid gap-2">
            {Array.from({ length: 2 }).map((_, index) => (
              <article key={`compare-skeleton-${index}`} className="animate-pulse border border-tl-border bg-black px-3 py-3">
                <div className="mb-2 h-3 w-16 bg-[#1f1f1f]" />
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 bg-[#1f1f1f]" />
                  <div className="min-w-0 flex-1">
                    <div className="h-4 w-28 bg-[#1f1f1f]" />
                    <div className="mt-1 h-3 w-32 bg-[#181818]" />
                  </div>
                </div>
                <div className="mt-2 h-5 w-24 bg-[#1f1f1f]" />
                <div className="mt-2 grid gap-1 border border-tl-border bg-[#050505] px-2 py-2">
                  <div className="h-3 w-full bg-[#1f1f1f]" />
                  <div className="h-3 w-full bg-[#1f1f1f]" />
                  <div className="h-3 w-full bg-[#1f1f1f]" />
                  <div className="h-3 w-full bg-[#1f1f1f]" />
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {!isLoading && data ? (
        <div className="mt-2 border border-tl-border bg-black px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-zinc-300">{data.comparison.summary}</p>
            <span className="border border-tl-border bg-[#050505] px-2 py-1 text-[11px] text-zinc-300">
              Delta: {data.comparison.scoreDelta > 0 ? "+" : ""}
              {Math.round(data.comparison.scoreDelta)} pts
            </span>
          </div>
          <div className="mt-2 grid gap-2">
            {renderTokenCard(data.tokenA, "Token A")}
            {renderTokenCard(data.tokenB, "Token B")}
          </div>
        </div>
      ) : null}
    </section>
  );
}
