import { ledgerDecimals } from '@coinnibal/sdk';
import { TOKEN_SYMBOL_DEFAULT, formatToken } from '@coinnibal/shared';
import { useMemo } from 'react';
import { useUi } from '../store';

/**
 * The game token's display (symbol, decimals, amount formats), light enough for the player guide: it reads the small UI
 * store only, never the wallet layer (viem, the wallet store), so `/docs` does not download them. The lobby's
 * `useTokenText` (ui/lobby/useLobby.ts) adds the on-chain decimals once the wallet layer has read them.
 */
export interface TokenText {
  symbol: string;
  /** The token's decimals (base units). */
  decimals: number;
  /** Base units (chain amounts): exact with grouping (`12,450`), compact (K/M/B) from one million up. */
  fee: (raw: bigint | number) => string;
  /** Base units, always compact (`310K`). */
  compact: (raw: bigint | number) => string;
  /** Base units with every decimal the token has (confirm sheet: what you sign). */
  exact: (raw: bigint | number) => string;
  /** Ledger units (the game server's amounts: payouts, loot), like `fee`. */
  wire: (ledger: number) => string;
  /** Ledger units, always compact. */
  wireCompact: (ledger: number) => string;
}

export function tokenText(decimals: number, symbol: string): TokenText {
  const million = 10n ** BigInt(decimals + 6);
  const ld = ledgerDecimals(decimals);
  const ledgerMillion = 10 ** (ld + 6);
  return {
    symbol,
    decimals,
    fee: (raw) => formatToken(raw, decimals, { compact: BigInt(raw) >= million }),
    compact: (raw) => formatToken(raw, decimals, { compact: true, maxFrac: 1 }),
    exact: (raw) => formatToken(raw, decimals, { maxFrac: decimals }),
    wire: (n) => formatToken(n, ld, { compact: Math.abs(n) >= ledgerMillion }),
    wireCompact: (n) => formatToken(n, ld, { compact: true, maxFrac: 1 }),
  };
}

/**
 * The game token's display from the server's config (`ChainStatus.token` in the UI store). Until the token is set the
 * symbol shows as "tokens" (`TOKEN_SYMBOL_DEFAULT`) and amounts use 18 decimals (the contract's default).
 * `chainDecimals`: the on-chain decimals, when the caller has them (the lobby).
 */
export function useTokenText(chainDecimals?: number): TokenText {
  const token = useUi((s) => s.chain?.token ?? null);
  const decimals = chainDecimals ?? token?.decimals ?? 18;
  return useMemo(() => tokenText(decimals, token?.symbol || TOKEN_SYMBOL_DEFAULT), [decimals, token?.symbol]);
}
