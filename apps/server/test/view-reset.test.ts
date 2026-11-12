import { TICK_MS, decodeSnapshot, type ServerMessage } from '@elymum/shared';
import { describe, expect, it } from 'vitest';
import { Conn } from '../src/net/conn';
import { World } from '../src/game/world';
import { Room } from '../src/rooms/room';
import { ViewState } from '../src/rooms/visibility';
import { ArenaChain, freeCustom, roomDeps } from './helpers';

/**
 * A client's world mirror, fed by the connection's messages in wire order, cleared the way the web
 * client clears it: on every `joined` and `spectating` (`GameEngine.onMessage`).
 */
function mirroredConn(): { conn: Conn; mirror: Map<number, number> } {
  const mirror = new Map<number, number>();
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: unknown) {
      if (typeof data === 'string') {
        const m = JSON.parse(data) as ServerMessage;
        if (m.t === 'joined' || m.t === 'spectating') mirror.clear();
        return;
      }
      const s = decodeSnapshot(data as ArrayBuffer);
      for (const u of s.upserts) mirror.set(u.id, u.kind);
      for (const r of s.removals) mirror.delete(r.id);
    },
  };
  return { conn: new Conn(ws as never, '127.0.0.1'), mirror };
}

const pond = (id: string, seed: number) =>
  new Room({ id, mode: 'private', code: id.slice(-5).toUpperCase(), name: id, maxPlayers: 40, bots: { count: 8, difficulty: 'easy' }, custom: freeCustom(8), seed }, roomDeps(new ArenaChain([])));

const tick = (rooms: Room[], n: number) => {
  for (let i = 0; i < n; i++) for (const r of rooms) r.tick(TICK_MS);
};

describe('client mirror vs server view', () => {
  it('after lobby → another room, rejoining the same room and a respawn, the mirror holds exactly what is in view (no ghosts)', () => {
    const a = pond('practice-rookie-1', 11);
    const b = pond('practice-rookie-2', 12);
    const rooms = [a, b];
    const { conn, mirror } = mirroredConn();
    const check = (room: Room) => {
      // everything the client holds exists in its room right now, and the server knows it holds it
      for (const id of mirror.keys()) expect(room.world.entities.has(id), `ghost entity ${id}`).toBe(true);
      expect([...mirror.keys()].sort((x, y) => x - y)).toEqual([...conn.view.known.keys()].sort((x, y) => x - y));
      expect(mirror.size).toBeGreaterThan(0);
    };

    // the lobby's live view watches room A
    a.spectate(conn);
    tick(rooms, 20);
    check(a);

    // the player picks room B: nothing of room A may stay on screen
    b.join(conn, { name: 'newbie', skin: 0, flags: 0 });
    tick(rooms, 20);
    check(b);

    // back to the lobby (same room), then play again in the same room
    b.leave(conn, 'left');
    b.spectate(conn);
    tick(rooms, 15);
    check(b);
    // "watch" again: the same room, the same camera, a fresh `spectating`
    b.spectate(conn);
    tick(rooms, 5);
    check(b);
    b.join(conn, { name: 'newbie', skin: 0, flags: 0 });
    tick(rooms, 15);
    check(b);

    // the camera moved on and things were eaten meanwhile: still exact
    tick(rooms, 300);
    check(b);
  });
});

describe('player infos follow the view', () => {
  it('a coin that left the view and comes back brings its info again (the client let go of it: no bare coin without a name tag)', () => {
    const world = new World({ width: 6000, height: 6000, foodTarget: 0, virusTarget: 0, maxPowerUps: 0, powerUps: false, coinRain: false, seed: 3 });
    const big = world.addPlayer({ spawnShield: false, name: 'Bluey', skin: 3, x: 1000, y: 1000, mass: 4000, country: 'TR' });
    const view = new ViewState();
    const at = (x: number, y: number) => ({ x0: x - 800, y0: y - 500, x1: x + 800, y1: y + 500 });
    const v = { x: 0, y: 0, h: 1000 };
    const first = view.build(world, at(1000, 1000), v)!;
    expect(first.players.map((p) => p.name)).toEqual(['Bluey']);
    // still in view: sent once only
    world.tick(TICK_MS);
    expect(view.build(world, at(1000, 1000), v)?.players ?? []).toEqual([]);
    // the view moves away: the coin is removed from the mirror (and the client prunes its player)
    const away = view.build(world, at(5000, 5000), v)!;
    expect(away.removals.map((r) => r.id)).toContain(big.cells[0].id);
    // back in view: the coin AND its player info (name, flag) come again
    const back = view.build(world, at(1000, 1000), v)!;
    expect(back.upserts.some((u) => u.id === big.cells[0].id)).toBe(true);
    expect(back.players).toEqual([expect.objectContaining({ id: big.id, name: 'Bluey', skin: 3, country: 'TR' })]);
  });
});
