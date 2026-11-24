/**
 * The lobby's room list (every 5 s) and the chain status go to every connection at once. They were stringified once
 * per socket: in a round's break every arena player is in the lobby, and at 1,500 sockets a list of some 40 rooms
 * held the main thread, which relays every snapshot, for 150 to 300 ms each time. Serialised once, sent to all.
 */
import { describe, expect, it, vi } from 'vitest';
import { Auth } from '../src/auth';
import { loadConfig } from '../src/config';
import { Gateway } from '../src/net/gateway';
import { RoomManager } from '../src/rooms/manager';
import { Journal } from '../src/stake/journal';
import { ArenaChain, arena, fakeConn, roomDeps, type TestConn } from './helpers';

describe('lobby broadcasts', () => {
  it('the room list and the chain status are serialised once for every socket', async () => {
    const cfg = loadConfig({ GAME_ACCESS: 'public' } as unknown as NodeJS.ProcessEnv);
    const chain = new ArenaChain([arena(1, 1_000_000), arena(2, 5_000_000)]);
    const journal = new Journal(null);
    const rooms = new RoomManager(cfg, { ...roomDeps(chain, journal), log: () => {} }, chain);
    await rooms.ensureArenaRooms();
    const gateway = new Gateway(cfg, rooms, new Auth(cfg.authSecret), chain, journal, () => {});
    const conns: TestConn[] = [];
    for (let i = 0; i < 200; i++) {
      const c = fakeConn(null, `10.0.${i}.1`);
      c.helloed = true;
      rooms.conns.add(c);
      conns.push(c);
    }
    const spy = vi.spyOn(JSON, 'stringify');
    try {
      gateway.broadcastRooms();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      gateway.broadcastChain();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    for (const c of conns) {
      expect(c.msgs.map((m) => m.t)).toEqual(['rooms', 'chain']);
      const list = c.msgs[0] as Extract<(typeof c.msgs)[number], { t: 'rooms' }>;
      expect(list.rooms.map((r) => r.id)).toEqual(rooms.list().map((r) => r.id));
    }
  });
});
