/**
 * Join permits (CoinnibalArena v4). `join(arenaId, deadline, signature)` needs the game server's EIP-712 signature of
 * `JoinPermit(address player, uint16 arenaId, uint64 nonce, uint64 deadline)` in the arena's domain (name, version,
 * chainId, verifyingContract). `nonce` is the player's join counter on the contract (`joinNonce`), used up by the
 * join: a permit buys one ticket. The server issues one at `POST /api/arena/permit {arenaId}` (signed in) only when
 * the game is open for the wallet, the arena is open, the wallet has no open ticket there and is not a repeated
 * no-show, and the arena is not at its cap of tickets waiting for a seat.
 */

/** The EIP-712 domain name and version of the arena's join permits. */
export const JOIN_PERMIT_DOMAIN = { name: 'CoinnibalArena', version: '4' } as const;

/** A permit's deadline may be at most this far ahead of the block time (the contract's `MAX_PERMIT_WINDOW`). */
export const JOIN_PERMIT_MAX_WINDOW_S = 3600;

/** `POST /api/arena/permit` → `{ permit }`. */
export interface JoinPermit {
  /** The arena contract it is signed for (EIP-55). */
  arena: string;
  chainId: number;
  /** The wallet it is for (EIP-55): only this wallet's `join` accepts it. */
  player: string;
  arenaId: number;
  /** The player's join nonce it names (decimal). */
  nonce: string;
  /** Unix seconds. */
  deadline: number;
  /** 0x, 65 bytes. */
  signature: string;
}

/**
 * Why a permit is refused (`{ error, message, retryAt? }`):
 * `game_closed` the game is not open to this wallet · `banned` · `arenas_off` paid rooms are off · `arena_closed` the
 * arena is disabled, paused or kept closed (maintenance, re-price) · `session_open` the wallet already holds a ticket
 * there (resume it) · `no_show` too many of its tickets went back unplayed in a day (`retryAt`: Unix ms) ·
 * `arena_busy` the arena holds as many tickets waiting for a seat as a round can take · `rate_limited` ·
 * `chain_busy` the network could not be read · `unauthorized` not signed in · `bad_request`.
 */
export type JoinPermitError =
  | 'bad_request'
  | 'unauthorized'
  | 'rate_limited'
  | 'game_closed'
  | 'banned'
  | 'arenas_off'
  | 'arena_closed'
  | 'session_open'
  | 'no_show'
  | 'arena_busy'
  | 'chain_busy';
