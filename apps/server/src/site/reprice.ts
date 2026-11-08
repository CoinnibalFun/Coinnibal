import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RoundWindow } from '@elymum/shared';
import type { ChainArena } from '../chain/types';
import type { Journal } from '../stake/journal';

/**
 * Where an arena is on its way to a re-price at the next bell:
 * - `waiting`: joins stay open until the round's last minute (when they close anyway);
 * - `closing`: the last minute; nobody new is seated, the round plays out to its bell;
 * - `draining`: after the bell: no new seat (`arena_repricing`), unseated tickets are cancelled at once (full entry
 *   fee back), until no ticket of the arena is open on chain or in the journal;
 * - `ready`: nothing is open: the owner signs `updateArena` now (the contract accepts it: no `ArenaBusy`). Once the
 *   chain shows a new entry fee (or the admin cancels) the arena opens again.
 */
export type RepricePhase = 'waiting' | 'closing' | 'draining' | 'ready';

export interface RepriceEntry {
  arenaId: number;
  phase: RepricePhase;
  /** Who asked, and when (Unix ms). */
  by: string;
  at: number;
  /** The entry fee (ledger units) when it was asked: a different one on chain means the owner signed. */
  entryFeeAtStart: number;
  /** The bell it waits for (Unix ms); null while waiting for the last minute. */
  bellAt: number | null;
  /** When it became ready to sign (Unix ms). */
  readyAt: number | null;
  /** What still keeps it open while draining (open tickets on chain, journal items, live coins). */
  open?: { onChain: number; journal: number; live: number };
}

export interface RepriceDeps {
  listArenas: (fresh?: boolean) => Promise<ChainArena[]>;
  journal: Journal;
  roundWindow: (now?: number) => RoundWindow;
  now: () => number;
  /** Live coins of an arena in the rooms. */
  liveStakes: (arenaId: number) => number;
  /** Runs the stale sweep now (the draining arena's unseated tickets are cancelled at once). */
  sweepNow: () => void;
  file: string | null;
  log: (m: string) => void;
}

/** How often a draining arena re-reads its open tickets on chain. */
const CHAIN_READ_MS = 5_000;
/** How often a draining arena asks the sweeper for its unseated tickets (a ticket bought meanwhile). */
const SWEEP_EVERY_MS = 15_000;

/**
 * The admin's "Re-price at next bell" (`/api/admin/reprice`): closes an arena's joins for the round's last minute,
 * waits for the bell and the drain, says "ready to sign", and opens again once the owner signed. The server never holds
 * the owner key: the signature stays in `/admin` (`updateArena`). Kept in `DATA_DIR/chains/<id>/reprice.json`, so a
 * restart keeps a draining arena closed.
 */
export class RepriceScheduler {
  private readonly entries = new Map<number, RepriceEntry>();
  private lastChainRead = -Infinity;
  private lastSweep = -Infinity;
  private ticking = false;

  constructor(private readonly d: RepriceDeps) {
    this.load();
  }

  /** Asks for a re-price of `arenaIds` at the next bell. */
  async schedule(arenaIds: number[], by: string): Promise<RepriceEntry[]> {
    const arenas = await this.d.listArenas(true);
    for (const id of arenaIds) {
      const a = arenas.find((x) => x.id === id);
      if (!a) throw new RepriceFail(`arena #${id} does not exist`);
      if (this.entries.has(id)) continue;
      this.entries.set(id, { arenaId: id, phase: 'waiting', by, at: this.d.now(), entryFeeAtStart: a.entryFee, bellAt: null, readyAt: null });
      this.d.log(`reprice: arena #${id} closes at the next bell for a re-price (asked by ${by})`);
    }
    this.save();
    await this.tick();
    return this.view();
  }

  /** Opens the arenas again without a re-price. */
  cancel(arenaIds: number[], by: string): RepriceEntry[] {
    for (const id of arenaIds) if (this.entries.delete(id)) this.d.log(`reprice: arena #${id} opened again without a re-price (by ${by})`);
    this.save();
    return this.view();
  }

  view(): RepriceEntry[] {
    return [...this.entries.values()].sort((a, b) => a.arenaId - b.arenaId).map((e) => ({ ...e }));
  }

  /** No new seat in this arena now (from its bell until it opens again). */
  closedForSeats(arenaId: number): boolean {
    const e = this.entries.get(arenaId);
    if (!e) return false;
    if (e.phase === 'draining' || e.phase === 'ready') return true;
    // the last minute is closed to joins anyway; the break after the bell must not reopen it
    return e.phase === 'closing' && e.bellAt !== null && this.d.now() >= e.bellAt;
  }

  /** Arenas whose unseated tickets the stale sweeper cancels at once. */
  closedArenas(): Set<number> {
    return new Set([...this.entries.values()].filter((e) => e.phase === 'draining' || e.phase === 'ready').map((e) => e.arenaId));
  }

  /** Moves every arena along (every 2 s). */
  async tick(): Promise<void> {
    if (this.ticking || this.entries.size === 0) return;
    this.ticking = true;
    try {
      const now = this.d.now();
      let changed = false;
      for (const e of this.entries.values()) {
        if (e.phase === 'waiting') {
          const r = this.d.roundWindow(now);
          if (now >= r.joinsCloseAt) {
            e.phase = 'closing';
            e.bellAt = r.endsAt;
            changed = true;
            this.d.log(`reprice: arena #${e.arenaId} takes no new seat now; its bell rings in ${Math.round((r.endsAt - now) / 1000)} s`);
          }
        }
        if (e.phase === 'closing' && e.bellAt !== null && now >= e.bellAt) {
          e.phase = 'draining';
          changed = true;
          this.lastSweep = -Infinity;
        }
      }
      const draining = [...this.entries.values()].filter((e) => e.phase === 'draining' || e.phase === 'ready');
      if (draining.length > 0) {
        if (now - this.lastSweep >= SWEEP_EVERY_MS && draining.some((e) => e.phase === 'draining')) {
          this.lastSweep = now;
          this.d.sweepNow();
        }
        if (now - this.lastChainRead >= CHAIN_READ_MS) {
          this.lastChainRead = now;
          const arenas = await this.d.listArenas(true).catch(() => null);
          for (const e of draining) {
            const a = arenas?.find((x) => x.id === e.arenaId);
            if (!a) continue;
            if (a.entryFee !== e.entryFeeAtStart) {
              // the owner signed the new entry fee: the arena opens again
              this.entries.delete(e.arenaId);
              changed = true;
              this.d.log(`reprice: arena #${e.arenaId} re-priced on chain (${e.entryFeeAtStart} → ${a.entryFee} ledger units) — open again`);
              continue;
            }
            const journal = this.d.journal.pending.filter((p) => p.arenaId === e.arenaId).length + this.d.journal.live().filter((l) => l.arenaId === e.arenaId).length;
            const live = this.d.liveStakes(e.arenaId);
            e.open = { onChain: a.openSessions, journal, live };
            const clear = a.openSessions === 0 && journal === 0 && live === 0;
            if (clear && e.phase === 'draining') {
              e.phase = 'ready';
              e.readyAt = now;
              changed = true;
              this.d.log(`reprice: arena #${e.arenaId} is READY TO SIGN — no ticket is open; sign updateArena in /admin → Game → Arena prices`);
            } else if (!clear && e.phase === 'ready') {
              // a ticket was bought meanwhile: drain it again
              e.phase = 'draining';
              e.readyAt = null;
              changed = true;
            }
          }
        }
      }
      if (changed) this.save();
    } finally {
      this.ticking = false;
    }
  }

  private load(): void {
    if (!this.d.file || !existsSync(this.d.file)) return;
    try {
      const j = JSON.parse(readFileSync(this.d.file, 'utf8')) as { entries?: RepriceEntry[] };
      for (const e of j.entries ?? []) if (Number.isInteger(e.arenaId) && ['waiting', 'closing', 'draining', 'ready'].includes(e.phase)) this.entries.set(e.arenaId, e);
    } catch (err) {
      this.d.log(`!!! reprice: ${this.d.file} is unreadable (${(err as Error).message}); no re-price is pending`);
    }
  }

  private save(): void {
    if (!this.d.file) return;
    try {
      mkdirSync(dirname(this.d.file), { recursive: true });
      writeFileSync(`${this.d.file}.tmp`, JSON.stringify({ v: 1, entries: this.view() }));
      renameSync(`${this.d.file}.tmp`, this.d.file);
    } catch (err) {
      this.d.log(`!!! reprice: could not write ${this.d.file} (${(err as Error).message})`);
    }
  }
}

export class RepriceFail extends Error {}
