import type { TokenSnapshot } from "./types";

/**
 * Narrative tagging by keyword. Deterministic on purpose: an LLM could later improve the tags, but it should
 * only ever return a theme label, never trade. Short keywords only match at the start or end of a symbol so
 * "AI" does not fire inside "BAIT".
 */
const THEMES: { id: string; words: string[] }[] = [
  { id: "dog", words: ["doge", "dog", "inu", "bonk", "wif", "shib", "puppy"] },
  { id: "frog", words: ["pepe", "frog", "kek"] },
  { id: "cat", words: ["cat", "kitty", "meow"] },
  { id: "ape", words: ["ape", "monkey", "kong", "gorilla"] },
  { id: "political", words: ["trump", "maga", "elon", "biden", "vote", "president"] },
  { id: "ai", words: ["ai", "gpt", "agent", "neural", "llm"] },
  { id: "space", words: ["moon", "rocket", "mars", "star"] },
];

export const OTHER_THEME = "other";

export function themeOf(symbol: string, name?: string): string {
  const text = `${symbol} ${name ?? ""}`.toLowerCase();
  let best: { id: string; pos: number } | null = null;

  for (const theme of THEMES) {
    for (const word of theme.words) {
      const idx = text.indexOf(word);
      if (idx < 0) continue;
      const atStart = idx === 0;
      const atEnd = idx + word.length >= symbol.length;
      if (word.length <= 3 && !atStart && !atEnd) continue;
      if (!best || idx < best.pos) best = { id: theme.id, pos: idx };
    }
  }
  return best?.id ?? OTHER_THEME;
}

export interface ThemeHeat {
  theme: string;
  tokens: number;
  volume5mUsd: number;
  avgBuyRatio: number;
  topSymbol: string;
}

/** Which themes are hot right now: aggregate activity per theme over the current universe. */
export function themeHeat(universe: TokenSnapshot[]): ThemeHeat[] {
  const groups = new Map<string, TokenSnapshot[]>();
  for (const t of universe) {
    const theme = t.theme ?? OTHER_THEME;
    const list = groups.get(theme) ?? [];
    list.push(t);
    groups.set(theme, list);
  }
  const out: ThemeHeat[] = [];
  for (const [theme, list] of groups) {
    const buys = list.map((t) => t.buyRatio).filter((b): b is number => b !== null);
    const top = list.reduce((a, b) => (b.volume5mUsd > a.volume5mUsd ? b : a));
    out.push({
      theme,
      tokens: list.length,
      volume5mUsd: list.reduce((s, t) => s + t.volume5mUsd, 0),
      avgBuyRatio: buys.length ? buys.reduce((s, b) => s + b, 0) / buys.length : 0.5,
      topSymbol: top.symbol,
    });
  }
  return out.sort((a, b) => b.volume5mUsd - a.volume5mUsd);
}
