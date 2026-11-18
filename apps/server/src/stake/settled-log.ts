import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** One confirmed money movement the server signed: a ticket settled or cancelled, or a loot burn. */
export interface SettledRecord {
  kind: 'settle' | 'cancel' | 'sweep';
  /**
   * The arena contract that moved the money (lower case). Session ids restart at 1 on every new arena contract, so
   * a record only ever describes a session of this contract; records written before this field existed have none
   * and match no contract (`SettledLog.get`).
   */
  contract?: string;
  /** The journal key (`<arenaId>:<player>:<sessionId>`, or `sweep:<room>:<round>`). */
  key: string;
  arenaId: number;
  /** Wallet (settle / cancel). */
  player?: string;
  sessionId?: number;
  /** Ledger units that left the vault (the gross payout, the cancelled entry fee, the burned loot). */
  amount: number;
  /** What reached the player (settle / cancel), ledger units. */
  net?: number;
  /** Fee on profit (burned + fee wallet), ledger units. */
  fee?: number;
  /** The journal reason (`round`, `death`, `crash`, `stale`, ...). */
  reason?: string;
  sweepId?: number;
  tx: string;
  /** Unix ms. */
  at: number;
}

/** How long a record is kept (reorg protection and appeals need days, not months). */
export const SETTLED_KEEP_MS = 14 * 24 * 3600_000;
/** Records kept in memory at most (oldest dropped first). */
const MAX_RECORDS = 200_000;

/**
 * Append-only record of every settlement, cancel and loot burn the server confirmed on chain
 * (`DATA_DIR/chains/<id>/settled.jsonl`, one JSON object per line).
 *
 * - **Reorg protection.** The journal forgets an item once its receipt is in. If a reorg dropped that
 *   transaction the session is open again on chain; the stale sweeper would then refund it at the entry fee
 *   (a winner would lose the winnings, a loser would get the stake back from the winners' share). With this
 *   record the sweeper re-sends the original settlement instead (`EvmChain.sweepStale`). A record is scoped to the
 *   arena contract that wrote it (a new arena restarts session ids at 1, so the same key names another ticket
 *   there), and the sweeper re-sends only while the original transaction has no successful receipt.
 * - **Audit and appeals.** What every ticket was paid, why, and in which transaction, for 14 days.
 *
 * Appends are cheap (one line); the file is compacted when it is loaded and holds far more lines than records.
 */
export class SettledLog {
  private readonly byKey = new Map<string, SettledRecord>();

  constructor(
    private readonly path: string | null,
    private readonly log: (m: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    let lines: string[];
    try {
      lines = readFileSync(this.path, 'utf8').split('\n');
    } catch (err) {
      this.log(`!!! settled log ${this.path} is unreadable (${(err as Error).message}): reorg protection starts empty`);
      return;
    }
    const cutoff = this.now() - SETTLED_KEEP_MS;
    let bad = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as SettledRecord;
        if (typeof r?.key !== 'string' || !Number.isSafeInteger(r.amount) || typeof r.at !== 'number') throw new Error('shape');
        if (r.at >= cutoff) this.keep(r);
      } catch {
        bad++;
      }
    }
    if (bad > 0) this.log(`settled log: ignored ${bad} malformed line(s) of ${this.path}`);
    const used = lines.filter((l) => l.trim()).length;
    if (used > this.byKey.size * 2 + 1_000) this.compact();
  }

  private keep(r: SettledRecord): void {
    this.byKey.delete(r.key);
    this.byKey.set(r.key, r);
    if (this.byKey.size > MAX_RECORDS) this.byKey.delete(this.byKey.keys().next().value!);
  }

  private compact(): void {
    if (!this.path) return;
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, [...this.byKey.values()].map((r) => JSON.stringify(r)).join('\n') + '\n');
      renameSync(tmp, this.path);
    } catch (err) {
      this.log(`settled log: compaction failed (${(err as Error).message})`);
    }
  }

  record(r: SettledRecord): void {
    this.keep(r);
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(r) + '\n');
    } catch (err) {
      // the money already moved on chain: losing the record only weakens reorg protection, never a payout
      this.log(`!!! settled log: could not append to ${this.path} (${(err as Error).message})`);
    }
  }

  /**
   * The record of `key` written for the arena contract `contract`, within the last `SETTLED_KEEP_MS`. A record of
   * another contract (an earlier arena on the same chain, whose session ids are reused by the new one) or one
   * without a contract (written before records named it) never matches.
   */
  get(key: string, contract: string): SettledRecord | undefined {
    const r = this.byKey.get(key);
    if (!r || !r.contract || r.contract !== contract.toLowerCase()) return undefined;
    // a long-running process keeps records in memory past the window the file keeps
    if (r.at < this.now() - SETTLED_KEEP_MS) return undefined;
    return r;
  }

  /** The newest records first (at most `limit`), optionally of one wallet. */
  recent(limit = 100, player?: string): SettledRecord[] {
    const out: SettledRecord[] = [];
    const who = player?.toLowerCase();
    const all = [...this.byKey.values()];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      if (who && all[i].player?.toLowerCase() !== who) continue;
      out.push(all[i]);
    }
    return out;
  }

  get size(): number {
    return this.byKey.size;
  }
}
