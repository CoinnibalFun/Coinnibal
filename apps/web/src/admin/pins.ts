import type { StatusSnapshot } from '@coinnibal/sdk/ops';
import { chainInfo, isSupportedChainId } from '@coinnibal/shared';
import { getAddress, isAddress, type Address } from 'viem';
import { PINS, PIN_ENV, mayRunUnpinned, type BuildPins, type Pins } from '../wallet/pinned';
import type { AdminNetwork } from './net';

/**
 * The site's contract pins against the registered contracts (pure, tested). The site signs only with the contracts it
 * was built with (`wallet/pinned.ts`); after the owner deploys and registers new ones, nothing can be signed until the
 * site is built again with their addresses. Setup ("Site pins") and the Network checklist show what is missing and the
 * exact lines. The addresses come from the server, which is what the pins guard against: the owner checks them in their
 * own wallet before pasting them, and a pin changes only in the VPS shell (or with a new build), never from this panel.
 */

export type PinKind = keyof Pins;

const KINDS: readonly PinKind[] = ['arena', 'nft', 'token'];

/** The `/opt/elymum/.env` key the VPS passes as each `VITE_*` pin (deploy/vps/docker-compose.yml, build args). */
export const PIN_VPS_KEY: Readonly<Record<PinKind, string>> = Object.freeze({ arena: 'COINNIBAL_PIN_ARENA', nft: 'COINNIBAL_PIN_NFT', token: 'COINNIBAL_PIN_TOKEN' });

/** Rebuilds the site with the pins of `/opt/elymum/.env` and restarts the app (deploy/vps/README.md, section 4). */
export const PIN_REBUILD = 'coinnibal-compose up -d --build app';

/**
 * The same in two steps, once players are in the arenas: the build takes minutes (longer than the break after a bell)
 * and the swap must land in the break (a SIGTERM mid-round cashes every arena player out), like update.sh does it.
 */
export const PIN_BUILD_FIRST = 'coinnibal-compose build app';
export const PIN_SWAP = 'coinnibal-compose up -d app';

/** The web build outside Docker. */
export const PIN_BUILD_OUTSIDE = 'pnpm -F @coinnibal/web build';

/** Each contract's row label on the card (a label, so the token's is capitalised). */
export const PIN_NAME: Readonly<Record<PinKind, string>> = Object.freeze({ arena: 'CoinnibalArena', nft: 'CoinnibalNFT', token: 'The game token' });

/** The same names in the middle of a sentence. */
export const PIN_PROSE: Readonly<Record<PinKind, string>> = Object.freeze({ arena: 'CoinnibalArena', nft: 'CoinnibalNFT', token: 'the game token' });

/**
 * - `match`: pinned to the registered address.
 * - `missing`: not pinned in this build (or the build is for another chain).
 * - `differs`: pinned to another address.
 * - `local`: not pinned, and the local node may run unpinned (the arena's code hash is still checked).
 */
export type PinState = 'match' | 'missing' | 'differs' | 'local';

export interface PinRow {
  kind: PinKind;
  name: string;
  registered: Address;
  pinned: Address | null;
  state: PinState;
}

export interface PinReport {
  /** true: the site trusts every registered contract; false: a pin is missing, different or broken; null: nothing to compare (no chain, nothing registered). */
  ok: boolean | null;
  /** The server's chain. */
  chainId: number | null;
  /** The chain this site was built for (`VITE_CHAIN_ID`). */
  buildChainId: number;
  /** One row per registered contract (the token once it is set on the arena). */
  rows: PinRow[];
  /** The rows whose pin is missing or different. */
  todo: PinRow[];
  /** The `VITE_*` pins of this build that hold something that is not an address (the site then signs nothing). */
  invalid: { env: string; key: string }[];
  /** The lines for `/opt/elymum/.env` (the registered addresses; an empty line clears a broken pin). */
  envLines: string[];
  /** The same as `VITE_*` lines, for a build outside Docker (with the server's chain). */
  viteLines: string[];
}

const addr = (v: string | null | undefined): Address | null => (v && isAddress(v, { strict: false }) ? getAddress(v) : null);
const same = (a: string | null, b: string | null): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Compares the build's pins for the server's chain with the registered arena and NFT and the arena's game token (pass
 * the token only once it is set on the arena).
 */
export function pinReport(i: { chainId: number | null | undefined; arena: string | null | undefined; nft: string | null | undefined; token: string | null | undefined }, pins: BuildPins = PINS): PinReport {
  const chainId = i.chainId ?? null;
  const base = { chainId, buildChainId: pins.chainId };
  if (chainId === null) return { ...base, ok: null, rows: [], todo: [], invalid: [], envLines: [], viteLines: [] };
  const pin: Pins = pins.chains[chainId] ?? { arena: null, nft: null, token: null };
  const registered: Record<PinKind, Address | null> = { arena: addr(i.arena), nft: addr(i.nft), token: addr(i.token) };
  const rows: PinRow[] = [];
  for (const kind of KINDS) {
    const r = registered[kind];
    if (!r) continue;
    const pinned = pin[kind];
    const state: PinState = pinned ? (same(pinned, r) ? 'match' : 'differs') : mayRunUnpinned(chainId) ? 'local' : 'missing';
    rows.push({ kind, name: PIN_NAME[kind], registered: r, pinned, state });
  }
  const invalid = KINDS.filter((k) => pins.invalid.includes(PIN_ENV[k])).map((k) => ({ env: PIN_ENV[k], key: PIN_VPS_KEY[k] }));
  const todo = rows.filter((r) => r.state === 'missing' || r.state === 'differs');
  const ok = rows.length === 0 && invalid.length === 0 ? null : todo.length === 0 && invalid.length === 0;
  // every registered contract, then an empty line for a broken pin of a contract that is not registered (it clears it)
  const lines = (name: (k: PinKind) => string) => [
    ...rows.map((r) => `${name(r.kind)}=${r.registered}`),
    ...KINDS.filter((k) => !registered[k] && pins.invalid.includes(PIN_ENV[k])).map((k) => `${name(k)}=`),
  ];
  return { ...base, ok, rows, todo, invalid, envLines: lines((k) => PIN_VPS_KEY[k]), viteLines: [`VITE_CHAIN_ID=${chainId}`, ...lines((k) => PIN_ENV[k])] };
}

/**
 * The report of the panel's chain: the registered arena and NFT, and the arena's game token once it is set (the
 * panel's own read of the arena; while that is not in, the server's).
 */
export function registeredPinReport(net: AdminNetwork, status: StatusSnapshot | null, pins: BuildPins = PINS): PinReport {
  const cfg = status?.arena?.config ?? null;
  const token = cfg ? (cfg.token ?? null) : (net.chain?.token?.address ?? null);
  return pinReport({ chainId: net.info?.id ?? null, arena: net.arenaAddress, nft: net.nftAddress, token }, pins);
}

/** The checklist line's detail: what is pinned, or what is not and where to fix it (pure, tested). */
export function pinSummary(r: PinReport): string {
  if (r.chainId === null) return 'No chain.';
  if (r.ok === null) return 'Nothing registered yet.';
  if (r.ok) {
    if (r.rows.every((x) => x.state === 'local')) return 'The local node runs unpinned (the arena code hash is still checked).';
    return `Built with the registered ${r.rows.map((x) => (x.kind === 'token' ? 'game token' : x.name)).join(', ')}.`;
  }
  const parts: string[] = [];
  const missing = r.todo.filter((x) => x.state === 'missing').map((x) => PIN_PROSE[x.kind]);
  const differs = r.todo.filter((x) => x.state === 'differs').map((x) => PIN_PROSE[x.kind]);
  if (r.invalid.length) parts.push(`${r.invalid.map((x) => x.env).join(', ')} of this build is not an address: the site signs nothing.`);
  if (missing.length) parts.push(`Not pinned in this build: ${missing.join(', ')}.`);
  if (differs.length) parts.push(`Pinned to another address: ${differs.join(', ')}.`);
  parts.push(`Setup → Site pins: the lines for /opt/elymum/.env, then ${PIN_REBUILD} on the VPS.`);
  return parts.join(' ');
}

/** The card's red line: each contract whose pin is missing or different, in one sentence; null when none is (pure, tested). */
export function pinTodoLine(r: PinReport): string | null {
  if (r.todo.length === 0) return null;
  const s = r.todo.map((x) => `${PIN_PROSE[x.kind]} is ${x.state === 'missing' ? 'not pinned' : 'pinned to another address'}`).join('; ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

/** A row's state in two or three words (the card's pill). */
export const PIN_LABEL: Readonly<Record<PinState, string>> = Object.freeze({ match: 'pinned', missing: 'not pinned', differs: 'pinned to another address', local: 'not pinned (local node)' });

/** What a missing or different pin means, null when it is pinned (pure: the card's words). */
export function pinEffect(row: PinRow): string | null {
  if (row.state === 'missing') {
    if (row.kind === 'arena') return 'The site signs no ticket, refund or shop payment until it is pinned.';
    if (row.kind === 'nft') return 'The mint page signs nothing until it is pinned.';
    return "The site does not check the arena's token against a pin.";
  }
  if (row.state === 'differs') {
    if (row.kind === 'arena') return `This build pins ${row.pinned}: the site refuses the registered arena.`;
    if (row.kind === 'nft') return `This build pins ${row.pinned}: the mint page refuses the registered NFT.`;
    return `This build pins ${row.pinned}: the site refuses the arena (its token is not the pinned one).`;
  }
  if (row.state === 'local') return "The local node may run unpinned (the arena's code hash is still checked).";
  return null;
}

/** "Robinhood Chain Testnet (46630)", or the bare id. */
export function chainLabel(id: number): string {
  return isSupportedChainId(id) ? `${chainInfo(id).name} (${id})` : `chain ${id}`;
}
