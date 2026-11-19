import type { StatusSnapshot } from '@coinnibal/sdk/ops';
import { chainInfo, isSupportedChainId } from '@coinnibal/shared';
import { getAddress, isAddress, type Address } from 'viem';
import { OWNER_ENV, PINS, PIN_ENV, mayRunUnpinned, withSigned, type BuildPins, type Pins } from '../wallet/pinned';
import type { AdminNetwork } from './net';

/**
 * The site's contract pins against the registered contracts (pure, tested). The site signs only with the contracts the
 * owner signed for (`wallet/pinned.ts`: the owner wallet's signed record on the server, or a `VITE_*` override in the
 * build). After a deploy, and again after the game token is set, the owner signs the new addresses once in Setup
 * ("Site pins"): one free signature, no transaction and no shell. The server only keeps the record; every browser
 * checks the signature against the owner wallet it was built with.
 */

export type PinKind = keyof Pins;

const KINDS: readonly PinKind[] = ['arena', 'nft', 'token'];

/** The `/opt/elymum/.env` key the VPS passes as each `VITE_*` pin (deploy/vps/docker-compose.yml, build args). */
export const PIN_VPS_KEY: Readonly<Record<PinKind, string>> = Object.freeze({ arena: 'COINNIBAL_PIN_ARENA', nft: 'COINNIBAL_PIN_NFT', token: 'COINNIBAL_PIN_TOKEN' });

/** The `/opt/elymum/.env` key the VPS passes as `VITE_OWNER_WALLET` (deploy/vps/docker-compose.yml, build args). */
export const OWNER_VPS_KEY = 'COINNIBAL_OWNER_WALLET';

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
  /** Where the pin comes from: the owner's signed record, or the build's `.env` override (null: nowhere). */
  source: 'signed' | 'build' | null;
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
  /** A pin that differs because the build's `.env` override names another address: a signature cannot fix it. */
  overridden: PinRow[];
  /** The lines for `/opt/elymum/.env` (the registered addresses; an empty line clears a broken pin). */
  envLines: string[];
  /** The same as `VITE_*` lines, for a build outside Docker (with the server's chain). */
  viteLines: string[];
}

const addr = (v: string | null | undefined): Address | null => (v && isAddress(v, { strict: false }) ? getAddress(v) : null);
const same = (a: string | null, b: string | null): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Compares this site's pins for the server's chain (the build's override, then the owner's verified signed record) with
 * the registered arena and NFT and the arena's game token (pass the token only once it is set on the arena).
 */
export function pinReport(
  i: { chainId: number | null | undefined; arena: string | null | undefined; nft: string | null | undefined; token: string | null | undefined },
  pins: BuildPins = PINS,
  /** The owner's signed record of that chain, once verified (`signedPinsFor`). */
  signed: Pins | null = null,
): PinReport {
  const chainId = i.chainId ?? null;
  const base = { chainId, buildChainId: pins.chainId };
  if (chainId === null) return { ...base, ok: null, rows: [], todo: [], invalid: [], overridden: [], envLines: [], viteLines: [] };
  const own: Pins = pins.chains[chainId] ?? { arena: null, nft: null, token: null };
  const pin: Pins = withSigned(pins, chainId, signed).chains[chainId]!;
  const registered: Record<PinKind, Address | null> = { arena: addr(i.arena), nft: addr(i.nft), token: addr(i.token) };
  const rows: PinRow[] = [];
  for (const kind of KINDS) {
    const r = registered[kind];
    if (!r) continue;
    const pinned = pin[kind];
    const state: PinState = pinned ? (same(pinned, r) ? 'match' : 'differs') : mayRunUnpinned(chainId) ? 'local' : 'missing';
    rows.push({ kind, name: PIN_NAME[kind], registered: r, pinned, state, source: own[kind] ? 'build' : signed?.[kind] ? 'signed' : null });
  }
  const invalid = KINDS.filter((k) => pins.invalid.includes(PIN_ENV[k])).map((k) => ({ env: PIN_ENV[k], key: PIN_VPS_KEY[k] }));
  if (pins.invalid.includes(OWNER_ENV)) invalid.push({ env: OWNER_ENV, key: OWNER_VPS_KEY });
  const todo = rows.filter((r) => r.state === 'missing' || r.state === 'differs');
  const ok = rows.length === 0 && invalid.length === 0 ? null : todo.length === 0 && invalid.length === 0;
  // every registered contract, then an empty line for a broken pin of a contract that is not registered (it clears it)
  const lines = (name: (k: PinKind) => string) => [
    ...rows.map((r) => `${name(r.kind)}=${r.registered}`),
    ...KINDS.filter((k) => !registered[k] && pins.invalid.includes(PIN_ENV[k])).map((k) => `${name(k)}=`),
  ];
  return {
    ...base,
    ok,
    rows,
    todo,
    invalid,
    overridden: todo.filter((r) => r.state === 'differs' && r.source === 'build'),
    envLines: lines((k) => PIN_VPS_KEY[k]),
    viteLines: [`VITE_CHAIN_ID=${chainId}`, ...lines((k) => PIN_ENV[k])],
  };
}

/**
 * The report of the panel's chain: the registered arena and NFT, and the arena's game token once it is set (the
 * panel's own read of the arena; while that is not in, the server's).
 */
export function registeredPinReport(net: AdminNetwork, status: StatusSnapshot | null, pins: BuildPins = PINS, signed: Pins | null = null): PinReport {
  return pinReport({ chainId: net.info?.id ?? null, ...pinTargets(net, status) }, pins, signed);
}

/** The addresses the owner signs: the registered arena and NFT, and the arena's game token (none while it is not set). */
export function pinTargets(net: AdminNetwork, status: StatusSnapshot | null): { arena: Address | null; nft: Address | null; token: Address | null } {
  const cfg = status?.arena?.config ?? null;
  const token = cfg ? (cfg.token ?? null) : (net.chain?.token?.address ?? null);
  return { arena: net.arenaAddress, nft: net.nftAddress, token: addr(token) };
}

/** The checklist line's detail: what the site trusts, or what is missing and how to fix it (pure, tested). */
export function pinSummary(r: PinReport): string {
  if (r.chainId === null) return 'No chain.';
  if (r.ok === null) return 'Nothing registered yet.';
  const names = (rows: PinRow[]) => rows.map((x) => PIN_PROSE[x.kind]).join(', ');
  if (r.ok) {
    if (r.rows.every((x) => x.state === 'local')) return 'The local node runs unpinned (the arena code hash is still checked).';
    const signed = r.rows.filter((x) => x.source === 'signed');
    const build = r.rows.filter((x) => x.source === 'build');
    return [signed.length ? `Signed by the owner: ${names(signed)}.` : '', build.length ? `Pinned in the build: ${names(build)}.` : ''].filter(Boolean).join(' ');
  }
  const parts: string[] = [];
  const missing = r.todo.filter((x) => x.state === 'missing');
  const differs = r.todo.filter((x) => x.state === 'differs');
  if (r.invalid.length) parts.push(`${r.invalid.map((x) => x.env).join(', ')} of this build is not an address: the site signs nothing.`);
  if (missing.length) parts.push(`Not signed yet: ${names(missing)}.`);
  if (differs.length) parts.push(`Signed for another address: ${names(differs)}.`);
  if (r.overridden.length) parts.push(`${r.overridden.map((x) => PIN_VPS_KEY[x.kind]).join(', ')} in /opt/elymum/.env names another address: clear it and rebuild (Setup → Site pins → Advanced).`);
  if (missing.length || differs.length > r.overridden.length) parts.push('Setup → Site pins: sign them with the owner wallet (free, no transaction).');
  return parts.join(' ');
}

/** The card's red line: each contract whose pin is missing or different, in one sentence; null when none is (pure, tested). */
export function pinTodoLine(r: PinReport): string | null {
  if (r.todo.length === 0) return null;
  const s = r.todo.map((x) => `${PIN_PROSE[x.kind]} is ${x.state === 'missing' ? 'not signed yet' : x.source === 'build' ? 'pinned to another address in the build' : 'signed for another address'}`).join('; ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

/** A row's state in two or three words (the card's pill). */
export function pinLabel(row: PinRow): string {
  if (row.state === 'match') return row.source === 'build' ? 'pinned in the build' : 'signed';
  if (row.state === 'missing') return 'not signed yet';
  if (row.state === 'differs') return row.source === 'build' ? 'another address in the build' : 'signed for another address';
  return 'not pinned (local node)';
}

/** What a missing or different pin means, null when it is pinned (pure: the card's words). */
export function pinEffect(row: PinRow): string | null {
  if (row.state === 'missing') {
    if (row.kind === 'arena') return 'The site signs no ticket, refund or shop payment until you sign it.';
    if (row.kind === 'nft') return 'The mint page signs nothing until you sign it.';
    return "The site does not check the arena's token until you sign it.";
  }
  if (row.state === 'differs') {
    const where = row.source === 'build' ? 'The build pins' : 'The signed pins name';
    if (row.kind === 'arena') return `${where} ${row.pinned}: the site refuses the registered arena.`;
    if (row.kind === 'nft') return `${where} ${row.pinned}: the mint page refuses the registered NFT.`;
    return `${where} ${row.pinned}: the site refuses the arena (its token is not the pinned one).`;
  }
  if (row.state === 'local') return "The local node may run unpinned (the arena's code hash is still checked).";
  return null;
}

/** "Robinhood Chain Testnet (46630)", or the bare id. */
export function chainLabel(id: number): string {
  return isSupportedChainId(id) ? `${chainInfo(id).name} (${id})` : `chain ${id}`;
}
