import { FINAL_BOARD_ROWS } from '@coinnibal/shared';
import { PlayerFlag, TICK_MS, type ServerMessage } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../src/net/gateway';
import { Room, boardRows } from '../src/rooms/room';
import { ArenaChain, fakeConn, freeCustom, roomDeps } from './helpers';

type Standings = Extract<ServerMessage, { t: 'standings' }>;
const standingsOf = (msgs: ServerMessage[]) => msgs.filter((m): m is Standings => m.t === 'standings');

const pond = () =>
  new Room({ id: 'priv-PONDS', mode: 'private', code: 'PONDS', name: 'Practice', maxPlayers: 40, bots: { count: 6, difficulty: 'easy' }, custom: freeCustom(6), seed: 7 }, roomDeps(new ArenaChain([])));

/** Ticks until the room's once-a-second leaderboard went out (the room reads the wall clock for it). */
async function nextSecond(room: Room): Promise<void> {
  await new Promise((r) => setTimeout(r, 1010));
  room.tick(TICK_MS);
}

describe('full standings (standings sheet)', () => {
  it('only connections that asked get every coin in play, ranked, with BOT, holder and picture marks', async () => {
    const room = pond();
    for (let i = 0; i < 30; i++) room.tick(TICK_MS);
    const me = fakeConn('0x1111111111111111111111111111111111111111');
    const other = fakeConn(null);
    const watcher = fakeConn(null);
    const p = room.join(me, { name: 'Daphne', skin: 4, flags: PlayerFlag.Verified | PlayerFlag.Holder, avatar: '0123456789abcdef', country: 'NL' });
    room.join(other, { name: 'Guest', skin: 2, flags: 0 });
    room.spectate(watcher, false);

    // nothing unasked
    room.tick(TICK_MS);
    await nextSecond(room);
    expect(standingsOf(me.msgs)).toHaveLength(0);

    // asking sends the rows at once, then with every leaderboard
    me.standings = true;
    room.sendStandings(me);
    const first = standingsOf(me.msgs).at(-1)!;
    expect(first.rows.length).toBe(first.players);
    expect(first.rows.length).toBeGreaterThanOrEqual(4);
    const scores = first.rows.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    const mine = first.rows.find((r) => r.pid === p.id)!;
    expect(mine).toMatchObject({ name: 'Daphne', skin: 4, holder: true, verified: true, avatar: '0123456789abcdef', country: 'NL' });
    expect(first.rows.find((r) => r.name === 'Guest')?.country).toBeUndefined();
    // practice bots are labelled BOT and pretend nothing: no flag, a "Bot N" name
    for (const b of first.rows.filter((r) => r.isBot)) {
      expect(b.country).toBeUndefined();
      expect(b.name).toMatch(/^Bot \d+$/);
    }
    expect(mine.isBot).toBeUndefined();
    const bots = first.rows.filter((r) => r.isBot);
    expect(bots.length).toBeGreaterThan(0);
    for (const b of bots) expect(b.avatar).toBeUndefined();
    expect(first.rows.find((r) => r.name === 'Guest')?.holder).toBeUndefined();
    // the spectator has no coin: it is counted as watching
    expect(first.watching).toBe(1);

    const before = standingsOf(me.msgs).length;
    await nextSecond(room);
    expect(standingsOf(me.msgs).length).toBe(before + 1);
    expect(standingsOf(other.msgs)).toHaveLength(0);

    // off: no more rows
    me.standings = false;
    await nextSecond(room);
    expect(standingsOf(me.msgs).length).toBe(before + 1);
  });

  it('the gateway turns the sheet on and off (and answers at once)', async () => {
    const room = pond();
    const conn = fakeConn(null);
    room.join(conn, { name: 'Pip', skin: 1, flags: 0 });
    conn.helloed = true;
    const gw = Object.create(Gateway.prototype) as Gateway;
    await gw.onMessage(conn, Buffer.from(JSON.stringify({ t: 'standings', on: true })), false);
    expect(conn.standings).toBe(true);
    expect(standingsOf(conn.msgs)).toHaveLength(1);
    await gw.onMessage(conn, Buffer.from(JSON.stringify({ t: 'standings', on: false })), false);
    expect(conn.standings).toBe(false);
    // anything but `true` is off
    await gw.onMessage(conn, Buffer.from(JSON.stringify({ t: 'standings', on: 'yes' })), false);
    expect(conn.standings).toBe(false);
  });
});

describe('final standings rows (the same at a bell and at a custom room end)', () => {
  const ranked = Array.from({ length: 14 }, (_, i) => ({ pid: i + 1, name: `p${i + 1}`, mass: 1000 - i * 10, kills: i % 3, ...(i === 2 ? { isBot: true } : {}) }));

  it('sends the whole board with rank, mass and kills; the receiver\'s row is marked', () => {
    const top = boardRows(ranked, 3);
    expect(top).toHaveLength(14);
    expect(top[2]).toEqual({ rank: 3, name: 'p3', mass: 980, kills: 2, isBot: true, you: true });
    const low = boardRows(ranked, 13);
    expect(low).toHaveLength(14);
    expect(low[12]).toEqual({ rank: 13, name: 'p13', mass: 880, kills: 0, you: true });
    expect(low.filter((r) => r.you)).toHaveLength(1);
    // a huge room is capped, and the receiver below the cap still gets their own row
    const many = Array.from({ length: FINAL_BOARD_ROWS + 30 }, (_, i) => ({ pid: i + 1, name: `p${i + 1}`, mass: 10_000 - i, kills: 0 }));
    const capped = boardRows(many, FINAL_BOARD_ROWS + 20);
    expect(capped).toHaveLength(FINAL_BOARD_ROWS + 1);
    expect(capped.at(-1)).toMatchObject({ rank: FINAL_BOARD_ROWS + 20, you: true });
    // a spectator: no own row
    expect(boardRows(ranked, -1).some((r) => r.you)).toBe(false);
    // arenas carry the value
    expect(boardRows([{ pid: 1, name: 'a', mass: 50, kills: 1, value: 7 }], 1)).toEqual([{ rank: 1, name: 'a', mass: 50, kills: 1, value: 7, you: true }]);
  });
});
