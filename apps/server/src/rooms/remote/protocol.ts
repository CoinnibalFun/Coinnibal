import type { PlayerLook } from '../handle';
import type { CustomDifficulty, DeathStats, IntegrityTransfer, MapScaleSettings, RoomInfo, RoundBoard } from '@elymum/shared';
import type { SessionSummary } from '../../integrity/types';
import type { CountryGame, LbRecord } from '../../leaderboards';
import type { JournalItem, LiveStake, LootRecord, SettleReason, SettlementItem } from '../../stake/journal';
import type { RoomLoad, ThreadLoad } from '../load';
import type { BellSettled, JoinOptions, RoomOptions } from '../room';

/**
 * The messages between the main thread and a room worker (`worker_threads`). One `postMessage` carries
 * a batch: `{ cmds }` towards the worker, `{ ctl, frames }` back. Batches are FIFO on the port, so the
 * order of everything a room does (journal writes, events, frames to clients) is the order it did it.
 */

/** Set once, through `workerData`. */
export interface WorkerInit {
  index: number;
  round: { roundMs: number; closeMs: number; breakMs?: number };
  /** The main thread's clock minus `Date.now()` (tests run the rounds on an injected clock). */
  clockOffset: number;
  /** The chain's clock minus `Date.now()` (ms): ticket ages. */
  chainOffset?: number;
  /** Arena rooms run the integrity telemetry (the main thread has an `IntegrityService`). */
  integrity: boolean;
}

/** What a room worker knows of a connection (the socket stays on the main thread). */
export interface ConnMeta {
  id: number;
  wallet: string | null;
  /** HMAC of the IP (integrity evidence; the raw IP never leaves the main thread). */
  ipHash: string;
  /** HMAC of the browser fingerprint, or null. */
  fpHash: string | null;
  aspect: number;
  standings: boolean;
}

/** A `RoomOptions` that crosses threads: no functions (a custom room's map shape is rebuilt from its config). */
export type RoomSpec = RoomOptions;

export type Cmd =
  | { k: 'create'; hid: number; spec: RoomSpec; loot: LootRecord[] }
  /**
   * Cleanup (`force` false: only when the room is idle, answered by `closed`), a custom room's end
   * (`force` and `message`: evict everyone) or a paid custom room's end (`message` without `force`:
   * only once nothing of value is left in it, `Room.closeSettled`; answered by `closed`).
   */
  | { k: 'close'; hid: number; force: boolean; message?: string }
  | { k: 'join'; hid: number; conn: ConnMeta; opts: JoinOptions }
  | { k: 'reattach'; hid: number; conn: ConnMeta; pid: number; req: number }
  | { k: 'spectate'; hid: number; conn: ConnMeta; next: boolean }
  | { k: 'leave'; hid: number; conn: number; reason: 'left' | 'disconnect' | 'switch' }
  | { k: 'detach'; hid: number; conn: number }
  | { k: 'in'; conn: number; op: number; x: number; y: number }
  | { k: 'chat'; hid: number; conn: number; text: unknown }
  | { k: 'emote'; hid: number; conn: number; id: unknown }
  | { k: 'cashout'; hid: number; conn: number }
  | { k: 'standings'; conn: number; on: boolean; send: boolean }
  | { k: 'aspect'; conn: number; aspect: number }
  | { k: 'slow'; conn: number; slow: boolean }
  | { k: 'boost'; hid: number; conn: number; pid: number; kind: string; req: number }
  | { k: 'drop'; conn: number }
  | { k: 'map'; hid: number; scale: MapScaleSettings }
  /** A test arena's bot settings (`Room.setBots`). */
  | { k: 'bots'; hid: number; count: number; difficulty: CustomDifficulty }
  /** The arena's ticket price changed on chain (`Room.setBuyIn`). */
  | { k: 'buyIn'; hid: number; buyIn: number }
  | { k: 'avatar'; wallet: string }
  | { k: 'announce'; hid: number; text: string }
  | { k: 'closing'; hid: number; endsAt: number; message: string }
  | { k: 'clock'; offset: number; chain?: number }
  /** Test hook: keeps the worker busy for `ms` (the hang watchdog's test). */
  | { k: 'block'; ms: number }
  | { k: 'shutdown' };

/** A room's figures for the directory (sent every second, and with acks where they matter). */
export interface RoomSummary {
  hid: number;
  info: RoomInfo;
  humans: number;
  conns: number;
  bots: number;
  loot: number;
  side: number;
  mapScale: MapScaleSettings | null;
  lastActivity: number;
}

export type Ctl =
  | {
      k: 'commit';
      hid: number;
      enqueue?: JournalItem[];
      roomId?: string;
      live?: LiveStake[];
      loot?: { roomId: string; arenaId: number; items: { x: number; y: number; value: number }[] };
      /** Seated stakes after this write: session → player id (the directory's `findStakeByWallet`). */
      seats: [session: string, pid: number, player: string][];
      /** Settlements the integrity auto-hold must look at: key → the ticket's stake (`IntegrityService.holdDecision`). */
      holds: [key: string, entryFee: number][];
    }
  | { k: 'go'; hid: number; conn: number | null; player: PlayerLook; stats: DeathStats }
  | { k: 'nk'; hid: number; conn: number; player: PlayerLook; mass: number; kills: number; victim: string; victimMass: number }
  | { k: 'bell'; e: BellSettled }
  | { k: 'lb'; rec: LbRecord }
  | { k: 'country'; g: CountryGame }
  | { k: 'roundBoard'; r: RoundBoard }
  | { k: 'log'; m: string }
  /** A connection's state in a room changed: its player (or none) and whether it is still attached. */
  | { k: 'cs'; conn: number; hid: number; attached: boolean; pid: number | null }
  | { k: 'joined'; hid: number; conn: number; pid: number; humans: number }
  | { k: 'joinFail'; hid: number; conn: number }
  | { k: 'reattached'; req: number; ok: boolean; humans: number; holder: boolean }
  | { k: 'boost'; req: number; ok: boolean }
  | { k: 'session'; s: SessionSummary }
  | { k: 'transfer'; t: IntegrityTransfer }
  | { k: 'liveSessions'; list: SessionSummary[] }
  | { k: 'stats'; load: ThreadLoad; rooms: RoomSummary[]; roomLoads: RoomLoad[] }
  | { k: 'closed'; hid: number; ok: boolean }
  | { k: 'bye' };

/** One worker → main batch: control entries, each delivered after the first `at` frames of `frames`. */
export interface OutBatch {
  ctl: (Ctl & { at: number })[];
  /** Frames: `FRAME_HEADER` bytes (conn id u32, room hid u32, kind u8, length u32) then the payload. */
  frames: ArrayBuffer | null;
  bytes: number;
  count: number;
}

export const FRAME_HEADER = 13;
export const FRAME_TEXT = 0;
export const FRAME_BINARY = 1;
