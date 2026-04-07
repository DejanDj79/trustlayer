import type { RiskStatus } from "../types";

const BASE58_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_LIST_FALLBACK_LOGO_BASE =
  "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet";

export function shortMint(mint: string | null | undefined): string {
  if (!mint || mint.length < 12) {
    return mint || "n/a";
  }
  return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

export function formatUsd(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) {
    return "n/a";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(Number(value));
}

export function formatPrice(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) {
    return "n/a";
  }
  const numeric = Number(value);
  const maxDigits = numeric >= 1 ? 2 : 6;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: maxDigits
  }).format(numeric);
}

export function formatPercent(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) {
    return "n/a";
  }
  const numeric = Number(value);
  return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(2)}%`;
}

export function formatNumber(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) {
    return "n/a";
  }
  return new Intl.NumberFormat("en-US").format(Number(value));
}

export function normalizeStatus(status: RiskStatus | null | undefined): "green" | "yellow" | "red" {
  const normalized = String(status || "yellow").toLowerCase();
  if (normalized === "green" || normalized === "red") {
    return normalized;
  }
  return "yellow";
}

export function riskBandFromScore(score: number | null | undefined): "green" | "yellow" | "red" {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) {
    return "yellow";
  }
  if (numeric >= 70) {
    return "green";
  }
  if (numeric >= 40) {
    return "yellow";
  }
  return "red";
}

export function riskLabelFromBand(
  band: "green" | "yellow" | "red"
): "LOW RISK" | "MEDIUM RISK" | "HIGH RISK" {
  if (band === "green") {
    return "LOW RISK";
  }
  if (band === "red") {
    return "HIGH RISK";
  }
  return "MEDIUM RISK";
}

export function riskToneClassFromBand(band: "green" | "yellow" | "red"): string {
  if (band === "green") {
    return "bg-green-950/30";
  }
  if (band === "red") {
    return "bg-red-950/30";
  }
  return "bg-amber-950/30";
}

export function statusClasses(status: RiskStatus | null | undefined): string {
  const normalized = normalizeStatus(status);
  if (normalized === "green") {
    return "bg-green-950 text-green-300";
  }
  if (normalized === "red") {
    return "bg-red-950 text-red-300";
  }
  return "bg-amber-950 text-amber-300";
}

export function fallbackLogoUrlForMint(mint: string | null | undefined): string {
  const normalizedMint = String(mint || "").trim();
  if (!BASE58_MINT_RE.test(normalizedMint)) {
    return "";
  }
  return `${TOKEN_LIST_FALLBACK_LOGO_BASE}/${normalizedMint}/logo.png`;
}

export function initials(symbol: string | null | undefined, name: string | null | undefined): string {
  const text = String(symbol || name || "T")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 2)
    .toUpperCase();
  return text || "T";
}
