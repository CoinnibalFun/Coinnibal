import { chainInfo, configuredChainId, isSupportedChainId, setActiveChain, type ChainStatus } from '@coinnibal/shared';
import { refreshChainText } from './i18n';

/**
 * The Robinhood Chain network the site names (testnet or mainnet): `VITE_CHAIN_ID` (default 46630, Robinhood Chain
 * Testnet) until the game server says which network it is on, then the server's. Display only: wallets are always
 * switched to the server's chain (`wallet/network.ts`), never to this one.
 */
export const BUILD_CHAIN_ID = configuredChainId(import.meta.env.VITE_CHAIN_ID as string | undefined);

type Shown = Pick<ChainStatus, 'chainId' | 'faucetUrl' | 'explorerUrl' | 'rpcUrl'>;

/** Names the server's network in every string (`{chain}`); null, or a chain that is not Robinhood Chain: the build's. */
export function showChain(chain: Partial<Shown> | null | undefined): void {
  const known = !!chain && isSupportedChainId(chain.chainId);
  const id = known ? (chain!.chainId as number) : BUILD_CHAIN_ID;
  const over: Partial<Shown> = known ? chain! : {};
  setActiveChain(
    chainInfo(id, {
      faucetUrl: over.faucetUrl,
      explorerUrl: over.explorerUrl,
      rpcUrl: over.rpcUrl,
    }),
  );
  refreshChainText();
}

showChain(null);
