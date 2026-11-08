import type { GasRunway } from '@elymum/shared';
import type { ChainGateway } from './chain/types';
import type { ServerConfig } from './config';
import type { RoomManager } from './rooms/manager';
import type { Journal } from './stake/journal';

/** Due, unheld settlements beyond this many: the queue is not keeping up (`HEALTH_MAX_PENDING`). */
export const HEALTH_MAX_PENDING = 400;
/** The oldest due, unheld settlement older than this (s): payouts are stuck (`HEALTH_MAX_PENDING_AGE_S`). */
export const HEALTH_MAX_PENDING_AGE_S = 15 * 60;
/** The RPC has not answered for this long: the chain is unreachable. */
const RPC_STALE_MS = 3 * 60_000;
/** The server clock is this far off the chain's. */
const CLOCK_SKEW_MS = 30_000;

/** What the chain gateway may tell the health check (the EVM gateway has them all; the fake and null chains none). */
interface ChainHealth {
  rpcReachable?(withinMs?: number): boolean;
  lastRpcOkAt?(): number | null;
  gasRunway?(): GasRunway;
  booksGuard?(): ReadonlyMap<number, string>;
}

export interface HealthReport {
  /** False: something needs a person (`reasons`); the HTTP status is 503 then. */
  ok: boolean;
  reasons: string[];
  uptimeS: number;
  online: number;
  rooms: number;
  game: { mode: 'workers' | 'single'; workers: number; up: number };
  journal: { writeFailing: boolean; pending: number; held: number; oldestDueS: number | null };
  chain: { configured: boolean; enabled: boolean; reachable: boolean | null; lastOkS: number | null; clockSkewS: number | null };
  gas: GasRunway | null;
  /** Arenas whose payouts the books guard stopped (id and why). */
  booksGuard: { arenaId: number; why: string }[];
}

/**
 * `GET /api/health`: 503 with the reasons when the journal cannot be written, the settlement queue is backed up or
 * stuck, the chain is unreachable, the server key's gas is critically low, the books guard stopped an arena, the
 * server clock is more than 30 s off the chain's, or a room worker is down. The alert job (deploy/vps/alert.sh) reads
 * it every minute. It is not the container's liveness check (`/api/health?live=1`): none of these is fixed by a
 * restart, and a server that only waits on the RPC must not be killed.
 */
export function healthReport(d: {
  cfg: ServerConfig;
  rooms: RoomManager;
  journal?: Journal;
  chain: ChainGateway;
  startedAt: number;
  now?: number;
}): HealthReport {
  const now = d.now ?? Date.now();
  const reasons: string[] = [];
  const chain = d.chain as ChainGateway & ChainHealth;
  const game = d.rooms.pool
    ? { mode: 'workers' as const, workers: d.rooms.pool.size, up: d.rooms.pool.threads().filter((t) => t.up).length }
    : { mode: 'single' as const, workers: 0, up: 0 };
  if (game.mode === 'workers' && game.up < game.workers) reasons.push(`${game.workers - game.up} room worker(s) down`);

  const j = d.journal;
  const due = (j?.pending ?? []).filter((p) => !(p.kind === 'settle' && p.held));
  const oldest = due.reduce<number | null>((m, p) => (m === null || p.createdAt < m ? p.createdAt : m), null);
  const oldestDueS = oldest === null ? null : Math.max(0, Math.round((now - oldest) / 1000));
  const maxPending = d.cfg.health?.maxPending ?? HEALTH_MAX_PENDING;
  const maxAgeS = d.cfg.health?.maxPendingAgeS ?? HEALTH_MAX_PENDING_AGE_S;
  if (j?.writeFailing) reasons.push('the journal cannot be written (disk full?): money records are only in memory');
  if (due.length > maxPending) reasons.push(`${due.length} settlements pending (over ${maxPending})`);
  if (oldestDueS !== null && oldestDueS > maxAgeS) reasons.push(`the oldest pending settlement is ${oldestDueS} s old (over ${maxAgeS} s)`);

  const configured = !!d.cfg.chain.rpcUrl && !!d.cfg.chain.serverKey && !d.cfg.devFakeChain;
  const reachable = configured ? (chain.rpcReachable ? chain.enabled && chain.rpcReachable(RPC_STALE_MS) : chain.enabled) : null;
  if (configured && !reachable) reasons.push('the chain RPC is unreachable');
  const lastOk = chain.lastRpcOkAt?.() ?? null;
  const skew = chain.clockSkewMs?.() ?? null;
  if (skew !== null && Math.abs(skew) > CLOCK_SKEW_MS) reasons.push(`the server clock is ${Math.round(skew / 1000)} s off the chain's`);

  const gas = chain.gasRunway?.() ?? null;
  if (gas?.level === 'critical') reasons.push(`the server key's gas is low (${gas.days !== null ? `${gas.days} day(s) left` : 'under the floor'})`);

  const books = [...(chain.booksGuard?.() ?? new Map<number, string>())].map(([arenaId, why]) => ({ arenaId, why }));
  for (const b of books) reasons.push(`arena #${b.arenaId} payouts stopped by the books guard`);

  return {
    ok: reasons.length === 0,
    reasons,
    uptimeS: Math.round((now - d.startedAt) / 1000),
    online: d.rooms.online(),
    rooms: d.rooms.roomCount,
    game,
    journal: { writeFailing: !!j?.writeFailing, pending: due.length, held: j?.held().length ?? 0, oldestDueS },
    chain: { configured, enabled: chain.enabled, reachable, lastOkS: lastOk === null ? null : Math.round((now - lastOk) / 1000), clockSkewS: skew === null ? null : Math.round(skew / 1000) },
    gas,
    booksGuard: books,
  };
}
