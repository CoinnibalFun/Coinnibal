import { SITE_X_HANDLE_DEFAULT, activeChain, isXHandle } from '@coinnibal/shared';
import { useSyncExternalStore } from 'react';
import { en } from './en';
import { LOCALES, type Locale } from './locales/meta';
import { storageKey } from '../storageKey';

export { LOCALES, type Locale, type LocaleInfo } from './locales/meta';

export type TKey = keyof typeof en;
/** A full dictionary: every English key, any language. */
export type Dict = Record<TKey, string>;
export type TVars = Record<string, string | number>;

const STORAGE_KEY = storageKey('locale.v1');

let current: Locale = 'en';
let dict: Dict = en;
const listeners = new Set<() => void>();
const plurals = new Map<Locale, Intl.PluralRules>();

function pluralRules(l: Locale): Intl.PluralRules {
  let r = plurals.get(l);
  if (!r) {
    r = new Intl.PluralRules(l);
    plurals.set(l, r);
  }
  return r;
}

/**
 * ICU-style plurals, flat (no nesting): `{n, plural, one {# coin} few {# монеты} other {# coins}}`.
 * `=0`-style exact cases win; `#` is the number as passed. A missing category falls back to `other`.
 */
const PLURAL = /\{(\w+), plural,((?:\s*(?:=\d+|zero|one|two|few|many|other)\s*\{(?:[^{}]|\{\w+\})*\})+)\s*\}/g;
const CASE = /(=\d+|zero|one|two|few|many|other)\s*\{((?:[^{}]|\{\w+\})*)\}/g;

export function formatMessage(s: string, vars: TVars | undefined, locale: Locale = current): string {
  if (!vars) return s;
  if (s.includes(', plural,')) {
    s = s.replace(PLURAL, (whole, name: string, body: string) => {
      const raw = vars[name];
      if (raw === undefined) return whole;
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^\d.-]/g, ''));
      const cases = new Map<string, string>();
      for (const m of body.matchAll(CASE)) cases.set(m[1], m[2]);
      const pick = cases.get(`=${n}`) ?? cases.get(Number.isFinite(n) ? pluralRules(locale).select(n) : 'other') ?? cases.get('other') ?? '';
      return pick.replaceAll('#', String(raw));
    });
  }
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** The project's X handle at boot (no `@`): the build's `VITE_X_HANDLE`, else the shared default. */
export const X_HANDLE_BUILD: string = (() => {
  const v = String((import.meta.env?.VITE_X_HANDLE as string | undefined) ?? '').replace(/^@/, '').trim();
  return isXHandle(v) ? v : SITE_X_HANDLE_DEFAULT;
})();

/**
 * The placeholders every string may use without the caller passing them:
 * - `{chain}`, the name of the Robinhood Chain network the game runs on ("Robinhood Chain Testnet" now, "Robinhood
 *   Chain" at mainnet). It follows the active network (`setActiveChain` in `@coinnibal/shared`: `VITE_CHAIN_ID` at boot,
 *   then the server's); `refreshChainText` re-renders on a change.
 * - `{ourX}`, the project's X handle with its `@` (`X_HANDLE_BUILD`, then the server's site setting once it is
 *   loaded: `setOurXHandle`).
 */
/** A network's name as visitor pages say it: without a trailing "Testnet" (the wallet shows the exact network). */
export const plainChainName = (name: string): string => name.replace(/\s+Testnet$/i, '');

let chainVars: { chain: string; ourX: string } = { chain: activeChain().name, ourX: `@${X_HANDLE_BUILD}` };

function setGlobals(next: { chain: string; ourX: string }): void {
  if (next.chain === chainVars.chain && next.ourX === chainVars.ourX) return;
  chainVars = next;
  fns.clear();
  for (const fn of listeners) fn();
}

/** Re-reads `{chain}` from the active network; components using `useT` re-render when it changed. */
export function refreshChainText(): void {
  setGlobals({ ...chainVars, chain: activeChain().name });
}

/** The project's X handle with its `@` (what `{ourX}` reads). */
export const ourXHandle = (): string => chainVars.ourX;

/** Sets `{ourX}` from the site settings (a handle with or without `@`; an invalid one is ignored). */
export function setOurXHandle(handle: string | null | undefined): void {
  const h = String(handle ?? '').replace(/^@/, '');
  if (isXHandle(h)) setGlobals({ ...chainVars, ourX: `@${h}` });
}

export function translate(key: TKey, vars?: TVars): string {
  const s: string = dict[key] ?? en[key] ?? key;
  return formatMessage(s, vars ? { ...chainVars, ...vars } : chainVars);
}

/** Non-React access (engine, toasts): always the current language. */
export const t = (key: TKey, vars?: TVars): string => translate(key, vars);

export const getLocale = (): Locale => current;

/**
 * A server error message (English) or our own words: outside English the client's translated
 * fallback wins, since the server only speaks English.
 */
export const serverText = (server: string | null | undefined, fallback: string): string => (current === 'en' && server ? server : fallback);

/** The `Intl` tag for dates and numbers in the current language (`en-US` for English). */
export const intlLocale = (): string => (current === 'en' ? 'en-US' : (LOCALES.find((l) => l.code === current)?.tag ?? current));

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** One function per language and chain: components that memoise on `t` re-run when either changes. */
const fns = new Map<string, (key: TKey, vars?: TVars) => string>();
function fnFor(k: string) {
  let f = fns.get(k);
  if (!f) {
    f = (key: TKey, vars?: TVars) => translate(key, vars);
    fns.set(k, f);
  }
  return f;
}
const textKey = (): string => `${current}|${chainVars.chain}|${chainVars.ourX}`;

/** React hook: `const t = useT(); t('lo.tab.play')`. Re-renders when the language or the chain changes. */
export function useT(): (key: TKey, vars?: TVars) => string {
  return fnFor(useSyncExternalStore(subscribe, textKey, () => 'en'));
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, () => 'en' as Locale);
}

/** The language for this browser: always English (the only one the interface ships in). */
export function detectLocale(): Locale {
  return 'en';
}

function apply(l: Locale, d: Dict): void {
  current = l;
  dict = d;
  if (typeof document !== 'undefined') document.documentElement.lang = 'en';
  for (const fn of listeners) fn();
}

/** Boot: English, and any language a visitor picked before (other languages are gone) is forgotten. */
export function initLocale(): Promise<void> {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode */
  }
  apply('en', en);
  return Promise.resolve();
}
