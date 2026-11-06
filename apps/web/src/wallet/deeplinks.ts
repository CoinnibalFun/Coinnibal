/**
 * Phones have no browser extension: a player opening the site in Safari or Chrome finds no wallet. The wallet apps
 * have a browser of their own (with the wallet injected), and these links open this very page in it. Pure: tested.
 *
 * - MetaMask: `https://metamask.app.link/dapp/<host><path>` (its documented deep link). Robinhood Chain is added by
 *   the site's own `wallet_addEthereumChain` when the ticket sheet switches networks.
 * - Coinbase Wallet: `https://go.cb-w.com/dapp?cb_url=<url>`. Its in-app browser takes custom EVM networks through
 *   `wallet_addEthereumChain` as well.
 * - Rabby's phone app has no page deep link: it is offered through WalletConnect (when the build has it), else as a
 *   download.
 */

export interface WalletLink {
  id: 'metamask' | 'coinbase' | 'rabby';
  name: string;
  href: string;
  /** Opens this page inside the wallet's browser (false: a download page). */
  opensHere: boolean;
}

const coarsePointer = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

/** A phone or tablet browser (a mobile user agent, or a touch-only screen): where extensions do not exist. */
export function isPhoneBrowser(
  ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0,
  coarse: boolean = coarsePointer(),
): boolean {
  if (/Android|iPhone|iPod|Mobile|Opera Mini|IEMobile/i.test(ua)) return true;
  // iPadOS reports a desktop Safari user agent, with touch
  if (/Macintosh/.test(ua) && touchPoints > 1) return true;
  // a touch screen whose main pointer is a finger (a laptop with a touch screen has a mouse: fine pointer)
  return touchPoints > 1 && coarse;
}

/** The deep links for `href` (this page). `walletConnect`: Rabby goes through WalletConnect instead of a download. */
export function walletLinks(href: string, o: { walletConnect?: boolean } = {}): WalletLink[] {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return [];
  }
  const hostPath = `${url.host}${url.pathname}${url.search}`;
  const out: WalletLink[] = [
    { id: 'metamask', name: 'MetaMask', href: `https://metamask.app.link/dapp/${hostPath}`, opensHere: true },
    { id: 'coinbase', name: 'Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url.href)}`, opensHere: true },
  ];
  if (!o.walletConnect) out.push({ id: 'rabby', name: 'Rabby', href: 'https://rabby.io/', opensHere: false });
  return out;
}
