/**
 * The game's money rules in one place (paid arenas).
 *
 * - **Entry.** A ticket's entry fee goes into the arena vault; the coin starts at that value.
 * - **Winnings cut.** When a ticket is paid, 20 % of its *winnings* (what it holds above the value it
 *   started with) goes to the team: 15 % is burned (`$ELYMUM` leaves the supply for good) and 5 % stays
 *   in the arena vault as the team's reserve. A game that ends at or below its start value pays no cut;
 *   the cut never touches the stake itself.
 * - **Floor loot** still on the floor at the bell is burned.
 *
 * The on-chain entry fee rate (`feeBps` of the arena contract) is separate and set by the owner; with
 * this model the recommended rate is 0 (`RECOMMENDED_ENTRY_FEE_BPS`).
 */
export const ECONOMY = {
  /** Share of the winnings burned, basis points. */
  burnBps: 1500,
  /** Share of the winnings kept in the arena vault (the team's reserve), basis points. */
  vaultBps: 500,
} as const;

/** The whole cut on winnings, basis points (burn + vault: 20 %). */
export const WINNINGS_CUT_BPS = ECONOMY.burnBps + ECONOMY.vaultBps;

/** The on-chain entry fee rate this economy is designed for (the cut on winnings replaces it). */
export const RECOMMENDED_ENTRY_FEE_BPS = 0;

export interface WinningsCut {
  /** What the ticket holds at payout time. */
  gross: number;
  /** Above the start value (0 when it ends at or below it). */
  profit: number;
  /** Burned. */
  burn: number;
  /** Kept in the arena vault. */
  vault: number;
  /** burn + vault. */
  cut: number;
  /** Paid to the player: gross − cut. */
  net: number;
}

const bps = (amount: number, rate: number): number => Number((BigInt(amount) * BigInt(rate)) / 10_000n);

/**
 * The cut of a payout of `gross` ledger units for a ticket that started at `start` (whole ledger
 * units; rounding is down on each share, so the player never pays more than 20 %).
 */
export function winningsCut(gross: number, start: number): WinningsCut {
  const g = Number.isSafeInteger(gross) && gross > 0 ? gross : 0;
  const s = Number.isSafeInteger(start) && start > 0 ? start : 0;
  const profit = Math.max(0, g - s);
  const burn = bps(profit, ECONOMY.burnBps);
  const vault = bps(profit, ECONOMY.vaultBps);
  const cut = burn + vault;
  return { gross: g, profit, burn, vault, cut, net: g - cut };
}
