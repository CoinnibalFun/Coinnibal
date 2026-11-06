/**
 * The mainnet economic audit's checks (test/mainnet-econ-sim.ts, scripts/mainnet-econ-sim.ts):
 *
 *  - the money simulation's mainnet scenario: the four USD tiers converted at a mainnet token price, the $10 arena
 *    holders-only, every fault on, and the owner re-pricing arenas by ±50 % between rounds (close, wait, sync): the
 *    conservation checker must stay silent;
 *  - the economy layer's exact books on a short physics calibration, the gas model against the Hardhat figures and
 *    the re-pricing pause model.
 *
 * The audit's two server findings (a closed arena kept busy by unseated tickets; power-up prices in tokens drifting
 * away from the dollar ticket) are fixed and tested here as regular tests.
 */
import { generatePrivateKey } from 'viem/accounts';
import { DEFAULT_ARENAS, SHOP_DEFAULTS, parseUsdPrice, roundSigFigs, usdToTokenRaw } from '@elymum/shared';
import { describe, expect, it } from 'vitest';
import { EvmChain } from '../src/chain/evm';
import { loadConfig } from '../src/config';
import { mulberry32 } from '../src/game/rng';
import { Journal } from '../src/stake/journal';
import { ARENA, FakeEvm } from './fake-evm';
import { MAINNET_DEFAULT, calibrate, loadGas, runEconomy, syncPauseS, txGas, type Calibration } from './mainnet-econ-sim';
import { DEFAULT_FAULTS, fakeSimChain, runMoneySim } from './money-sim';
import { testSigner } from './signers';

const PRICE = MAINNET_DEFAULT.usdPerToken;

describe('mainnet money simulation (USD tiers at a mainnet price, holders-only $10 arena, re-pricing)', () => {
  it('keeps every book balanced through faults and ±50 % re-pricing', { timeout: 300_000 }, async () => {
    const price = parseUsdPrice(PRICE);
    const arenas = DEFAULT_ARENAS.map((a) => ({ id: a.id, tokens: usdToTokenRaw(a.usdCents, price, 18, 2) / 10n ** 18n, holdersOnly: a.holdersOnly }));
    expect(arenas.map((a) => a.tokens)).toEqual([10_000n, 30_000n, 50_000n, 100_000n]);
    const seed = 4663;
    const sim = fakeSimChain({ players: 24, seed, arenas, holderShare: 0.4 });
    const r = await runMoneySim(sim, {
      seed,
      rounds: Number(process.env.ECON_MONEY_ROUNDS ?? 160),
      instances: 1,
      faults: DEFAULT_FAULTS,
      // the token moves up to ±50 % between two syncs; the new entry fee is rounded to 2 figures like the admin's sync
      reprice: { everyRounds: 5, newEntry: (old, rng) => roundSigFigs((old * BigInt(Math.round((0.5 + rng()) * 1000))) / 1000n, 2) },
    });
    expect(r.violations).toEqual([]);
    expect(r.reprice!.synced).toBeGreaterThan(3);
    // the $10 arena takes holders only: every ticket of arena #4 is a holder's
    const closures = await sim.closures();
    for (const c of closures.filter((x) => x.arenaId === 4)) expect(sim.holders.has(c.player.toLowerCase())).toBe(true);
    // at least one sync waited for an open ticket (ArenaBusy) before it went through
    expect(r.reprice!.busy + r.reprice!.pauseRounds.filter((x) => x > 1).length).toBeGreaterThan(0);
    expect(r.closures.Settled).toBeGreaterThan(100);
  });
});

describe('re-pricing downtime (fixed)', () => {
  it('closing an arena for a sync cancels its unseated tickets at once, not after 15 minutes', async () => {
    // a ticket bought 2 minutes ago whose player never took the seat; the owner closed the arena for a USD sync
    const evm = new FakeEvm();
    evm.addArena(1, 10_000n);
    const T0 = 1_791_000_000_000;
    evm.nowS = () => Math.floor(T0 / 1000);
    const journal = new Journal(null);
    const cfg = loadConfig({ EVM_RPC_URL: 'http://127.0.0.1:1', SERVER_PRIVATE_KEY: generatePrivateKey() } as unknown as NodeJS.ProcessEnv);
    const chain = new EvmChain(cfg, journal, () => {}, { client: evm, contracts: () => ({ arena: ARENA, nft: null }), loops: false, now: () => T0, receiptTimeoutMs: 10 });
    chain.setLiveSessionProvider(() => new Set());
    await chain.start();
    evm.join(1, testSigner().address, { openedAt: Math.floor(T0 / 1000) - 120 });
    // the control: a ticket of the same arena older than 15 minutes, which the sweeper of today does cancel
    evm.join(1, testSigner().address, { openedAt: Math.floor(T0 / 1000) - 1_000 });
    evm.arenaMap.get(1)!.enabled = false;
    // both queued for a cancel (the full entry fee back): the fresh one no longer keeps the closed arena busy until it
    // is 900 s old (STALE_SESSION_AFTER_S) and the next 5-minute sweep
    expect(await chain.sweepStale()).toBe(2);
    // the same while the contract is paused (every arena), or when the server closed the arena for a re-price
    evm.arenaMap.get(1)!.enabled = true;
    evm.join(1, testSigner().address, { openedAt: Math.floor(T0 / 1000) - 30 });
    expect(await chain.sweepStale()).toBe(0);
    chain.setClosedArenaProvider(() => new Set([1]));
    expect(await chain.sweepStale()).toBe(1);
  });

});

describe('economy layer', () => {
  let cal: Calibration | null = null;
  const getCal = () => (cal ??= calibrate({ sizes: [12], rounds: 2, seeds: [1] }));

  it('balances every instance-round exactly and burns three quarters of the fee on profit', { timeout: 120_000 }, () => {
    const r = runEconomy(getCal(), { ...MAINNET_DEFAULT, name: 'test', concurrent: 40, hours: 2 });
    expect(r.violations).toEqual([]);
    for (const t of r.tiers) {
      expect(t.deposited).toBe(t.netPaid + t.burned + t.toFeeWallet + t.vaultLeft);
      expect(t.vaultLeft).toBe(0n);
      // non-holders 15 + 5, holders 8 + 2: the burn is between 75 % and 80 % of the fee (rounding down each share)
      const fee = t.burned + t.toFeeWallet;
      if (fee > 0n) {
        expect(Number(t.burned) / Number(fee)).toBeGreaterThanOrEqual(0.74);
        expect(Number(t.burned) / Number(fee)).toBeLessThanOrEqual(0.81);
      }
    }
    // the arena takes at most the fee rate of what changes hands, never the stake
    expect(r.houseEdge.feePerTicket).toBeLessThan(0.2);
  });

  it('prices server transactions from the Hardhat measurements', () => {
    const g = loadGas();
    // a death settles at 0 and moves no token: the cheapest settle
    expect(txGas(g, 'settle', 1, 0).gas).toBe((g.settle_death_1 as { gas: number }).gas);
    expect(txGas(g, 'settle', 40, 40).gas).toBe((g.settle_bell_40 as { gas: number }).gas);
    // batching: 40 tickets in one transaction cost far less than 40 transactions
    expect(txGas(g, 'settle', 40, 40).gas).toBeLessThan(40 * txGas(g, 'settle', 1, 1).gas * 0.3);
    expect(txGas(g, 'cancel', 10, 10).gas).toBe((g.cancel_10 as { gas: number }).gas);
  });

  it('models a sync: the stale sweeper holds an arena closed for minutes, a drain on close for about one', () => {
    const rng = mulberry32(1);
    const now: number[] = [];
    const fixed: number[] = [];
    for (let i = 0; i < 400; i++) {
      now.push(syncPauseS(rng, { ticketsPer15Min: 270, unplayed: 0.01, fixed: false }));
      fixed.push(syncPauseS(rng, { ticketsPer15Min: 270, unplayed: 0.01, fixed: true }));
    }
    now.sort((a, b) => a - b);
    expect(now[200]).toBeGreaterThan(8 * 60);
    expect(Math.max(...fixed)).toBeLessThan(2 * 60);
  });
});

describe('power-ups priced in dollars (fixed)', () => {
  it('a power-up charge stays at the documented 20 % of the $1 ticket at the mainnet price (both priced in USD)', () => {
    const price = parseUsdPrice(PRICE);
    const ticket = Number(usdToTokenRaw(100, price, 18, 2) / 10n ** 18n);
    // the pack converts at the same price and rounding as the ticket
    const charge = Number(usdToTokenRaw(SHOP_DEFAULTS.usdCents.magnet, price, 18, 2) / 10n ** 18n) / SHOP_DEFAULTS.packSize;
    // ECONOMY.md section 3: "one charge is a fifth of a ticket or more"
    expect(charge / ticket).toBeGreaterThanOrEqual(0.15);
    expect(charge / ticket).toBeLessThanOrEqual(0.25);
  });
});
