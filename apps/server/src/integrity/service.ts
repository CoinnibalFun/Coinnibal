import { createHmac } from 'node:crypto';
import { getAddress } from 'viem';
import {
  INTEGRITY_SETTINGS_DEFAULT,
  isFingerprint,
  type IntegrityBan,
  type IntegrityFlag,
  type IntegrityFlagKind,
  type IntegrityFlagStatus,
  type IntegrityHeld,
  type IntegrityOverview,
  type IntegritySettings,
  type IntegrityTransfer,
  type IntegrityWalletView,
} from '@elymum/shared';
import type { Player } from '../game/entities';
import { csv } from '../site/store';
import type { Journal, SettlementItem } from '../stake/journal';
import { runDetectors, scopeSnapshot, walletRisk, type Candidate } from './detectors';
import { applySettingsPatch } from './settings';
import type { IntegrityState, IntegrityStore } from './store';
import { IntegrityMonitor, type MonitorRoom } from './telemetry';
import type { IntegritySnapshot, SessionSummary } from './types';

const DAY = 86_400_000;
/** A flag that was reviewed or dismissed opens again when its score rises by this much. */
const REOPEN_RISE = 20;
const MAX_FLAGS = 5000;

export interface IntegrityOptions {
  store: IntegrityStore;
  journal: Journal;
  /** Wakes the settlement worker after a release or a settle at 0. */
  kick: () => void;
  /** Arenas the chain worker's books guard stopped (`EvmChain.booksGuard`); absent: none. */
  books?: () => ReadonlyMap<number, string>;
  log?: (m: string) => void;
  /** Wall clock (Unix ms). */
  now?: () => number;
  /** Monotonic clock of the input statistics (ms). */
  mono?: () => number;
  /** Detection window and memory caps. */
  windowDays?: number;
  maxSessions?: number;
  maxTransfers?: number;
}

export interface FlagFilter {
  status?: string | null;
  kind?: string | null;
  minScore?: number | null;
  q?: string | null;
}

export class IntegrityError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'not_found' | 'bad_request' | 'wrong_state',
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

const isWallet = (w: unknown): w is string => typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w);

/**
 * Cheat and collusion detection: owns the telemetry window, the detectors' flags, the bans and the
 * auto-hold decision. The rooms feed `monitor` and call `join` / `settle`; the admin API calls the rest.
 */
export class IntegrityService {
  readonly monitor: IntegrityMonitor;
  private state: IntegrityState;
  private readonly flags = new Map<string, IntegrityFlag>();
  private readonly bans = new Map<string, IntegrityBan>();
  /** Finished tickets in the window, oldest first (Map keeps insertion order). */
  private readonly sessions = new Map<string, SessionSummary>();
  private transfers: IntegrityTransfer[] = [];
  private unsaved: { sessions: SessionSummary[]; transfers: IntegrityTransfer[] } = { sessions: [], transfers: [] };
  private stateDirty = false;
  private timers: NodeJS.Timeout[] = [];
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxSessions: number;
  private readonly maxTransfers: number;

  constructor(private readonly opts: IntegrityOptions) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.windowMs = (opts.windowDays ?? 7) * DAY;
    this.maxSessions = opts.maxSessions ?? 20_000;
    this.maxTransfers = opts.maxTransfers ?? 60_000;
    this.state = opts.store.loadState();
    for (const f of this.state.flags) this.flags.set(f.id, f);
    for (const b of this.state.bans) this.bans.set(b.wallet, b);
    const recent = opts.store.loadRecent(this.now() - this.windowMs, this.maxSessions, this.maxTransfers);
    for (const s of recent.sessions) this.sessions.set(s.key, s);
    this.transfers = recent.transfers;
    this.monitor = new IntegrityMonitor({
      mono: opts.mono,
      onSession: (s) => this.addSession(s),
      onTransfer: (t) => this.addTransfer(t),
    });
  }

  /* ---------------------------------------------------------------- */
  /* Telemetry window                                                 */
  /* ---------------------------------------------------------------- */

  private addSession(s: SessionSummary): void {
    this.sessions.delete(s.key);
    this.sessions.set(s.key, s);
    this.unsaved.sessions.push(s);
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value!);
  }

  private addTransfer(t: IntegrityTransfer): void {
    this.transfers.push(t);
    this.unsaved.transfers.push(t);
    if (this.transfers.length > this.maxTransfers + 1000) this.transfers.splice(0, this.transfers.length - this.maxTransfers);
  }

  /** Drops what is older than the window. */
  private trim(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [k, s] of this.sessions) {
      if ((s.endedAt ?? Infinity) >= cutoff) break;
      this.sessions.delete(k);
    }
    let i = 0;
    while (i < this.transfers.length && this.transfers[i].at < cutoff) i++;
    if (i > 0) this.transfers.splice(0, i);
  }

  /** Every ticket (finished in the window and still in play) and transfer, for the detectors. */
  snapshot(): IntegritySnapshot {
    return { now: this.now(), sessions: [...this.sessions.values(), ...this.monitor.live(), ...this.remoteLive()], transfers: this.transfers };
  }

  /** Tickets in play in room workers (their monitors report them; empty in single-thread mode). */
  private remoteLive: () => SessionSummary[] = () => [];

  /** Room workers run the telemetry: the main thread receives what their monitors finish. */
  setRemoteLive(provider: () => SessionSummary[]): void {
    this.remoteLive = provider;
  }

  /** A ticket summary finished by a room worker's monitor (`onSession` there). */
  ingestSession(s: SessionSummary): void {
    this.addSession(s);
  }

  /** A staker-to-staker transfer seen by a room worker's monitor. */
  ingestTransfer(t: IntegrityTransfer): void {
    this.addTransfer(t);
  }

  /** Writes the unsaved summaries as one log chunk and the state when it changed. */
  flush(): void {
    const chunk = this.unsaved;
    this.unsaved = { sessions: [], transfers: [] };
    try {
      this.opts.store.appendLog(chunk);
    } catch (err) {
      this.log(`integrity: log write failed (${(err as Error).message}); ${chunk.sessions.length} ticket summaries kept in memory only`);
    }
    if (this.stateDirty) this.saveState();
  }

  private saveState(): void {
    this.state.flags = [...this.flags.values()];
    this.state.bans = [...this.bans.values()];
    try {
      this.opts.store.saveState(this.state);
      this.stateDirty = false;
    } catch (err) {
      this.log(`!!! integrity: state write failed (${(err as Error).message})`);
    }
  }

  start(scanMs = 60_000, flushMs = 30_000): void {
    this.stop();
    const flush = setInterval(() => this.flush(), flushMs);
    const scan = setInterval(() => {
      try {
        this.trim();
        this.scan();
      } catch (err) {
        this.log(`integrity: scan failed (${(err as Error).stack ?? err})`);
      }
    }, scanMs);
    flush.unref();
    scan.unref();
    this.timers = [flush, scan];
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  close(): void {
    this.stop();
    this.flush();
  }

  /* ---------------------------------------------------------------- */
  /* Rooms                                                            */
  /* ---------------------------------------------------------------- */

  hashIp(ip: string): string {
    return createHmac('sha256', this.opts.store.secret).update(`ip:${ip}`).digest('hex').slice(0, 20);
  }

  /** The browser fingerprint is untrusted: re-hashed with the server secret, null when malformed. */
  hashFp(fp: unknown): string | null {
    return isFingerprint(fp) ? createHmac('sha256', this.opts.store.secret).update(`fp:${fp}`).digest('hex').slice(0, 20) : null;
  }

  /** A staker joined an arena instance. */
  join(
    room: MonitorRoom,
    pid: number,
    conn: { ip: string; fp: string | null },
    t: { player: string; session: string; sessionId: number; arenaId: number; entryFee: number; value?: number },
  ): void {
    this.monitor.onJoin(room, pid, {
      wallet: t.player,
      session: t.session,
      sessionId: t.sessionId,
      arenaId: t.arenaId,
      // the stake the ticket plays with (a fee-on-entry arena plays entry − fee): a payout above it is a profit
      entryFee: t.value ?? t.entryFee,
      ipHash: this.hashIp(conn.ip),
      fpHash: this.hashFp(conn.fp),
    });
  }

  /**
   * A ticket ended. Finishes its telemetry and, with auto-hold on, holds a profitable payout whose
   * wallet's risk score is at or above `holdScore` (`item.held`, written by the caller in the same
   * journal write that queues the settlement). Never throws: integrity must not break a settlement.
   */
  settle(room: MonitorRoom, pid: number, item: SettlementItem | null, end: { reason: string; payout: number; killer: Player | null; killerIsBot: boolean }): void {
    try {
      const s = this.monitor.onEnd(room, pid, end);
      if (!s || !item) return;
      this.holdDecision(item, s.entryFee);
    } catch (err) {
      this.log(`integrity: settle hook failed (${(err as Error).stack ?? err})`);
    }
  }

  /**
   * The auto-hold part of `settle`, for a ticket whose telemetry is finished (`entryFee`: the stake it
   * played with). A room worker finishes the telemetry there; the main thread decides here, before the
   * settlement is written, so the hold lands in the same journal write. Never throws.
   */
  holdDecision(item: SettlementItem, entryFee: number): void {
    try {
      const st = this.state.settings;
      const payout = item.payout ?? 0;
      if (!st.autoHold || payout <= entryFee || !(item.reason === 'round' || item.reason === 'kicked' || item.reason === 'maxage')) return;
      const risk = this.evaluate(item.player);
      if (risk.score < st.holdScore) return;
      const top = risk.flags.map((id) => this.flags.get(id)).filter((f): f is IntegrityFlag => !!f && f.status !== 'dismissed');
      const why = top.length > 0 ? top.sort((a, b) => b.score - a.score)[0].summary : 'risk score above the hold threshold';
      item.held = { at: this.now(), score: risk.score, why, flags: top.map((f) => f.id) };
      this.log(`integrity: HELD settlement ${item.key} of ${item.player} (payout ${payout}, risk ${risk.score}) for admin review`);
    } catch (err) {
      this.log(`integrity: settle hook failed (${(err as Error).stack ?? err})`);
    }
  }

  isBanned(wallet: string | null | undefined): boolean {
    return !!wallet && this.bans.has(wallet);
  }

  /* ---------------------------------------------------------------- */
  /* Detection                                                        */
  /* ---------------------------------------------------------------- */

  get settings(): IntegritySettings {
    return structuredClone(this.state.settings);
  }

  /** Runs every detector over the whole window and merges the results into the flags. */
  scan(): IntegrityFlag[] {
    const cands = runDetectors(this.snapshot(), this.state.settings.thresholds);
    this.state.scannedAt = this.now();
    this.stateDirty = true;
    return this.merge(cands);
  }

  /**
   * Risk of one wallet now: the detectors over the part of the window that concerns it (cheap enough
   * for a bell with many settlements). Dismissed flags do not count.
   */
  evaluate(wallet: string): { score: number; flags: string[] } {
    const cands = runDetectors(scopeSnapshot(this.snapshot(), wallet), this.state.settings.thresholds);
    this.merge(cands);
    const live = cands.filter((c) => this.flags.get(c.id)?.status !== 'dismissed');
    return walletRisk(wallet, live);
  }

  /** Current risk of a wallet from the stored flags (open or reviewed). */
  riskOf(wallet: string): number {
    let r = 0;
    for (const f of this.flags.values()) {
      if (f.status === 'dismissed') continue;
      const hit = f.beneficiary ? f.beneficiary === wallet : f.wallets.includes(wallet);
      if (hit && f.score > r) r = f.score;
    }
    return r;
  }

  private merge(cands: Candidate[]): IntegrityFlag[] {
    const now = this.now();
    const changed: IntegrityFlag[] = [];
    for (const c of cands) {
      const f = this.flags.get(c.id);
      if (!f) {
        const nf: IntegrityFlag = { ...c, status: 'open', firstSeen: now, lastSeen: now, statusBy: null, statusAt: null, note: '', scoreAtStatus: null };
        this.flags.set(c.id, nf);
        changed.push(nf);
        this.log(`integrity: new ${c.kind} flag ${c.id} (score ${c.score}): ${c.summary}`);
        continue;
      }
      const same = f.score === c.score && JSON.stringify(f.evidence) === JSON.stringify(c.evidence);
      Object.assign(f, { score: c.score, wallets: c.wallets, beneficiary: c.beneficiary, arenaId: c.arenaId, summary: c.summary, evidence: c.evidence, lastSeen: now });
      if (f.status !== 'open' && f.scoreAtStatus !== null && c.score >= f.scoreAtStatus + REOPEN_RISE) {
        f.status = 'open';
        f.note = `${f.note ? `${f.note}\n` : ''}Re-opened: score rose from ${f.scoreAtStatus} to ${c.score}.`.slice(-2000);
      }
      if (!same) changed.push(f);
    }
    if (this.flags.size > MAX_FLAGS) {
      const old = [...this.flags.values()].filter((f) => f.status !== 'open').sort((a, b) => a.lastSeen - b.lastSeen);
      for (const f of old.slice(0, this.flags.size - MAX_FLAGS)) this.flags.delete(f.id);
    }
    if (changed.length > 0) this.stateDirty = true;
    return changed;
  }

  /* ---------------------------------------------------------------- */
  /* Admin                                                            */
  /* ---------------------------------------------------------------- */

  updateSettings(body: Record<string, unknown>, by: string): IntegritySettings {
    const before = this.state.settings;
    this.state.settings = applySettingsPatch(before, body);
    if (before.autoHold !== this.state.settings.autoHold) this.log(`integrity: auto-hold turned ${this.state.settings.autoHold ? 'ON' : 'off'} by ${by}`);
    this.saveState();
    return this.settings;
  }

  listFlags(filter: FlagFilter = {}): IntegrityFlag[] {
    const q = filter.q?.trim().toLowerCase() ?? '';
    const min = Number.isFinite(filter.minScore) ? Number(filter.minScore) : 0;
    return [...this.flags.values()]
      .filter((f) => (!filter.status || f.status === filter.status) && (!filter.kind || f.kind === filter.kind) && f.score >= min)
      .filter((f) => !q || f.id.toLowerCase().includes(q) || f.wallets.some((w) => w.toLowerCase().includes(q)) || f.summary.toLowerCase().includes(q) || f.note.toLowerCase().includes(q))
      .sort((a, b) => b.score - a.score || b.lastSeen - a.lastSeen);
  }

  getFlag(id: string): IntegrityFlag {
    const f = this.flags.get(id);
    if (!f) throw new IntegrityError(404, 'not_found', 'No such flag.');
    return f;
  }

  setFlagStatus(id: string, status: unknown, note: unknown, by: string): IntegrityFlag {
    const f = this.getFlag(id);
    if (status !== 'open' && status !== 'reviewed' && status !== 'dismissed') throw new IntegrityError(400, 'bad_request', 'status must be open, reviewed or dismissed', 'status');
    if (note !== undefined && (typeof note !== 'string' || note.length > 1000)) throw new IntegrityError(400, 'bad_request', 'note must be text of at most 1000 characters', 'note');
    f.status = status as IntegrityFlagStatus;
    f.statusBy = by;
    f.statusAt = this.now();
    f.scoreAtStatus = status === 'open' ? null : f.score;
    if (typeof note === 'string') f.note = note;
    this.saveState();
    return f;
  }

  ban(raw: unknown, reason: unknown, by: string): IntegrityBan {
    if (!isWallet(raw)) throw new IntegrityError(400, 'bad_request', 'Not an EVM wallet address.', 'wallet');
    const wallet = getAddress(raw);
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 500) throw new IntegrityError(400, 'bad_request', 'Give a reason (at most 500 characters).', 'reason');
    const b: IntegrityBan = { wallet, at: this.now(), by, reason: reason.trim() };
    this.bans.set(wallet, b);
    this.saveState();
    this.log(`integrity: wallet ${wallet} BANNED from arenas by ${by}: ${b.reason}`);
    return b;
  }

  unban(raw: string, by: string): void {
    const wallet = isWallet(raw) ? getAddress(raw) : raw;
    if (!this.bans.delete(wallet)) throw new IntegrityError(404, 'not_found', 'This wallet is not banned.');
    this.saveState();
    this.log(`integrity: wallet ${wallet} unbanned by ${by}`);
  }

  heldList(): IntegrityHeld[] {
    return this.opts.journal.held().map((i) => ({
      key: i.key,
      player: i.player,
      arenaId: i.arenaId ?? null,
      payout: i.payout ?? 0,
      reason: i.reason ?? null,
      createdAt: i.createdAt,
      heldAt: i.held!.at,
      score: i.held!.score,
      why: i.held!.why,
      flags: i.held!.flags,
    }));
  }

  /** Pays a held settlement as it was. */
  release(key: string, by: string): void {
    try {
      this.opts.journal.release(key, this.now());
    } catch {
      throw new IntegrityError(404, 'not_found', 'No held settlement with that key.');
    }
    this.log(`integrity: held settlement ${key} RELEASED by ${by}`);
    this.opts.kick();
  }

  /**
   * Holds a pending (not yet sent) settlement for review by hand, e.g. the item behind a books-guard stop. It is
   * then released or settled at 0 like any held item.
   */
  hold(key: string, reason: unknown, by: string): void {
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) throw new IntegrityError(400, 'bad_request', 'Give a reason (3 to 500 characters).', 'reason');
    const ok = this.opts.journal.hold(key, { at: this.now(), score: 0, why: `held by ${by}: ${reason.trim()}`, flags: ['admin_hold'] });
    if (!ok) throw new IntegrityError(404, 'not_found', 'No pending settlement with that key (or it is held already).');
    this.log(`integrity: settlement ${key} HELD by ${by}: ${reason.trim()}`);
  }

  /** Pending settlements (not held), newest first: what the admin may hold by hand. */
  pendingList(): IntegrityHeld[] {
    return this.opts.journal
      .settlements()
      .filter((i) => !i.held)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 500)
      .map((i) => ({ key: i.key, player: i.player, arenaId: i.arenaId ?? null, payout: i.payout ?? 0, reason: i.reason ?? null, createdAt: i.createdAt, heldAt: 0, score: 0, why: i.lastError ?? '', flags: [] }));
  }

  /** Settles a held settlement at 0 (the value stays in the arena vault as a journaled forfeit). */
  settleZero(key: string, reason: unknown, by: string): number {
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) throw new IntegrityError(400, 'bad_request', 'Give a reason (3 to 500 characters).', 'reason');
    let amount: number;
    try {
      amount = this.opts.journal.settleZero(key, reason.trim(), by, this.now()).forfeit.amount;
    } catch {
      throw new IntegrityError(404, 'not_found', 'No held settlement with that key.');
    }
    this.log(`integrity: held settlement ${key} SETTLED AT 0 by ${by} (${amount} forfeited, stays in the vault): ${reason.trim()}`);
    this.opts.kick();
    return amount;
  }

  overview(): IntegrityOverview {
    const counts = { open: 0, reviewed: 0, dismissed: 0, held: 0, bans: this.bans.size, sessions: this.sessions.size, transfers: this.transfers.length };
    for (const f of this.flags.values()) counts[f.status]++;
    const held = this.heldList();
    counts.held = held.length;
    return {
      settings: this.settings,
      defaults: structuredClone(INTEGRITY_SETTINGS_DEFAULT),
      counts,
      held,
      bans: [...this.bans.values()].sort((a, b) => b.at - a.at),
      scannedAt: this.state.scannedAt,
      books: [...(this.opts.books?.() ?? new Map<number, string>())].map(([arenaId, why]) => ({ arenaId, why })),
    };
  }

  /** Tickets, flags and value transfers of one wallet (optionally only those with `other`). */
  walletView(rawWallet: string, rawOther?: string | null): IntegrityWalletView {
    if (!isWallet(rawWallet)) throw new IntegrityError(400, 'bad_request', 'Not an EVM wallet address.', 'wallet');
    if (rawOther && !isWallet(rawOther)) throw new IntegrityError(400, 'bad_request', 'Not an EVM wallet address.', 'other');
    const wallet = getAddress(rawWallet);
    const other = rawOther ? getAddress(rawOther) : null;
    const snap = this.snapshot();
    const sessions = snap.sessions
      .filter((s) => s.wallet === wallet)
      .sort((a, b) => b.joinedAt - a.joinedAt)
      .slice(0, 200)
      .map((s) => ({ key: s.key, arenaId: s.arenaId, roomId: s.roomId, round: s.round, joinedAt: s.joinedAt, endedAt: s.endedAt, entryFee: s.entryFee, payout: s.payout, endReason: s.endReason, afkMs: s.afkMs }));
    const transfers = snap.transfers
      .filter((t) => (t.from === wallet || t.to === wallet) && (!other || t.from === other || t.to === other))
      .slice(-500);
    const flags = [...this.flags.values()].filter((f) => f.wallets.includes(wallet)).sort((a, b) => b.score - a.score);
    return { wallet, ban: this.bans.get(wallet) ?? null, risk: this.riskOf(wallet), flags, sessions, transfers };
  }

  flagsCsv(filter: FlagFilter): string {
    const rows: unknown[][] = [['id', 'kind', 'status', 'score', 'beneficiary', 'wallets', 'arena', 'summary', 'first_seen', 'last_seen', 'status_by', 'note', 'evidence']];
    for (const f of this.listFlags(filter)) {
      rows.push([
        f.id,
        f.kind,
        f.status,
        f.score,
        f.beneficiary ?? '',
        f.wallets.join(' '),
        f.arenaId ?? '',
        f.summary,
        new Date(f.firstSeen).toISOString(),
        new Date(f.lastSeen).toISOString(),
        f.statusBy ?? '',
        f.note,
        JSON.stringify(f.evidence),
      ]);
    }
    return csv(rows);
  }

  /** Kinds, for validating a filter. */
  static readonly kinds: readonly IntegrityFlagKind[] = ['pair_transfer', 'eject_feed', 'suicide_feed', 'shared_device', 'bot_input', 'bell_abuse'];
}
