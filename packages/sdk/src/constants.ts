import { DEFAULT_ARENAS, DEFAULT_HOLDER_FEE_RATES } from '@elymum/shared';

/**
 * Constants mirrored from `packages/contracts/contracts/*.sol` (a unit test checks the ones the
 * contracts expose as `public constant` against the bundled ABIs, and the e2e test reads them from
 * a deployed contract).
 */

/** Basis-point denominator (100 %). */
export const BPS = 10_000;
/** Upper bound of the arena's fee pair on profit, `burnBps + vaultBps` (25 %): `ElymumArena.MAX_TOTAL_FEE_BPS`. */
export const MAX_TOTAL_FEE_BPS = 2_500;
/** Share of the profit a freshly deployed arena burns (15 %) and sends to the fee wallet (5 %). */
export const DEFAULT_BURN_BPS = 1_500;
export const DEFAULT_VAULT_BPS = 500;
/** Share of a `pay` payment (power-ups) a freshly deployed arena burns (50 %); the rest goes to the fee wallet. */
export const DEFAULT_PAYMENT_BURN_BPS = 5_000;
/** `ElymumArena.burnMode`: send burned tokens to `BURN_ADDRESS` (the default; works with every ERC-20). */
export const BURN_MODE_DEAD = 0;
/** `ElymumArena.burnMode`: call the token's `burn(uint256)` (ERC20Burnable), falling back to `BURN_ADDRESS`. */
export const BURN_MODE_CALL = 1;
/** Bounds of `maxSessions` (open tickets per arena). */
export const MIN_ARENA_SESSIONS = 2;
export const MAX_ARENA_SESSIONS = 2_000;
/** Arena ids are uint16 and never 0. */
export const MIN_ARENA_ID = 1;
export const MAX_ARENA_ID = 65_535;
/** A ticket the server never settled can be refunded by its player this many seconds after joining (24 h). */
export const REFUND_DELAY_SECS = 86_400;
/** Burned tokens go here unless the burn mode is `BURN_MODE_CALL` (fee burns, loot burns, payment burns). */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;
/** Largest uint128 (entry fees and payouts). */
export const MAX_UINT128 = (1n << 128n) - 1n;
/** Largest uint64 (session ids, sweep ids). */
export const MAX_UINT64 = (1n << 64n) - 1n;

/** `SettleSkipped.reason` codes. */
export const SettleSkipReason = {
  UnknownArena: 1,
  SessionMismatch: 2,
  Finalized: 3,
  InsufficientVault: 4,
} as const;
export type SettleSkipReason = (typeof SettleSkipReason)[keyof typeof SettleSkipReason];

/** Human text for a `SettleSkipped.reason`. */
export function settleSkipReasonText(reason: number): string {
  switch (reason) {
    case SettleSkipReason.UnknownArena:
      return 'the arena does not exist';
    case SettleSkipReason.SessionMismatch:
      return 'no open session with this id (never opened, already settled or refunded)';
    case SettleSkipReason.Finalized:
      return 'already settled; waits for the player to collect';
    case SettleSkipReason.InsufficientVault:
      return 'the payout (or the cancelled entry fee) is larger than the arena vault';
    default:
      return `unknown reason ${reason}`;
  }
}

/** Items per `settle` transaction (the server chunks a bell's batch at this size). */
export const SETTLE_CHUNK = 40;

/** NFT mint phases (`ElymumNFT.Phase`). */
export const MintPhase = {
  Closed: 0,
  Allowlist: 1,
  Public: 2,
} as const;
export type MintPhase = (typeof MintPhase)[keyof typeof MintPhase];
export const MINT_PHASE_NAMES = ['closed', 'allowlist', 'public'] as const;
export type MintPhaseName = (typeof MINT_PHASE_NAMES)[number];

/** NFT royalty upper bound (10 %). */
export const MAX_ROYALTY_BPS = 1_000;
/** Default overpayment on a mint (1 %): the contract refunds the excess, so a price change in between cannot fail the mint. */
export const DEFAULT_MINT_BUFFER_BPS = 100;
/** Hyperliquid's public info API (POST `{"type":"allMids"}`): ETH's USD price (the $1 NFT mint). */
export const GAS_PRICE_URL_DEFAULT = 'https://api.hyperliquid.xyz/info';

/**
 * Holder rates Finish setup and `pnpm admin holder-perks` use for `setHolderPerks` (the contract starts without a holder
 * discount): `DEFAULT_HOLDER_FEE_RATES`, 8 % burned + 2 % to the fee wallet, i.e. holders pay 10 % of their profit
 * instead of 20 %.
 */
export const SUGGESTED_HOLDER_BURN_BPS = DEFAULT_HOLDER_FEE_RATES.burnBps;
export const SUGGESTED_HOLDER_VAULT_BPS = DEFAULT_HOLDER_FEE_RATES.vaultBps;
/** Arenas Finish setup marks holders-only (the $10 tier, #4 the $10 Room: `DEFAULT_ARENAS`). */
export const DEFAULT_HOLDERS_ONLY_ARENA_IDS: readonly number[] = DEFAULT_ARENAS.filter((a) => a.holdersOnly).map((a) => a.id);
