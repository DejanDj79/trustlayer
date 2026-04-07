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

export interface ScoreResponse {
  mint: string;
  score: number;
  status: RiskStatus;
  scoreConfidence?: ScoreConfidence;
  reasons?: string[];
  dataSource?: string;
  signalDetails?: TokenRiskSignals;
  rpcHealth?: RpcHealth;
  warnings?: string[];
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

export interface TokenRiskState {
  state: "pending" | "ready" | "error";
  score?: number;
  status?: RiskStatus;
}
