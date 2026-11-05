import { RULES } from './constants';

/** One arena round on the shared wall clock (all times are Unix milliseconds). */
export interface RoundWindow {
  /** Round number: floor(nowMs / roundMs). */
  n: number;
  /** The round's slot starts (the previous bell). */
  startsAt: number;
  /** The break after the previous bell is over: joins open (`startsAt` + the break). */
  opensAt: number;
  endsAt: number;
  /** New joins are refused from here until `endsAt` (= the next round's `startsAt`). */
  joinsCloseAt: number;
}

/**
 * The round running at `nowMs`. Rounds are aligned to Unix time, so every arena and every
 * server instance agrees on them: round n's slot is [n·roundMs, (n+1)·roundMs); its first
 * `breakMs` is the break after the previous bell (no joins: payouts go out, people read the
 * results), then joins are open until `closeMs` before the bell.
 */
export function roundAt(nowMs: number, roundMs: number = RULES.roundMs, closeMs: number = RULES.roundJoinCloseMs, breakMs = 0): RoundWindow {
  const n = Math.floor(nowMs / roundMs);
  const startsAt = n * roundMs;
  const endsAt = startsAt + roundMs;
  const joinsCloseAt = endsAt - closeMs;
  const opensAt = Math.min(joinsCloseAt, startsAt + Math.max(0, breakMs));
  return { n, startsAt, opensAt, endsAt, joinsCloseAt };
}

/** One coin at a bell on the public "Last rounds" board. */
export interface RoundBoardRow {
  name: string;
  /** What it held at the bell (ledger units; a person was paid this before the cut on winnings). */
  value: number;
  skin: number;
  /** A house bot (they play for the team and are tagged like in the game). */
  isBot?: boolean;
  country?: string;
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
