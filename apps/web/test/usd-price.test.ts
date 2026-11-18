import { describe, expect, it } from 'vitest';
import { staleHours, usdQuote } from '../src/wallet/usdPrice';
import { getTokensHref, safeHttpsUrl, tokenSteps } from '../src/wallet/getTokens';
import { isPhoneBrowser, walletLinks } from '../src/wallet/deeplinks';

const ONE = 10n ** 18n;
const at = new Date(2026, 10, 6, 14, 20).getTime();

describe('USD where money is spent (price and its age)', () => {
  it('shows the value and when the price was set', () => {
    const q = usdQuote({ usdPerToken: '0.001', at }, 1000n * ONE, 18, at + 30 * 60_000);
    expect(q).toEqual({ text: '≈ $1', setAt: '14:20', stale: false });
    expect(usdQuote({ usdPerToken: '0.00081', at }, 1234n * ONE, 18, at)?.text).toBe('≈ $1');
    expect(usdQuote({ usdPerToken: '0.0123', at }, 1000n * ONE, 18, at)?.text).toBe('≈ $12.30');
  });

  it('calls out a price older than the limit (6 h by default), and one of unknown age', () => {
    expect(usdQuote({ usdPerToken: '0.001', at }, ONE, 18, at + 6 * 3600_000)?.stale).toBe(false);
    expect(usdQuote({ usdPerToken: '0.001', at }, ONE, 18, at + 6 * 3600_000 + 1)?.stale).toBe(true);
    expect(usdQuote({ usdPerToken: '0.001', at }, ONE, 18, at + 2 * 3600_000, 1)?.stale).toBe(true);
    const unknown = usdQuote({ usdPerToken: '0.001', at: null }, ONE, 18, at);
    expect(unknown).toMatchObject({ setAt: null, stale: true });
    // another day: the date comes with the time
    expect(usdQuote({ usdPerToken: '0.001', at }, ONE, 18, at + 26 * 3600_000)?.setAt).toBe('6 Nov 14:20');
  });

  it('shows nothing without a usable price', () => {
    expect(usdQuote(null, ONE, 18, at)).toBeNull();
    expect(usdQuote({ usdPerToken: null, at }, ONE, 18, at)).toBeNull();
    expect(usdQuote({ usdPerToken: 'garbage', at }, ONE, 18, at)).toBeNull();
    expect(usdQuote({ usdPerToken: '0', at }, ONE, 18, at)).toBeNull();
  });

  it('reads the stale limit from the build, 6 h when unset or nonsense', () => {
    expect(staleHours(undefined)).toBe(6);
    expect(staleHours('')).toBe(6);
    expect(staleHours('abc')).toBe(6);
    expect(staleHours('-1')).toBe(6);
    expect(staleHours('12')).toBe(12);
    expect(staleHours('0.5')).toBe(0.5);
  });
});

describe('How to get $NIBAL', () => {
  it('testnet: gas from the faucet, test tokens from the site faucet', () => {
    const s = tokenSteps({ testnet: true, faucetUrl: 'https://faucet.testnet.chain.robinhood.com', bridgeUrl: null, buyUrl: null });
    expect(s.map((x) => [x.key, x.href])).toEqual([
      ['gasFaucet', 'https://faucet.testnet.chain.robinhood.com'],
      ['testTokens', '/faucet'],
      ['play', null],
    ]);
    expect(getTokensHref(true, null)).toBe('/faucet');
  });

  it('mainnet: the bridge, then Pons when the build names it (no link otherwise)', () => {
    const s = tokenSteps({ testnet: false, faucetUrl: null, bridgeUrl: 'https://portal.arbitrum.io/bridge', buyUrl: 'https://pons.example/swap' });
    expect(s.map((x) => [x.key, x.href])).toEqual([
      ['gasBridge', 'https://portal.arbitrum.io/bridge'],
      ['buy', 'https://pons.example/swap'],
      ['play', null],
    ]);
    expect(tokenSteps({ testnet: false, faucetUrl: null, bridgeUrl: null, buyUrl: null }).map((x) => [x.key, x.href])).toEqual([
      ['gasAny', null],
      ['buy', null],
      ['play', null],
    ]);
    expect(getTokensHref(false, null)).toBeNull();
    expect(getTokensHref(false, 'https://pons.example/swap')).toBe('https://pons.example/swap');
  });

  it('takes only an https buy link from the build', () => {
    expect(safeHttpsUrl('https://pons.example/swap?token=0xabc')).toBe('https://pons.example/swap?token=0xabc');
    expect(safeHttpsUrl('  ')).toBeNull();
    expect(safeHttpsUrl(undefined)).toBeNull();
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('http://pons.example')).toBeNull();
  });
});

describe('phone wallets (deep links)', () => {
  it('opens this page in the wallet apps', () => {
    const links = walletLinks('https://coinnibal.fun/play?room=arena-1');
    expect(links.map((l) => [l.id, l.href, l.opensHere])).toEqual([
      ['metamask', 'https://metamask.app.link/dapp/coinnibal.fun/play?room=arena-1', true],
      ['coinbase', 'https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fcoinnibal.fun%2Fplay%3Froom%3Darena-1', true],
      ['rabby', 'https://rabby.io/', false],
    ]);
    // with WalletConnect, Rabby connects through it
    expect(walletLinks('https://coinnibal.fun/play', { walletConnect: true }).map((l) => l.id)).toEqual(['metamask', 'coinbase']);
    expect(walletLinks('not a url')).toEqual([]);
  });

  it('tells a phone from a desktop', () => {
    expect(isPhoneBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 5)).toBe(true);
    expect(isPhoneBrowser('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36', 5)).toBe(true);
    // iPadOS asks for the desktop site
    expect(isPhoneBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5)).toBe(true);
    expect(isPhoneBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 0, false)).toBe(false);
    expect(isPhoneBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36', 0, false)).toBe(false);
    // a touch-only screen (a phone asking for the desktop site), but not a laptop with a touch screen
    expect(isPhoneBrowser('Mozilla/5.0 (X11; Linux x86_64) Chrome/130 Safari/537.36', 5, true)).toBe(true);
    expect(isPhoneBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36', 10, false)).toBe(false);
  });
});
