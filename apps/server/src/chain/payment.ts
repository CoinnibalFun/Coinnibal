import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CUSTOM_REQUEST_RE } from '@elymum/shared';

export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** What a used payment opened: when, for whom, which room, and (rooms paid in tokens) its request and the amount. */
export interface UsedPayment {
  at: number;
  /** EIP-55 wallet that paid and opened the room. */
  wallet: string;
  /** The room's invite code. */
  code: string;
  /** The room request the payment's ref named (`customRoomPaymentRef`); absent for the ETH payments of before 2026-11-18. */
  request?: string;
  /** Raw base units of the game token paid (decimal string); absent for the ETH payments of before 2026-11-18. */
  paid?: string;
}

interface UsedFile {
  v: 1;
  /** Lower-case hash → what it opened. */
  used: Record<string, UsedPayment>;
}

/** The key of a wallet's room request (`wallet:request`, lower case). */
const requestKey = (wallet: string, request: string) => `${wallet.toLowerCase()}:${request}`;

/**
 * Custom-room payments that already opened a room, persisted per chain (`DATA_DIR/chains/<id>/room-payments.json`,
 * atomic write) so a restart can never let one payment open two rooms: a transaction hash opens one room, and so does
 * a wallet's room request (the ref of its `ElymumArena.pay`; another wallet paying with the same ref changes nothing for
 * this one). Also holds hashes being checked right now (`claim`), so two requests with the same hash cannot both pass.
 * The file of the rooms paid in ETH (before 2026-11-18) loads as it is: those hashes stay used.
 */
export class UsedPayments {
  private readonly used = new Map<string, UsedPayment>();
  private readonly requests = new Map<string, string>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly file: string | null,
    private readonly log: (m: string) => void = () => {},
  ) {
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as UsedFile;
      for (const [h, e] of Object.entries(raw.used ?? {})) {
        if (!TX_HASH_RE.test(h)) continue;
        this.used.set(h.toLowerCase(), e);
        if (typeof e?.request === 'string' && typeof e.wallet === 'string') this.requests.set(requestKey(e.wallet, e.request), h.toLowerCase());
      }
      if (this.used.size > 0) this.log(`room payments: ${this.used.size} used payment(s) loaded`);
    } catch (err) {
      // never start over silently: a lost file would let old payments open rooms again
      throw new Error(`room payments: ${file} is unreadable (${(err as Error).message}); fix or remove it by hand`);
    }
  }

  get size(): number {
    return this.used.size;
  }

  /** The hash already opened a room. */
  has(hash: string): boolean {
    return this.used.has(hash.toLowerCase());
  }

  /** What the hash opened (null: unused). */
  get(hash: string): UsedPayment | null {
    return this.used.get(hash.toLowerCase()) ?? null;
  }

  /** The wallet's room request already opened a room (with any transaction). */
  hasRequest(wallet: string, request: string): boolean {
    return this.requests.has(requestKey(wallet, request));
  }

  /** Reserves a hash while it is being checked; false when it is used or already being checked. */
  claim(hash: string): boolean {
    const h = hash.toLowerCase();
    if (this.used.has(h) || this.inFlight.has(h)) return false;
    this.inFlight.add(h);
    return true;
  }

  release(hash: string): void {
    this.inFlight.delete(hash.toLowerCase());
  }

  /**
   * Marks a hash (and its wallet's request) used for good, written before the room opens. On a failed write nothing is
   * marked (a retry after the disk is fixed still opens one room) and the error is thrown.
   */
  markUsed(hash: string, e: UsedPayment): void {
    if (e.request !== undefined && !CUSTOM_REQUEST_RE.test(e.request)) throw new TypeError(`bad room request ${e.request}`);
    const h = hash.toLowerCase();
    this.used.set(h, e);
    if (e.request) this.requests.set(requestKey(e.wallet, e.request), h);
    try {
      this.save();
    } catch (err) {
      this.used.delete(h);
      if (e.request) this.requests.delete(requestKey(e.wallet, e.request));
      throw err;
    }
    this.inFlight.delete(h);
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const body: UsedFile = { v: 1, used: Object.fromEntries(this.used) };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, this.file);
  }
}
