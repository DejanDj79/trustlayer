import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnalyzerForm } from "./components/AnalyzerForm";
import { ComparePanel } from "./components/ComparePanel";
import { Header } from "./components/Header";
import { ScoreResult } from "./components/ScoreResult";
import { TableInsightsPanel } from "./components/TableInsightsPanel";
import { TopTokensTable } from "./components/TopTokensTable";
import { WatchlistPanel } from "./components/WatchlistPanel";
import { API_BASE, requestJsonWithRetry } from "./lib/api";
import { fallbackLogoUrlForMint, initials, shortMint } from "./lib/format";
import type {
  CompareResponse,
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
  WatchlistAlertSeverity,
  WatchlistItem
} from "./types";

const REQUEST_TIMEOUT_MS = 30000;
const TOP_TOKENS_TIMEOUT_MS = 20000;
const TOP_TOKEN_SCORE_TIMEOUT_MS = 15000;
const TOP_TOKEN_SCORE_BATCH_SIZE = 5;
const TOP_TOKEN_SCORE_REUSE_MS = 8 * 60 * 1000;
const TOP_TOKENS_AUTO_REFRESH_MS = 5 * 60 * 1000;
const TOKEN_PROFILE_TIMEOUT_MS = 12000;
const TOKEN_SEARCH_TIMEOUT_MS = 12000;
const TOKEN_HISTORY_TIMEOUT_MS = 12000;
const WATCHLIST_STORAGE_KEY = "trustlayer.watchlist.v1";
const WATCHLIST_ALERTS_STORAGE_KEY = "trustlayer.watchlist.alerts.v1";
const WATCHLIST_ALERT_PREFS_STORAGE_KEY = "trustlayer.watchlist.alertprefs.v1";
const WATCHLIST_ALERT_THRESHOLD_STORAGE_KEY = "trustlayer.watchlist.alertthreshold.v1";
const WATCHLIST_MAX_ITEMS = 25;
const WATCHLIST_SCORE_TIMEOUT_MS = 15000;
const WATCHLIST_AUTO_REFRESH_MS = 2 * 60 * 1000;
const WATCHLIST_ALERT_DEFAULT_THRESHOLD = 10;
const WATCHLIST_ALERT_THRESHOLD_OPTIONS = [5, 10, 15] as const;
const WATCHLIST_MAX_ALERTS = 80;
const WATCHLIST_SNOOZE_MS = 60 * 60 * 1000;
const WATCHLIST_ALERT_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const BASE58_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface TopTokenRiskCacheEntry {
  score: number;
  status: string;
  updatedAt: number;
}

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

function formatCheckTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
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

function alertSeverityFromDelta(delta: number): WatchlistAlertSeverity {
  const abs = Math.abs(Number(delta || 0));
  if (abs >= 20) {
    return "critical";
  }
  if (abs >= 12) {
    return "major";
  }
  return "minor";
}

function alertSeverityClass(severity: WatchlistAlertSeverity): string {
  if (severity === "critical") {
    return "border-red-500/50 bg-red-950/40 text-red-300";
  }
  if (severity === "major") {
    return "border-amber-500/50 bg-amber-950/40 text-amber-300";
  }
  return "border-sky-500/50 bg-sky-950/40 text-sky-300";
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
  const [compareMint, setCompareMint] = useState("");
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [compareData, setCompareData] = useState<CompareResponse | null>(null);
  const [isCompareOpen, setIsCompareOpen] = useState(false);
  const [compareTokenHints, setCompareTokenHints] = useState<Record<string, TokenSearchItem>>({});
  const [remoteSuggestions, setRemoteSuggestions] = useState<TokenSearchItem[]>([]);
  const [compareRemoteSuggestions, setCompareRemoteSuggestions] = useState<TokenSearchItem[]>([]);
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [watchlistRisks, setWatchlistRisks] = useState<Record<string, TokenRiskState>>({});
  const [watchlistAlerts, setWatchlistAlerts] = useState<WatchlistAlertEvent[]>([]);
  const [watchlistAlertPreferences, setWatchlistAlertPreferences] = useState<
    Record<string, WatchlistAlertPreference>
  >({});
  const [watchlistAlertThreshold, setWatchlistAlertThreshold] = useState<number>(
    WATCHLIST_ALERT_DEFAULT_THRESHOLD
  );
  const [watchlistHydrated, setWatchlistHydrated] = useState(false);
  const [watchlistAlertsHydrated, setWatchlistAlertsHydrated] = useState(false);
  const [watchlistAlertPreferencesHydrated, setWatchlistAlertPreferencesHydrated] = useState(false);
  const [watchlistAlertThresholdHydrated, setWatchlistAlertThresholdHydrated] = useState(false);
  const [watchlistAlertFilter, setWatchlistAlertFilter] = useState<"all" | "critical">("all");
  const [isWatchlistOpen, setIsWatchlistOpen] = useState(false);
  const [isRecentAlertsOpen, setIsRecentAlertsOpen] = useState(true);
  const [watchlistRefreshLoading, setWatchlistRefreshLoading] = useState(false);
  const [watchlistLastCheckedAt, setWatchlistLastCheckedAt] = useState<string | null>(null);
  const [isMethodologyOpen, setIsMethodologyOpen] = useState(false);

  const [topTokens, setTopTokens] = useState<TopToken[]>([]);
  const [topTokensSource, setTopTokensSource] = useState<string>("unknown");
  const [topTokensWarnings, setTopTokensWarnings] = useState<string[]>([]);
  const [topTokensLoading, setTopTokensLoading] = useState(false);
  const [topTokensReadyOnce, setTopTokensReadyOnce] = useState(false);
  const [topTokensError, setTopTokensError] = useState<string | null>(null);
  const [topTokenRisks, setTopTokenRisks] = useState<Record<string, TokenRiskState>>({});
  const topTokenNonceRef = useRef(0);
  const topTokenRisksRef = useRef<Record<string, TokenRiskState>>({});
  const topTokenScoreCacheRef = useRef<Map<string, TopTokenRiskCacheEntry>>(new Map());
  const topTokensFetchInFlightRef = useRef(false);
  const tokenProfileNonceRef = useRef(0);
  const tokenProfileCacheRef = useRef<Map<string, TokenProfileResponse | null>>(new Map());
  const tokenProfileInFlightRef = useRef<Map<string, Promise<TokenProfileResponse | null>>>(new Map());
  const tokenSearchNonceRef = useRef(0);
  const compareSearchNonceRef = useRef(0);
  const compareProfileNonceRef = useRef(0);
  const tokenHistoryNonceRef = useRef(0);
  const watchlistNonceRef = useRef(0);
  const watchlistRefreshInFlightRef = useRef(false);
  const watchlistLastScoresRef = useRef<Record<string, number>>({});
  const watchlistAlertsRef = useRef<WatchlistAlertEvent[]>([]);
  const watchlistMintSet = useMemo(
    () => new Set(watchlistItems.map((item) => item.mint)),
    [watchlistItems]
  );
  const persistWatchlistAlertPreferences = useCallback(
    (next: Record<string, WatchlistAlertPreference>) => {
      if (typeof window === "undefined") {
        return;
      }
      window.localStorage.setItem(
        WATCHLIST_ALERT_PREFS_STORAGE_KEY,
        JSON.stringify(next)
      );
    },
    []
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
      if (Math.abs(delta) < watchlistAlertThreshold) {
        return;
      }
      const severity = alertSeverityFromDelta(delta);
      const nowIso = new Date().toISOString();
      const nowMs = Date.parse(nowIso);
      const direction = delta === 0 ? 0 : delta > 0 ? 1 : -1;

      const matching = watchlistItems.find((item) => item.mint === normalizedMint);
      const alert: WatchlistAlertEvent = {
        id: `${Date.now()}-${normalizedMint}-${Math.random().toString(36).slice(2, 9)}`,
        mint: normalizedMint,
        symbol: matching?.symbol || null,
        name: matching?.name || null,
        previousScore: Number(previousScore.toFixed(2)),
        nextScore: Number(nextScore.toFixed(2)),
        delta,
        severity,
        status: status || undefined,
        createdAt: nowIso
      };
      setWatchlistAlerts((current) => {
        const latestSameMint = current.find((item) => item.mint === normalizedMint);
        if (latestSameMint) {
          const latestTs = Date.parse(String(latestSameMint.createdAt || ""));
          const latestDirection =
            latestSameMint.delta === 0 ? 0 : Number(latestSameMint.delta || 0) > 0 ? 1 : -1;
          const latestSeverity = latestSameMint.severity || alertSeverityFromDelta(latestSameMint.delta || 0);
          const withinCooldown =
            Number.isFinite(latestTs) && nowMs - latestTs < WATCHLIST_ALERT_DEDUP_WINDOW_MS;
          if (withinCooldown && latestDirection === direction && latestSeverity === severity) {
            return current;
          }
        }
        return [alert, ...current].slice(0, WATCHLIST_MAX_ALERTS);
      });
    },
    [watchlistAlertPreferences, watchlistAlertThreshold, watchlistItems]
  );

  const fetchScoreByMint = useCallback(
    async (mintToAnalyze: string, timeoutMs: number, retries = 0): Promise<ScoreResponse> => {
      const normalizedMint = String(mintToAnalyze || "").trim();
      if (!normalizedMint) {
        throw new Error("Invalid mint address.");
      }
      return await requestJsonWithRetry<ScoreResponse>(
        `/v1/score/${encodeURIComponent(normalizedMint)}`,
        {
          timeoutMs,
          retries,
          retryDelayMs: 300
        }
      );
    },
    []
  );

  useEffect(() => {
    topTokenRisksRef.current = topTokenRisks;
  }, [topTokenRisks]);

  const rememberTopTokenRisk = useCallback((mintToStore: string, score: number, status?: string) => {
    const normalizedMint = String(mintToStore || "").trim();
    const numericScore = Number(score);
    if (!BASE58_MINT_RE.test(normalizedMint) || !Number.isFinite(numericScore)) {
      return;
    }
    topTokenScoreCacheRef.current.set(normalizedMint, {
      score: numericScore,
      status: String(status || "yellow"),
      updatedAt: Date.now()
    });
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
      rememberTopTokenRisk(normalizedMint, payload.score, payload.status);
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
        setAnalyzeError(
          `Request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. Try again, or switch to another token while RPC providers recover.`
        );
      } else {
        const message = error instanceof Error ? error.message : "Could not reach API.";
        setAnalyzeError(`${message} Try again in a few seconds.`);
      }
    } finally {
      setAnalyzeLoading(false);
    }
  }, [fetchScoreByMint, pushWatchlistAlert, rememberTopTokenRisk, watchlistMintSet]);

  const fetchTopTokens = useCallback(async () => {
    if (topTokensFetchInFlightRef.current) {
      return;
    }

    topTokensFetchInFlightRef.current = true;
    const nonce = ++topTokenNonceRef.current;
    setTopTokensLoading(true);
    setTopTokensError(null);

    try {
      const payload = await requestJsonWithRetry<TopTokensResponse>("/v1/top-tokens?limit=20", {
        timeoutMs: TOP_TOKENS_TIMEOUT_MS,
        retries: 1,
        retryDelayMs: 400
      });
      if (nonce !== topTokenNonceRef.current) {
        return;
      }

      const tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
      setTopTokens(tokens);
      setTopTokensSource(String(payload.source || "unknown"));
      setTopTokensWarnings(Array.isArray(payload.warnings) ? payload.warnings : []);

      const nowMs = Date.now();
      const staleCutoffMs = nowMs - TOP_TOKEN_SCORE_REUSE_MS;
      const existingRisks = topTokenRisksRef.current;
      const initialRisks: Record<string, TokenRiskState> = {};
      const tokensToFetch: TopToken[] = [];
      for (const token of tokens) {
        const cached = topTokenScoreCacheRef.current.get(token.mint);
        if (cached && cached.updatedAt >= staleCutoffMs) {
          initialRisks[token.mint] = {
            state: "ready",
            score: cached.score,
            status: cached.status
          };
          continue;
        }

        const existing = existingRisks[token.mint];
        if (existing?.state === "ready" && Number.isFinite(Number(existing.score))) {
          initialRisks[token.mint] = {
            state: "ready",
            score: existing.score,
            status: existing.status
          };
        } else {
          initialRisks[token.mint] = { state: "pending" };
        }
        tokensToFetch.push(token);
      }
      setTopTokenRisks(initialRisks);
      const aggregatedRisks: Record<string, TokenRiskState> = { ...initialRisks };

      if (tokensToFetch.length > 0) {
        const queue = [...tokensToFetch];
        const workerCount = Math.max(1, Math.min(TOP_TOKEN_SCORE_BATCH_SIZE, queue.length));
        await Promise.all(
          Array.from({ length: workerCount }).map(async () => {
            while (queue.length > 0) {
              const token = queue.shift();
              if (!token) {
                continue;
              }
              try {
                const score = await fetchScoreByMint(token.mint, TOP_TOKEN_SCORE_TIMEOUT_MS, 1);
                if (nonce !== topTokenNonceRef.current) {
                  return;
                }
                aggregatedRisks[token.mint] = {
                  state: "ready",
                  score: score.score,
                  status: score.status
                };
                rememberTopTokenRisk(token.mint, score.score, score.status);
              } catch {
                if (nonce !== topTokenNonceRef.current) {
                  return;
                }
                if (aggregatedRisks[token.mint]?.state !== "ready") {
                  aggregatedRisks[token.mint] = {
                    state: "error"
                  };
                }
              }
            }
          })
        );
      }

      for (const [mintKey, entry] of topTokenScoreCacheRef.current.entries()) {
        if (entry.updatedAt < nowMs - TOP_TOKEN_SCORE_REUSE_MS * 3) {
          topTokenScoreCacheRef.current.delete(mintKey);
        }
      }
      while (topTokenScoreCacheRef.current.size > 400) {
        const oldestKey = topTokenScoreCacheRef.current.keys().next().value;
        if (!oldestKey) {
          break;
        }
        topTokenScoreCacheRef.current.delete(oldestKey);
      }

      if (nonce !== topTokenNonceRef.current) {
        return;
      }
      setTopTokenRisks(aggregatedRisks);
      setTopTokensReadyOnce(true);
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
  }, [fetchScoreByMint, rememberTopTokenRisk]);

  const getTokenProfileCached = useCallback(
    async (mintToLookup: string): Promise<TokenProfileResponse | null> => {
      const normalizedMint = String(mintToLookup || "").trim();
      if (!BASE58_MINT_RE.test(normalizedMint)) {
        return null;
      }

      if (tokenProfileCacheRef.current.has(normalizedMint)) {
        return tokenProfileCacheRef.current.get(normalizedMint) || null;
      }

      const inFlight = tokenProfileInFlightRef.current.get(normalizedMint);
      if (inFlight) {
        return inFlight;
      }

      const task = requestJsonWithRetry<TokenProfileResponse>(`/v1/token/${encodeURIComponent(normalizedMint)}`, {
        timeoutMs: TOKEN_PROFILE_TIMEOUT_MS,
        retries: 1,
        retryDelayMs: 250
      })
        .then((profile) => profile || null)
        .catch(() => null)
        .then((profile) => {
          tokenProfileCacheRef.current.set(normalizedMint, profile);
          return profile;
        })
        .finally(() => {
          tokenProfileInFlightRef.current.delete(normalizedMint);
        });

      tokenProfileInFlightRef.current.set(normalizedMint, task);
      return task;
    },
    []
  );

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
    } finally {
      setWatchlistHydrated(true);
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
          const severityRaw = String(item?.severity || "").trim().toLowerCase();
          const severity: WatchlistAlertSeverity =
            severityRaw === "critical" || severityRaw === "major" || severityRaw === "minor"
              ? (severityRaw as WatchlistAlertSeverity)
              : alertSeverityFromDelta(delta);
          return {
            id: String(item?.id || "").trim(),
            mint: String(item?.mint || "").trim(),
            symbol: item?.symbol ? String(item.symbol).trim().toUpperCase() : null,
            name: item?.name ? String(item.name).trim() : null,
            previousScore: Number.isFinite(previous) ? previous : 0,
            nextScore: Number.isFinite(next) ? next : 0,
            delta: Number.isFinite(delta) ? delta : 0,
            severity,
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
    } finally {
      setWatchlistAlertsHydrated(true);
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
    } finally {
      setWatchlistAlertPreferencesHydrated(true);
    }
  }, []);

  useEffect(() => {
    try {
      if (typeof window === "undefined") {
        return;
      }
      const raw = window.localStorage.getItem(WATCHLIST_ALERT_THRESHOLD_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = Number(raw);
      if (
        Number.isFinite(parsed) &&
        WATCHLIST_ALERT_THRESHOLD_OPTIONS.includes(parsed as (typeof WATCHLIST_ALERT_THRESHOLD_OPTIONS)[number])
      ) {
        setWatchlistAlertThreshold(parsed);
      }
    } catch {
      // ignore localStorage parsing errors
    } finally {
      setWatchlistAlertThresholdHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !watchlistHydrated) {
      return;
    }
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlistItems));
  }, [watchlistHydrated, watchlistItems]);

  useEffect(() => {
    if (typeof window === "undefined" || !watchlistAlertsHydrated) {
      return;
    }
    window.localStorage.setItem(WATCHLIST_ALERTS_STORAGE_KEY, JSON.stringify(watchlistAlerts));
    watchlistAlertsRef.current = watchlistAlerts;
  }, [watchlistAlerts, watchlistAlertsHydrated]);

  useEffect(() => {
    if (typeof window === "undefined" || !watchlistAlertPreferencesHydrated) {
      return;
    }
    window.localStorage.setItem(
      WATCHLIST_ALERT_PREFS_STORAGE_KEY,
      JSON.stringify(watchlistAlertPreferences)
    );
  }, [watchlistAlertPreferences, watchlistAlertPreferencesHydrated]);

  useEffect(() => {
    if (typeof window === "undefined" || !watchlistAlertThresholdHydrated) {
      return;
    }
    window.localStorage.setItem(
      WATCHLIST_ALERT_THRESHOLD_STORAGE_KEY,
      String(watchlistAlertThreshold)
    );
  }, [watchlistAlertThreshold, watchlistAlertThresholdHydrated]);

  const normalizedInputMint = mint.trim();
  const normalizedCompareInput = compareMint.trim();

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

  const compareLocalSuggestions = useMemo<TokenSearchItem[]>(() => {
    const query = normalizeSearchText(normalizedCompareInput);
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
  }, [normalizedCompareInput, topTokens]);

  useEffect(() => {
    const query = normalizedInputMint;
    if (!query || query.length < 2 || BASE58_MINT_RE.test(query)) {
      tokenSearchNonceRef.current += 1;
      setRemoteSuggestions([]);
      return;
    }

    const nonce = ++tokenSearchNonceRef.current;
    const timeoutId = window.setTimeout(() => {
      void requestJsonWithRetry<TokenSearchResponse>(
        `/v1/token-search?q=${encodeURIComponent(query)}&limit=8`,
        {
          timeoutMs: TOKEN_SEARCH_TIMEOUT_MS,
          retries: 1,
          retryDelayMs: 250
        }
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

  useEffect(() => {
    const query = normalizedCompareInput;
    if (!query || query.length < 2 || BASE58_MINT_RE.test(query)) {
      compareSearchNonceRef.current += 1;
      setCompareRemoteSuggestions([]);
      return;
    }

    const nonce = ++compareSearchNonceRef.current;
    const timeoutId = window.setTimeout(() => {
      void requestJsonWithRetry<TokenSearchResponse>(
        `/v1/token-search?q=${encodeURIComponent(query)}&limit=8`,
        {
          timeoutMs: TOKEN_SEARCH_TIMEOUT_MS,
          retries: 1,
          retryDelayMs: 250
        }
      )
        .then((payload) => {
          if (nonce !== compareSearchNonceRef.current) {
            return;
          }
          const tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
          setCompareRemoteSuggestions(tokens);
        })
        .catch(() => {
          if (nonce !== compareSearchNonceRef.current) {
            return;
          }
          setCompareRemoteSuggestions([]);
        });
    }, 180);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [normalizedCompareInput]);

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

  const compareSuggestions = useMemo<TokenSearchItem[]>(() => {
    const merged = [...compareLocalSuggestions, ...compareRemoteSuggestions];
    const deduped = new Map<string, TokenSearchItem>();
    for (const token of merged) {
      const tokenMint = String(token?.mint || "").trim();
      if (!tokenMint || deduped.has(tokenMint)) {
        continue;
      }
      deduped.set(tokenMint, token);
    }
    return Array.from(deduped.values()).slice(0, 8);
  }, [compareLocalSuggestions, compareRemoteSuggestions]);
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
      persistWatchlistAlertPreferences(rest);
      return rest;
    });
    const { [normalizedMint]: _score, ...restScores } = watchlistLastScoresRef.current;
    watchlistLastScoresRef.current = restScores;
  }, [persistWatchlistAlertPreferences]);

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
        persistWatchlistAlertPreferences(rest);
        return rest;
      }
      const next = {
        ...current,
        [normalizedMint]: {
          muted: nextMuted,
          snoozedUntil: nextMuted ? null : row.snoozedUntil || null
        }
      };
      persistWatchlistAlertPreferences(next);
      return next;
    });
  }, [persistWatchlistAlertPreferences]);

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
          persistWatchlistAlertPreferences(rest);
          return rest;
        }
        const next = {
          ...current,
          [normalizedMint]: {
            ...row,
            snoozedUntil: null
          }
        };
        persistWatchlistAlertPreferences(next);
        return next;
      }
      const snoozedUntil = new Date(Date.now() + WATCHLIST_SNOOZE_MS).toISOString();
      const next = {
        ...current,
        [normalizedMint]: {
          muted: false,
          snoozedUntil
        }
      };
      persistWatchlistAlertPreferences(next);
      return next;
    });
  }, [persistWatchlistAlertPreferences]);

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

  const refreshWatchlistScores = useCallback(async (options?: { interactive?: boolean }) => {
    const interactive = Boolean(options?.interactive);
    if (watchlistRefreshInFlightRef.current) {
      return;
    }
    watchlistRefreshInFlightRef.current = true;
    if (interactive) {
      setWatchlistRefreshLoading(true);
    }

    const mints = Array.from(new Set(watchlistItems.map((item) => item.mint))).filter((itemMint) =>
      BASE58_MINT_RE.test(itemMint)
    );
    if (mints.length === 0) {
      watchlistRefreshInFlightRef.current = false;
      if (interactive) {
        setWatchlistRefreshLoading(false);
      }
      return;
    }

    const nonce = ++watchlistNonceRef.current;
    try {
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
              const score = await fetchScoreByMint(itemMint, WATCHLIST_SCORE_TIMEOUT_MS, 1);
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
              rememberTopTokenRisk(itemMint, score.score, score.status);
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
      if (nonce === watchlistNonceRef.current) {
        setWatchlistLastCheckedAt(new Date().toISOString());
      }
    } finally {
      watchlistRefreshInFlightRef.current = false;
      if (interactive) {
        setWatchlistRefreshLoading(false);
      }
    }
  }, [fetchScoreByMint, pushWatchlistAlert, rememberTopTokenRisk, watchlistItems]);

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
    if (!watchlistHydrated || !watchlistAlertsHydrated || !watchlistAlertPreferencesHydrated) {
      return;
    }
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
  }, [
    watchlistAlertPreferencesHydrated,
    watchlistAlertsHydrated,
    watchlistHydrated,
    watchlistItems
  ]);

  const watchlistAlertMintSet = useMemo(
    () => new Set(watchlistAlerts.map((alert) => alert.mint)),
    [watchlistAlerts]
  );
  const criticalAlertsCount = useMemo(
    () => watchlistAlerts.filter((alert) => (alert.severity || alertSeverityFromDelta(alert.delta)) === "critical").length,
    [watchlistAlerts]
  );
  const visibleWatchlistAlerts = useMemo(() => {
    if (watchlistAlertFilter === "critical") {
      return watchlistAlerts.filter(
        (alert) => (alert.severity || alertSeverityFromDelta(alert.delta)) === "critical"
      );
    }
    return watchlistAlerts;
  }, [watchlistAlertFilter, watchlistAlerts]);
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
  const compareBaseMint = String(scoreData?.mint || "").trim();
  const compareDisplayData = useMemo(() => {
    if (!compareData) {
      return null;
    }
    const hintA = compareTokenHints[compareData.tokenA.mint];
    const hintB = compareTokenHints[compareData.tokenB.mint];
    const tokenAPreferredImage =
      compareData.tokenA.mint === compareBaseMint ? String(activeTokenImage || "").trim() : "";
    const topTokenAImage =
      topTokens.find((token) => token.mint === compareData.tokenA.mint)?.imageUrl || null;
    const topTokenBImage =
      topTokens.find((token) => token.mint === compareData.tokenB.mint)?.imageUrl || null;
    const fallbackA =
      topTokenAImage ||
      fallbackLogoUrlForMint(compareData.tokenA.mint) ||
      null;
    const fallbackB =
      topTokenBImage ||
      fallbackLogoUrlForMint(compareData.tokenB.mint) ||
      null;
    return {
      ...compareData,
      tokenA: {
        ...compareData.tokenA,
        symbol: compareData.tokenA.symbol || hintA?.symbol || null,
        name: compareData.tokenA.name || hintA?.name || null,
        imageUrl:
          tokenAPreferredImage ||
          (hintA?.imageUrl || "").trim() ||
          (topTokenAImage || "").trim() ||
          (compareData.tokenA.imageUrl || "").trim() ||
          fallbackA
      },
      tokenB: {
        ...compareData.tokenB,
        symbol: compareData.tokenB.symbol || hintB?.symbol || null,
        name: compareData.tokenB.name || hintB?.name || null,
        imageUrl:
          (hintB?.imageUrl || "").trim() ||
          (topTokenBImage || "").trim() ||
          (compareData.tokenB.imageUrl || "").trim() ||
          fallbackB
      }
    };
  }, [activeTokenImage, compareBaseMint, compareData, compareTokenHints, topTokens]);

  const runCompare = useCallback(async (mintBOverride?: string) => {
    const mintA = compareBaseMint;
    const mintBInput = String((mintBOverride ?? compareMint) || "").trim();
    if (!mintA || !BASE58_MINT_RE.test(mintA)) {
      setCompareError("Analyze token A first, then run compare.");
      return;
    }
    if (!mintBInput) {
      setCompareError("Enter Token B mint address, name, or symbol.");
      return;
    }

    setCompareLoading(true);
    setCompareError(null);
    try {
      let mintBResolved = mintBInput;
      let resolvedHint: TokenSearchItem | null =
        compareSuggestions.find((token) => token.mint === mintBInput) || null;
      if (!BASE58_MINT_RE.test(mintBResolved)) {
        let resolvedFromSearch = resolveMintFromQuery(mintBInput, compareSuggestions);
        let searchTokens: TokenSearchItem[] = [];
        if (!resolvedFromSearch) {
          const searchPayload = await requestJsonWithRetry<TokenSearchResponse>(
            `/v1/token-search?q=${encodeURIComponent(mintBInput)}&limit=8`,
            {
              timeoutMs: TOKEN_SEARCH_TIMEOUT_MS,
              retries: 1,
              retryDelayMs: 250
            }
          );
          searchTokens = Array.isArray(searchPayload.tokens) ? searchPayload.tokens : [];
          resolvedFromSearch =
            resolveMintFromQuery(mintBInput, searchTokens) ||
            (searchTokens.length === 1 ? searchTokens[0].mint : null);
        }
        if (!resolvedFromSearch || !BASE58_MINT_RE.test(resolvedFromSearch)) {
          setCompareData(null);
          setCompareError("Could not resolve Token B. Use full mint or a more specific token name.");
          return;
        }
        mintBResolved = resolvedFromSearch;
        if (!resolvedHint) {
          resolvedHint =
            compareSuggestions.find((token) => token.mint === mintBResolved) ||
            searchTokens.find((token) => token.mint === mintBResolved) ||
            null;
        }
      }

      if (mintA === mintBResolved) {
        setCompareData(null);
        setCompareError("Token A and Token B must be different mints.");
        return;
      }

      if (!resolvedHint) {
        resolvedHint = compareSuggestions.find((token) => token.mint === mintBResolved) || null;
      }
      if (resolvedHint) {
        setCompareTokenHints((current) => ({
          ...current,
          [mintBResolved]: {
            mint: mintBResolved,
            symbol: resolvedHint?.symbol || null,
            name: resolvedHint?.name || null,
            imageUrl: resolvedHint?.imageUrl || null
          }
        }));
      }

      const payload = await requestJsonWithRetry<CompareResponse>(
        `/v1/compare?mintA=${encodeURIComponent(mintA)}&mintB=${encodeURIComponent(mintBResolved)}`,
        {
          timeoutMs: REQUEST_TIMEOUT_MS,
          retries: 1,
          retryDelayMs: 300
        }
      );
      if (mintBResolved !== mintBInput) {
        setCompareMint(mintBResolved);
      }
      setCompareData(payload);
    } catch (error) {
      setCompareData(null);
      setCompareError(error instanceof Error ? error.message : "Failed to compare tokens.");
    } finally {
      setCompareLoading(false);
    }
  }, [compareBaseMint, compareMint, compareSuggestions]);

  useEffect(() => {
    if (!activeMint || activeToken || !BASE58_MINT_RE.test(activeMint)) {
      tokenProfileNonceRef.current += 1;
      setExternalTokenProfile(null);
      return;
    }

    const nonce = ++tokenProfileNonceRef.current;
    void getTokenProfileCached(activeMint)
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
  }, [activeMint, activeToken, getTokenProfileCached]);

  useEffect(() => {
    if (!compareData) {
      compareProfileNonceRef.current += 1;
      return;
    }

    const mints = [compareData.tokenA.mint, compareData.tokenB.mint]
      .map((value) => String(value || "").trim())
      .filter((value) => BASE58_MINT_RE.test(value));
    if (mints.length === 0) {
      return;
    }

    const nonce = ++compareProfileNonceRef.current;
    void Promise.all(
      mints.map((mintValue) =>
        getTokenProfileCached(mintValue).then((profile) => ({ mint: mintValue, profile }))
      )
    ).then((results) => {
      if (nonce !== compareProfileNonceRef.current) {
        return;
      }
      setCompareTokenHints((current) => {
        let changed = false;
        const next = { ...current };
        for (const result of results) {
          const existing = next[result.mint] || { mint: result.mint };
          const profile = result.profile;
          const imageUrl = String(profile?.imageUrl || existing.imageUrl || "").trim() || null;
          const symbol = profile?.symbol || existing.symbol || null;
          const name = profile?.name || existing.name || null;
          const updated = {
            mint: result.mint,
            symbol,
            name,
            imageUrl
          };
          if (
            existing.symbol !== updated.symbol ||
            existing.name !== updated.name ||
            String(existing.imageUrl || "") !== String(updated.imageUrl || "")
          ) {
            next[result.mint] = updated;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    });
  }, [compareData, getTokenProfileCached]);

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

    void requestJsonWithRetry<ScoreHistoryResponse>(
      `/v1/history/${encodeURIComponent(activeMint)}?limit=40`,
      {
        timeoutMs: TOKEN_HISTORY_TIMEOUT_MS,
        retries: 1,
        retryDelayMs: 300
      }
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

  useEffect(() => {
    setCompareData(null);
    setCompareError(null);
    setCompareMint("");
  }, [compareBaseMint]);

  useEffect(() => {
    if (!isMethodologyOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMethodologyOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isMethodologyOpen]);

  return (
    <div className="min-h-screen bg-tl-bg font-sans text-tl-text">
      <Header
        onOpenMethodology={() => setIsMethodologyOpen(true)}
        apiHealthHref={`${API_BASE}/health`}
      />
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
                      "Enter a valid mint address or pick a token name/symbol from suggestions."
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
                showInitialSkeleton={!topTokensReadyOnce && topTokensLoading}
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

              <TableInsightsPanel
                tokens={topTokens}
                risks={topTokenRisks}
                source={topTokensSource}
                fallbackMode={topTokensWarnings.length > 0}
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
              <section className="bg-transparent px-4 pb-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsWatchlistOpen((current) => !current)}
                  aria-expanded={isWatchlistOpen}
                  className="w-full border border-tl-border bg-black px-3 py-2 text-left transition-colors duration-150 hover:bg-[#101010]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-sm font-semibold text-tl-text">Favorites watchlist</span>
                    <span className="text-xs text-tl-muted">{watchlistItems.length} token(s)</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1">
                      {watchlistAlerts.length > 0 ? (
                        <span className="rounded-sm border border-red-500/40 bg-red-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
                          {watchlistAlerts.length} alert{watchlistAlerts.length === 1 ? "" : "s"}
                        </span>
                      ) : null}
                      {criticalAlertsCount > 0 ? (
                        <span className="rounded-sm border border-red-500/60 bg-red-950/60 px-1.5 py-0.5 text-[10px] font-semibold text-red-200">
                          {criticalAlertsCount} critical
                        </span>
                      ) : null}
                      {watchlistSuppressedMintSet.size > 0 ? (
                        <span className="rounded-sm border border-zinc-600/70 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300">
                          {watchlistSuppressedMintSet.size} suppressed
                        </span>
                      ) : null}
                    </div>
                    <span
                      aria-hidden="true"
                      className={`inline-block text-sm text-tl-muted transition-transform duration-150 ${
                        isWatchlistOpen ? "rotate-180" : ""
                      }`}
                    >
                      ▾
                    </span>
                  </div>
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
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={() => setIsRecentAlertsOpen((current) => !current)}
                  aria-expanded={isRecentAlertsOpen}
                  className="mt-2 w-full border border-tl-border bg-black px-3 py-2 text-left transition-colors duration-150 hover:bg-[#101010]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-sm font-semibold text-tl-text">Recent alerts</span>
                    <span className="text-xs text-tl-muted">{watchlistAlerts.length} alert(s)</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="rounded-sm border border-zinc-700/70 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300">
                        threshold {watchlistAlertThreshold}
                      </span>
                      {criticalAlertsCount > 0 ? (
                        <span className="rounded-sm border border-red-500/60 bg-red-950/60 px-1.5 py-0.5 text-[10px] font-semibold text-red-200">
                          {criticalAlertsCount} critical
                        </span>
                      ) : null}
                    </div>
                    <span
                      aria-hidden="true"
                      className={`inline-block text-sm text-tl-muted transition-transform duration-150 ${
                        isRecentAlertsOpen ? "rotate-180" : ""
                      }`}
                    >
                      ▾
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Alerts are generated from watchlist checks.
                  </p>
                </button>

                {isRecentAlertsOpen ? (
                  <div className="border-x border-b border-tl-border px-3 py-2">
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
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-[11px] uppercase tracking-[0.06em] text-zinc-500">
                        Alert threshold
                      </p>
                      <div className="flex items-center gap-1">
                        {WATCHLIST_ALERT_THRESHOLD_OPTIONS.map((value) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setWatchlistAlertThreshold(value)}
                            className={`border px-1.5 py-0.5 text-[10px] font-semibold ${
                              watchlistAlertThreshold === value
                                ? "border-sky-500/50 bg-sky-950/40 text-sky-300"
                                : "border-tl-border bg-black text-zinc-400 hover:text-zinc-200"
                            }`}
                          >
                            {value} pts
                          </button>
                        ))}
                      </div>
                    </div>
                    <p className="mb-2 text-[11px] text-zinc-500">
                      Threshold applies to new watchlist alerts during checks. Score History uses
                      historical snapshots and does not change with threshold.
                    </p>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-[11px] uppercase tracking-[0.06em] text-zinc-500">Quick test</p>
                      <button
                        type="button"
                        onClick={() => {
                          void refreshWatchlistScores({ interactive: true });
                        }}
                        disabled={watchlistItems.length === 0 || watchlistRefreshLoading}
                        className="border border-tl-border bg-black px-1.5 py-0.5 text-[10px] font-semibold uppercase text-zinc-300 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {watchlistRefreshLoading ? "Checking..." : "Check now"}
                      </button>
                    </div>
                    <p className="mb-2 text-[11px] text-zinc-500">
                      {watchlistRefreshLoading
                        ? "Running watchlist refresh..."
                        : watchlistLastCheckedAt
                          ? `Last check completed at ${formatCheckTimestamp(watchlistLastCheckedAt)}`
                          : "No manual check yet."}
                    </p>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-[11px] uppercase tracking-[0.06em] text-zinc-500">Filter</p>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setWatchlistAlertFilter("all")}
                          className={`border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                            watchlistAlertFilter === "all"
                              ? "border-sky-500/50 bg-sky-950/40 text-sky-300"
                              : "border-tl-border bg-black text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          All
                        </button>
                        <button
                          type="button"
                          onClick={() => setWatchlistAlertFilter("critical")}
                          className={`border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                            watchlistAlertFilter === "critical"
                              ? "border-red-500/50 bg-red-950/40 text-red-300"
                              : "border-tl-border bg-black text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          Critical
                        </button>
                      </div>
                    </div>

                    {watchlistAlerts.length === 0 ? (
                      <p className="text-xs text-tl-muted">
                        Alerts trigger when a watchlist token score moves by at least{" "}
                        {watchlistAlertThreshold} points between checks.
                      </p>
                    ) : visibleWatchlistAlerts.length === 0 ? (
                      <p className="text-xs text-tl-muted">No alerts in selected filter.</p>
                    ) : (
                      <ul className="grid gap-1.5">
                        {visibleWatchlistAlerts.slice(0, 8).map((alert) => (
                          <li key={alert.id} className="min-w-0">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedMint(
                                  topTokens.some((token) => token.mint === alert.mint) ? alert.mint : null
                                );
                                setMint(alert.mint);
                                void analyzeMint(alert.mint);
                              }}
                              className="flex w-full min-w-0 items-center justify-between gap-2 overflow-hidden text-left"
                            >
                              <span className="min-w-0 flex-1 text-xs text-zinc-300">
                                <span className="block truncate font-semibold text-zinc-200">
                                  {alert.name || alert.symbol || "Token"}
                                </span>
                                <span className="block truncate text-[11px] text-zinc-500">
                                  {alert.symbol || "N/A"} · {formatAlertTimestamp(alert.createdAt)}
                                </span>
                              </span>
                              <span className="flex shrink-0 items-center gap-2">
                                <span
                                  className={`rounded-sm border px-1 py-0.5 text-[10px] font-semibold uppercase ${alertSeverityClass(
                                    alert.severity || alertSeverityFromDelta(alert.delta)
                                  )}`}
                                >
                                  {alert.severity || alertSeverityFromDelta(alert.delta)}
                                </span>
                                <span
                                  className={`text-xs font-bold ${
                                    alert.delta >= 0 ? "text-red-400" : "text-green-300"
                                  }`}
                                >
                                  {alert.delta >= 0 ? "+" : ""}
                                  {Math.round(alert.delta)} pts
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={() => setIsCompareOpen((current) => !current)}
                  aria-expanded={isCompareOpen}
                  className="mt-2 w-full border border-tl-border bg-black px-3 py-2 text-left transition-colors duration-150 hover:bg-[#101010]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-sm font-semibold text-tl-text">Compare</span>
                    <span className="text-xs text-tl-muted">{compareBaseMint ? "ready" : "analyze token A first"}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-zinc-500">Compare active token against Token B.</span>
                    <span
                      aria-hidden="true"
                      className={`inline-block text-sm text-tl-muted transition-transform duration-150 ${
                        isCompareOpen ? "rotate-180" : ""
                      }`}
                    >
                      ▾
                    </span>
                  </div>
                </button>

                {isCompareOpen ? (
                  <div className="border-x border-b border-tl-border px-3 py-2">
                    <ComparePanel
                      activeMint={compareBaseMint}
                      compareMint={compareMint}
                      onCompareMintChange={(value) => {
                        setCompareMint(value);
                        if (compareError) {
                          setCompareError(null);
                        }
                      }}
                      suggestions={compareSuggestions}
                      onSelectSuggestion={(token) => {
                        setCompareTokenHints((current) => ({
                          ...current,
                          [token.mint]: {
                            mint: token.mint,
                            symbol: token.symbol || null,
                            name: token.name || null,
                            imageUrl: token.imageUrl || null
                          }
                        }));
                        setCompareMint(token.mint);
                        if (compareError) {
                          setCompareError(null);
                        }
                        void runCompare(token.mint);
                      }}
                      onCompare={runCompare}
                      isLoading={compareLoading}
                      errorMessage={compareError}
                      data={compareDisplayData}
                      onAnalyzeMint={(tokenMint) => {
                        setSelectedMint(topTokens.some((token) => token.mint === tokenMint) ? tokenMint : null);
                        setMint(tokenMint);
                        void analyzeMint(tokenMint);
                      }}
                      compact
                      showHeader={false}
                    />
                  </div>
                ) : null}
              </section>

              {activeMint ? (
                <section className="h-[128px] bg-transparent px-4 pb-3 pt-3">
                  <div className="flex items-center gap-3">
                    <div className="relative grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-transparent text-xs font-extrabold text-tl-text ring-1 ring-tl-border/70">
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
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
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
                      className={`ml-auto grid h-7 w-7 place-items-center border transition-colors duration-150 ${
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
                  Start here: 1) pick a top token or search by mint/name, 2) run analysis, 3) add
                  useful tokens to Favorites to monitor alerts over time.
                </section>
              )}

            </aside>
          </section>
        </main>
      </div>
      {isMethodologyOpen ? (
        <div className="fixed inset-0 z-[80] bg-black/80 px-4 py-6">
          <div className="mx-auto mt-8 w-full max-w-3xl border border-tl-border bg-black">
            <div className="flex items-center justify-between border-b border-tl-border px-4 py-3">
              <h2 className="font-display text-lg font-semibold text-tl-text">How Scoring Works</h2>
              <button
                type="button"
                onClick={() => setIsMethodologyOpen(false)}
                className="border border-tl-border px-2 py-1 text-xs text-zinc-300 hover:bg-[#111111]"
              >
                Close
              </button>
            </div>
            <div className="grid gap-4 px-4 py-4 text-sm text-tl-muted">
              <p>
                TrustLayer score ranges from 0 to 100. Higher score means lower risk.
              </p>
              <div className="grid gap-2 border border-tl-border bg-[#050505] px-3 py-3 text-xs">
                <p className="font-semibold text-tl-text">Current weighted formula</p>
                <p>Holder concentration safety: 35%</p>
                <p>Liquidity confidence: 20%</p>
                <p>Authority safety (mint/freeze): 25%</p>
                <p>Metadata confidence: 10%</p>
                <p>Activity confidence: 10%</p>
              </div>
              <p>
                Guardrails are applied for very high holder concentration, and confidence can
                downgrade final status to avoid over-trusting low-quality data.
              </p>
              <p className="text-xs text-zinc-500">
                Disclaimer: TrustLayer score is an informational signal and not financial advice.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
