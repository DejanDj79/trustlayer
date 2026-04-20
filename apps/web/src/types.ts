export type RiskStatus = "green" | "yellow" | "red" | string;
export type ScoreConfidence = "high" | "medium" | "low" | string;

export interface TokenRiskSignals {
  mintAuthorityEnabled?: boolean | null;
  freezeAuthorityEnabled?: boolean | null;
  holderConcentrationPct?: number | null;
  holderConcentrationSource?: string | null;
  holderSampledAccounts?: number | null;
  holderTotalAccounts?: number | null;
  holderSampleCoveragePct?: number | null;
  holderPagesFetched?: number | null;
  scoreConfidence?: ScoreConfidence;
  marketPairCount?: number | null;
  liquidityUsd?: number | null;
  volume24hUsd?: number | null;
  tx24h?: number | null;
}

export interface RpcFailure {
  endpoint: string;
  attempt: number;
  message: string;
}

export interface RpcHealthItem {
  status: string;
  providers?: RpcFailure[];
  note?: string;
  pagesFetched?: number;
}

export interface RpcHealth {
  largestHolders?: RpcHealthItem;
  tokenAccountsFallback?: RpcHealthItem;
  tokenSupply?: RpcHealthItem;
}

export interface ScoreBreakdownComponent {
  key: string;
  label: string;
  weightPct: number;
  signalLabel?: string;
  signalValue?: number | null;
  signalUnit?: string | null;
  normalizedSignal?: number | null;
  contribution: number;
}

export interface ScoreBreakdownAdjustment {
  type: string;
  key: string;
  label: string;
  delta: number;
  beforeScore: number;
  afterScore: number;
  note?: string | null;
  cap?: number | null;
  tier?: string | null;
}

export interface ScoreBreakdown {
  formulaVersion: string;
  maxScore: number;
  weights: Record<string, number>;
  baseScore: number;
  baseScoreRaw: number;
  components: ScoreBreakdownComponent[];
  adjustments: ScoreBreakdownAdjustment[];
  finalScore: number;
  impliedStatus: RiskStatus;
  finalStatus: RiskStatus;
  scoreConfidence?: ScoreConfidence;
  statusDowngraded?: boolean;
  statusDowngradeReason?: string | null;
}

export interface ScoreResponse {
  mint: string;
  score: number;
  status: RiskStatus;
  scoreConfidence?: ScoreConfidence;
  scoreBreakdown?: ScoreBreakdown | null;
  reasons?: string[];
  dataSource?: string;
  signalDetails?: TokenRiskSignals;
  rpcHealth?: RpcHealth;
  warnings?: string[];
  generatedAt?: string;
}

export interface CompareTokenResult {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  assessment: ScoreResponse;
}

export interface CompareResponse {
  mintA: string;
  mintB: string;
  tokenA: CompareTokenResult;
  tokenB: CompareTokenResult;
  comparison: {
    scoreDelta: number;
    scoreA: number;
    scoreB: number;
    riskierMint: string | null;
    saferMint: string | null;
    summary: string;
  };
  generatedAt?: string;
}

export interface TopToken {
  rank: number;
  symbol: string;
  name: string;
  mint: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  change24hPct: number | null;
  sparkline7d?: number[] | null;
  imageUrl?: string | null;
}

export interface TopTokensResponse {
  tokens: TopToken[];
  source?: string;
  warnings?: string[];
}

export interface TokenProfileResponse {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  source?: string;
  generatedAt?: string;
}

export interface TokenSearchItem {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  imageUrl?: string | null;
}

export interface TokenSearchResponse {
  tokens: TokenSearchItem[];
  query?: string;
  source?: string;
  generatedAt?: string;
}

export interface WatchlistItem {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  addedAt?: string;
}

export interface ScoreHistoryPoint {
  timestamp: string;
  score: number;
  status: RiskStatus;
  scoreConfidence?: ScoreConfidence;
  dataSource?: string;
  source?: string;
}

export interface ScoreHistoryResponse {
  mint: string;
  points: ScoreHistoryPoint[];
  source?: string;
  retentionMs?: number;
  generatedAt?: string;
}

export interface TokenRiskState {
  state: "pending" | "ready" | "error";
  score?: number;
  status?: RiskStatus;
}

export type WatchlistAlertSeverity = "minor" | "major" | "critical";

export interface WatchlistAlertEvent {
  id: string;
  mint: string;
  symbol?: string | null;
  name?: string | null;
  previousScore: number;
  nextScore: number;
  delta: number;
  severity?: WatchlistAlertSeverity;
  status?: RiskStatus;
  createdAt: string;
}

export interface WatchlistAlertPreference {
  muted?: boolean;
  snoozedUntil?: string | null;
}
