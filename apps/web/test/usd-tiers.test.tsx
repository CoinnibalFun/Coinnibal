import { ARENA_PRICING_DEFAULT, type ArenaPricingSettings } from '@elymum/shared';
import type { StatusSnapshot } from '@elymum/sdk/ops';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArenaPricesCard, arenaPricingPatch } from '../src/admin/ArenaPricesCard';
import { resolveNetwork } from '../src/admin/net';
import type { Plan } from '../src/admin/plan';
import type { ChainCtx } from '../src/admin/ui';
import { Kb } from '../src/design';
import type { AdminApi, ArenaPricesAdminView } from '../src/site/api';
import { useUi } from '../src/store';
import { TicketList } from '../src/ui/lobby/TicketList';
import { ProfileCard } from '../src/wallet/ProfileCard';
import { useChainData } from '../src/wallet/chain';
import { buildTickets } from '../src/wallet/ticket';
import { resetWallets, useWallet } from '../src/wallet/store';
import { ALICE, BOB, ONE, chainStatus, detail, fakeProvider } from './evm-helpers';

const ui0 = useUi.getState();
const chain0 = useChainData.getState();
afterEach(() => {
  act(() => {
    useUi.setState(ui0, true);
    useChainData.setState(chain0, true);
    resetWallets();
  });
});
const ui = (node: ReactElement) => render(<Kb>{node}</Kb>);
const ARENA = '0x00000000000000000000000000000000000A7e4A';

describe('lobby: tickets in US dollars with the token amount', () => {
  const prices = { source: 'manual' as const, usdPerToken: '0.001', at: 1, tiers: ARENA_PRICING_DEFAULT.tiers, sigFigs: 2 };
  const arenas = [
    { id: 1, entryFee: 1_000n * ONE, enabled: true },
    { id: 2, entryFee: 3_000n * ONE, enabled: true },
    // not re-priced yet: what it costs now, approximately
    { id: 3, entryFee: 50_000n * ONE, enabled: true },
    { id: 4, entryFee: 10_000n * ONE, enabled: true },
  ];
  const list = (p: typeof prices | null) => {
    act(() => {
      useUi.setState({ chain: chainStatus({ arenaAddress: ARENA }) });
      useChainData.setState({ prices: p });
    });
    const tickets = buildTickets([], arenas, [], { enabled: true, tokenReady: true, decimals: 18 }, [4]);
    return ui(<TicketList tickets={tickets} gates={{}} openTickets={[]} value="practice" onChange={() => {}} onActivate={() => {}} />);
  };
  const row = (id: number) => document.querySelector(`[data-kb-value="arena:${id}"]`) as HTMLElement;

  it('"$1" with "1,000 $ELYMUM" next to it; an arena not at its tier price shows its value', () => {
    list(prices);
    expect(within(row(1)).getByTestId('ticket-usd').textContent).toBe('$1');
    expect(within(row(1)).getByText('1,000 $ELYMUM')).toBeTruthy();
    expect(within(row(2)).getByTestId('ticket-usd').textContent).toBe('$3');
    expect(within(row(3)).getByTestId('ticket-usd')).toMatchObject({ textContent: '≈ $50' });
    expect(within(row(3)).getByTestId('ticket-usd').getAttribute('data-exact')).toBe('no');
    expect(within(row(4)).getByTestId('ticket-usd').textContent).toBe('$10');
    // the $10 arena carries the holders-only tag
    expect(within(row(4)).getByTestId('holders-only')).toBeTruthy();
  });

  it('no token price: the token amount alone, as before', () => {
    list(null);
    expect(screen.queryByTestId('ticket-usd')).toBeNull();
    expect(within(row(1)).getByText('1,000')).toBeTruthy();
  });
});

describe('the holder badge in the lobby (cosmetic)', () => {
  const connect = () => useWallet.setState({ status: 'connected', address: ALICE, chainId: 46630, current: detail(fakeProvider({ accounts: [ALICE] })) });

  it('shows for an emblem holder, not for anyone else', () => {
    act(() => {
      connect();
      useChainData.setState({ holder: true });
    });
    const view = ui(<ProfileCard />);
    expect(screen.getByTestId('holder-badge').textContent).toContain('NFT holder');
    view.unmount();
    act(() => useChainData.setState({ holder: false }));
    ui(<ProfileCard />);
    expect(screen.queryByTestId('holder-badge')).toBeNull();
  });
});

describe('admin: Sync arena prices to USD', () => {
  const settings = (o: Partial<ArenaPricingSettings> = {}): ArenaPricingSettings => ({ ...ARENA_PRICING_DEFAULT, manualUsdPerToken: '0.00081', manualSetAt: 1_800_000_000_000, ...o });
  const viewOf = (s: ArenaPricingSettings): ArenaPricesAdminView => ({
    settings: s,
    defaults: ARENA_PRICING_DEFAULT,
    price: s.manualUsdPerToken ? { ok: true, source: 'manual', usdPerToken: s.manualUsdPerToken, at: s.manualSetAt } : { ok: false, source: 'manual', reason: 'not_set', message: 'no price' },
  });
  const arenaInfo = (id: number, tokens: bigint, o: Record<string, unknown> = {}) => ({ id, exists: true, enabled: true, entryFee: tokens * ONE, maxSessions: 300, openSessions: 0, holdersOnly: false, vault: 0n, owed: 0n, ...o });
  const ctxOf = (api: Partial<AdminApi>, arenas: ReturnType<typeof arenaInfo>[], me = ALICE): ChainCtx & { plans: Plan[] } => {
    const plans: Plan[] = [];
    return {
      net: resolveNetwork(chainStatus({ arenaAddress: ARENA })),
      status: { arena: { code: 'ok', config: { admin: ALICE, token: BOB, decimals: 18, holderNft: BOB }, token: { symbol: '$ELYMUM' }, arenas } } as unknown as StatusSnapshot,
      refresh: vi.fn(async () => {}),
      reloadNet: vi.fn(async () => {}),
      me,
      walletChainId: 46630,
      client: null,
      api: api as AdminApi,
      open: (p: Plan) => plans.push(p),
      plans,
    };
  };

  it('shows the diff (old → new, tokens and USD) and offers exactly the calls that can be signed', async () => {
    const api = { arenaPrices: vi.fn(async () => viewOf(settings())) };
    ui(<ArenaPricesCard ctx={ctxOf(api, [arenaInfo(1, 1_000n), arenaInfo(2, 3_700n), arenaInfo(3, 5_000n, { openSessions: 4 }), arenaInfo(4, 10_000n)])} />);
    await waitFor(() => expect(screen.getByTestId('arena-price-sync')).toBeTruthy());
    const sync = screen.getByTestId('arena-price-sync');
    const r = (id: number) => sync.querySelector(`[data-arena="${id}"]`) as HTMLElement;
    expect(r(1).textContent).toContain('1,000 $ELYMUM · $0.81');
    expect(r(1).textContent).toContain('1,200 $ELYMUM · $0.97');
    expect(r(1).textContent).toContain('updateArena');
    expect(r(2).textContent).toContain('in sync');
    expect(r(3).textContent).toMatch(/4 open tickets/);
    expect(r(4).textContent).toContain('12,000 $ELYMUM · $9.72');
    expect(r(4).textContent).toContain('updateArena + holders only: on');
    // #1 and #4 entries + #4 holders-only; #3 waits for its tickets
    expect(screen.getByTestId('arena-price-sync-go').textContent).toBe('Sign 3 changes with the owner wallet');
    expect((screen.getByTestId('arena-price-sync-go') as HTMLButtonElement).disabled).toBe(false);
  });

  it('blocks the sync without a price, while unsaved, or for a wallet that is not the owner', async () => {
    const api = { arenaPrices: vi.fn(async () => viewOf(settings({ manualUsdPerToken: null, manualSetAt: null }))) };
    const view = ui(<ArenaPricesCard ctx={ctxOf(api, [arenaInfo(1, 1_000n)])} />);
    await waitFor(() => expect(screen.getByText('Set the token price first.')).toBeTruthy());
    expect((screen.getByTestId('arena-price-sync-go') as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
    ui(<ArenaPricesCard ctx={ctxOf({ arenaPrices: vi.fn(async () => viewOf(settings())) }, [arenaInfo(1, 1_000n)], BOB)} />);
    await waitFor(() => expect(screen.getByText('The connected wallet is not the arena owner.')).toBeTruthy());
    expect((screen.getByTestId('arena-price-sync-go') as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves a partial patch (the price, a tier)', async () => {
    const saved = settings();
    const saveArenaPrices = vi.fn(async (patch: Partial<ArenaPricingSettings>) => viewOf({ ...saved, ...patch }));
    ui(<ArenaPricesCard ctx={ctxOf({ arenaPrices: vi.fn(async () => viewOf(saved)), saveArenaPrices }, [arenaInfo(1, 1_000n)])} />);
    await waitFor(() => expect(screen.getByTestId('arena-tiers')).toBeTruthy());
    expect(arenaPricingPatch(saved, { ...saved, manualUsdPerToken: '0.002' })).toEqual({ manualUsdPerToken: '0.002' });
    expect(arenaPricingPatch(saved, { ...saved, tiers: saved.tiers.map((t) => (t.arenaId === 2 ? { ...t, usdCents: 250 } : t)) })).toEqual({
      tiers: [saved.tiers[0], { arenaId: 2, usdCents: 250, holdersOnly: false }, saved.tiers[2], saved.tiers[3]],
    });
    expect(arenaPricingPatch(saved, saved)).toEqual({});
  });
});
