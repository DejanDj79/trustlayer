import type { FormEvent } from "react";
import type { TokenSearchItem } from "../types";

interface AnalyzerFormProps {
  mint: string;
  onMintChange: (value: string) => void;
  suggestions: TokenSearchItem[];
  onSelectSuggestion: (token: TokenSearchItem) => void;
  onAnalyze: () => Promise<void> | void;
  isLoading: boolean;
  errorMessage: string | null;
  isLinkedMode: boolean;
}

export function AnalyzerForm(props: AnalyzerFormProps) {
  const {
    mint,
    onMintChange,
    suggestions,
    onSelectSuggestion,
    onAnalyze,
    isLoading,
    errorMessage,
    isLinkedMode
  } = props;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await onAnalyze();
  };

  return (
    <section
      className="-mx-4 -mt-4 border-b border-tl-border transition-colors duration-200"
      style={{ backgroundColor: isLinkedMode ? "#191a1a" : "#000000" }}
    >
      <div className="grid gap-4 px-4 py-8 xl:min-h-[132px] xl:grid-cols-[1.2fr_1fr] xl:items-center">
        <div>
          <h2 className="font-display text-3xl font-normal tracking-tight text-tl-text">Explore Risk</h2>
          <p className="mt-3 text-md text-tl-muted">
            Evaluate Solana token trust signals before every trade.
          </p>
        </div>
        <form onSubmit={onSubmit} className="flex w-full flex-col self-center">
          <div className="relative">
            <input
              id="mint"
              value={mint}
              onChange={(event) => onMintChange(event.target.value)}
              placeholder="Mint address or token name"
              required
              aria-label="Mint address or token name"
              autoComplete="off"
              className="w-full min-w-0 border border-tl-border bg-[#050505] px-3 py-3 text-sm text-tl-text outline-none focus:outline focus:outline-1 focus:outline-blue-400"
            />
            {mint.trim() && suggestions.length > 0 ? (
              <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto border border-tl-border bg-[#050505]">
                {suggestions.map((token) => (
                  <li key={token.mint}>
                    <button
                      type="button"
                      onClick={() => onSelectSuggestion(token)}
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
          <button type="submit" className="sr-only" disabled={isLoading}>
            Analyze
          </button>
          <p className="mt-2 h-4 text-xs">
            {isLoading ? (
              <span className="text-blue-300">Analyzing...</span>
            ) : (
              <span className="invisible">Analyzing...</span>
            )}
          </p>
        </form>
      </div>
      {errorMessage ? (
        <p className="mx-4 mb-4 bg-red-950 px-3 py-2 text-sm text-red-300">{errorMessage}</p>
      ) : null}
    </section>
  );
}
