import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnalyzerForm } from "./components/AnalyzerForm";
import { Header } from "./components/Header";
import { ScoreResult } from "./components/ScoreResult";
import { TopTokensTable } from "./components/TopTokensTable";
import { requestJson } from "./lib/api";
import { fallbackLogoUrlForMint, initials, shortMint } from "./lib/format";
import type {
  ScoreResponse,
  TokenProfileResponse,
  TokenSearchItem,
  TokenSearchResponse,
  TokenRiskState,
  TopToken,
  TopTokensResponse
} from "./types";

const REQUEST_TIMEOUT_MS = 30000;
const TOP_TOKENS_TIMEOUT_MS = 20000;
const TOP_TOKEN_SCORE_TIMEOUT_MS = 15000;
const TOP_TOKEN_SCORE_BATCH_SIZE = 5;
const TOP_TOKENS_AUTO_REFRESH_MS = 5 * 60 * 1000;
const TOKEN_PROFILE_TIMEOUT_MS = 12000;
const TOKEN_SEARCH_TIMEOUT_MS = 12000;
const BASE58_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function normalizeSearchText(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/j/g, "y");
}

function resolveMintFromQuery(query: string, candidates: TokenSearchItem[]): string | null {
  const normalized = String(query || "").trim();
  if (!normalized) {
    return null;
  }
  if (BASE58_MINT_RE.test(normalized)) {
    return normalized;
  }

  const lookup = normalizeSearchText(normalized);
  const exact = candidates.find((token) => {
    const symbol = normalizeSearchText(token.symbol || "");
    const name = normalizeSearchText(token.name || "");
    const mint = String(token.mint || "").trim().toLowerCase();
    return symbol === lookup || name === lookup || mint === normalized.toLowerCase();
  });
  if (exact) {
    return exact.mint;
  }

  const byPrefix = candidates.filter((token) => {
    const symbol = normalizeSearchText(token.symbol || "");
    const name = normalizeSearchText(token.name || "");
    return symbol.startsWith(lookup) || name.startsWith(lookup);
  });
  if (byPrefix.length === 1) {
    return byPrefix[0].mint;
  }

  const byContains = candidates.filter((token) => {
    const symbol = normalizeSearchText(token.symbol || "");
    const name = normalizeSearchText(token.name || "");
    return symbol.includes(lookup) || name.includes(lookup);
  });
  if (byContains.length === 1) {
    return byContains[0].mint;
  }

  return null;
}

export default function App() {
  const [mint, setMint] = useState("");
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [scoreData, setScoreData] = useState<ScoreResponse | null>(null);
  const [externalTokenProfile, setExternalTokenProfile] = useState<TokenProfileResponse | null>(null);
  const [activeImageFailed, setActiveImageFailed] = useState(false);
  const [remoteSuggestions, setRemoteSuggestions] = useState<TokenSearchItem[]>([]);

  const [topTokens, setTopTokens] = useState<TopToken[]>([]);
  const [topTokensSource, setTopTokensSource] = useState<string>("unknown");
  const [topTokensWarnings, setTopTokensWarnings] = useState<string[]>([]);
  const [topTokensLoading, setTopTokensLoading] = useState(false);
  const [topTokensError, setTopTokensError] = useState<string | null>(null);
  const [topTokenRisks, setTopTokenRisks] = useState<Record<string, TokenRiskState>>({});
  const topTokenNonceRef = useRef(0);
  const topTokensFetchInFlightRef = useRef(false);
  const tokenProfileNonceRef = useRef(0);
  const tokenSearchNonceRef = useRef(0);

  const analyzeMint = useCallback(async (mintToAnalyze: string) => {
    const normalizedMint = mintToAnalyze.trim();
    if (!normalizedMint) {
      setAnalyzeError("Paste a valid mint address before starting analysis.");
      return;
    }

    setAnalyzeError(null);
    setAnalyzeLoading(true);
    setScoreData(null);

    try {
      const payload = await requestJson<ScoreResponse>(
        `/v1/score/${encodeURIComponent(normalizedMint)}`,
        REQUEST_TIMEOUT_MS
      );
      setScoreData(payload);
      setTopTokenRisks((current) => ({
        ...current,
        [normalizedMint]: {
          state: "ready",
          score: payload.score,
          status: payload.status
        }
      }));
    } catch (error) {
      setTopTokenRisks((current) => ({
        ...current,
        [normalizedMint]: {
          state: "error"
        }
      }));
      if (error instanceof Error && error.name === "AbortError") {
        setAnalyzeError(`Request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`);
      } else {
        setAnalyzeError(error instanceof Error ? error.message : "Could not reach API.");
      }
    } finally {
      setAnalyzeLoading(false);
    }
  }, []);

  const fetchTopTokens = useCallback(async () => {
    if (topTokensFetchInFlightRef.current) {
      return;
    }

    topTokensFetchInFlightRef.current = true;
    const nonce = ++topTokenNonceRef.current;
    setTopTokensLoading(true);
    setTopTokensError(null);

    try {
      const payload = await requestJson<TopTokensResponse>(
        "/v1/top-tokens?limit=20",
        TOP_TOKENS_TIMEOUT_MS
      );
      if (nonce !== topTokenNonceRef.current) {
        return;
      }

      const tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
      setTopTokens(tokens);
      setTopTokensSource(String(payload.source || "unknown"));
      setTopTokensWarnings(Array.isArray(payload.warnings) ? payload.warnings : []);

      const initialRisks: Record<string, TokenRiskState> = {};
      for (const token of tokens) {
        initialRisks[token.mint] = { state: "pending" };
      }
      setTopTokenRisks(initialRisks);

      for (let i = 0; i < tokens.length; i += TOP_TOKEN_SCORE_BATCH_SIZE) {
        const batch = tokens.slice(i, i + TOP_TOKEN_SCORE_BATCH_SIZE);
        await Promise.all(
          batch.map(async (token) => {
            try {
              const score = await requestJson<ScoreResponse>(
                `/v1/score/${encodeURIComponent(token.mint)}`,
                TOP_TOKEN_SCORE_TIMEOUT_MS
              );
              if (nonce !== topTokenNonceRef.current) {
                return;
              }
              setTopTokenRisks((current) => ({
                ...current,
                [token.mint]: {
                  state: "ready",
                  score: score.score,
                  status: score.status
                }
              }));
            } catch {
              if (nonce !== topTokenNonceRef.current) {
                return;
              }
              setTopTokenRisks((current) => ({
                ...current,
                [token.mint]: {
                  state: "error"
                }
              }));
            }
          })
        );
      }
    } catch (error) {
      if (nonce !== topTokenNonceRef.current) {
        return;
      }
      setTopTokensError(error instanceof Error ? error.message : "Failed to load top tokens.");
      setTopTokens([]);
      setTopTokenRisks({});
    } finally {
      topTokensFetchInFlightRef.current = false;
      if (nonce === topTokenNonceRef.current) {
        setTopTokensLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void fetchTopTokens();

    const intervalId = window.setInterval(() => {
      void fetchTopTokens();
    }, TOP_TOKENS_AUTO_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchTopTokens]);

  const normalizedInputMint = mint.trim();

  const localSuggestions = useMemo<TokenSearchItem[]>(() => {
    const query = normalizeSearchText(normalizedInputMint);
    if (!query) {
      return [];
    }
    return topTokens
      .filter((token) => {
        const name = normalizeSearchText(token.name || "");
        const symbol = normalizeSearchText(token.symbol || "");
        const tokenMint = String(token.mint || "").toLowerCase();
        return name.includes(query) || symbol.includes(query) || tokenMint.includes(query);
      })
      .slice(0, 8)
      .map((token) => ({
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        imageUrl: token.imageUrl || null
      }));
  }, [normalizedInputMint, topTokens]);

  useEffect(() => {
    const query = normalizedInputMint;
    if (!query || query.length < 2 || BASE58_MINT_RE.test(query)) {
      tokenSearchNonceRef.current += 1;
      setRemoteSuggestions([]);
      return;
    }

    const nonce = ++tokenSearchNonceRef.current;
    const timeoutId = window.setTimeout(() => {
      void requestJson<TokenSearchResponse>(
        `/v1/token-search?q=${encodeURIComponent(query)}&limit=8`,
        TOKEN_SEARCH_TIMEOUT_MS
      )
        .then((payload) => {
          if (nonce !== tokenSearchNonceRef.current) {
            return;
          }
          const tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
          setRemoteSuggestions(tokens);
        })
        .catch(() => {
          if (nonce !== tokenSearchNonceRef.current) {
            return;
          }
          setRemoteSuggestions([]);
        });
    }, 180);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [normalizedInputMint]);

  const analyzerSuggestions = useMemo<TokenSearchItem[]>(() => {
    const merged = [...localSuggestions, ...remoteSuggestions];
    const deduped = new Map<string, TokenSearchItem>();
    for (const token of merged) {
      const tokenMint = String(token?.mint || "").trim();
      if (!tokenMint || deduped.has(tokenMint)) {
        continue;
      }
      deduped.set(tokenMint, token);
    }
    return Array.from(deduped.values()).slice(0, 8);
  }, [localSuggestions, remoteSuggestions]);

  const resolvedInputMint = resolveMintFromQuery(normalizedInputMint, analyzerSuggestions);
  const inputMatchesTopToken =
    Boolean(resolvedInputMint) && topTokens.some((token) => token.mint === resolvedInputMint);
  const isCustomAnalyzerMode = Boolean(normalizedInputMint) && !inputMatchesTopToken;
  const isPanelLinkedMode = Boolean(selectedMint) || isCustomAnalyzerMode;
  const selectedPanelToneClass = isPanelLinkedMode ? "bg-[#191a1a]" : "bg-black";
  const activeMint = String(
    scoreData?.mint ||
      resolvedInputMint ||
      (BASE58_MINT_RE.test(normalizedInputMint) ? normalizedInputMint : "") ||
      ""
  ).trim();
  const activeToken = activeMint ? topTokens.find((token) => token.mint === activeMint) : undefined;
  const externalTokenName = String(externalTokenProfile?.name || "").trim();
  const externalTokenSymbol = String(externalTokenProfile?.symbol || "")
    .trim()
    .toUpperCase();
  const externalTokenImage = String(externalTokenProfile?.imageUrl || "").trim();
  const activeTokenName = activeToken?.name || externalTokenName || (activeMint ? "Unlisted Token" : "");
  const activeTokenSymbol = activeToken?.symbol || externalTokenSymbol || "N/A";
  const activeTokenImage = activeMint
    ? ((activeToken?.imageUrl || "").trim() || externalTokenImage || fallbackLogoUrlForMint(activeMint))
    : "";
  const showActiveTokenImage = Boolean(activeTokenImage) && !activeImageFailed;

  useEffect(() => {
    if (!activeMint || activeToken || !BASE58_MINT_RE.test(activeMint)) {
      tokenProfileNonceRef.current += 1;
      setExternalTokenProfile(null);
      return;
    }

    const nonce = ++tokenProfileNonceRef.current;
    void requestJson<TokenProfileResponse>(
      `/v1/token/${encodeURIComponent(activeMint)}`,
      TOKEN_PROFILE_TIMEOUT_MS
    )
      .then((profile) => {
        if (nonce !== tokenProfileNonceRef.current) {
          return;
        }
        setExternalTokenProfile(profile);
      })
      .catch(() => {
        if (nonce !== tokenProfileNonceRef.current) {
          return;
        }
        setExternalTokenProfile(null);
      });
  }, [activeMint, activeToken]);

  useEffect(() => {
    setActiveImageFailed(false);
  }, [activeMint, activeTokenImage]);

  return (
    <div className="min-h-screen bg-tl-bg font-sans text-tl-text">
      <Header />
      <div className="mx-auto min-h-screen w-full max-w-[1640px] border-x border-tl-border bg-black">
        <main className="grid gap-0 pb-5">
          <section className="grid gap-0 xl:grid-cols-[minmax(0,2.25fr)_minmax(300px,0.75fr)]">
            <div className="grid content-start gap-4 px-4 pt-4">
              <AnalyzerForm
                mint={mint}
                onMintChange={(value) => {
                  setMint(value);
                  const normalized = value.trim();
                  if (!normalized || normalized !== selectedMint) {
                    setSelectedMint(null);
                  }
                }}
                suggestions={analyzerSuggestions}
                onSelectSuggestion={(token) => {
                  setMint(token.mint);
                  if (topTokens.some((item) => item.mint === token.mint)) {
                    setSelectedMint(token.mint);
                  } else {
                    setSelectedMint(null);
                  }
                  void analyzeMint(token.mint);
                }}
                onAnalyze={() => {
                  const normalizedMint = mint.trim();
                  const mintToAnalyze = resolveMintFromQuery(normalizedMint, analyzerSuggestions);
                  if (!mintToAnalyze) {
                    setAnalyzeError(
                      "Unesite validnu mint adresu ili ime/symbol tokena iz liste."
                    );
                    return;
                  }

                  if (topTokens.some((token) => token.mint === mintToAnalyze)) {
                    setSelectedMint(mintToAnalyze);
                  } else {
                    setSelectedMint(null);
                  }
                  return analyzeMint(mintToAnalyze);
                }}
                isLoading={analyzeLoading}
                errorMessage={analyzeError}
                isLinkedMode={isCustomAnalyzerMode}
              />

              <TopTokensTable
                tokens={topTokens}
                risks={topTokenRisks}
                isLoading={topTokensLoading}
                source={topTokensSource}
                fallbackMode={topTokensWarnings.length > 0}
                errorMessage={topTokensError}
                selectedMint={selectedMint}
                onAnalyzeToken={(tokenMint) => {
                  setSelectedMint(tokenMint);
                  setMint(tokenMint);
                  void analyzeMint(tokenMint);
                }}
              />
            </div>

            <aside
              className={`flex flex-col gap-0 border-l px-4 pb-6 pt-6 transition-colors duration-200 ${selectedPanelToneClass} ${
                isPanelLinkedMode ? "border-transparent" : "border-tl-border"
              }`}
            >
              {activeMint ? (
                <section className="h-[128px] bg-transparent px-4 pb-3 pt-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="relative grid h-10 w-10 place-items-center overflow-hidden rounded-full border border-tl-border bg-transparent text-xs font-extrabold text-tl-text"
                      style={{ borderRadius: "9999px", clipPath: "circle(50% at 50% 50%)" }}
                    >
                      {!showActiveTokenImage ? (
                        <span>{initials(activeTokenSymbol, activeTokenName)}</span>
                      ) : null}
                      {showActiveTokenImage ? (
                        <img
                          src={activeTokenImage}
                          alt={`${activeTokenName} logo`}
                          loading="lazy"
                          decoding="async"
                          onError={() => setActiveImageFailed(true)}
                          className="absolute inset-0 h-full w-full rounded-full object-cover"
                          style={{ borderRadius: "9999px", clipPath: "circle(50% at 50% 50%)" }}
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-tl-text">{activeTokenName}</p>
                      <p className="truncate text-xs text-tl-muted">
                        {activeTokenSymbol} · {shortMint(activeMint)}
                      </p>
                    </div>
                  </div>
                  <p className="mt-2 text-sm leading-snug text-tl-muted">
                    Risk breakdown, confidence, warnings, and RPC diagnostics.
                  </p>
                </section>
              ) : null}

              {scoreData || analyzeLoading ? (
                <div className="mt-0">
                  <ScoreResult
                    data={scoreData || ({ score: 0, status: "yellow", mint } as ScoreResponse)}
                    isLoading={analyzeLoading}
                  />
                </div>
              ) : (
                <section className="bg-transparent px-4 py-4 text-sm text-tl-muted">
                  Select a token from the table or paste any SPL mint address to generate a transparent
                  risk report.
                </section>
              )}
            </aside>
          </section>
        </main>
      </div>
    </div>
  );
}
