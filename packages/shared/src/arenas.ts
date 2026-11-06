export interface ArenaMeta {
  /** An Elysian place on the ring. */
  name: string;
  /** The arena's ink (ticket stripe, stamp, place marker). Upper-case hex. */
  ink: string;
  /** Second stop when the ink is a gradient (Lethe), else absent. */
  inkTo?: string;
}

/** Ink of an arena id the catalog does not know (`--teal`). */
export const ARENA_INK_FALLBACK = '#2D7388';

/** Display metadata for the arena contract's ids (the chain stores only numbers). */
export const ARENA_META: Record<number, ArenaMeta> = {
  1: { name: 'Asphodel Meadow', ink: '#6FCDE8' },
  2: { name: 'Lethe Shore', ink: '#93D9EE', inkTo: '#2D7388' },
  3: { name: 'Golden Bough', ink: '#F2C14E' },
  4: { name: 'Isles of the Blessed', ink: '#3C9A87' },
};

/**
 * The ticket tiers, priced in US dollars (owner decision 2026-11): $1, $3, $5 and $10, the $10 arena for Elymum emblem
 * holders only. The chain stores entry fees in token units (`ElymumArena.createArena` / `updateArena`), so the admin
 * converts these dollar prices into token amounts at the current USD price of the token and signs the update
 * (`arena-pricing.ts`, `/admin` → Game → Arena prices).
 *
 * `entryTokens` (whole tokens; scale by the token's decimals for base units) is what Finish setup creates the arenas
 * with before any price is set: the dollar price at the reference price `REFERENCE_USD_PER_TOKEN` ($0.001 a token),
 * so a fresh testnet already has the 1 : 3 : 5 : 10 ladder. `maxSessions` is how many tickets can be open at once.
 */
export const DEFAULT_ARENAS = [
  { id: 1, usdCents: 100, entryTokens: 1000, maxSessions: 300, holdersOnly: false },
  { id: 2, usdCents: 300, entryTokens: 3000, maxSessions: 300, holdersOnly: false },
  { id: 3, usdCents: 500, entryTokens: 5000, maxSessions: 300, holdersOnly: false },
  { id: 4, usdCents: 1000, entryTokens: 10000, maxSessions: 300, holdersOnly: true },
] as const;

/** The token price `DEFAULT_ARENAS.entryTokens` assume (USD per whole token, a decimal string). */
export const REFERENCE_USD_PER_TOKEN = '0.001';

export function arenaMeta(id: number): ArenaMeta {
  return ARENA_META[id] ?? { name: `Arena #${id}`, ink: ARENA_INK_FALLBACK };
}
