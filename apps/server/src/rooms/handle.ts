import type { ClientInput, CustomDifficulty, MapScaleSettings, RoomInfo, ServerMessage } from '@coinnibal/shared';
import type { Player } from '../game/entities';
import type { Conn } from '../net/conn';
import type { JoinOptions, RoomOptions } from './room';
import type { ViewState } from './visibility';

/** How a player looks on a share card (`share.ts`): what the room tells the main thread about a game's player. */
export interface PlayerLook {
  name: string;
  skin: number;
  country: string | null;
  /** `PlayerFlag` bits (the emblem holder's badge). */
  flags: number;
}

export const lookOf = (p: Pick<Player, 'name' | 'skin' | 'country' | 'flags'>): PlayerLook => ({ name: p.name, skin: p.skin, country: p.country, flags: p.flags });

/**
 * What a `Room` needs of a connection. The main thread's `Conn` (a WebSocket) is one; inside a
 * room worker a `WorkerConn` (frames go to the main thread, which owns the socket) is the other.
 */
export interface RoomConn {
  readonly id: number;
  readonly ip: string;
  fp: string | null;
  room: RoomConnRoom | null;
  player: Player | null;
  spectating: boolean;
  spectatePid: number | null;
  lastCenter: { x: number; y: number };
  aspect: number;
  wallet: string | null;
  lastName: string | null;
  lastSkin: number;
  lastChatAt: number;
  lastEmoteAt: number;
  standings: boolean;
  readonly view: ViewState;
  readonly open: boolean;
  /** Bytes queued on the socket (a slow client skips snapshots). */
  readonly buffered: number;
  send(msg: ServerMessage): void;
  sendText(json: string): void;
  sendBinary(buf: ArrayBuffer): void;
  /** A snapshot straight from the room's writer, copied before the call returns (room workers). */
  sendBytes?(bytes: Uint8Array): void;
}

/** The one thing a room asks of the room a connection leaves: forget it. */
export interface RoomConnRoom {
  detach(conn: RoomConn): void;
}

/** A staker's seat, as the directory sees it (`findStakeByWallet`). */
export interface StakeSeat {
  /** Player id inside the room (-1 while the join is still on its way to a room worker). */
  pid: number;
  player: string;
  session: string;
}

/**
 * A room as the main thread uses it: the local `Room` (GAME_WORKERS=0) or a `RemoteRoom` (a proxy of
 * a room that runs in a worker thread). The gateway, the directory (`RoomManager`) and the
 * custom-room service only use this.
 */
export interface RoomHandle extends RoomConnRoom {
  readonly id: string;
  readonly opts: RoomOptions;
  lastActivity: number;
  readonly isFull: boolean;
  /** Living human players (connected or AFK). */
  readonly humanCount: number;
  /** Connections attached (players and spectators). */
  readonly connCount: number;
  info(): RoomInfo;
  liveSessions(): string[];
  findStakeByWallet(wallet: string): StakeSeat | undefined;
  /** Loot pieces on the floor. */
  lootCount(): number;
  /** Current world side. */
  mapSide(): number;
  mapScale(): MapScaleSettings | null;
  /** People and practice bots in the room. */
  botCounts(): { humans: number; bots: number };
  setMapScale(scale: MapScaleSettings): void;
  /** A test arena's bot settings, applied live (ignored by any other room). */
  setBots(count: number, difficulty: CustomDifficulty): void;
  /**
   * The arena's ticket price changed on chain (the owner re-priced it while no ticket was open): the room's own
   * figure follows (the lobby fallback, the loot pieces, the integrity evidence). Money never reads it: every ticket
   * plays, settles and refunds at the entry fee recorded in its own session.
   */
  setBuyIn(buyIn: number): void;
  clearAvatar(wallet: string): number;
  announce(text: string): void;
  /** A custom room closes at `endsAt` (server clock): the countdown for everyone in it (`closing`). */
  closingSoon(endsAt: number, message: string): void;
  sendBoosts(conn: Conn): void;
  join(conn: Conn, opts: JoinOptions): unknown;
  /** A remote room answers asynchronously (the worker decides). */
  reattach(conn: Conn, pid: number): boolean | Promise<boolean>;
  spectate(conn: Conn, next?: boolean): void;
  leave(conn: Conn, reason: 'left' | 'disconnect' | 'switch'): void;
  input(conn: Conn, input: ClientInput): void;
  chat(conn: Conn, raw: unknown): void;
  emote(conn: Conn, id: unknown): void;
  cashout(conn: Conn): void;
  boost(conn: Conn, kind: unknown): void;
  sendStandings(conn: Conn): void;
  /** The connection's viewport or standings flag changed (a room worker keeps its own copy). */
  connChanged?(conn: Conn): void;
}
