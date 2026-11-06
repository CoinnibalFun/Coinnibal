import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_ARENA_DEFAULT, applyTestArenaSettings, testArenasAllowedOn, type TestArenaSettings } from '@elymum/shared';

/**
 * The admin switch "Test arenas with bots" and its bot settings (`DATA_DIR/site/test-arenas.json`,
 * `/api/admin/test-arenas`). Test arenas exist on a testnet only: on any other chain (the mainnet) every update is
 * refused (`TestArenaFail`), a stored file is ignored and `active` is false whatever the file says, so the room
 * directory never opens one (and `Room` refuses to build one there anyway).
 */
const TEST_ARENAS_FILE = join('site', 'test-arenas.json');

export class TestArenaFail extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export class TestArenaStore {
  private cur: TestArenaSettings = { ...TEST_ARENA_DEFAULT };
  private readonly listeners: (() => void)[] = [];

  constructor(
    /** The server's chain (`CHAIN_ID`). */
    readonly chainId: number,
    private readonly dataDir: string | null,
    private readonly log: (m: string) => void = () => {},
    /** The settings before any admin change (default `TEST_ARENA_DEFAULT`; a stored file wins). */
    initial: Partial<TestArenaSettings> = {},
  ) {
    this.cur = { ...TEST_ARENA_DEFAULT, ...initial };
    if (!this.available) {
      this.cur = { ...TEST_ARENA_DEFAULT, enabled: false };
      return;
    }
    const p = this.path();
    if (!p || !existsSync(p)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
      if (!isObj(raw)) throw new Error('not an object');
      const r = applyTestArenaSettings(this.cur, raw);
      if (!r.ok) throw new Error(r.message);
      this.cur = r.settings;
    } catch (err) {
      const backup = `${p}.corrupt-${Date.now()}`;
      renameSync(p, backup);
      this.log(`test arenas: ${p} is unreadable (${(err as Error).message}); moved to ${backup}, using the defaults`);
    }
  }

  /** The chain allows test arenas (Robinhood Chain Testnet or the local node). */
  get available(): boolean {
    return testArenasAllowedOn(this.chainId);
  }

  /** Test arenas are open: a testnet chain and the switch on. */
  get active(): boolean {
    return this.available && this.cur.enabled;
  }

  get settings(): TestArenaSettings {
    return { ...this.cur };
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private path(): string | null {
    return this.dataDir ? join(this.dataDir, TEST_ARENAS_FILE) : null;
  }

  /** Validates and stores an admin patch; throws `TestArenaFail` (always on the mainnet). */
  update(body: Record<string, unknown>): TestArenaSettings {
    if (!this.available) throw new TestArenaFail(`Test arenas exist on a testnet only; chain ${this.chainId} is not one`, 'enabled');
    const r = applyTestArenaSettings(this.cur, body);
    if (!r.ok) throw new TestArenaFail(r.message, r.field);
    this.cur = r.settings;
    const p = this.path();
    if (p) {
      mkdirSync(join(this.dataDir!, 'site'), { recursive: true });
      writeFileSync(`${p}.tmp`, JSON.stringify(this.cur, null, 2));
      renameSync(`${p}.tmp`, p);
    }
    for (const fn of this.listeners) fn();
    return this.settings;
  }
}
