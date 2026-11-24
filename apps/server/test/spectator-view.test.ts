/**
 * Anti-ghosting: a spectator of a paid room (an arena instance, a paid custom room) sees exactly what the followed
 * coin's own player sees (its `viewSize` for the coin's mass and the screen shape), never the wide spectator view, so
 * a watching socket (or two, one wide and one tall) cannot map the arena for a player it relays to. Free rooms keep
 * the wide spectator view.
 */
import { TICK_MS, VIEW, decodeSnapshot, viewSize, type ServerMessage } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import { Conn } from '../src/net/conn';
import { PAID_SPECTATE_SWITCH_MS, Room } from '../src/rooms/room';
import { ArenaChain, MID_ROUND, freeCustom, roomDeps, stakeJoin } from './helpers';

const FEE = 1_000_000;

/** A connection that keeps its messages and the view (`x`, `y`, `h`) of every snapshot it was sent. */
function viewConn(aspect = 16 / 9): Conn & { msgs: ServerMessage[]; views: { x: number; y: number; h: number }[] } {
  const msgs: ServerMessage[] = [];
  const views: { x: number; y: number; h: number }[] = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: unknown) {
      if (typeof data === 'string') msgs.push(JSON.parse(data) as ServerMessage);
      else views.push(decodeSnapshot(data as ArrayBuffer).view);
    },
  };
  const c = new Conn(ws as never, '127.0.0.1') as Conn & { msgs: typeof msgs; views: typeof views };
  c.msgs = msgs;
  c.views = views;
  c.aspect = aspect;
  return c;
}

const arenaRoom = (now: () => number = () => MID_ROUND) =>
  new Room({ id: 'arena-1-1', mode: 'arena', name: 'A', instance: 1, maxPlayers: 50, stake: { arenaId: 1, buyIn: FEE }, seed: 5 }, roomDeps(new ArenaChain([]), undefined, now));

const freeRoom = () =>
  new Room({ id: 'priv-FREEE', mode: 'private', code: 'FREEE', name: 'Free', maxPlayers: 40, bots: { count: 4, difficulty: 'easy' }, custom: freeCustom(4), seed: 5 }, roomDeps(new ArenaChain([])));

const lastH = (c: { views: { h: number }[] }) => c.views.at(-1)!.h;

describe('spectator view in paid rooms (anti-ghosting)', () => {
  it('an arena spectator gets the followed coin\'s own view: same size as its player, far below the wide spectator view', () => {
    const room = arenaRoom();
    const player = viewConn();
    const p = room.join(player, stakeJoin(1, FEE));
    p.cells[0].setMass(120);
    const watcher = viewConn();
    room.spectate(watcher);
    expect(watcher.msgs.find((m) => m.t === 'spectating')).toMatchObject({ targetPid: p.id });
    room.tick(TICK_MS);
    expect(lastH(watcher)).toBeCloseTo(lastH(player), 3);
    expect(lastH(watcher)).toBeCloseTo(viewSize(p.totalMass(), 16 / 9).h, 3);
    expect(lastH(watcher)).toBeLessThan(VIEW.spectatorBase);
    // centred on the coin
    expect(watcher.views.at(-1)!.x).toBeCloseTo(p.center().x, 3);
  });

  it('a wide or tall screen shape cannot widen it: the followed coin\'s view for that shape, within a player\'s aspect limits', () => {
    const room = arenaRoom();
    const p = room.join(viewConn(), stakeJoin(1, FEE));
    p.cells[0].setMass(600);
    const wide = viewConn(3);
    const tall = viewConn(0.3);
    room.spectate(wide);
    room.spectate(tall);
    room.tick(TICK_MS);
    const m = p.totalMass();
    expect(lastH(wide)).toBeCloseTo(viewSize(m, 3).h, 3);
    expect(lastH(tall)).toBeCloseTo(viewSize(m, 0.3).h, 3);
    // both shapes together still cover no more than a player's own extreme views (clamped to VIEW's aspect limits)
    expect(viewSize(m, 0.3)).toEqual(viewSize(m, VIEW.minAspect));
    expect(viewSize(m, 3)).toEqual(viewSize(m, VIEW.maxAspect));
    expect(lastH(tall)).toBeLessThan(viewSize(0, 0.3, true).h);
  });

  it('a paid room\'s dead player (not spectating) sees a new coin\'s view, not the wide one', () => {
    const room = arenaRoom();
    const c = viewConn();
    const p = room.join(c, stakeJoin(1, FEE));
    room.join(viewConn(), stakeJoin(1, FEE));
    p.cells[0].setMass(5000);
    room.tick(TICK_MS);
    // the player is gone (its coin no longer alive): the camera stays where it was, at a new coin's size
    room.leave(c, 'left');
    c.player = null;
    room.tick(TICK_MS);
    expect(lastH(c)).toBeCloseTo(viewSize(0, 16 / 9).h, 3);
  });

  it('free rooms keep the wide spectator view', () => {
    const room = freeRoom();
    for (let i = 0; i < 5; i++) room.tick(TICK_MS);
    const watcher = viewConn();
    room.spectate(watcher);
    room.tick(TICK_MS);
    expect(lastH(watcher)).toBeCloseTo(viewSize(0, 16 / 9, true).h, 3);
  });

  it('a paid room\'s spectator moves on to the next coin at most once per PAID_SPECTATE_SWITCH_MS; a free room has no limit', () => {
    let t = MID_ROUND;
    const room = arenaRoom(() => t);
    const pids = [room.join(viewConn(), stakeJoin(1, FEE)), room.join(viewConn(), stakeJoin(1, FEE)), room.join(viewConn(), stakeJoin(1, FEE))].map((p) => p.id);
    const watcher = viewConn();
    room.spectate(watcher);
    const targets = () => watcher.msgs.filter((m): m is Extract<ServerMessage, { t: 'spectating' }> => m.t === 'spectating').map((m) => m.targetPid);
    room.spectate(watcher, true);
    expect(targets()).toHaveLength(2);
    expect(targets()[1]).not.toBe(targets()[0]);
    // too early: dropped (the camera stays on its coin)
    t += PAID_SPECTATE_SWITCH_MS - 1;
    room.spectate(watcher, true);
    expect(targets()).toHaveLength(2);
    expect(watcher.spectatePid).toBe(targets()[1]);
    t += 1;
    room.spectate(watcher, true);
    expect(targets()).toHaveLength(3);
    expect(pids).toContain(targets()[2]);

    const free = freeRoom();
    for (let i = 0; i < 5; i++) free.tick(TICK_MS);
    const w2 = viewConn();
    free.spectate(w2);
    free.spectate(w2, true);
    free.spectate(w2, true);
    expect(w2.msgs.filter((m) => m.t === 'spectating')).toHaveLength(3);
  });
});
