import type { TopToken } from "../types";

export type NarrativeTone = "stable" | "core" | "defi" | "meme" | "infrastructure" | "neutral";
export type NarrativeFilter = "all" | NarrativeTone;

export const NARRATIVE_FILTERS: Array<{ value: NarrativeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "stable", label: "Stablecoin" },
  { value: "core", label: "Core" },
  { value: "defi", label: "DeFi" },
  { value: "meme", label: "Meme" },
  { value: "infrastructure", label: "Infra" },
  { value: "neutral", label: "General" }
];

export interface NarrativeTag {
  label: string;
  tone: NarrativeTone;
}

function normalize(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function hasKeyword(haystack: string, keywords: string[]): boolean {
  return keywords.some((keyword) => haystack.includes(keyword));
}

export function narrativeTagForToken(token: TopToken): NarrativeTag {
  const id = normalize(token.coingeckoId);
  const symbol = normalize(token.symbol);
  const name = normalize(token.name);
  const text = `${id} ${symbol} ${name}`;

  if (
    hasKeyword(text, [
      "usd",
      "usdc",
      "usdt",
      "tether",
      "usd coin",
      "paypal usd",
      "pyusd",
      "fdusd",
      "eurc",
      "stable"
    ])
  ) {
    return { label: "Stablecoin", tone: "stable" };
  }

  if (hasKeyword(text, ["solana", "sol"]) && !hasKeyword(text, ["jitosol", "msol", "bsol", "lst"])) {
    return { label: "Core Asset", tone: "core" };
  }

  if (hasKeyword(text, ["jitosol", "msol", "bsol", "blazesol", "lst", "liquid staking"])) {
    return { label: "Liquid Staking", tone: "infrastructure" };
  }

  if (hasKeyword(text, ["bonk", "dogwifhat", "wif", "memecoin", "meme", "trump", "popcat", "pepe"])) {
    return { label: "Meme", tone: "meme" };
  }

  if (hasKeyword(text, ["raydium", "ray", "jupiter", "jup", "orca", "drift", "kamino", "marinade"])) {
    return { label: "DeFi", tone: "defi" };
  }

  if (hasKeyword(text, ["pyth", "wormhole", "chainlink", "oracle", "bridge"])) {
    return { label: "Infrastructure", tone: "infrastructure" };
  }

  return { label: "General", tone: "neutral" };
}

export function narrativeToneClass(tone: NarrativeTone): string {
  switch (tone) {
    case "stable":
      return "border-emerald-800/70 bg-emerald-950/40 text-emerald-300";
    case "core":
      return "border-sky-800/70 bg-sky-950/40 text-sky-300";
    case "defi":
      return "border-indigo-800/70 bg-indigo-950/40 text-indigo-300";
    case "meme":
      return "border-fuchsia-800/70 bg-fuchsia-950/40 text-fuchsia-300";
    case "infrastructure":
      return "border-cyan-800/70 bg-cyan-950/40 text-cyan-300";
    default:
      return "border-zinc-700 bg-zinc-900/70 text-zinc-300";
  }
}
