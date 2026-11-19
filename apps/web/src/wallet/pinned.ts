import { coinnibalArenaArtifact, getCodeHash } from '@coinnibal/sdk';
import { LOCALNET_CHAIN_ID, configuredChainId } from '@coinnibal/shared';
import { getAddress, isAddress, type Address, type PublicClient } from 'viem';

/**
 * The contracts this build trusts, pinned per chain at build time. A player's wallet only ever approves tokens to,
 * or calls, the arena pinned here, whatever address the game server announces: a server API that was broken into (or
 * a man in the middle on it) could otherwise point every wallet at a contract that drains it. The pins do not guard
 * against someone with the VPS shell, which builds and serves this site.
 *
 * - `VITE_ARENA_ADDRESS`, `VITE_NFT_ADDRESS`, `VITE_TOKEN_ADDRESS` pin the contracts of the build's chain
 *   (`VITE_CHAIN_ID`, default Robinhood Chain Testnet). On the VPS they come from `COINNIBAL_PIN_ARENA`,
 *   `COINNIBAL_PIN_NFT` and `COINNIBAL_PIN_TOKEN` in `/opt/elymum/.env` (deploy/vps/docker-compose.yml, build args),
 *   so changing a pin needs the server's shell and a rebuild, never only the admin panel.
 * - No chain has defaults: the owner deploys every contract from their own wallet, and a build trusts only what it
 *   was built with. A testnet or mainnet build without `VITE_ARENA_ADDRESS` signs no ticket, refund or shop payment,
 *   one without `VITE_NFT_ADDRESS` no mint; without `VITE_TOKEN_ADDRESS` the arena's token is not checked against a pin.
 * - The local development node (31337) may run unpinned (its addresses change with every deploy); the arena's code
 *   hash is still checked.
 * - `/admin` → Setup ("Site pins") and the Network checklist compare these pins with the registered contracts.
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
}

/** The env names of the pins, by contract. */
export const PIN_ENV: Readonly<Record<keyof Pins, string>> = Object.freeze({ arena: 'VITE_ARENA_ADDRESS', nft: 'VITE_NFT_ADDRESS', token: 'VITE_TOKEN_ADDRESS' });

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
  return { chainId, chains: { [chainId]: own }, invalid };
}

export const PINS: BuildPins = buildPins({
  chainId: import.meta.env.VITE_CHAIN_ID as string | undefined,
  arena: import.meta.env.VITE_ARENA_ADDRESS as string | undefined,
  nft: import.meta.env.VITE_NFT_ADDRESS as string | undefined,
  token: import.meta.env.VITE_TOKEN_ADDRESS as string | undefined,
});

/** Why a contract is refused. */
export type PinRefusal =
  /** A `VITE_*_ADDRESS` of this build is not an address. */
  | 'bad_pin'
  /** No arena is pinned for this chain (a build without `VITE_ARENA_ADDRESS`, or built for another chain). */
  | 'unpinned'
  /** The server announced another arena than the pinned one. */
  | 'arena_mismatch'
  /** The arena's game token is not the pinned token. */
  | 'token_mismatch'
  /** The server announced another NFT than the pinned one. */
  | 'nft_mismatch'
  /** No code, or not the arena build this site was made with. */
  | 'code_mismatch'
  /** The code could not be read (RPC down): nothing is signed until it can be. */
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

/**
 * The full check before an approval or a ticket: the pins, then the arena's runtime code hash read from the chain
 * against the compiled artifact (the same check the server makes when a contract is registered). Never cached: one `eth_getCode` per transaction.
 */
export async function verifyArena(
  client: Pick<PublicClient, 'getCode'>,
  chainId: number | null | undefined,
  announced: { arena: string | null | undefined; token?: string | null },
  pins: BuildPins = PINS,
  /** The runtime code hash of the compiled arena (`@coinnibal/contracts`). */
  expected: string = coinnibalArenaArtifact.runtimeCodeHash,
): Promise<PinCheck> {
  const pinned = checkAnnounced(chainId, announced, pins);
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
