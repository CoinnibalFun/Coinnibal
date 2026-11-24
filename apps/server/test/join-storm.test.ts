/**
 * A join storm at a round's opening: many paid joins whose ticket reads come back together (concurrent reads are
 * merged into one multicall, so their answers resolve in the same tick). Every join then went through its last
 * awaits in lock step: each confirmed the same instance while none of them had been seated yet, and all of them sat
 * down in it, far past its seats (`ARENA_INSTANCE_CAP`). The seat must be picked again synchronously right before
 * it is taken, so the instance fills to its seats and the rest overflow into new instances.
 */
import { PROTOCOL_VERSION, type ServerMessage } from '@coinnibal/shared';
import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { EvmChain } from '../src/chain/evm';
import { loadConfig } from '../src/config';
import { Gateway } from '../src/net/gateway';
import { RoomManager } from '../src/rooms/manager';
import { Journal } from '../src/stake/journal';
import { ARENA, FakeEvm } from './fake-evm';
import { MID_ROUND, fakeConn, roomDeps, testWallet, type TestConn } from './helpers';

const CAP = 3;
const PLAYERS = 10;

describe('a join storm fills arena instances to their seats, never past them', () => {
  it('ticket reads that answer together seat at most ARENA_INSTANCE_CAP per instance; the rest open new instances', async () => {
    const evm = new FakeEvm();
    evm.addArena(3, 50_000n);
    const cfg = loadConfig({
      EVM_RPC_URL: 'http://127.0.0.1:1',
      SERVER_PRIVATE_KEY: generatePrivateKey(),
      GAME_ACCESS: 'public',
      ARENA_INSTANCE_CAP: String(CAP),
    } as unknown as NodeJS.ProcessEnv);
    const journal = new Journal(null);
    const chain = new EvmChain(cfg, journal, () => {}, { client: evm, contracts: () => ({ arena: ARENA, nft: null }), loops: false, now: () => MID_ROUND, receiptTimeoutMs: 10, cacheDir: null });
    await chain.start();
    const rooms = new RoomManager(cfg, { ...roomDeps(chain, journal, () => MID_ROUND), log: () => {} }, chain);
    chain.setLiveSessionProvider(() => rooms.liveSessions());
    const { Auth } = await import('../src/auth');
    const gateway = new Gateway(cfg, rooms, new Auth(cfg.authSecret), chain, journal, () => {});
    const send = (conn: TestConn, msg: Record<string, unknown>) => gateway.onMessage(conn, Buffer.from(JSON.stringify(msg)) as never, false);
    await rooms.ensureArenaRooms();

    // every ticket read waits for one release: the answers of a merged multicall
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ea = evm as unknown as { session: (...a: unknown[]) => Promise<unknown> };
    const session = ea.session.bind(evm);
    ea.session = async (...a) => {
      await gate;
      return session(...a);
    };

    const conns: TestConn[] = [];
    for (let i = 0; i < PLAYERS; i++) {
      const wallet = testWallet(0x100 + i);
      evm.join(3, wallet, { openedAt: Math.floor(Date.now() / 1000) - 60 });
      const conn = fakeConn(wallet, `10.0.${i}.1`);
      rooms.conns.add(conn);
      await send(conn, { t: 'hello', v: PROTOCOL_VERSION });
      conns.push(conn);
    }
    const joins = conns.map((c) => send(c, { t: 'join', room: 'arena:3', name: 'x', skin: 0 }));
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all(joins);

    const seated = conns.filter((c) => c.msgs.some((m: ServerMessage) => m.t === 'joined'));
    expect(seated).toHaveLength(PLAYERS);
    const instances = rooms.arenaInstances(3);
    for (const r of instances) expect(r.humanCount).toBeLessThanOrEqual(CAP);
    expect(instances.length).toBe(Math.ceil(PLAYERS / CAP));
    expect(instances.reduce((a, r) => a + r.humanCount, 0)).toBe(PLAYERS);
  });
});
