import type { Eip1193Provider, ProviderDetail } from './eip6963';

/**
 * WalletConnect v2 for phones without a browser wallet and desktops whose wallet lives on the phone. Off unless the
 * build has `VITE_WALLETCONNECT_PROJECT_ID` (a project id from WalletConnect Cloud, public by design). The library
 * (`@walletconnect/universal-provider`, the EIP-1193 provider under every WalletConnect connector, without a modal)
 * is only downloaded when a player picks WalletConnect: the pages that never use it do not grow.
 *
 * The session is asked for exactly the server's chain (Robinhood Chain), with the server's public RPC for reads.
 */

export const WC_PROJECT_ID: string | null = ((import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ?? '').trim() || null;

/** The rdns the wallet store remembers a WalletConnect session under. */
export const WC_RDNS = 'com.walletconnect';

const METHODS = ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'];
const EVENTS = ['chainChanged', 'accountsChanged'];

type Universal = Awaited<ReturnType<(typeof import('@walletconnect/universal-provider'))['UniversalProvider']['init']>>;

let shared: Promise<Universal> | null = null;

async function universal(): Promise<Universal> {
  if (!WC_PROJECT_ID) throw new Error('WalletConnect is not configured');
  shared ??= import('@walletconnect/universal-provider').then(({ UniversalProvider }) =>
    UniversalProvider.init({
      projectId: WC_PROJECT_ID!,
      metadata: {
        name: 'Elymum',
        description: 'A coin-eats-coin arena on Robinhood Chain',
        url: window.location.origin,
        icons: [`${window.location.origin}/favicon.svg`],
      },
    }),
  );
  return shared;
}

/** The connected session as an EIP-1193 provider the wallet store can use like a browser wallet. */
function detailOf(up: Universal, chainId: number): ProviderDetail {
  const chain = `eip155:${chainId}`;
  const provider: Eip1193Provider = {
    request: (a) => up.request({ method: a.method, params: a.params as unknown[] }, chain),
    on: (e, l) => up.on(e, l),
    removeListener: (e, l) => up.removeListener(e, l),
  };
  return { info: { uuid: 'walletconnect', name: 'WalletConnect', icon: '', rdns: WC_RDNS }, provider };
}

/**
 * Pairs a wallet over WalletConnect: `onUri` gets the pairing URI (`wc:…`) to show as a QR code or open on this phone;
 * resolves once the wallet approved the session (rejects when it declined or `signal` aborted).
 */
export async function pairWalletConnect(o: { chainId: number; rpcUrl: string | null; onUri: (uri: string) => void; signal?: AbortSignal }): Promise<ProviderDetail> {
  const up = await universal();
  if (up.session) await up.disconnect().catch(() => undefined);
  const onUri = (uri: string) => o.onUri(uri);
  up.on('display_uri', onUri);
  const abort = () => up.abortPairingAttempt();
  o.signal?.addEventListener('abort', abort);
  try {
    await up.connect({
      optionalNamespaces: {
        eip155: { methods: METHODS, chains: [`eip155:${o.chainId}`], events: EVENTS, ...(o.rpcUrl ? { rpcMap: { [o.chainId]: o.rpcUrl } } : {}) },
      },
    });
  } finally {
    up.removeListener('display_uri', onUri);
    o.signal?.removeEventListener('abort', abort);
  }
  up.setDefaultChain(`eip155:${o.chainId}`, o.rpcUrl ?? undefined);
  return detailOf(up, o.chainId);
}

/** Ends the WalletConnect session (the wallet forgets this site too). */
export async function endWalletConnect(): Promise<void> {
  if (!shared) return;
  const up = await shared.catch(() => null);
  if (up?.session) await up.disconnect().catch(() => undefined);
}
