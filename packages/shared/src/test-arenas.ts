import { isTestChainId } from './chains';
import { CUSTOM_DIFFICULTIES, type CustomDifficulty } from './custom-rooms';

/**
 * Test arenas (testnet only): for every official arena (ticket tier) one extra instance, `test-<arenaId>`, that plays
 * EXACTLY the official arena path (real on-chain tickets of the same ElymumArena contract, the same seating, rounds and
 * bell, settlement with the contract's fee on profit, loot burns, the journal, crash recovery), with one difference:
 * the room is populated with fair practice bots. Bots never buy a ticket and carry no value: eating a bot gives mass,
 * never value, and a bot that eats a player makes the eaten value spill as floor loot (burned at the bell if no
 * player picks it up), so the vault books stay exactly as in an official arena.
 *
 * They exist only while the server's chain is a testnet (Robinhood Chain Testnet, or the local node) AND the admin
 * switch is on (default on). On the mainnet the setting is refused and ignored and the server never opens one.
 * Quick play never seats anyone there; the lobby lists them after the official arenas, marked TEST; their results
 * stay off every official board (leaderboards, countries, last rounds, profile stats); their Share on X cards are
 * stamped TEST and never show a payout.
 */
export interface TestArenaSettings {
  /** The admin switch "Test arenas with bots" (testnet only). */
  enabled: boolean;
  /** Practice bots in every test arena. */
  bots: number;
  difficulty: CustomDifficulty;
}

export const TEST_ARENA_DEFAULT: TestArenaSettings = { enabled: true, bots: 10, difficulty: 'mixed' };

/** Bots per test arena: at least 3 (a test arena is never empty), at most 20. */
export const TEST_ARENA_BOTS = { min: 3, max: 20 } as const;

/** Bots arrive one by one: the first at once, then one about every this many ms (± 40 %). */
export const TEST_ARENA_ARRIVE_MS = 4000;

/** The test arena of `arenaId` (room id). */
export const testArenaRoomId = (arenaId: number): string => `test-${arenaId}`;

/** The join target of a ticket of `arenaId` seated in its test arena. */
export const testArenaTarget = (arenaId: number): string => `arena:${arenaId}:test`;

/** The lobby name of a test arena. */
export const testArenaName = (arenaName: string): string => `Test · ${arenaName}`;

/** Test arenas may exist on this chain (Robinhood Chain Testnet or the local node; never the mainnet). */
export const testArenasAllowedOn = (chainId: number | null | undefined): boolean => isTestChainId(chainId);

/** A partial admin update applied to `cur`: the new settings, or the first invalid field. */
export function applyTestArenaSettings(
  cur: TestArenaSettings,
  patch: Record<string, unknown>,
): { ok: true; settings: TestArenaSettings } | { ok: false; field: string; message: string } {
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'enabled') {
      if (typeof v !== 'boolean') return { ok: false, field: k, message: 'enabled must be true or false' };
      next.enabled = v;
    } else if (k === 'bots') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < TEST_ARENA_BOTS.min || v > TEST_ARENA_BOTS.max) {
        return { ok: false, field: k, message: `bots must be a whole number from ${TEST_ARENA_BOTS.min} to ${TEST_ARENA_BOTS.max}` };
      }
      next.bots = v;
    } else if (k === 'difficulty') {
      if (!(CUSTOM_DIFFICULTIES as readonly unknown[]).includes(v)) return { ok: false, field: k, message: `difficulty must be one of ${CUSTOM_DIFFICULTIES.join(', ')}` };
      next.difficulty = v as CustomDifficulty;
    } else return { ok: false, field: k, message: `unknown setting ${k}` };
  }
  return { ok: true, settings: next };
}

/** One live test arena (`GET /api/admin/test-arenas`). */
export interface TestArenaRoomView {
  arenaId: number;
  id: string;
  name: string;
  people: number;
  bots: number;
  capacity: number;
  /** Takes no new seat; closes once its bell settled every ticket in it (the switch was turned off). */
  closing: boolean;
  /** The room worker it runs on (`w<n>`), absent on the main thread. */
  thread?: string;
}

/** `GET /api/admin/test-arenas`. */
export interface TestArenaView {
  /** The server's chain allows test arenas (a testnet); false on the mainnet, where the setting is refused. */
  available: boolean;
  chainId: number;
  /** The switch is on and the chain allows it: test arenas are open. */
  active: boolean;
  settings: TestArenaSettings;
  defaults: TestArenaSettings;
  limits: { botsMin: number; botsMax: number };
  rooms: TestArenaRoomView[];
}
