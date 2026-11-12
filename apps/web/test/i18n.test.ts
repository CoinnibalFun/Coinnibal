import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EMOTES, PowerUpType, activeChain, chainInfo, setActiveChain } from '@elymum/shared';
import { describe, expect, it } from 'vitest';
import { detectLocale, formatMessage, getLocale, initLocale, LOCALES, loadLocale, ourXHandle, refreshChainText, setLocale, setOurXHandle, translate, X_HANDLE_BUILD, type Dict, type Locale, type TKey } from '../src/i18n';
import { renderRich } from '../src/i18n/rich';
import { en } from '../src/i18n/en';
import { BUILD_CHAIN_ID } from '../src/chainText';
import { useUi } from '../src/store';
import { chainStatus } from './evm-helpers';

// vitest runs in apps/web (pnpm -r / -F run each package in its own directory)
const SRC = resolve(process.cwd(), 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const code = sources(SRC)
  .filter((p) => !p.endsWith(join('i18n', 'en.ts')) && !p.includes(join('i18n', 'locales')))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');
const keys = new Set(Object.keys(en));

/** The server's `ErrorCode` union, read from the shared protocol source (it is a type only). */
function errorCodes(): string[] {
  const proto = readFileSync(resolve(process.cwd(), '../../packages/shared/src/protocol.ts'), 'utf8');
  // comments inside the union may hold a ';' of their own: drop them first
  const code = proto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const union = /export type ErrorCode =([^;]+);/.exec(code)?.[1] ?? '';
  return [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** The CI guard's Turkish letters, built from code points so this file passes the guard itself. */
const TURKISH = new RegExp(`[${String.fromCodePoint(0xe7, 0x11f, 0x131, 0xf6, 0x15f, 0xfc, 0xc7, 0x11e, 0x130, 0xd6, 0x15e, 0xdc)}]`);

describe('the English string table', () => {
  it('has every key the code asks for with a literal t() call', () => {
    const used = new Set([...code.matchAll(/\b(?:t|tx)\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(300);
    expect([...used].filter((k) => !keys.has(k))).toEqual([]);
  });

  it('has every key the code builds at run time', () => {
    const built = [
      ...EMOTES.map((e) => `g.emote.${e.id}`),
      ...Object.values(PowerUpType).map((p) => `pu.${p}`),
      ...errorCodes().map((c) => `err.${c}`),
    ];
    expect(errorCodes()).toEqual(expect.arrayContaining(['round_closed', 'no_cashout', 'round_ended']));
    expect(built.filter((k) => !keys.has(k))).toEqual([]);
  });

  it('is non-empty, English and free of emoji', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim().length, key).toBeGreaterThan(0);
      expect(value, key).not.toMatch(TURKISH);
      expect(value, key).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('fills placeholders and leaves unknown keys readable', () => {
    expect(translate('lo.onFloor', { n: '84,200', sym: '$ELYMUM' })).toBe('84,200 $ELYMUM on the floor');
    expect(translate('nope.missing' as TKey)).toBe('nope.missing');
  });

  it('names the network only through {chain} (testnet or mainnet) and the gas token as ETH, in every language', async () => {
    const all: [string, Dict][] = [['en', en as Dict]];
    for (const l of LOCALES) if (l.code !== 'en') all.push([l.code, await loadLocale(l.code)]);
    for (const [code, dict] of all)
      for (const [key, value] of Object.entries(dict)) {
        // Robinhood Chain only: no other chain, gas token or faucet is named anywhere
        expect(value, `${code} ${key}`).not.toMatch(/HYPE|Elysium|Kinetiq|HyperEVM|\{gas\}/);
        // the network's name is the placeholder, so the copy is right on the testnet and on mainnet
        expect(value, `${code} ${key}`).not.toMatch(/Robinhood/);
      }
    expect(en['tf.lowGas']).toBe('You have no ETH on {chain} for the network fee. Add a little ETH to this wallet first.');
  });

  it('fills {chain} from the active network (the server\'s, once known); a caller\'s value wins', () => {
    const before = activeChain();
    try {
      setActiveChain(chainInfo(46630));
      refreshChainText();
      expect(translate('tx.confirmed')).toBe('Confirmed on Robinhood Chain Testnet');
      setActiveChain(chainInfo(4663));
      refreshChainText();
      expect(translate('tx.confirmed')).toBe('Confirmed on Robinhood Chain');
      expect(translate('tf.lowGas', { chain: 'Somewhere' })).toContain('Somewhere');
    } finally {
      setActiveChain(before);
      refreshChainText();
    }
  });

  it("follows the server's chain as the store receives it (and the build's chain before)", () => {
    const before = useUi.getState().chain;
    try {
      // VITE_CHAIN_ID is unset in tests: the default chain, Robinhood Chain Testnet
      expect(BUILD_CHAIN_ID).toBe(46630);
      useUi.setState({ chain: chainStatus({ chainId: 4663, chainName: 'Robinhood Chain', testnet: false, faucetUrl: null }) });
      expect(translate('tx.confirmed')).toBe('Confirmed on Robinhood Chain');
      // a server on any other chain is not named: the build's network stays
      useUi.setState({ chain: chainStatus({ chainId: 99801, chainName: 'Elsewhere' }) });
      expect(translate('tx.confirmed')).toBe('Confirmed on Robinhood Chain Testnet');
      useUi.setState({ chain: null });
      expect(translate('tx.confirmed')).toBe('Confirmed on Robinhood Chain Testnet');
    } finally {
      useUi.setState({ chain: before });
    }
  });
});

describe('?lang=', () => {
  it('is remembered like a pick, English included (a stored other language does not come back)', async () => {
    localStorage.setItem('elymum.locale.v1', 'ru');
    history.replaceState(null, '', '/?lang=en');
    try {
      await initLocale();
      expect(getLocale()).toBe('en');
      expect(localStorage.getItem('elymum.locale.v1')).toBe('en');
      history.replaceState(null, '', '/');
      expect(detectLocale(['ru-RU'])).toBe('en');
    } finally {
      history.replaceState(null, '', '/');
      localStorage.removeItem('elymum.locale.v1');
    }
  });
});

describe('{ourX}: the project X handle every string may name', () => {
  it('starts at the build default and follows the site setting', () => {
    expect(X_HANDLE_BUILD).toBe('elymumio');
    expect(translate('pg.follow')).toBe('Follow @elymumio');
    setOurXHandle('coinnibal');
    expect(ourXHandle()).toBe('@coinnibal');
    expect(translate('pg.follow')).toBe('Follow @coinnibal');
    expect(translate('wp.post')).toContain('@coinnibal WL');
    // an invalid handle is ignored
    setOurXHandle('not a handle');
    expect(ourXHandle()).toBe('@coinnibal');
    setOurXHandle('@elymumio');
    expect(translate('pg.follow')).toBe('Follow @elymumio');
  });

  it('no string writes the handle out: every language uses {ourX}', () => {
    for (const [key, text] of Object.entries(en)) expect(`${key}: ${text}`).not.toMatch(/@elymumio/i);
  });
});
