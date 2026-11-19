import { coinnibalArenaArtifact, getCodeHash } from '@coinnibal/sdk';
import { LOCALNET_CHAIN_ID, OWNER_WALLET, configuredChainId, parseSitePinsRecord, sitePinsMessage, type SitePinsResponse } from '@coinnibal/shared';
import { getAddress, isAddress, verifyMessage, type Address, type Hex, type PublicClient } from 'viem';
import { SERVER } from '../config';
import { storageKey } from '../storageKey';

/**
 * The contracts this site trusts, per chain. A player's wallet only ever approves tokens to, or calls, the arena
 * trusted here, whatever address the game server announces: a server API that was broken into (or a man in the middle
 * on it), or a stolen admin login, could otherwise point every wallet at a contract that drains it.
 *
 * - The owner signs the pins: after a deploy (and again after the game token is set) `/admin` asks the owner's wallet
 *   for one free signature of a plain message naming the chain id, the arena, the NFT and the token
 *   (`sitePinsMessage`). The server stores that record (`POST /api/admin/pins`, admin only) and serves it to everyone
 *   (`GET /api/site/pins`); this site uses it only when the signature is the owner's (`OWNER_WALLET`, built in,
 *   overridable with `VITE_OWNER_WALLET`) for exactly that chain and those addresses. A record older than one this
 *   browser has already seen is refused (no rollback to an earlier signed deploy).
 * - `VITE_ARENA_ADDRESS`, `VITE_NFT_ADDRESS`, `VITE_TOKEN_ADDRESS` (the build chain `VITE_CHAIN_ID`, default Robinhood
 *   Chain Testnet) are an optional override: a contract pinned there wins over the signed record. On the VPS they come
 *   from `COINNIBAL_PIN_*` in `/opt/elymum/.env` (a rebuild).
 * - Nothing pinned (no signed record, no override): a testnet or mainnet site signs no ticket, refund or shop payment
 *   without an arena, no mint without an NFT; without a token the arena's token is not checked against a pin.
 * - The local development node (31337) may run unpinned (its addresses change with every deploy); the arena's code
 *   hash is still checked.
 * - `/admin` (Setup → Site pins, and the Network checklist) compares the pins with the registered contracts.
 *
 * On top of the address, the arena's runtime code is checked against the build of `@coinnibal/contracts` this site was
 * made with (its `runtimeCodeHash`) before every approval and ticket.
 */

export interface Pins {
  arena: Address | null;
  nft: Address | null;
  token: Address | null;
}

export interface PinEnv {
  chainId?: string;
  arena?: string;
  nft?: string;
  token?: string;
  /** `VITE_OWNER_WALLET`: the wallet whose signed pins this site trusts (default `OWNER_WALLET`). */
  owner?: string;
}

/** An env value as an address: undefined when unset, null when set but not an address (a broken build: refuse). */
function envAddress(v: string | undefined): Address | null | undefined {
  const s = v?.trim();
  if (!s) return undefined;
  return isAddress(s, { strict: false }) ? getAddress(s) : null;
}

export interface BuildPins {
  /** The build's chain (`VITE_CHAIN_ID`): the only chain with pins. */
  chainId: number;
  /** Pins per chain id. */
  chains: Record<number, Pins>;
  /** The env names that hold something that is not an address (nothing is signed then). */
  invalid: string[];
  /** The owner wallet whose signed pins are trusted (null: `VITE_OWNER_WALLET` is not an address). */
  owner: Address | null;
}

/** The env names of the pins, by contract. */
export const PIN_ENV: Readonly<Record<keyof Pins, string>> = Object.freeze({ arena: 'VITE_ARENA_ADDRESS', nft: 'VITE_NFT_ADDRESS', token: 'VITE_TOKEN_ADDRESS' });

/** The env name of the owner wallet override. */
export const OWNER_ENV = 'VITE_OWNER_WALLET';

/** The pins of a build (`import.meta.env`), per chain id: only the build's own chain, only what the env names. Pure: unit-tested. */
export function buildPins(env: PinEnv): BuildPins {
  const chainId = configuredChainId(env.chainId);
  const invalid: string[] = [];
  const own: Pins = { arena: null, nft: null, token: null };
  for (const key of ['arena', 'nft', 'token'] as const) {
    const a = envAddress(env[key]);
    if (a === null) invalid.push(PIN_ENV[key]);
    else if (a !== undefined) own[key] = a;
  }
  const o = envAddress(env.owner);
  if (o === null) invalid.push(OWNER_ENV);
  return { chainId, chains: { [chainId]: own }, invalid, owner: o === undefined ? getAddress(OWNER_WALLET) : o };
}

export const PINS: BuildPins = buildPins({
  chainId: import.meta.env.VITE_CHAIN_ID as string | undefined,
  arena: import.meta.env.VITE_ARENA_ADDRESS as string | undefined,
  nft: import.meta.env.VITE_NFT_ADDRESS as string | undefined,
  token: import.meta.env.VITE_TOKEN_ADDRESS as string | undefined,
  owner: import.meta.env.VITE_OWNER_WALLET as string | undefined,
});

/** The owner's signed pins of one chain, once their signature checks out. */
export interface SignedPins extends Pins {
  chainId: number;
  signedAt: string;
}

/**
 * The owner's signed record as pins, or null: the record must be for `chainId`, and its signature must be the owner's
 * `personal_sign` of exactly these fields (a wrong signer, another chain, or any changed address fails). Pure.
 */
export async function verifySignedPins(raw: unknown, chainId: number, owner: Address | null): Promise<SignedPins | null> {
  const rec = parseSitePinsRecord(raw);
  if (!rec || !owner || rec.chainId !== chainId) return null;
  const fields = { chainId, arena: getAddress(rec.arena), nft: getAddress(rec.nft), token: rec.token ? getAddress(rec.token) : null, signedAt: rec.signedAt };
  const ok = await verifyMessage({ address: owner, message: sitePinsMessage(fields), signature: rec.signature as Hex }).catch(() => false);
  return ok ? { chainId, arena: fields.arena, nft: fields.nft, token: fields.token, signedAt: fields.signedAt } : null;
}

/** The pins of `chainId`: the build's override per contract, else the owner's signed record. Pure. */
export function withSigned(build: BuildPins, chainId: number, signed: Pins | null): BuildPins {
  const own = build.chains[chainId] ?? { arena: null, nft: null, token: null };
  const merged: Pins = { arena: own.arena ?? signed?.arena ?? null, nft: own.nft ?? signed?.nft ?? null, token: own.token ?? signed?.token ?? null };
  return { ...build, chains: { ...build.chains, [chainId]: merged } };
}

/** The newest signed record this browser accepted, per chain (an older one is a rollback: refused). */
const SEEN_KEY = storageKey('pins.seen.v1');

function seenAt(chainId: number): number {
  try {
    const all = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, string>;
    return Date.parse(all[String(chainId)] ?? '') || 0;
  } catch {
    return 0;
  }
}

function remember(p: SignedPins): void {
  try {
    const all = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, string>;
    if ((Date.parse(all[String(p.chainId)] ?? '') || 0) < Date.parse(p.signedAt)) localStorage.setItem(SEEN_KEY, JSON.stringify({ ...all, [p.chainId]: p.signedAt }));
  } catch {
    /* no storage: nothing to remember */
  }
}

/** `GET /api/site/pins?chainId=`: the stored record (unchecked). Throws when the server cannot be asked. */
export type SignedPinsFetch = (chainId: number) => Promise<unknown>;

const fetchSignedPins: SignedPinsFetch = async (chainId) => {
  const res = await fetch(`${SERVER.http}/api/site/pins?chainId=${chainId}`, { cache: 'no-store' });
  // a server without the route has no signed record (the build's own pins still apply)
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`pins: HTTP ${res.status}`);
  return ((await res.json()) as Partial<SitePinsResponse>).record ?? null;
};

const SIGNED_TTL_MS = 60_000;
const signedCache = new Map<number, { at: number; p: Promise<SignedPins | null> }>();

/**
 * The owner's verified pins of a chain (null: none, or not the owner's, or older than one this browser saw), read at
 * most once a minute. Throws when the server cannot be asked (the caller then signs nothing).
 */
export function signedPinsFor(chainId: number, opts: { fetch?: SignedPinsFetch; owner?: Address | null; fresh?: boolean } = {}): Promise<SignedPins | null> {
  const hit = signedCache.get(chainId);
  if (hit && !opts.fresh && !opts.fetch && Date.now() - hit.at < SIGNED_TTL_MS) return hit.p;
  const owner = opts.owner === undefined ? PINS.owner : opts.owner;
  const p = (opts.fetch ?? fetchSignedPins)(chainId).then(async (raw) => {
    const v = await verifySignedPins(raw, chainId, owner);
    if (!v || Date.parse(v.signedAt) < seenAt(chainId)) return null;
    remember(v);
    return v;
  });
  signedCache.set(chainId, { at: Date.now(), p });
  p.catch(() => {
    if (signedCache.get(chainId)?.p === p) signedCache.delete(chainId);
  });
  return p;
}

/** Forgets the read signed pins (the admin just signed new ones). */
export function forgetSignedPins(): void {
  signedCache.clear();
}

/** The pins this site uses on `chainId`: the build's, completed by the owner's signed record. Throws when it cannot be read. */
export async function pinsFor(chainId: number | null | undefined, build: BuildPins = PINS): Promise<BuildPins> {
  if (chainId == null) return build;
  const own = build.chains[chainId];
  if (build.invalid.length > 0 || (own?.arena && own.nft && own.token)) return build;
  return withSigned(build, chainId, await signedPinsFor(chainId, { owner: build.owner }));
}

/** Why a contract is refused. */
export type PinRefusal =
  /** A `VITE_*_ADDRESS` of this build is not an address. */
  | 'bad_pin'
  /** No arena is pinned for this chain (no owner-signed pins and no `VITE_ARENA_ADDRESS`). */
  | 'unpinned'
  /** The server announced another arena than the pinned one. */
  | 'arena_mismatch'
  /** The arena's game token is not the pinned token. */
  | 'token_mismatch'
  /** The server announced another NFT than the pinned one. */
  | 'nft_mismatch'
  /** No code, or not the arena build this site was made with. */
  | 'code_mismatch'
  /** The code (or the owner's signed pins) could not be read: nothing is signed until it can be. */
  | 'unreadable';

export type PinCheck = { ok: true; arena: Address } | { ok: false; reason: PinRefusal };

const same = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** May this chain run without a pinned arena (the local node only). */
export const mayRunUnpinned = (chainId: number): boolean => chainId === LOCALNET_CHAIN_ID;

/**
 * The announced arena against the pins, no network: the pinned arena when it matches. Pure: unit-tested. `token`
 * (the arena's on-chain game token, once known) must be the pinned token.
 */
export function checkAnnounced(chainId: number | null | undefined, announced: { arena: string | null | undefined; token?: string | null }, pins: BuildPins = PINS): PinCheck {
  if (pins.invalid.length > 0) return { ok: false, reason: 'bad_pin' };
  if (chainId == null || !announced.arena || !isAddress(announced.arena, { strict: false })) return { ok: false, reason: 'unpinned' };
  const pin = pins.chains[chainId];
  if (!pin?.arena) return mayRunUnpinned(chainId) ? { ok: true, arena: getAddress(announced.arena) } : { ok: false, reason: 'unpinned' };
  if (!same(pin.arena, announced.arena)) return { ok: false, reason: 'arena_mismatch' };
  if (announced.token && pin.token && !same(pin.token, announced.token)) return { ok: false, reason: 'token_mismatch' };
  return { ok: true, arena: pin.arena };
}

/** The announced NFT against the pin (the mint page): the address to use, or why not. */
export function checkNft(chainId: number | null | undefined, announced: string | null | undefined, pins: BuildPins = PINS): { ok: true; nft: Address } | { ok: false; reason: PinRefusal } {
  if (pins.invalid.length > 0) return { ok: false, reason: 'bad_pin' };
  if (chainId == null || !announced || !isAddress(announced, { strict: false })) return { ok: false, reason: 'unpinned' };
  const pin = pins.chains[chainId]?.nft;
  if (!pin) return mayRunUnpinned(chainId) ? { ok: true, nft: getAddress(announced) } : { ok: false, reason: 'unpinned' };
  return same(pin, announced) ? { ok: true, nft: pin } : { ok: false, reason: 'nft_mismatch' };
}

/** `checkNft` against this site's pins (`pinsFor`): the mint page, right before the wallet opens. */
export async function verifyNft(chainId: number | null | undefined, announced: string | null | undefined): Promise<{ ok: true; nft: Address } | { ok: false; reason: PinRefusal }> {
  try {
    return checkNft(chainId, announced, await pinsFor(chainId));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/**
 * The full check before an approval or a ticket: the pins, then the arena's runtime code hash read from the chain
 * against the compiled artifact (the same check the server makes when a contract is registered). Never cached: one `eth_getCode` per transaction.
 */
export async function verifyArena(
  client: Pick<PublicClient, 'getCode'>,
  chainId: number | null | undefined,
  announced: { arena: string | null | undefined; token?: string | null },
  /** The pins to check against (default: this site's, `pinsFor`). */
  pins?: BuildPins,
  /** The runtime code hash of the compiled arena (`@coinnibal/contracts`). */
  expected: string = coinnibalArenaArtifact.runtimeCodeHash,
): Promise<PinCheck> {
  let use: BuildPins;
  try {
    use = pins ?? (await pinsFor(chainId));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const pinned = checkAnnounced(chainId, announced, use);
  if (!pinned.ok) return pinned;
  let hash: string | null;
  try {
    hash = await getCodeHash(client, pinned.arena);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  return same(hash, expected) ? pinned : { ok: false, reason: 'code_mismatch' };
}

/** The ticket sheet's error name (`tf.err.*`) for a refusal. */
export function pinErrorName(reason: PinRefusal): 'NetworkError' | 'ContractMismatch' {
  return reason === 'unreadable' ? 'NetworkError' : 'ContractMismatch';
}
