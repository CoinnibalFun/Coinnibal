import { describe, expect, it } from 'vitest';
import {
  LOCALNET_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  TEST_ARENA_BOTS,
  TEST_ARENA_DEFAULT,
  applyTestArenaSettings,
  joinTargetArena,
  parseJoinTarget,
  testArenaName,
  testArenaRoomId,
  testArenaTarget,
  testArenasAllowedOn,
} from '../src';

describe('test arenas (shared rules)', () => {
  it('exist on the testnet and the local node only, never on the mainnet', () => {
    expect(testArenasAllowedOn(ROBINHOOD_TESTNET_CHAIN_ID)).toBe(true);
    expect(testArenasAllowedOn(LOCALNET_CHAIN_ID)).toBe(true);
    expect(testArenasAllowedOn(ROBINHOOD_CHAIN_ID)).toBe(false);
    expect(testArenasAllowedOn(1)).toBe(false);
    expect(testArenasAllowedOn(null)).toBe(false);
  });

  it('default on, 10 mixed bots, at least 3', () => {
    expect(TEST_ARENA_DEFAULT).toEqual({ enabled: true, bots: 10, difficulty: 'mixed' });
    expect(TEST_ARENA_BOTS.min).toBe(3);
  });

  it('the join target, the room id and the name', () => {
    expect(testArenaTarget(2)).toBe('arena:2:test');
    expect(parseJoinTarget(testArenaTarget(2))).toEqual({ mode: 'arena', arenaId: 2, test: true });
    expect(joinTargetArena('arena:2:test')).toBe(2);
    // a paid room code is 5 characters: never confused with the test target
    expect(parseJoinTarget('arena:2:TESTS')).toEqual({ mode: 'arena', arenaId: 2, code: 'TESTS' });
    expect(parseJoinTarget('arena:2:TEST')).toBeNull();
    expect(parseJoinTarget('arena:2:tes')).toBeNull();
    expect(testArenaRoomId(3)).toBe('test-3');
    expect(testArenaName('Lagoon')).toBe('Test · Lagoon');
  });

  it('validates admin patches', () => {
    const ok = applyTestArenaSettings(TEST_ARENA_DEFAULT, { bots: 3, difficulty: 'hard', enabled: false });
    expect(ok).toEqual({ ok: true, settings: { enabled: false, bots: 3, difficulty: 'hard' } });
    for (const bad of [{ bots: 2 }, { bots: 21 }, { bots: 4.5 }, { bots: '5' }, { difficulty: 'insane' }, { enabled: 'yes' }, { other: 1 }]) {
      expect(applyTestArenaSettings(TEST_ARENA_DEFAULT, bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
