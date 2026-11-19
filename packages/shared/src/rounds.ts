import { RULES } from './constants';

/** One arena round on the shared wall clock (all times are Unix milliseconds). */
export interface RoundWindow {
  /** Round number: floor(nowMs / (playMs + breakMs)). */
  n: number;
  /** The round's slot starts (the previous bell): the break after it runs from here to `opensAt`. */
  startsAt: number;
  /** The break after the previous bell is over: play starts and joins open (`startsAt` + the break). */
  opensAt: number;
  /** The bell: `opensAt` + the full play length (= the next round's `startsAt`). */
  endsAt: number;
  /** New joins are refused from here until the next round's `opensAt` (the final `closeMs` and the break after the bell). */
  joinsCloseAt: number;
}

/**
 * The round running at `nowMs`. Rounds are aligned to Unix time, so every arena and every server
 * instance agrees on them. One cycle is the break plus the full play: round n's slot is
 * [n·C, (n+1)·C) with C = breakMs + playMs. It starts with the break after the previous bell (no
 * joins: payouts go out, people read the results), then `playMs` of play from `opensAt` to the bell
 * at `endsAt`; joins are open from `opensAt` until `closeMs` before the bell. With the defaults
 * (5:00 of play, a 30 s break, joins closed in the last 1:00): a 5:30 cycle, joins open for 4:00.
 */
export function roundAt(nowMs: number, playMs: number = RULES.roundMs, closeMs: number = RULES.roundJoinCloseMs, breakMs = 0): RoundWindow {
  const brk = Math.max(0, breakMs);
  const cycle = playMs + brk;
  const n = Math.floor(nowMs / cycle);
  const startsAt = n * cycle;
  const endsAt = startsAt + cycle;
  const joinsCloseAt = endsAt - Math.min(Math.max(0, closeMs), playMs);
  const opensAt = startsAt + brk;
  return { n, startsAt, opensAt, endsAt, joinsCloseAt };
}

/**
 * A custom ticket room's own clock: ONE game from `startsAt` (the room opened) to `endsAt` (the room's end, its
 * only bell). It has no tie to the official arenas' rounds: no 5-minute bell, no break, no next round.
 */
export interface OwnRound {
  startsAt: number;
  endsAt: number;
}

/**
 * The window of a room's own game (`OwnRound`) in the arenas' terms: open from `startsAt`, joins closed in the last
 * `closeMs` before the end (the arenas' last-minute close, mirrored on the room's end; at most the whole game), the
 * bell at `endsAt`. `n` is the second the room opened (a stable id of that game; rooms have their own ids anyway).
 */
export function ownRoundAt(o: OwnRound, closeMs: number = RULES.roundJoinCloseMs): RoundWindow {
  const len = Math.max(0, o.endsAt - o.startsAt);
  return { n: Math.floor(o.startsAt / 1000), startsAt: o.startsAt, opensAt: o.startsAt, endsAt: o.endsAt, joinsCloseAt: o.endsAt - Math.min(Math.max(0, closeMs), len) };
}

/** The length of one round cycle on the wall clock: the full play plus the break after its bell. */
export const roundCycleMs = (playMs: number = RULES.roundMs, breakMs: number = RULES.roundBreakMs): number => playMs + Math.max(0, breakMs);

/** One coin at a bell on the public "Last rounds" board. */
export interface RoundBoardRow {
  name: string;
  /** What it held at the bell (ledger units; a person was paid this before the cut on winnings). */
  value: number;
  skin: number;
  /** A house bot (they play for the team and are tagged like in the game). */
  isBot?: boolean;
  country?: string;
  /** The ticket's wallet (EIP-55; a person): the board marks "you" by it, never by a name. Absent on older rows. */
  wallet?: string;
}

/** A finished arena round on the public board (`/api/leaderboard` `rounds`, newest first). */
export interface RoundBoard {
  /** Round number (`roundAt(...).n`). */
  n: number;
  /** The bell (Unix ms). */
  endedAt: number;
  arenaId: number;
  /** Ticket price of the arena (ledger units). */
  entryFee: number;
  /** Coins holding value at the bell. */
  players: number;
  /** The top of the bell's standings, best first (at most `ROUND_BOARD_TOP`). */
  top: RoundBoardRow[];
}

/** Rows kept per round, and rounds kept on the board. */
export const ROUND_BOARD_TOP = 10;
export const ROUND_BOARD_KEEP = 30;
