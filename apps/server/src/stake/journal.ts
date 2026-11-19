import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * Why a ticket was settled. `round`: alive at the round end (paid arenas). `cashout` and `afk` are
 * no longer produced by arena rooms (timed rounds) but stay readable in old journals.
 */
export type SettleReason = 'cashout' | 'death' | 'afk' | 'crash' | 'stale' | 'maxage' | 'kicked' | 'round';

export interface SettlementItem {
  /** v1 journals also held free-play `record` items; v2 drops them on load. */
  kind: 'settle';
  /** Unique key: `<arenaId>:<player lowercase>:<sessionId>`. */
  key: string;
  /** Wallet, EIP-55 checksummed. */
  player: string;
  arenaId?: number;
  session?: string;
  /** On-chain session id: `settle` refuses (skips) an item whose id no longer matches. */
  sessionId?: number;
  /**
   * The ticket's gross value, ledger units (the token with at most 6 decimals; converted to base units only
   * when sent). The arena contract takes its fee on the profit from it; this is what leaves the vault.
   */
  payout?: number;
  /** The ticket's entry fee (ledger units), when known: what a refund after 24 h would take out of the vault. */
  entryFee?: number;
  /**
   * Σ entry fees of every ticket seated in this ticket's arena instance during its round, plus loot restored into it
   * (ledger units): all the value a ticket can have taken from others. The payout guard holds a payout above it.
   * Absent on items not made by a room (crash recovery, older journals): the guard uses `PAYOUT_GUARD_MULTIPLE` then.
   */
  roundPool?: number;
  score: number;
  kills: number;
  xp: number;
  reason?: SettleReason;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  lastError?: string;
  /**
   * Integrity auto-hold: the settlement waits for an admin decision (`Journal.release` or
   * `Journal.settleZero`). The chain worker never sends a held item; it still counts as owed.
   */
  held?: { at: number; score: number; why: string; flags: string[] };
  /**
   * An admin released this item after the chain worker's payout guard held it (`EvmChain`): the guard does not
   * hold it again.
   */
  guardCleared?: boolean;
  /** When this server first broadcast a transaction with this item (Unix ms): from then on it may be settled by us. */
  sentAt?: number;
  /**
   * A stale cancel of a ticket that was never seated while its arena was open (not a closed arena's refund): a
   * no-show. Too many in a day and the wallet gets no join permit for a while (`JoinPermits`).
   */
  noShow?: true;
}

/**
 * Value an admin forfeited from a held settlement ("settle at 0"): the ticket is settled on chain
 * with payout 0 and this much stays in the arena vault, owed to nobody. Kept for good so the
 * books still add up: Σ live + Σ loot + Σ pending + Σ forfeited = Σ entry fees − Σ paid.
 */
export interface ForfeitRecord {
  key: string;
  player: string;
  arenaId: number | null;
  /**
   * Ledger units left in the vault, owed to nobody. Negative for a correction that took value out of what was
   * counted there (a held ticket refunded after 24 h at an entry fee above its payout).
   */
  amount: number;
  reason: string;
  by: string;
  at: number;
}

/**
 * Floor loot an arena instance still held at a round end, burned from the arena vault by
 * `sweepLoot` (server-signed). Only the loot value the room computed is ever swept: never
 * live stakes or owed payouts. Idempotent by `key` = `sweep:<roomId>:<round>` here, and on chain by
 * `sweepId`: the contract refuses a sweep id that is not above the arena's `lastSweepId`, so a resend
 * can never burn twice.
 */
export interface SweepItem {
  kind: 'sweep';
  /** `sweep:<roomId>:<round>`. */
  key: string;
  arenaId: number;
  /** Arena instance whose floor held the loot. */
  roomId: string;
  /** Round number (`roundAt(...).n`) that ended. */
  round: number;
  /** Ledger units to burn from the arena vault (> 0). */
  amount: number;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  lastError?: string;
  /**
   * The on-chain sweep id, assigned (and persisted) before the first send and never changed: the
   * sweep landed exactly when the arena's `lastSweepId` reaches it.
   */
  sweepId?: number;
  /** The last transaction sent for this sweep and when (Unix ms). */
  sentTx?: string;
  sentAt?: number;
}

/** Everything the chain worker executes: ticket settlements and loot sweeps. */
export type JournalItem = SettlementItem | SweepItem;

/** Ledger units a journal item still owes out of its arena vault. */
export const itemAmount = (item: JournalItem): number => (item.kind === 'sweep' ? item.amount : (item.payout ?? 0));

/** `held.flags` of an item the chain worker's payout guard held (`EvmChain`). */
export const PAYOUT_GUARD_FLAG = 'payout_guard';

export const sweepKey = (roomId: string, round: number): string => `sweep:${roomId}:${round}`;

export interface LiveStake {
  roomId: string;
  session: string;
  sessionId: number;
  player: string;
  arenaId: number;
  value: number;
  /** The ticket's entry fee (ledger units); absent in older journals. */
  entryFee?: number;
  score: number;
  kills: number;
}

/** A loot piece lying on an arena instance's floor (value in ledger units). */
export interface LootRecord {
  /** The arena instance (room id) whose floor holds the piece. */
  roomId: string;
  arenaId: number;
  x: number;
  y: number;
  value: number;
}

/** Room id of an arena's first instance (where recovered loot is merged). */
export const firstArenaInstance = (arenaId: number): string => `arena-${arenaId}-1`;

interface JournalFile {
  version: 2;
  pending: JournalItem[];
  live: LiveStake[];
  loot: LootRecord[];
  /** Integrity: value forfeited from held settlements (absent in older files). */
  forfeits?: ForfeitRecord[];
  /**
   * Retired fields of journals written while house bots played arenas (`purses`, value bots held) and the
   * off-chain cut on winnings existed (`house`, the vault share). They are read and ignored: that value
   * stayed in the arena vault and is owed to nobody (`Journal.retiredValue` reports it once).
   */
  purses?: unknown;
  house?: unknown;
  /** Highest sweep id assigned per arena id (monotonic, never reused). */
  sweepSeq?: Record<string, number>;
  /** The arena contract the items belong to (lower-case 0x); null until bound. */
  contract?: string | null;
  updatedAt: number;
}

interface JournalFileV1 {
  version: 1;
  pending: SettlementItem[];
  live: LiveStake[];
  updatedAt: number;
}

/**
 * Crash-safe record of money the server owes. Every change is written with
 * write-to-temp + rename, so the file on disk is always a complete snapshot.
 *
 * Invariant: at any instant, Σ live values + Σ loot + Σ pending amounts (payouts and sweeps, per arena) + Σ
 * forfeits equals what the journal owes out of the arena vault, because value only leaves
 * `live` in the same write that adds the matching pending settlement, loot only leaves
 * the floor records in the same write that adds its sweep, and the room writes live
 * values and loot together.
 *
 * File format v2 adds `loot`; v1 files are migrated on load. (A `hasPass` field that older v2
 * files carry on live stakes is ignored: the Pass is gone.)
 * Loot is keyed by arena instance (room id), so instances of one arena never
 * overwrite each other's records; on restart an arena's first instance adopts
 * every instance's loot (`adoptLoot`). Records written before instances
 * existed (no `roomId`) belong to the first instance.
 */
export class Journal {
  private pendingItems: JournalItem[] = [];
  private liveByRoom = new Map<string, LiveStake[]>();
  private lootByRoom = new Map<string, LootRecord[]>();
  private forfeitList: ForfeitRecord[] = [];
  private sweepSeqV: Record<string, number> = {};
  private contractV: string | null = null;
  /** Arenas whose loot was already adopted in this process (restored once only). */
  private readonly adopted = new Set<number>();
  /** `load` quarantined an unreadable file in this process. */
  private quarantinedHere = false;

  constructor(
    private readonly path: string | null,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as JournalFile | JournalFileV1;
      const data = migrate(raw);
      // v1 free-play `record` items: v2 writes no on-chain records, so they are dropped
      // (any other unknown kind is kept and reaches the worker's loud "unknown kind" path)
      const settle = data.pending.filter((p) => (p as { kind: string }).kind !== 'record');
      const legacy = data.pending.length - settle.length;
      this.pendingItems = settle;
      if (legacy > 0) this.log(`journal: dropped ${legacy} legacy free-play record item(s) (v2 writes no on-chain records)`);
      for (const l of data.live) {
        const list = this.liveByRoom.get(l.roomId) ?? [];
        list.push(l);
        this.liveByRoom.set(l.roomId, list);
      }
      for (const l of data.loot) {
        const list = this.lootByRoom.get(l.roomId) ?? [];
        list.push(l);
        this.lootByRoom.set(l.roomId, list);
      }
      this.forfeitList = data.forfeits ?? [];
      const retired = retiredValue(data);
      if (retired > 0) this.log(`journal: ignored ${retired} ledger unit(s) of retired house-bot purses and team reserve (they stay in the arena vault, owed to nobody)`);
      this.sweepSeqV = { ...(data.sweepSeq ?? {}) };
      this.contractV = typeof data.contract === 'string' ? data.contract.toLowerCase() : null;
      if (legacy > 0) this.persist();
    } catch (err) {
      this.quarantinedHere = true;
      const backup = `${this.path}.corrupt-${Date.now()}`;
      this.log(`!!! journal at ${this.path} is unreadable (${(err as Error).message}); moved to ${backup}. Manual review required.`);
      try {
        renameSync(this.path, backup);
      } catch {
        /* ignore */
      }
    }
  }

  get pending(): readonly JournalItem[] {
    return this.pendingItems;
  }

  /** The pending ticket settlements (without loot sweeps). */
  settlements(): SettlementItem[] {
    return this.pendingItems.filter((p): p is SettlementItem => p.kind === 'settle');
  }

  live(): LiveStake[] {
    return [...this.liveByRoom.values()].flat();
  }

  /** Loot that was on any instance of an arena at the last write (empty when none). Non-destructive. */
  recoverLoot(arenaId: number): LootRecord[] {
    const out: LootRecord[] = [];
    for (const list of this.lootByRoom.values()) for (const l of list) if (l.arenaId === arenaId) out.push({ ...l });
    return out;
  }

  /**
   * Moves every loot record of `arenaId` (from all instances) under `roomId`
   * in one atomic write and returns them. The adopting room restores them, so
   * its later commits keep the whole amount. One-shot per arena and process:
   * a second call returns nothing, so the same loot is never restored twice.
   */
  adoptLoot(arenaId: number, roomId: string): LootRecord[] {
    if (this.adopted.has(arenaId)) return [];
    this.adopted.add(arenaId);
    const all = this.recoverLoot(arenaId).map((l) => ({ ...l, roomId }));
    let moved = false;
    for (const [rid, list] of [...this.lootByRoom]) {
      if (rid === roomId || !list.some((l) => l.arenaId === arenaId)) continue;
      moved = true;
      const rest = list.filter((l) => l.arenaId !== arenaId);
      if (rest.length > 0) this.lootByRoom.set(rid, rest);
      else this.lootByRoom.delete(rid);
    }
    const own = (this.lootByRoom.get(roomId) ?? []).filter((l) => l.arenaId !== arenaId);
    if (all.length > 0 || own.length > 0) this.lootByRoom.set(roomId, [...own, ...all]);
    else this.lootByRoom.delete(roomId);
    if (moved) this.persist();
    return all.map((l) => ({ ...l }));
  }

  /**
   * What the journal says arena `arenaId`'s vault owes: Σ pending payouts and loot sweeps + Σ loot
   * on its floors + Σ live ticket values (ledger units). The vault must hold at least this.
   */
  owedByArena(arenaId: number): number {
    let sum = this.liveAndLootByArena(arenaId);
    for (const p of this.pendingItems) if (p.arenaId === arenaId) sum += itemAmount(p);
    return sum;
  }

  /** Σ live ticket values + Σ floor loot of an arena (ledger units): `owedByArena` without the pending items. */
  liveAndLootByArena(arenaId: number): number {
    let sum = 0;
    for (const list of this.lootByRoom.values()) for (const l of list) if (l.arenaId === arenaId) sum += l.value;
    for (const list of this.liveByRoom.values()) for (const l of list) if (l.arenaId === arenaId) sum += l.value;
    return sum;
  }

  /**
   * A settlement of a live ticket at its last journaled value (crash recovery). The payout is the gross
   * value: the arena contract takes the fee on the profit when it settles.
   */
  private settleLive(l: LiveStake, now: number): void {
    this.pendingItems.push({
      kind: 'settle',
      key: l.session,
      player: l.player,
      arenaId: l.arenaId,
      session: l.session,
      sessionId: l.sessionId,
      payout: l.value,
      ...(l.entryFee !== undefined ? { entryFee: l.entryFee } : {}),
      score: l.score,
      kills: l.kills,
      xp: 0,
      reason: 'crash',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    });
  }

  /** Σ loot value over every arena. */
  lootTotal(): number {
    let sum = 0;
    for (const list of this.lootByRoom.values()) for (const l of list) sum += l.value;
    return sum;
  }

  /**
   * Converts every player that was alive when the server stopped into a
   * settlement at their last snapshot value ("auto cash-out on crash").
   * Returns the number of recovered players.
   */
  recoverLive(now = Date.now()): number {
    const live = this.live();
    for (const l of live) {
      if (this.pendingItems.some((p) => p.key === l.session)) continue;
      this.settleLive(l, now);
    }
    this.liveByRoom.clear();
    this.persist();
    return live.length;
  }

  /**
   * A room worker died (or hung and was stopped): what its rooms held is recovered from this
   * journal the way a process restart recovers everything (`recoverLive`), in one atomic write:
   * every live ticket of those rooms becomes a settlement at its last journaled value (reason
   * `crash`), and the floor loot of those rooms is queued to burn (a `sweep` item per room, as at a
   * bell), since the rooms are gone. A ticket already pending is never queued twice. `round`: the
   * round in play (it names the sweep). Returns what was queued.
   */
  recoverRooms(roomIds: readonly string[], round: number, now = Date.now()): { settled: number; swept: number } {
    const ids = new Set(roomIds);
    let settled = 0;
    let swept = 0;
    for (const id of ids) {
      for (const l of this.liveByRoom.get(id) ?? []) {
        if (this.pendingItems.some((p) => p.key === l.session)) continue;
        this.settleLive(l, now);
        settled++;
      }
      this.liveByRoom.delete(id);
      const loot = this.lootByRoom.get(id);
      if (loot && loot.length > 0) {
        const amount = loot.reduce((s, l) => s + l.value, 0);
        let key = `${sweepKey(id, round)}:lost`;
        for (let k = 2; this.pendingItems.some((p) => p.key === key); k++) key = `${sweepKey(id, round)}:lost:${k}`;
        this.pendingItems.push({ kind: 'sweep', key, arenaId: loot[0].arenaId, roomId: id, round, amount, attempts: 0, nextAttemptAt: now, createdAt: now });
        swept += amount;
      }
      this.lootByRoom.delete(id);
    }
    this.persist();
    return { settled, swept };
  }

  /**
   * Atomically enqueue settlements, replace a room's live snapshot and
   * replace an arena instance's loot records. An item whose key is already pending is dropped, with one
   * exception: a real settlement (any reason but `stale`) replaces a pending `stale` one (the sweeper's
   * entry-fee refund of a ticket that was seated meanwhile), never the other way round.
   */
  commit(opts: {
    enqueue?: JournalItem[];
    roomId?: string;
    live?: LiveStake[];
    loot?: { roomId: string; arenaId: number; items: { x: number; y: number; value: number }[] };
  }): void {
    if (opts.enqueue) {
      for (const item of opts.enqueue) {
        const i = this.pendingItems.findIndex((p) => p.key === item.key);
        if (i < 0) this.pendingItems.push(item);
        else if (replacesStale(this.pendingItems[i], item)) this.pendingItems[i] = item;
      }
    }
    if (opts.roomId !== undefined && opts.live) {
      if (opts.live.length > 0) this.liveByRoom.set(opts.roomId, opts.live);
      else this.liveByRoom.delete(opts.roomId);
    }
    if (opts.loot) {
      const { roomId, arenaId, items } = opts.loot;
      if (items.length > 0) this.lootByRoom.set(roomId, items.map((i) => ({ roomId, arenaId, x: i.x, y: i.y, value: i.value })));
      else this.lootByRoom.delete(roomId);
    }
    this.persist();
  }

  enqueue(item: JournalItem): void {
    this.commit({ enqueue: [item] });
  }

  /**
   * Assigns the next sweep id of the sweep's arena: above both the journal's own high-water mark and
   * `onchainLast` (the arena's `lastSweepId`). Persisted before anything is sent; an item keeps its id.
   */
  assignSweepId(key: string, onchainLast: number): number {
    const item = this.pendingItems.find((p) => p.key === key);
    if (!item || item.kind !== 'sweep') throw new Error(`no sweep item ${key}`);
    if (item.sweepId !== undefined) return item.sweepId;
    const id = Math.max(this.lastSweepId(item.arenaId), onchainLast) + 1;
    item.sweepId = id;
    this.sweepSeqV[String(item.arenaId)] = id;
    this.persist();
    return id;
  }

  /** Highest sweep id this journal assigned for an arena (0 when none). */
  lastSweepId(arenaId: number): number {
    return this.sweepSeqV[String(arenaId)] ?? 0;
  }

  /** Marks settlements as sent (right before their batch is broadcast; persisted first). */
  markSettleSent(keys: readonly string[], at = Date.now()): void {
    const want = new Set(keys);
    let changed = false;
    for (const p of this.pendingItems) {
      if (p.kind === 'settle' && want.has(p.key) && p.sentAt === undefined) {
        p.sentAt = at;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Records the transaction just sent for a sweep item. */
  markSent(key: string, txHash: string, at = Date.now()): void {
    const item = this.pendingItems.find((p) => p.key === key);
    if (!item || item.kind !== 'sweep') return;
    item.sentTx = txHash;
    item.sentAt = at;
    this.persist();
  }

  /** The arena contract (lower-case) this journal's money records belong to; null until bound. */
  get contract(): string | null {
    return this.contractV;
  }

  /** Nothing is owed: no pending items, no live stakes and no loot. */
  isIdle(): boolean {
    return this.pendingItems.length === 0 && this.liveByRoom.size === 0 && this.lootByRoom.size === 0;
  }

  /**
   * Binds the journal to an arena contract. Allowed when it is unbound, already bound to the same one,
   * or idle (nothing owed: the sweep ids restart with the new contract). False otherwise: the records
   * belong to another contract and must never be sent to this one.
   */
  bindContract(address: string): boolean {
    const a = address.toLowerCase();
    if (this.contractV === a) return true;
    if (this.contractV !== null && !this.isIdle()) return false;
    if (this.contractV !== null) this.sweepSeqV = {};
    this.contractV = a;
    this.persist();
    return true;
  }

  /**
   * Testnet escape hatch (`JOURNAL_ABANDON_CONTRACT`): when the journal is bound to `oldAddress` and still
   * holds records for it, copies the whole journal to `<path>.abandoned-<old>-<time>` and clears it, so it can
   * bind to a new arena. Returns how many records were set aside (0 when it is bound to anything else).
   * Nothing on chain changes: what the old contract owes stays collectable there (`refund` after 24 h).
   */
  abandonContract(oldAddress: string): number {
    const old = oldAddress.toLowerCase();
    if (this.contractV !== old || this.isIdle()) return 0;
    const n = this.pendingItems.length + this.live().length + [...this.lootByRoom.values()].flat().length;
    if (this.path) {
      const backup = `${this.path}.abandoned-${old}-${Date.now()}`;
      try {
        writeFileSync(backup, readFileSync(this.path, 'utf8'));
      } catch {
        /* nothing persisted yet */
      }
      this.log(`!!! journal: ${n} record(s) of arena ${old} set aside in ${backup} (JOURNAL_ABANDON_CONTRACT)`);
    }
    this.pendingItems = [];
    this.liveByRoom.clear();
    this.lootByRoom.clear();
    this.adopted.clear();
    this.persist();
    return n;
  }

  /* ---------------------------------------------------------------- */
  /* Integrity holds                                                  */
  /* ---------------------------------------------------------------- */

  /** Settlements held for an admin decision. */
  held(): SettlementItem[] {
    return this.pendingItems.filter((p): p is SettlementItem => p.kind === 'settle' && !!p.held);
  }

  forfeits(): readonly ForfeitRecord[] {
    return this.forfeitList;
  }

  /** Σ value forfeited from held settlements of an arena (stays in its vault, owed to nobody). */
  forfeitedByArena(arenaId: number): number {
    let sum = 0;
    for (const f of this.forfeitList) if (f.arenaId === arenaId) sum += f.amount;
    return sum;
  }

  private heldItem(key: string): SettlementItem {
    const item = this.pendingItems.find((p) => p.key === key);
    if (!item || item.kind !== 'settle' || !item.held) throw new Error('not_held');
    return item;
  }

  /**
   * Releases a held settlement: the worker pays it as it was (same payout, due now).
   * Nothing moves between buckets, so the books are unchanged.
   */
  release(key: string, now = Date.now()): SettlementItem {
    const item = this.heldItem(key);
    if (item.held?.flags.includes(PAYOUT_GUARD_FLAG)) item.guardCleared = true;
    delete item.held;
    item.nextAttemptAt = now;
    this.persist();
    return item;
  }

  /**
   * Holds a pending settlement for an admin decision (the chain worker's payout guard; the integrity auto-hold
   * holds in the room's own write instead). Nothing moves between buckets. False when there is no such item.
   */
  hold(key: string, held: NonNullable<SettlementItem['held']>): boolean {
    const item = this.pendingItems.find((p) => p.key === key);
    if (!item || item.kind !== 'settle' || item.held) return false;
    item.held = held;
    this.persist();
    return true;
  }

  /**
   * Settles a held settlement at 0: its payout moves to a forfeit record in the same atomic write,
   * and the worker settles the ticket on chain with payout 0 (the value stays in the vault).
   */
  settleZero(key: string, reason: string, by: string, now = Date.now()): { item: SettlementItem; forfeit: ForfeitRecord } {
    const item = this.heldItem(key);
    const forfeit: ForfeitRecord = { key, player: item.player, arenaId: item.arenaId ?? null, amount: item.payout ?? 0, reason, by, at: now };
    this.forfeitList.push(forfeit);
    item.payout = 0;
    delete item.held;
    item.nextAttemptAt = now;
    this.persist();
    return { item, forfeit };
  }

  /**
   * A held settlement whose ticket the player refunded on chain (24 h after the join, at the entry fee): the item
   * is dropped, and the difference between what it owed and what the refund took (payout − entry fee) is recorded
   * as a forfeit in the same write, so the books keep matching the vault (a winner's surplus stays there, owed to
   * nobody; a loser's refund took more than the ticket was worth). Returns the recorded amount (0: none).
   */
  dropRefunded(key: string, by: string, now = Date.now()): number {
    const item = this.pendingItems.find((p) => p.key === key);
    if (!item || item.kind !== 'settle') return 0;
    this.pendingItems = this.pendingItems.filter((p) => p !== item);
    const amount = item.entryFee === undefined ? 0 : (item.payout ?? 0) - item.entryFee;
    if (amount !== 0) {
      this.forfeitList.push({ key, player: item.player, arenaId: item.arenaId ?? null, amount, reason: 'held past 24 h: the player refunded the ticket at its entry fee', by, at: now });
    }
    this.persist();
    return amount;
  }

  /** Marks an item as done (settled on-chain or no longer applicable). */
  remove(key: string): void {
    const before = this.pendingItems.length;
    this.pendingItems = this.pendingItems.filter((p) => p.key !== key);
    if (this.pendingItems.length !== before) this.persist();
  }

  /**
   * Records a failed attempt with exponential backoff (max 5 minutes), or after
   * `opts.delayMs` when given.
   */
  retryLater(key: string, error: string, now = Date.now(), opts: { delayMs?: number; maxDelayMs?: number } = {}): void {
    const item = this.pendingItems.find((p) => p.key === key);
    if (!item) return;
    item.attempts++;
    item.lastError = error.slice(0, 300);
    // `maxDelayMs`: a transient RPC failure (rate limit, timeout) never waits the full 5 minutes
    item.nextAttemptAt = now + (opts.delayMs ?? Math.min(opts.maxDelayMs ?? 300_000, 300_000, 2000 * 2 ** Math.min(item.attempts, 8)));
    this.persist();
  }

  /**
   * Quarantined journal files next to this one (`<name>.corrupt-<ts>`, moved aside by
   * `load`). While any exists, what the server owed at that time is unknown.
   */
  quarantinedFiles(): string[] {
    if (!this.path) return this.quarantinedHere ? ['(in-memory)'] : [];
    const dir = dirname(this.path);
    const prefix = `${basename(this.path)}.corrupt-`;
    try {
      return readdirSync(dir).filter((f) => f.startsWith(prefix));
    } catch {
      return this.quarantinedHere ? [`${prefix}?`] : [];
    }
  }

  /** The last write failed (disk full, permissions): retried with every change and every second. */
  private persistFailing = false;
  private persistRetry: NodeJS.Timeout | null = null;
  private lastPersistWarn = 0;

  /**
   * Writes the whole journal. A failed write (disk full, ...) never throws into the room or chain code that
   * changed it: the in-memory journal stays the truth, the failure is logged loudly, and the write is retried
   * every second (and with every change) until it succeeds.
   */
  private persist(): void {
    if (!this.path) return;
    try {
      this.write();
      if (this.persistFailing) {
        this.log('journal: writes succeed again');
        this.persistFailing = false;
        this.notifyWriteState();
      }
    } catch (err) {
      const was = this.persistFailing;
      this.persistFailing = true;
      if (!was) this.notifyWriteState();
      const now = Date.now();
      if (now - this.lastPersistWarn > 30_000) {
        this.lastPersistWarn = now;
        this.log(`!!! journal: could not write ${this.path} (${(err as Error).message}) — money records are only in memory until it works again; free disk space now`);
      }
      this.persistRetry ??= setTimeout(() => {
        this.persistRetry = null;
        if (this.persistFailing) this.persist();
      }, 1_000);
      this.persistRetry.unref?.();
    }
  }

  /** The journal could not be written lately (the records are only in memory). */
  get writeFailing(): boolean {
    return this.persistFailing;
  }

  private readonly writeStateListeners: (() => void)[] = [];

  /** `fn()` runs when writes start failing and when they succeed again (`writeFailing` flips). */
  onWriteStateChange(fn: () => void): void {
    this.writeStateListeners.push(fn);
  }

  private notifyWriteState(): void {
    for (const fn of this.writeStateListeners) {
      try {
        fn();
      } catch {
        /* a listener never breaks the journal */
      }
    }
  }

  private write(): void {
    if (!this.path) return;
    const data: JournalFile = {
      version: 2,
      pending: this.pendingItems,
      live: this.live(),
      loot: [...this.lootByRoom.values()].flat(),
      ...(this.forfeitList.length > 0 ? { forfeits: this.forfeitList } : {}),
      ...(Object.keys(this.sweepSeqV).length > 0 ? { sweepSeq: this.sweepSeqV } : {}),
      ...(this.contractV ? { contract: this.contractV } : {}),
      updatedAt: Date.now(),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.path);
  }
}

/** Whether `next` (same key) supersedes the pending `prev`: a real result over the sweeper's stale refund. */
function replacesStale(prev: JournalItem, next: JournalItem): boolean {
  return prev.kind === 'settle' && prev.reason === 'stale' && next.kind === 'settle' && next.reason !== 'stale';
}

/** Validates a journal file and upgrades v1 (no loot) to v2. */
function migrate(data: JournalFile | JournalFileV1): JournalFile {
  if (!data || !Array.isArray(data.pending) || !Array.isArray(data.live)) throw new Error('bad journal shape');
  if (data.version === 1) {
    return {
      version: 2,
      pending: data.pending,
      live: data.live,
      loot: [],
      updatedAt: data.updatedAt,
    };
  }
  if (data.version !== 2 || !Array.isArray(data.loot)) throw new Error('bad journal shape');
  if (data.forfeits !== undefined) {
    if (!Array.isArray(data.forfeits)) throw new Error('bad journal shape');
    for (const f of data.forfeits) if (typeof f?.key !== 'string' || !Number.isSafeInteger(f.amount)) throw new Error('bad forfeit record');
  }
  for (const p of data.pending) {
    if ((p as { kind: string }).kind !== 'sweep') continue;
    const sw = p as SweepItem;
    if (typeof sw.key !== 'string' || !Number.isSafeInteger(sw.amount) || sw.amount <= 0) throw new Error('bad sweep item');
    if (!Number.isInteger(sw.arenaId) || sw.arenaId < 0 || typeof sw.roomId !== 'string' || !Number.isInteger(sw.round)) throw new Error('bad sweep item');
    if (sw.sweepId !== undefined && (!Number.isSafeInteger(sw.sweepId) || sw.sweepId <= 0)) throw new Error('bad sweep item');
  }
  if (data.sweepSeq !== undefined && (typeof data.sweepSeq !== 'object' || data.sweepSeq === null)) throw new Error('bad journal shape');
  for (const l of data.loot) {
    if (!Number.isSafeInteger(l.value) || l.value <= 0 || !Number.isFinite(l.x) || !Number.isFinite(l.y)) throw new Error('bad loot record');
    if (!Number.isInteger(l.arenaId) || l.arenaId < 0) throw new Error('bad loot record');
    // written before arena instances existed: the arena's single room is its first instance
    if (l.roomId === undefined) l.roomId = firstArenaInstance(l.arenaId);
    else if (typeof l.roomId !== 'string' || l.roomId.length === 0) throw new Error('bad loot record');
  }
  // retired fields of live stakes (the old Pass, the base of the off-chain cut): not carried on
  data.live = data.live.map((l) => {
    const { hasPass: _pass, start: _start, ...rest } = l as LiveStake & { hasPass?: unknown; start?: unknown };
    return rest;
  });
  return data;
}

/**
 * Value held by retired journal fields (house-bot `purses`, the off-chain cut's `house` reserve), ledger units.
 * Malformed entries count as 0: the fields are ignored either way.
 */
export function retiredValue(data: { purses?: unknown; house?: unknown }): number {
  let sum = 0;
  if (Array.isArray(data.purses)) for (const p of data.purses) if (Number.isSafeInteger(p?.value) && p.value > 0) sum += p.value;
  if (data.house && typeof data.house === 'object') for (const v of Object.values(data.house)) if (Number.isSafeInteger(v) && (v as number) > 0) sum += v as number;
  return sum;
}
