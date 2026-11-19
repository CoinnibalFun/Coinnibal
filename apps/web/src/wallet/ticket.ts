/**
 * Arena tickets: what the lobby lists, what a ticket button does, and the calls that buy one.
 * Pure functions (no React, no network) so the money path is unit-tested (test/ticket.test.ts).
 *
 * Units: amounts read from the chain (entry fees, balances, `owed`) are bigint **base units** of
 * the ERC-20 game token. Amounts on the game server's wire (room entry fees, loot, payouts) are
 * **ledger units** (at most 6 decimals, see `fromLedger` / `ledgerDecimals` in the SDK); they
 * are converted with `fromLedger` before they meet a chain amount.
 */
import { DEFAULT_ARENAS, DEFAULT_FEE_RATES, ratesFor, totalFeeBps, type ArenaFees, type FeeRates, type RoomInfo } from '@coinnibal/shared';
import type { Address, Hex } from 'viem';
import { REFUND_DELAY_SECS, fromLedger, type Erc20Call } from '@coinnibal/sdk';

/* ── the ticket calls ───────────────────────────────────────────────── */

/**
 * `approve` (only when the allowance is short) then `join`: two wallet prompts at most. The approval names an exact
 * amount, never unlimited (2026-11 audit: an unlimited approval to whatever arena the server names is a wallet-drain
 * risk): the entry fee of 1, 5, 10 or 20 tickets of that room (`Settings.approveTickets`, 5 preselected and
 * remembered). Until that allowance runs out, the next tickets need one transaction (the join) only.
 */
export type TicketStep = 'approve' | 'join';

/** How many tickets one approval may cover: the player's choices, and the cap (20 entry fees). */
export const APPROVE_TICKET_CHOICES = [1, 5, 10, 20] as const;
export const APPROVE_MAX_TICKETS = 20;
/** Preselected (and kept until the player picks another). */
export const APPROVE_DEFAULT_TICKETS = 5;

/** A stored choice as one of `APPROVE_TICKET_CHOICES` (the default for anything else; never above the cap). */
export function approveTickets(n: unknown): number {
  return (APPROVE_TICKET_CHOICES as readonly number[]).includes(n as number) ? (n as number) : APPROVE_DEFAULT_TICKETS;
}

/** The amount an approval for `tickets` tickets of `entryFee` grants (base units), capped at 20 entry fees. */
export function approveAmount(tickets: number, entryFee: bigint): bigint {
  return entryFee * BigInt(Math.max(1, Math.min(APPROVE_MAX_TICKETS, Math.floor(tickets))));
}

/** Tickets of `entryFee` the arena's allowance still covers (each needs only the join); null while unknown. */
export function ticketsLeft(allowance: bigint | null, entryFee: bigint): number | null {
  if (allowance === null || entryFee <= 0n) return null;
  return Number(allowance / entryFee);
}

/**
 * The last look at an approval before the wallet opens: an ERC-20 `approve` on the arena's game token, for the
 * pinned arena, of exactly the amount the sheet showed. Anything else (another spender, another amount, an unlimited
 * allowance) is refused. Pure: unit-tested.
 */
export function approvalIsSafe(call: Pick<Erc20Call, 'address' | 'functionName' | 'args'>, o: { token: Address; arena: Address; amount: bigint }): boolean {
  if (call.functionName !== 'approve' || call.address.toLowerCase() !== o.token.toLowerCase()) return false;
  const [spender, amount] = call.args as readonly unknown[];
  return typeof spender === 'string' && spender.toLowerCase() === o.arena.toLowerCase() && amount === o.amount && o.amount > 0n;
}

/** The calls a ticket needs, in order. `allowance` null (unknown) asks for the approval to be safe. */
export function ticketSteps(allowance: bigint | null, entryFee: bigint): TicketStep[] {
  return allowance !== null && allowance >= entryFee ? ['join'] : ['approve', 'join'];
}

/** `planJoin` refusals (its RangeError text) → the ticket sheet's error names (`tf.err.*`). */
export function planErrorName(message: string): string {
  if (/is full/.test(message)) return 'ArenaFull';
  if (/is closed/.test(message)) return 'ArenaDisabled';
  if (/balance too low/.test(message)) return 'InsufficientBalance';
  if (/no game token/.test(message)) return 'TokenNotSet';
  if (/holders only/.test(message)) return 'HoldersOnly';
  if (/does not exist/.test(message)) return 'PriceChanged';
  return 'NetworkError';
}

/** The journal key of a session: `<arenaId>:<player lowercase>:<sessionId>` (= `joined.session` / `settled.session`). */
export function sessionKey(arenaId: number, player: string, sessionId: bigint | number): string {
  return `${arenaId}:${player.toLowerCase()}:${sessionId.toString()}`;
}

/* ── the ticket list ────────────────────────────────────────────────────── */

/** `test:<id>`: the arena's test arena (testnet only): the same ticket, played in a room with practice bots. */
export type TicketKey = 'practice' | `arena:${number}` | `test:${number}`;

/** On-chain arena fields the lobby needs (an SDK `ArenaInfo` fits). */
export interface ArenaLike {
  id: number;
  /** Base units. */
  entryFee: bigint;
  enabled: boolean;
  exists?: boolean;
}

export interface TicketModel {
  key: TicketKey;
  arenaId: number | null;
  /** Base units of the game token (0 for practice). */
  entryFee: bigint;
  /** Summed over every instance of the arena. */
  humans: number;
  bots: number;
  /** Loot on the floor, ledger units (from the server). */
  loot: number;
  /** The arena exists on chain and is open (practice: always). */
  open: boolean;
  /** The server keeps this arena closed (its vault cannot cover the journal): "under maintenance", no sales. */
  blocked?: boolean;
  /**
   * The game token is not set on chain yet: a default arena shown as "Opening soon" (its
   * price from `DEFAULT_ARENAS`), not for sale. Practice still plays.
   */
  soon?: boolean;
  /** The arena admits Coinnibal emblem holders only (on-chain `holdersOnly`): a small laurel lock for everyone else. */
  holdersOnly?: boolean;
  /**
   * The arena's test arena (testnet only): the official ticket, rounds and payouts in a room with practice bots.
   * Listed after the official arenas, never picked by quick play.
   */
  test?: true;
}

/** What the lobby knows about the game token (`ChainStatus`). */
export interface TokenState {
  /** The chain is on (an arena contract is configured). */
  enabled: boolean;
  /** The token is set on the arena contract (`ChainStatus.tokenReady`). */
  tokenReady: boolean;
  /** The token's decimals (18 when unknown, like the contract's default). */
  decimals: number;
}

/** The default arenas, "Opening soon", while the token is not set (whole tokens × 10^decimals). */
export function soonTickets(decimals: number): TicketModel[] {
  const unit = 10n ** BigInt(decimals);
  return DEFAULT_ARENAS.map((a) => ({
    key: `arena:${a.id}` as TicketKey,
    arenaId: a.id,
    entryFee: BigInt(a.entryTokens) * unit,
    humans: 0,
    bots: 0,
    loot: 0,
    open: false,
    soon: true,
  }));
}

/** A ledger amount from the wire in base units (0 when it is not a safe whole number). */
export function ledgerToBase(ledger: number | undefined, decimals: number): bigint {
  try {
    return fromLedger(Math.max(0, Math.round(ledger ?? 0)), decimals);
  } catch {
    return 0n;
  }
}

/**
 * Practice plus one ticket per arena. Arena rooms are sharded into instances, so live counts
 * and loot are summed per `arenaId`. The on-chain arena wins for the price (it is what the player
 * signs); rooms fill in when the chain is not readable yet. Sorted by price. While the chain is on
 * but the game token is not set the default arenas are listed as "Opening soon".
 */
export function buildTickets(
  rooms: readonly RoomInfo[],
  arenas: readonly ArenaLike[],
  blocked: readonly number[] = [],
  token: TokenState = { enabled: true, tokenReady: true, decimals: 18 },
  /** Arena ids marked holders-only on chain. */
  holdersOnly: readonly number[] = [],
): TicketModel[] {
  const practice: TicketModel = { key: 'practice', arenaId: null, entryFee: 0n, humans: 0, bots: 0, loot: 0, open: true };
  for (const r of rooms) {
    if (r.mode !== 'practice') continue;
    practice.humans += r.players;
    practice.bots += r.bots;
  }
  if (token.enabled && !token.tokenReady) return [practice, ...soonTickets(token.decimals)];
  const byId = new Map<number, TicketModel>();
  for (const a of arenas) {
    if (a.exists === false) continue;
    byId.set(a.id, { key: `arena:${a.id}`, arenaId: a.id, entryFee: a.entryFee, humans: 0, bots: 0, loot: 0, open: a.enabled });
  }
  const chainKnown = byId.size > 0;
  for (const r of rooms) {
    // a test arena is its own ticket (below), never counted in the official arena's numbers
    if (r.mode !== 'arena' || r.arenaId === undefined || r.test) continue;
    let t = byId.get(r.arenaId);
    if (!t) {
      // only list arenas the chain does not know about when the chain is not readable
      if (chainKnown) continue;
      t = {
        key: `arena:${r.arenaId}`,
        arenaId: r.arenaId,
        entryFee: ledgerToBase(r.entryFee, token.decimals),
        humans: 0,
        bots: 0,
        loot: 0,
        open: true,
      };
      byId.set(r.arenaId, t);
    }
    t.humans += r.players;
    t.bots += r.bots;
    t.loot += r.loot ?? 0;
  }
  for (const id of blocked) {
    const t = byId.get(id);
    if (t) t.blocked = true;
  }
  for (const id of holdersOnly) {
    const t = byId.get(id);
    if (t) t.holdersOnly = true;
  }
  const list = [...byId.values()].sort((a, b) => (a.entryFee < b.entryFee ? -1 : a.entryFee > b.entryFee ? 1 : (a.arenaId ?? 0) - (b.arenaId ?? 0)));
  // the testnet's test arenas: the same ticket as their arena (price, state), listed after every official arena
  const tests: TicketModel[] = [];
  for (const official of list) {
    const id = official.arenaId;
    const room = id === null ? undefined : rooms.find((r) => r.test && r.mode === 'arena' && r.arenaId === id);
    if (!room || id === null) continue;
    tests.push({ ...official, key: `test:${id}`, humans: room.players, bots: room.bots, loot: room.loot ?? 0, test: true });
  }
  return [practice, ...list, ...tests];
}

/* ── quick play ─────────────────────────────────────────────────────────── */

export interface QuickPlayInput {
  walletConnected: boolean;
  /** Game-token balance, base units (`null` = unknown). */
  balance: bigint | null;
  tickets: readonly TicketModel[];
  lastArena: number | null;
  /** Arenas where the wallet already has an open ticket (playing them costs nothing). */
  openSessions?: readonly number[];
  /** The wallet holds an emblem (false: holders-only arenas are skipped). */
  holder?: boolean | null;
}

/**
 * Where "Quick play" goes: no wallet or no tokens → practice; otherwise an open ticket, then
 * the last arena if still affordable, else the cheapest affordable arena, else practice.
 */
export function quickPlayTarget(input: QuickPlayInput): TicketKey {
  // quick play never picks a test arena
  const tickets = input.tickets.filter((t) => !t.test);
  if (!input.walletConnected || input.balance === null || input.balance <= 0n) {
    const resumable = input.walletConnected ? tickets.find((t) => t.arenaId !== null && input.openSessions?.includes(t.arenaId)) : undefined;
    return resumable ? resumable.key : 'practice';
  }
  const arenas = tickets.filter((t) => t.arenaId !== null && t.open && !t.blocked && !t.soon && !(t.holdersOnly && input.holder === false));
  const open = arenas.find((t) => input.openSessions?.includes(t.arenaId!));
  if (open) return open.key;
  const balance = input.balance;
  const affordable = (t: TicketModel) => t.entryFee > 0n && t.entryFee <= balance;
  const last = arenas.find((t) => t.arenaId === input.lastArena);
  if (last && affordable(last)) return last.key;
  const cheapest = arenas.filter(affordable).sort((a, b) => (a.entryFee < b.entryFee ? -1 : a.entryFee > b.entryFee ? 1 : 0))[0];
  return cheapest ? cheapest.key : 'practice';
}

/* ── what a ticket button does ──────────────────────────────────────────── */

/** `GET /api/pending?wallet=0x…`: payouts the server is still settling. */
export interface PendingPayout {
  /** Journal key `<arenaId>:<player lowercase>:<sessionId>`. */
  key: string;
  arenaId: number | null;
  /** Ledger units the server is still settling. */
  payout: number;
}

export interface OpenSession {
  /** Journal key (see `sessionKey`). */
  key: string;
  /** On-chain session id (> 0). */
  id: bigint;
  /** Unix seconds. */
  openedAt: number;
  /** Base units paid at join. */
  entryFee?: bigint;
  /** Settled with the player transfer failing: `owed` waits for the player to collect it (`refund`). */
  finalized?: boolean;
  /** Base units to collect (finalized sessions). */
  owed?: bigint;
}

export type TicketGate =
  | { kind: 'practice' }
  /** The game token is not set on chain yet: the arena opens soon (nothing is sold; practice plays). */
  | { kind: 'soon' }
  | { kind: 'offline' }
  /** The server keeps this arena closed (its vault cannot cover the journal); nothing is sold. */
  | { kind: 'maintenance' }
  | { kind: 'connect' }
  /** The last game here is settled and its payout waits for the player: "Collect payout" (base units). */
  | { kind: 'collect'; owed: bigint }
  /** The previous game in this arena is being paid out (ledger units; no new ticket yet). */
  | { kind: 'settling'; payout: number }
  /** The open ticket is older than 24 h: the player may refund it themselves. */
  | { kind: 'refund' }
  | { kind: 'verify' }
  /** An open ticket, no transaction. */
  | { kind: 'resume' }
  /** A holders-only arena and the wallet holds no emblem: the CTA points to the mint. */
  | { kind: 'holders' }
  /** Base units missing. */
  | { kind: 'insufficient'; missing: bigint }
  | { kind: 'buy' };

export interface GateInput {
  ticket: TicketModel;
  arenasEnabled: boolean;
  walletConnected: boolean;
  verified: boolean;
  balance: bigint | null;
  session: OpenSession | null;
  pending: readonly PendingPayout[];
  nowS: number;
  /** The wallet holds an emblem; null / undefined while unknown (the contract checks at join anyway). */
  holder?: boolean | null;
}

export function ticketGate(g: GateInput): TicketGate {
  const t = g.ticket;
  if (t.arenaId === null) return { kind: 'practice' };
  if (t.soon) return { kind: 'soon' };
  // a payout waiting to be collected comes first, even while arenas are offline or blocked
  if (g.walletConnected && g.session?.finalized) return { kind: 'collect', owed: g.session.owed ?? 0n };
  if (!g.arenasEnabled) return { kind: 'offline' };
  if (!t.blocked && !t.open) return { kind: 'offline' };
  if (!g.walletConnected) return t.blocked ? { kind: 'maintenance' } : { kind: 'connect' };
  // a payout the server is still settling comes next, even in a blocked arena
  const owed = g.pending.filter((p) => (g.session && p.key === g.session.key) || p.arenaId === t.arenaId);
  if (owed.length > 0) return { kind: 'settling', payout: owed.reduce((s, p) => s + p.payout, 0) };
  // an open ticket keeps its paths (resume, or the 24 h self-refund) even in a blocked arena
  if (g.session) {
    if (g.nowS - g.session.openedAt >= REFUND_DELAY_SECS) return { kind: 'refund' };
    return g.verified ? { kind: 'resume' } : { kind: 'verify' };
  }
  // the server keeps this arena closed; nothing new is sold
  if (t.blocked) return { kind: 'maintenance' };
  // holders-only and no emblem: nothing to sell (planJoin refuses it with HoldersOnly too)
  if (t.holdersOnly && g.holder === false) return { kind: 'holders' };
  if (!g.verified) return { kind: 'verify' };
  if (g.balance !== null && g.balance < t.entryFee) return { kind: 'insufficient', missing: t.entryFee - g.balance };
  return { kind: 'buy' };
}

/* ── fee policy ─────────────────────────────────────────────────────────── */

/**
 * The fee rates on profit of a new ticket (arena v3: no entry fee; a winning ticket pays `burnBps` + `vaultBps` of
 * its profit, a losing one nothing): the server's `ChainStatus.fees` (the arena's `config()` it reads), else the
 * loaded config, else the contract defaults (15 % + 5 %). The ticket sheet re-reads the config before signing and
 * refuses a change.
 */
export function arenaRates(server: Pick<ArenaFees, 'burnBps' | 'vaultBps'> | null | undefined, config: FeeRates | null = null): FeeRates {
  const r = server ?? config ?? DEFAULT_FEE_RATES;
  return { burnBps: r.burnBps, vaultBps: r.vaultBps };
}

/**
 * The rates a ticket of this wallet gets (`planJoin`'s `rates`): the holder pair for emblem holders while the perks
 * are on and it totals less (`CoinnibalArena._ratesFor`), else the normal pair.
 */
export function ticketRates(
  normal: FeeRates,
  config: { holderNft: string | null; holderBurnBps: number; holderVaultBps: number } | null,
  holder: boolean | null | undefined,
): { rates: FeeRates; discount: boolean } {
  const pair = config?.holderNft ? { burnBps: config.holderBurnBps, vaultBps: config.holderVaultBps } : null;
  const rates = ratesFor(normal, pair, holder === true);
  return { rates, discount: totalFeeBps(rates) < totalFeeBps(normal) };
}

/** The two pairs are the same rates. */
export const sameRates = (a: FeeRates, b: FeeRates): boolean => a.burnBps === b.burnBps && a.vaultBps === b.vaultBps;

/** Arenas whose last game is settled with a payout waiting to be collected (base units). */
export function sessionsToCollect(sessions: Readonly<Record<number, OpenSession | null>>): { arenaId: number; owed: bigint }[] {
  return Object.entries(sessions)
    .filter(([, s]) => s?.finalized)
    .map(([id, s]) => ({ arenaId: Number(id), owed: s!.owed ?? 0n }));
}

/** Gas for `join` when the estimate cannot be read (a ticket with its permit uses about 165k, a holder's first one about 185k). */
export const JOIN_GAS_FALLBACK = 260_000n;

/**
 * Right after an approval the wallet's node may not see it yet: its own gas estimate for `join` then
 * fails, and a wallet that sends anyway with a guessed limit gets a reverted ticket. So: wait until
 * the allowance is visible on our read client (at most `waitMs`), estimate `join` there, and send it
 * with a margin (+30 %); a failed estimate falls back to `JOIN_GAS_FALLBACK`.
 */
export async function joinGasAfterApprove(
  client: { estimateGas: (a: never) => Promise<bigint> },
  readAllowance: () => Promise<bigint>,
  p: { owner: Address; arena: Address; data: Hex; fee: bigint },
  o: { waitMs?: number; stepMs?: number } = {},
): Promise<bigint> {
  const until = Date.now() + (o.waitMs ?? 20_000);
  for (;;) {
    const a = await readAllowance().catch(() => 0n);
    if (a >= p.fee || Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, o.stepMs ?? 700));
  }
  try {
    const est = await client.estimateGas({ account: p.owner, to: p.arena, data: p.data } as never);
    const g = (est * 13n) / 10n;
    return g > JOIN_GAS_FALLBACK ? g : JOIN_GAS_FALLBACK;
  } catch {
    return JOIN_GAS_FALLBACK;
  }
}
