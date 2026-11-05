import { chainInfo, configuredChainId, isChainId, setActiveChain, type ChainStatus } from '@elymum/shared';
import { refreshChainText } from './i18n';

/**
 * The chain the site names and prices gas in: `VITE_CHAIN_ID` (default Robinhood Chain Testnet, the registry's
 * `DEFAULT_CHAIN_ID`) until the game server says which chain it is on, then the server's. Display only: wallets are
 * always switched to the server's chain (`wallet/network.ts`), never to this one.
 */
export const BUILD_CHAIN_ID = configuredChainId(import.meta.env.VITE_CHAIN_ID as string | undefined);

type Shown = Pick<ChainStatus, 'chainId' | 'chainName' | 'gasSymbol' | 'faucetUrl' | 'explorerUrl' | 'rpcUrl'>;

/** Names the server's chain in every string (`{chain}`, `{gas}`); null or a chain without an id: the build's chain. */
export function showChain(chain: Partial<Shown> | null | undefined): void {
  const known = !!chain && isChainId(chain.chainId);
  const id = known ? (chain!.chainId as number) : BUILD_CHAIN_ID;
  const over: Partial<Shown> = known ? chain! : {};
  setActiveChain(
    chainInfo(id, {
      name: over.chainName ?? null,
      gasSymbol: over.gasSymbol ?? null,
      faucetUrl: over.faucetUrl,
      explorerUrl: over.explorerUrl,
      rpcUrl: over.rpcUrl,
    }),
  );
  refreshChainText();
}

showChain(null);
