/**
 * Join permits (CoinnibalArena v4). `join(arenaId, deadline, signature)` needs the game server's EIP-712 signature of
 * `JoinPermit(address player, uint16 arenaId, uint64 nonce, uint64 deadline)` in the arena's domain (name, version,
 * chainId, verifyingContract). `nonce` is the player's join counter on the contract (`joinNonce`), used up by the
 * join: a permit buys one ticket. The server issues one at `POST /api/arena/permit {arenaId, room?}` (signed in; `room`:
 * the code of the paid custom room the ticket is for, which must take seats now) only when
 * the game is open for the wallet, the arena is open (a holders-only arena: the wallet holds the NFT), the wallet has no
 * open ticket there and it is not a repeated no-show, and the arena is not at its cap of tickets waiting for a seat. A
 * wallet without standing (no played ticket in 14 days, no NFT of its own) must also hold the entry fee, its network
 * must not be a repeated no-show nor have its share of the arena's tickets not played yet, the wallet must not have let
 * several permits of the arena run out unused that day, and new wallets together must not hold their share of the arena.
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
 * arena is disabled, paused or kept closed (maintenance, re-price) · `holders_only` the arena is for NFT holders and
 * the wallet holds none · `session_open` the wallet already holds a ticket there (resume it) · `no_show` too many of
 * its tickets, or of the tickets bought from its network, went back unplayed in a day (`retryAt`: Unix ms) ·
 * `network_busy` the network it is asked from (an IPv4 address or /24, an IPv6 /64 or /48) has its share of the
 * arena's permits not played yet (they free up as they are played or run out, within half an hour) · `unused_permits`
 * a wallet without standing let several permits of the arena run out unused in a day since its last ticket (`retryAt`: Unix
 * ms; a ticket bought starts afresh) · `arena_busy` the arena holds as many tickets waiting for a seat as a round can take,
 * or new wallets hold their share of them · `no_funds` a new wallet does not hold the entry fee · `ticket_elsewhere` a
 * wallet with standing holds a ticket of another arena not played yet (standing covers one at a time) and the network
 * rules refuse this one · `rate_limited` · `chain_busy` the network could not be read · `unauthorized` not signed in ·
 * `bad_request`.
 */
export type JoinPermitError =
  | 'bad_request'
  | 'unauthorized'
  | 'rate_limited'
  | 'game_closed'
  | 'banned'
  | 'arenas_off'
  | 'arena_closed'
  | 'holders_only'
  | 'session_open'
  | 'no_show'
  | 'network_busy'
  | 'unused_permits'
  | 'arena_busy'
  | 'no_funds'
  | 'ticket_elsewhere'
  | 'chain_busy';
