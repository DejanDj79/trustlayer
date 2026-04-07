import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnalyzerForm } from "./components/AnalyzerForm";
import { Header } from "./components/Header";
import { ScoreResult } from "./components/ScoreResult";
import { TopTokensTable } from "./components/TopTokensTable";
import { WatchlistPanel } from "./components/WatchlistPanel";
import { requestJson } from "./lib/api";
import { fallbackLogoUrlForMint, initials, shortMint } from "./lib/format";
import type {
  ScoreResponse,
  ScoreHistoryResponse,
  TokenProfileResponse,
  TokenSearchItem,
  TokenSearchResponse,
  TokenRiskState,
  TopToken,
  TopTokensResponse,
  WatchlistAlertEvent,
  WatchlistAlertPreference,
  WatchlistItem
} from "./types";

const REQUEST_TIMEOUT_MS = 30000;
const TOP_TOKENS_TIMEOUT_MS = 20000;
const TOP_TOKEN_SCORE_TIMEOUT_MS = 15000;
const TOP_TOKEN_SCORE_BATCH_SIZE = 5;
const TOP_TOKENS_AUTO_REFRESH_MS = 5 * 60 * 1000;
const TOKEN_PROFILE_TIMEOUT_MS = 12000;
const TOKEN_SEARCH_TIMEOUT_MS = 12000;
const TOKEN_HISTORY_TIMEOUT_MS = 12000;
const WATCHLIST_STORAGE_KEY = "trustlayer.watchlist.v1";
const WATCHLIST_ALERTS_STORAGE_KEY = "trustlayer.watchlist.alerts.v1";
const WATCHLIST_ALERT_PREFS_STORAGE_KEY = "trustlayer.watchlist.alertprefs.v1";
const WATCHLIST_MAX_ITEMS = 25;
const WATCHLIST_SCORE_TIMEOUT_MS = 15000;
const WATCHLIST_AUTO_REFRESH_MS = 2 * 60 * 1000;
const WATCHLIST_ALERT_THRESHOLD = 10;
const WATCHLIST_MAX_ALERTS = 80;
const WATCHLIST_SNOOZE_MS = 60 * 60 * 1000;
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

function FavoriteStarIcon({ active }: { active: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill={active ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3.75l2.5 5.06 5.58.81-4.04 3.94.95 5.56L12 16.5 7.01 19.12l.95-5.56-4.04-3.94 5.58-.81L12 3.75z" />
    </svg>
  );
}

function formatAlertTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function isSnoozeActive(value?: string | null): boolean {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  const untilMs = new Date(normalized).getTime();
  return Number.isFinite(untilMs) && untilMs > Date.now();
}

export default function App() {
  const [mint, setMint] = useState("");
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [scoreData, setScoreData] = useState<ScoreResponse | null>(null);
  const [historyData, setHistoryData] = useState<ScoreHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRefreshNonce, setHistoryRefreshNonce] = useState(0);
  const [externalTokenProfile, setExternalTokenProfile] = useState<TokenProfileResponse | null>(null);
  const [activeImageFailed, setActiveImageFailed] = useState(false);
  const [remoteSuggestions, setRemoteSuggestions] = useState<TokenSearchItem[]>([]);
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [watchlistRisks, setWatchlistRisks] = useState<Record<string, TokenRiskState>>({});
  const [watchlistAlerts, setWatchlistAlerts] = useState<WatchlistAlertEvent[]>([]);
  const [watchlistAlertPreferences, setWatchlistAlertPreferences] = useState<
    Record<string, WatchlistAlertPreference>
  >({});
  const [isWatchlistOpen, setIsWatchlistOpen] = useState(false);

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
  const tokenHistoryNonceRef = useRef(0);
  const watchlistNonceRef = useRef(0);
  const watchlistLastScoresRef = useRef<Record<string, number>>({});
  const watchlistAlertsRef = useRef<WatchlistAlertEvent[]>([]);
  const watchlistMintSet = useMemo(
    () => new Set(watchlistItems.map((item) => item.mint)),
    [watchlistItems]
  );

  const pushWatchlistAlert = useCallback(
    (mintToAlert: string, previousScore: number, nextScore: number, status?: string) => {
      const normalizedMint = String(mintToAlert || "").trim();
      if (!normalizedMint || !Number.isFinite(previousScore) || !Number.isFinite(nextScore)) {
        return;
      }
      const preference = watchlistAlertPreferences[normalizedMint];
      if (preference?.muted) {
        return;
      }
      if (isSnoozeActive(preference?.snoozedUntil)) {
        return;
      }
      const delta = Number((nextScore - previousScore).toFixed(2));
      if (Math.abs(delta) < WATCHLIST_ALERT_THRESHOLD) {
        return;
      }

      const matching = watchlistItems.find((item) => item.mint === normalizedMint);
      const alert: WatchlistAlertEvent = {
        id: `${Date.now()}-${normalizedMint}-${Math.random().toString(36).slice(2, 9)}`,
        mint: normalizedMint,
        symbol: matching?.symbol || null,
        name: matching?.name || null,
        previousScore: Number(previousScore.toFixed(2)),
        nextScore: Number(nextScore.toFixed(2)),
        delta,
        status: status || undefined,
        createdAt: new Date().toISOString()
      };
      setWatchlistAlerts((current) => [alert, ...current].slice(0, WATCHLIST_MAX_ALERTS));
    },
    [watchlistAlertPreferences, watchlistItems]
  );

  const fetchScoreByMint = useCallback(async (mintToAnalyze: string, timeoutMs: number) => {
    const normalizedMint = String(mintToAnalyze || "").trim();
    if (!normalizedMint) {
      throw new Error("Invalid mint address.");
    }
    return await requestJson<ScoreResponse>(
      `/v1/score/${encodeURIComponent(normalizedMint)}`,
      timeoutMs
    );
  }, []);

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
      const payload = await fetchScoreByMint(normalizedMint, REQUEST_TIMEOUT_MS);
      setScoreData(payload);
      setTopTokenRisks((current) => ({
        ...current,
        [normalizedMint]: {
          state: "ready",
          score: payload.score,
          status: payload.status
        }
      }));
      setWatchlistRisks((current) => ({
        ...current,
        [normalizedMint]: {
          state: "ready",
          score: payload.score,
          status: payload.status
        }
      }));
      if (watchlistMintSet.has(normalizedMint)) {
        const previousScore = watchlistLastScoresRef.current[normalizedMint];
        if (Number.isFinite(previousScore)) {
          pushWatchlistAlert(normalizedMint, previousScore, payload.score, payload.status);
        }
        watchlistLastScoresRef.current = {
          ...watchlistLastScoresRef.current,
          [normalizedMint]: payload.score
        };
      }
      setHistoryRefreshNonce((current) => current + 1);
    } catch (error) {
      setTopTokenRisks((current) => ({
        ...current,
        [normalizedMint]: {
          state: "error"
        }
      }));
      setWatchlistRisks((current) => ({
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
  }, [fetchScoreByMint, pushWatchlistAlert, watchlistMintSet]);

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

  useEffect(() => {
    try {
      if (typeof window === "undefined") {
        return;
      }
      const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      const sanitized: WatchlistItem[] = parsed
        .map((item) => ({
          mint: String(item?.mint || "").trim(),
          symbol: item?.symbol ? String(item.symbol).trim().toUpperCase() : null,
          name: item?.name ? String(item.name).trim() : null,
          imageUrl: item?.imageUrl ? String(item.imageUrl).trim() : null,
          addedAt: item?.addedAt ? String(item.addedAt) : undefined
        }))
        .filter((item) => BASE58_MINT_RE.test(item.mint))
        .slice(0, WATCHLIST_MAX_ITEMS);
      setWatchlistItems(sanitized);
    } catch {
      // ignore localStorage parsing errors
    }
  }, []);

  useEffect(() => {
    try {
      if (typeof window === "undefined") {
        return;
      }
      const raw = window.localStorage.getItem(WATCHLIST_ALERTS_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      const sanitized: WatchlistAlertEvent[] = parsed
        .map((item) => {
          const previous = Number(item?.previousScore);
          const next = Number(item?.nextScore);
          const delta = Number(item?.delta);
          return {
            id: String(item?.id || "").trim(),
            mint: String(item?.mint || "").trim(),
            symbol: item?.symbol ? String(item.symbol).trim().toUpperCase() : null,
            name: item?.name ? String(item.name).trim() : null,
            previousScore: Number.isFinite(previous) ? previous : 0,
            nextScore: Number.isFinite(next) ? next : 0,
            delta: Number.isFinite(delta) ? delta : 0,
            status: item?.status ? String(item.status) : undefined,
            createdAt: item?.createdAt ? String(item.createdAt) : new Date().toISOString()
          };
        })
        .filter((item) => item.id && BASE58_MINT_RE.test(item.mint))
        .slice(0, WATCHLIST_MAX_ALERTS);
      setWatchlistAlerts(sanitized);
      watchlistAlertsRef.current = sanitized;
    } catch {
      // ignore localStorage parsing errors
    }
  }, []);

  useEffect(() => {
    try {
      if (typeof window === "undefined") {
        return;
      }
      const raw = window.localStorage.getItem(WATCHLIST_ALERT_PREFS_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      const next: Record<string, WatchlistAlertPreference> = {};
      for (const [mintKey, value] of Object.entries(parsed as Record<string, unknown>)) {
        const normalizedMint = String(mintKey || "").trim();
        if (!BASE58_MINT_RE.test(normalizedMint)) {
          continue;
        }
        const row = (value || {}) as Record<string, unknown>;
        const muted = Boolean(row.muted);
        const snoozedUntil = row.snoozedUntil ? String(row.snoozedUntil) : null;
        const snoozedActive = isSnoozeActive(snoozedUntil);
        if (!muted && !snoozedActive) {
          continue;
        }
        next[normalizedMint] = {
          muted,
          snoozedUntil: snoozedActive ? snoozedUntil : null
        };
      }
      setWatchlistAlertPreferences(next);
    } catch {
      // ignore localStorage parsing errors
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlistItems));
  }, [watchlistItems]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(WATCHLIST_ALERTS_STORAGE_KEY, JSON.stringify(watchlistAlerts));
    watchlistAlertsRef.current = watchlistAlerts;
  }, [watchlistAlerts]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      WATCHLIST_ALERT_PREFS_STORAGE_KEY,
      JSON.stringify(watchlistAlertPreferences)
    );
  }, [watchlistAlertPreferences]);

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
  const addToWatchlist = useCallback((item: WatchlistItem) => {
    const normalizedMint = String(item?.mint || "").trim();
    if (!BASE58_MINT_RE.test(normalizedMint)) {
      return;
    }
    setWatchlistItems((current) => {
      const existingIndex = current.findIndex((entry) => entry.mint === normalizedMint);
      const nextItem: WatchlistItem = {
        mint: normalizedMint,
        symbol: item?.symbol ? String(item.symbol).trim().toUpperCase() : null,
        name: item?.name ? String(item.name).trim() : null,
        imageUrl: item?.imageUrl ? String(item.imageUrl).trim() : null,
        addedAt: item?.addedAt || new Date().toISOString()
      };
      if (existingIndex >= 0) {
        const copy = [...current];
        copy[existingIndex] = {
          ...copy[existingIndex],
          ...nextItem
        };
        return copy;
      }
      const next = [nextItem, ...current];
      return next.slice(0, WATCHLIST_MAX_ITEMS);
    });
  }, []);

  const removeFromWatchlist = useCallback((mintToRemove: string) => {
    const normalizedMint = String(mintToRemove || "").trim();
    setWatchlistItems((current) => current.filter((item) => item.mint !== normalizedMint));
    setWatchlistRisks((current) => {
      const { [normalizedMint]: _removed, ...rest } = current;
      return rest;
    });
    setWatchlistAlerts((current) => current.filter((item) => item.mint !== normalizedMint));
    setWatchlistAlertPreferences((current) => {
      const { [normalizedMint]: _removed, ...rest } = current;
      return rest;
    });
    const { [normalizedMint]: _score, ...restScores } = watchlistLastScoresRef.current;
    watchlistLastScoresRef.current = restScores;
  }, []);

  const toggleWatchlistAlertMute = useCallback((mintToToggle: string) => {
    const normalizedMint = String(mintToToggle || "").trim();
    if (!BASE58_MINT_RE.test(normalizedMint)) {
      return;
    }
    setWatchlistAlertPreferences((current) => {
      const row = current[normalizedMint] || {};
      const nextMuted = !Boolean(row.muted);
      if (!nextMuted && !isSnoozeActive(row.snoozedUntil)) {
        const { [normalizedMint]: _removed, ...rest } = current;
        return rest;
      }
      return {
        ...current,
        [normalizedMint]: {
          muted: nextMuted,
          snoozedUntil: nextMuted ? null : row.snoozedUntil || null
        }
      };
    });
  }, []);

  const toggleWatchlistAlertSnooze = useCallback((mintToToggle: string) => {
    const normalizedMint = String(mintToToggle || "").trim();
    if (!BASE58_MINT_RE.test(normalizedMint)) {
      return;
    }
    setWatchlistAlertPreferences((current) => {
      const row = current[normalizedMint] || {};
      const active = isSnoozeActive(row.snoozedUntil);
      if (active) {
        if (!row.muted) {
          const { [normalizedMint]: _removed, ...rest } = current;
          return rest;
        }
        return {
          ...current,
          [normalizedMint]: {
            ...row,
            snoozedUntil: null
          }
        };
      }
      const snoozedUntil = new Date(Date.now() + WATCHLIST_SNOOZE_MS).toISOString();
      return {
        ...current,
        [normalizedMint]: {
          muted: false,
          snoozedUntil
        }
      };
    });
  }, []);

  const toggleWatchlistFromTopToken = useCallback(
    (token: TopToken) => {
      if (watchlistMintSet.has(token.mint)) {
        removeFromWatchlist(token.mint);
        return;
      }
      addToWatchlist({
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        imageUrl: token.imageUrl || null
      });
    },
    [addToWatchlist, removeFromWatchlist, watchlistMintSet]
  );

  const refreshWatchlistScores = useCallback(async () => {
    const mints = Array.from(new Set(watchlistItems.map((item) => item.mint))).filter((itemMint) =>
      BASE58_MINT_RE.test(itemMint)
    );
    if (mints.length === 0) {
      return;
    }

    const nonce = ++watchlistNonceRef.current;
    setWatchlistRisks((current) => {
      const next = { ...current };
      for (const itemMint of mints) {
        if (!next[itemMint]) {
          next[itemMint] = { state: "pending" };
        }
      }
      return next;
    });

    const BATCH_SIZE = 4;
    for (let i = 0; i < mints.length; i += BATCH_SIZE) {
      const batch = mints.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (itemMint) => {
          try {
            const score = await fetchScoreByMint(itemMint, WATCHLIST_SCORE_TIMEOUT_MS);
            if (nonce !== watchlistNonceRef.current) {
              return;
            }
            setWatchlistRisks((current) => ({
              ...current,
              [itemMint]: {
                state: "ready",
                score: score.score,
                status: score.status
              }
            }));
            const previousScore = watchlistLastScoresRef.current[itemMint];
            if (Number.isFinite(previousScore)) {
              pushWatchlistAlert(itemMint, previousScore, score.score, score.status);
            }
            watchlistLastScoresRef.current = {
              ...watchlistLastScoresRef.current,
              [itemMint]: score.score
            };
            setTopTokenRisks((current) => ({
              ...current,
              [itemMint]: {
                state: "ready",
                score: score.score,
                status: score.status
              }
            }));
          } catch {
            if (nonce !== watchlistNonceRef.current) {
              return;
            }
            setWatchlistRisks((current) => ({
              ...current,
              [itemMint]: {
                state: "error"
              }
            }));
          }
        })
      );
    }
  }, [fetchScoreByMint, pushWatchlistAlert, watchlistItems]);

  useEffect(() => {
    if (watchlistItems.length === 0) {
      watchlistNonceRef.current += 1;
      return;
    }
    void refreshWatchlistScores();
    const intervalId = window.setInterval(() => {
      void refreshWatchlistScores();
    }, WATCHLIST_AUTO_REFRESH_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshWatchlistScores, watchlistItems.length]);

  useEffect(() => {
    const activeMints = new Set(watchlistItems.map((item) => item.mint));
    const nextScores: Record<string, number> = {};
    for (const [itemMint, score] of Object.entries(watchlistLastScoresRef.current)) {
      if (activeMints.has(itemMint)) {
        nextScores[itemMint] = score;
      }
    }
    watchlistLastScoresRef.current = nextScores;
    setWatchlistAlertPreferences((current) => {
      const next: Record<string, WatchlistAlertPreference> = {};
      for (const [itemMint, pref] of Object.entries(current)) {
        if (!activeMints.has(itemMint)) {
          continue;
        }
        const muted = Boolean(pref?.muted);
        const snoozedActive = isSnoozeActive(pref?.snoozedUntil);
        if (!muted && !snoozedActive) {
          continue;
        }
        next[itemMint] = {
          muted,
          snoozedUntil: snoozedActive ? String(pref?.snoozedUntil || "") : null
        };
      }
      return next;
    });
    if (watchlistAlertsRef.current.length === 0) {
      return;
    }
    setWatchlistAlerts((current) => current.filter((alert) => activeMints.has(alert.mint)));
  }, [watchlistItems]);

  const watchlistAlertMintSet = useMemo(
    () => new Set(watchlistAlerts.map((alert) => alert.mint)),
    [watchlistAlerts]
  );
  const watchlistSuppressedMintSet = useMemo(() => {
    const next = new Set<string>();
    for (const item of watchlistItems) {
      const pref = watchlistAlertPreferences[item.mint];
      if (!pref) {
        continue;
      }
      if (pref.muted || isSnoozeActive(pref.snoozedUntil)) {
        next.add(item.mint);
      }
    }
    return next;
  }, [watchlistAlertPreferences, watchlistItems]);

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
    if (!activeMint || !BASE58_MINT_RE.test(activeMint)) {
      tokenHistoryNonceRef.current += 1;
      setHistoryData(null);
      setHistoryError(null);
      setHistoryLoading(false);
      return;
    }

    const nonce = ++tokenHistoryNonceRef.current;
    setHistoryLoading(true);
    setHistoryError(null);

    void requestJson<ScoreHistoryResponse>(
      `/v1/history/${encodeURIComponent(activeMint)}?limit=40`,
      TOKEN_HISTORY_TIMEOUT_MS
    )
      .then((payload) => {
        if (nonce !== tokenHistoryNonceRef.current) {
          return;
        }
        setHistoryData(payload);
      })
      .catch((error) => {
        if (nonce !== tokenHistoryNonceRef.current) {
          return;
        }
        setHistoryError(error instanceof Error ? error.message : "Failed to load history.");
      })
      .finally(() => {
        if (nonce !== tokenHistoryNonceRef.current) {
          return;
        }
        setHistoryLoading(false);
      });
  }, [activeMint, historyRefreshNonce]);

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
                watchlistMints={watchlistMintSet}
                onAnalyzeToken={(tokenMint) => {
                  setSelectedMint(tokenMint);
                  setMint(tokenMint);
                  void analyzeMint(tokenMint);
                }}
                onToggleWatchlist={toggleWatchlistFromTopToken}
              />
            </div>

            <aside
              className={`flex flex-col gap-0 border-l px-4 pb-6 pt-6 transition-colors duration-200 ${selectedPanelToneClass} ${
                isPanelLinkedMode ? "border-transparent" : "border-tl-border"
              }`}
            >
              <section className="bg-transparent px-4 pb-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsWatchlistOpen((current) => !current)}
                  aria-expanded={isWatchlistOpen}
                  className="flex w-full items-center gap-2 border border-tl-border bg-black px-3 py-2 text-left transition-colors duration-150 hover:bg-[#101010]"
                >
                  <span className="font-display text-sm font-semibold text-tl-text">Favorites watchlist</span>
                  <span className="ml-1 text-xs text-tl-muted">{watchlistItems.length} token(s)</span>
                  {watchlistAlerts.length > 0 ? (
                    <span className="rounded-sm border border-red-500/40 bg-red-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
                      {watchlistAlerts.length} alert{watchlistAlerts.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {watchlistSuppressedMintSet.size > 0 ? (
                    <span className="rounded-sm border border-zinc-600/70 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300">
                      {watchlistSuppressedMintSet.size} suppressed
                    </span>
                  ) : null}
                  <span
                    aria-hidden="true"
                    className={`ml-auto inline-block text-sm text-tl-muted transition-transform duration-150 ${
                      isWatchlistOpen ? "rotate-180" : ""
                    }`}
                  >
                    ▾
                  </span>
                </button>

                {isWatchlistOpen ? (
                  <div className="border-x border-b border-tl-border px-3 py-2">
                    <WatchlistPanel
                      items={watchlistItems}
                      risks={watchlistRisks}
                      alertMints={watchlistAlertMintSet}
                      alertPreferences={watchlistAlertPreferences}
                      selectedMint={selectedMint}
                      onAnalyzeMint={(watchMint) => {
                        setSelectedMint(topTokens.some((token) => token.mint === watchMint) ? watchMint : null);
                        setMint(watchMint);
                        void analyzeMint(watchMint);
                      }}
                      onRemoveMint={removeFromWatchlist}
                      onToggleMute={toggleWatchlistAlertMute}
                      onToggleSnooze={toggleWatchlistAlertSnooze}
                      showHeader={false}
                      compact
                    />
                    <div className="mt-2 border border-tl-border bg-black px-3 py-2">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-zinc-300">
                          Recent alerts
                        </p>
                        {watchlistAlerts.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => setWatchlistAlerts([])}
                            className="text-[11px] text-zinc-400 hover:text-zinc-200"
                          >
                            Clear
                          </button>
                        ) : null}
                      </div>

                      {watchlistAlerts.length === 0 ? (
                        <p className="text-xs text-tl-muted">
                          Alerts trigger when a watchlist token score moves by at least{" "}
                          {WATCHLIST_ALERT_THRESHOLD} points between checks.
                        </p>
                      ) : (
                        <ul className="grid gap-1.5">
                          {watchlistAlerts.slice(0, 8).map((alert) => (
                            <li key={alert.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedMint(
                                    topTokens.some((token) => token.mint === alert.mint) ? alert.mint : null
                                  );
                                  setMint(alert.mint);
                                  void analyzeMint(alert.mint);
                                }}
                                className="flex w-full items-center justify-between gap-2 text-left"
                              >
                                <span className="min-w-0 text-xs text-zinc-300">
                                  <span className="block truncate font-semibold text-zinc-200">
                                    {alert.name || alert.symbol || "Token"}
                                  </span>
                                  <span className="block truncate text-[11px] text-zinc-500">
                                    {alert.symbol || "N/A"} · {formatAlertTimestamp(alert.createdAt)}
                                  </span>
                                </span>
                                <span
                                  className={`text-xs font-bold ${
                                    alert.delta >= 0 ? "text-red-400" : "text-green-300"
                                  }`}
                                >
                                  {alert.delta >= 0 ? "+" : ""}
                                  {Math.round(alert.delta)} pts
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                ) : null}
              </section>

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
                    <button
                      type="button"
                      onClick={() => {
                        if (!activeMint) {
                          return;
                        }
                        if (watchlistMintSet.has(activeMint)) {
                          removeFromWatchlist(activeMint);
                          return;
                        }
                        addToWatchlist({
                          mint: activeMint,
                          symbol: activeTokenSymbol,
                          name: activeTokenName,
                          imageUrl: activeTokenImage
                        });
                      }}
                      aria-label={
                        watchlistMintSet.has(activeMint) ? "Remove from favorites" : "Add to favorites"
                      }
                      title={
                        watchlistMintSet.has(activeMint) ? "Remove from favorites" : "Add to favorites"
                      }
                      className={`grid h-7 w-7 place-items-center border transition-colors duration-150 ${
                        watchlistMintSet.has(activeMint)
                          ? "border-amber-500/40 bg-amber-950/40 text-amber-300 hover:text-amber-200"
                          : "border-tl-border bg-black text-zinc-500 hover:text-zinc-200"
                      }`}
                    >
                      <FavoriteStarIcon active={watchlistMintSet.has(activeMint)} />
                    </button>
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
                    historyData={historyData}
                    historyLoading={historyLoading}
                    historyError={historyError}
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
