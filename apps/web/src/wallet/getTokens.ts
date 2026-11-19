/**
 * "How to get tokens": the short path for a player who has a wallet but nothing to play with. Pure: unit-tested.
 *
 * - Testnet: test ETH from the network's faucet (gas), test tokens from the site's own faucet page.
 * - Mainnet: ETH bridged onto Robinhood Chain, then the game token bought on Pons (`VITE_TOKEN_BUY_URL`; without it the step
 *   names no link: never a guessed one).
 */

/** Only an https link is taken from the build (anything else is ignored). */
export function safeHttpsUrl(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Where the game token is bought (Pons), set at build time; null: no link is shown. */
export const TOKEN_BUY_URL = safeHttpsUrl(import.meta.env.VITE_TOKEN_BUY_URL as string | undefined);

export type TokenStepKey = 'gasFaucet' | 'gasBridge' | 'gasAny' | 'testTokens' | 'buy' | 'play';

export interface TokenStep {
  key: TokenStepKey;
  /** Where the step's link goes (null: no link). */
  href: string | null;
  /** Opens another site (new tab). */
  external: boolean;
}

export function tokenSteps(o: { testnet: boolean; faucetUrl: string | null; bridgeUrl: string | null; buyUrl: string | null }): TokenStep[] {
  if (o.testnet) {
    return [
      o.faucetUrl ? { key: 'gasFaucet', href: o.faucetUrl, external: true } : { key: 'gasAny', href: null, external: false },
      { key: 'testTokens', href: '/faucet', external: false },
      { key: 'play', href: null, external: false },
    ];
  }
  return [
    o.bridgeUrl ? { key: 'gasBridge', href: o.bridgeUrl, external: true } : { key: 'gasAny', href: null, external: false },
    { key: 'buy', href: o.buyUrl, external: true },
    { key: 'play', href: null, external: false },
  ];
}

/** Where "Get tokens" goes in one click: the testnet faucet page, else the buy link (null: open the guide). */
export function getTokensHref(testnet: boolean, buyUrl: string | null = TOKEN_BUY_URL): string | null {
  return testnet ? '/faucet' : buyUrl;
}
