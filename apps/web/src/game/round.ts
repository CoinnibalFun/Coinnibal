import { RULES, roundAt, type RoomInfo, type RoundInfo } from '@elymum/shared';
import { useEffect, useState } from 'react';
import { useUi } from '../store';
import { serverClock } from './clock';

/**
 * Arena rounds on the client. Every arena plays the same wall-clock round (`roundAt` in
 * `@elymum/shared`): the server sends the round in play (`RoundInfo`) with room listings and
 * `joined`; from it and the server clock offset (`serverClock`) anyone, players who were
 * eaten and lobby viewers included, can tell the round's phase and roll it forward past
 * `endsAt` without waiting for a new listing.
 */

export type RoundPhase = 'open' | 'closing';

export interface RoundState {
  n: number;
  endsAt: number;
  joinsCloseAt: number;
  /** Play starts and joins open here (the break after the previous bell ends); the slot start on servers without a break. */
  opensAt: number;
  /** Until the bell (ms, never negative). */
  msLeft: number;
  /** `open`: joins open (or the break before them, see `breakMsLeft`); `closing`: the final minute, joins closed until the next round. */
  phase: RoundPhase;
  /** The break after the bell (joins closed, payouts going out): ms until the floor opens; 0 once it is open. */
  breakMsLeft: number;
}

/** The big countdown takes over the chip for the last 10 s. */
export const COUNTDOWN_MS = 10_000;

/** The rules' default round: 5:00 of play, joins closed in the last 1:00, a 30 s break after the bell. */
const DEFAULT_LENGTHS = { roundMs: RULES.roundMs, closeMs: RULES.roundJoinCloseMs, breakMs: RULES.roundBreakMs };

/**
 * The play, join-close and break lengths implied by a `RoundInfo` (the server may run shorter rounds for tests and
 * demos: `ROUND_SECONDS`). Round n's slot is [n·cycle, (n+1)·cycle) with cycle = break + play, so the bell of round n
 * is at (n + 1) · cycle and its play starts `breakMs` into the slot (`opensAt`). `roundMs` is the play alone.
 */
export function roundLengths(info: RoundInfo): { roundMs: number; closeMs: number; breakMs: number } {
  // a custom ticket room's own game: one round from its start to its end, no break
  if (info.startsAt !== undefined) {
    const roundMs = Math.max(1, info.endsAt - info.startsAt);
    return { roundMs, closeMs: Math.min(roundMs, Math.max(0, info.endsAt - info.joinsCloseAt)), breakMs: 0 };
  }
  const cycle = info.endsAt / (info.n + 1);
  if (!Number.isInteger(cycle) || cycle <= 0) return DEFAULT_LENGTHS;
  const breakMs = info.opensAt !== undefined ? info.opensAt - info.n * cycle : 0;
  const roundMs = cycle - breakMs;
  const closeMs = info.endsAt - info.joinsCloseAt;
  if (breakMs < 0 || roundMs <= 0 || closeMs < 0 || closeMs > roundMs) return DEFAULT_LENGTHS;
  return { roundMs, closeMs, breakMs };
}

/** The round in play at server time `now`, from the last known `RoundInfo` (rolled forward with `roundAt`). */
export function roundStateAt(info: RoundInfo, now: number): RoundState {
  const { roundMs, closeMs, breakMs } = roundLengths(info);
  // a room's own game never rolls into a next round (there is none): it ends at `endsAt` and stays ended
  const w: Pick<RoundState, 'n' | 'endsAt' | 'joinsCloseAt' | 'opensAt'> =
    info.startsAt !== undefined
      ? { n: info.n, endsAt: info.endsAt, joinsCloseAt: info.joinsCloseAt, opensAt: info.startsAt }
      : now >= info.endsAt
        ? roundAt(now, roundMs, closeMs, breakMs)
        : { ...info, opensAt: info.opensAt ?? info.endsAt - roundMs };
  return {
    n: w.n,
    endsAt: w.endsAt,
    joinsCloseAt: w.joinsCloseAt,
    opensAt: w.opensAt,
    msLeft: Math.max(0, w.endsAt - now),
    phase: now >= w.joinsCloseAt ? 'closing' : 'open',
    breakMsLeft: Math.max(0, w.opensAt - now),
  };
}

/**
 * The freshest `RoundInfo` for an arena: the room being played or watched, else its listing,
 * else any arena's (rounds are shared by every arena). `arenaId` null: any arena.
 */
export function roundInfoFor(rooms: readonly RoomInfo[], room: RoomInfo | null, arenaId: number | null): RoundInfo | null {
  if (room?.mode === 'arena' && room.round && (arenaId === null || room.arenaId === arenaId)) return room.round;
  const own = rooms.find((r) => r.mode === 'arena' && r.round && (arenaId === null || r.arenaId === arenaId));
  if (own?.round) return own.round;
  return rooms.find((r) => r.mode === 'arena' && r.round)?.round ?? null;
}

/**
 * A round as players name it: the wall-clock time its play started ("15:45:30" shows as "15:45"; the break after the
 * previous bell comes before it), not its index since 1970. `info` (any arena's) gives the lengths.
 */
export function roundStartLabel(n: number, info: RoundInfo | null | undefined): string {
  const { roundMs, breakMs } = info ? roundLengths(info) : DEFAULT_LENGTHS;
  // a room's own game says when it started
  const at = info?.startsAt !== undefined && info.n === n ? info.startsAt : n * (roundMs + breakMs) + breakMs;
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * The round's play in minutes for copy ("5-minute rounds"; the break after the bell is not counted): from the round
 * the server announced (it may run shorter rounds), else the rules' default. One decimal at most (`1.5`).
 */
export function roundMinutes(rooms: readonly RoomInfo[], room: RoomInfo | null): number {
  // the arenas' rounds (a custom ticket room plays its own one game: not "the round")
  const own = room?.round?.startsAt !== undefined;
  const info = roundInfoFor(rooms, own ? null : room, null);
  const ms = info ? roundLengths(info).roundMs : RULES.roundMs;
  return Math.round(ms / 6000) / 10;
}

/** `m:ss` of a countdown, rounded up (0:01 until the very end). */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The current round state of an arena (server clock), or null while no round is known. */
export function currentRound(arenaId: number | null, now = serverClock.now()): RoundState | null {
  const s = useUi.getState();
  const info = roundInfoFor(s.rooms, s.room, arenaId);
  return info ? roundStateAt(info, now) : null;
}

/**
 * `{ n, msLeft, phase }` of an arena's round, re-rendering as the shown second changes.
 * `arenaId` null: any arena (they share one clock).
 */
export function useRound(arenaId: number | null, active = true): RoundState | null {
  const rooms = useUi((s) => s.rooms);
  const room = useUi((s) => s.room);
  const info = active ? roundInfoFor(rooms, room, arenaId) : null;
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    if (!info) return;
    // tick on the second boundary of the countdown (plus a hair), so m:ss flips on time
    let id: ReturnType<typeof setTimeout>;
    const step = () => {
      const t = serverClock.now();
      setNow(t);
      const st = roundStateAt(info, t);
      // the break's countdown and the bell's flip on the same second boundaries
      const left = st.breakMsLeft > 0 ? st.breakMsLeft : st.msLeft;
      id = setTimeout(step, (left % 1000) + 15);
    };
    step();
    return () => clearTimeout(id);
  }, [info?.n, info?.endsAt, info?.joinsCloseAt]);
  return info ? roundStateAt(info, now) : null;
}
