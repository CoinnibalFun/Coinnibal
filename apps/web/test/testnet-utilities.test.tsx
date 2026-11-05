import type { StatusSnapshot } from '@elymum/sdk/ops';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MapsCard, mapsPatch } from '../src/admin/GameTab';
import { adminHash, groupSummary, parseAdminHash } from '../src/admin/groups';
import { ImportHoldersCard } from '../src/admin/MintTab';
import { mainnetChecklist } from '../src/admin/NetworkTab';
import { resolveNetwork } from '../src/admin/net';
import type { Plan } from '../src/admin/plan';
import { HoldersOnlyCard } from '../src/admin/SetupExtras';
import type { ChainCtx } from '../src/admin/ui';
import { Kb } from '../src/design';
import { adminApi, type MapAdminView } from '../src/site/api';
import { FaucetPage } from '../src/site/faucet/FaucetPage';
import { claimErrorText, faucetTokenAddress, servedConfig, faucetView, formatWait, holderMultiple, watchAssetParams, wholeTokens } from '../src/site/faucet/logic';
import { emblemPerks } from '../src/site/mint/logic';
import { isLazyPage, loadedPage, resetPages, warmPage } from '../src/site/pages';
import { navigate } from '../src/site/router';
import { resetServerChain } from '../src/site/serverChain';
import { navFor } from '../src/site/Shell';
import { Feed } from '../src/ui/game/Feed';
import { useUi } from '../src/store';
import { buildTickets, quickPlayTarget, ticketGate, type TicketModel } from '../src/wallet/ticket';
import { resetWallets } from '../src/wallet/store';
import { ALICE, ONE, chainStatus } from './evm-helpers';
import { installDomStubs, mockFetch } from './site-helpers';

const ARENA = '0x00000000000000000000000000000000000a4e4a';
const ui = (node: ReactElement) => render(<Kb>{node}</Kb>);

let restore: (() => void) | null = null;
beforeEach(() => {
  installDomStubs();
  resetServerChain();
});
afterEach(() => {
  restore?.();
  restore = null;
  act(() => resetWallets());
});

/* ── navigation ───────────────────────────────────────────────────── */

describe('fast navigation', () => {
  it('keeps the header short: Play, Mint, Faucet only on testnet, WL, Docs', () => {
    expect(navFor(true).map((n) => n.label)).toEqual(['Play', 'Mint', 'Faucet', 'WL', 'Docs']);
    expect(navFor(false).map((n) => n.label)).toEqual(['Play', 'Mint', 'WL', 'Docs']);
    expect(navFor(null).map((n) => n.label)).toEqual(['Play', 'Mint', 'WL', 'Docs']);
  });

  it('warms a page once and hands the loaded component back synchronously after that', async () => {
    resetPages();
    expect(isLazyPage('/faucet')).toBe(true);
    expect(isLazyPage('/')).toBe(false);
    expect(loadedPage('/docs')).toBeNull();
    const a = warmPage('/docs');
    const b = warmPage('/docs');
    expect(a).toBe(b);
    const c = await a;
    expect(c).toBeTypeOf('function');
    expect(loadedPage('/docs')).toBe(c);
  });

  it('a click on a page that is not warm waits for its chunk, then turns the page', async () => {
    resetPages();
    history.replaceState(null, '', '/');
    navigate('/wl');
    // the old page stays until the chunk is in (no loader flash)
    expect(location.pathname).toBe('/');
    await waitFor(() => expect(location.pathname).toBe('/wl'), { timeout: 3000 });
    history.replaceState(null, '', '/');
  });
});

/* ── faucet ───────────────────────────────────────────────────────── */

describe('the faucet', () => {
  it('picks what to show from the chain and the token', () => {
    expect(faucetView({ chain: 'loading', token: null })).toBe('loading');
    expect(faucetView({ chain: 'off', token: '0x1' })).toBe('offline');
    expect(faucetView({ chain: 'mainnet', token: '0x1' })).toBe('mainnet');
    expect(faucetView({ chain: 'testnet', token: null })).toBe('no-token');
    expect(faucetView({ chain: 'testnet', token: '0x1', tokenUnreadable: true })).toBe('no-token');
    expect(faucetView({ chain: 'testnet', token: '0x1' })).toBe('ready');
  });

  it('reads the TestToken from the registry first, then the game token', () => {
    const rec = (address: string) => ({ address, txHash: null, chainId: 46630, registeredAt: 1, registeredBy: ALICE });
    expect(faucetTokenAddress({ arena: null, nft: null, token: rec('0xaa') }, '0xbb')).toBe('0xaa');
    expect(faucetTokenAddress({ arena: null, nft: null, token: null }, '0xbb')).toBe('0xbb');
    expect(faucetTokenAddress(null, null)).toBeNull();
  });

  it('formats the countdown, the amounts, the holder bonus and the watchAsset call', () => {
    expect(formatWait(3599)).toBe('59:59');
    expect(formatWait(3661)).toBe('1:01:01');
    expect(formatWait(-5)).toBe('0:00');
    expect(wholeTokens(1_000_000n * ONE, 18)).toBe('1,000,000');
    expect(holderMultiple({ amount: 1_000_000n * ONE, holderAmount: 2_000_000n * ONE, holderNft: '0xnft' })).toBe(2);
    expect(holderMultiple({ amount: 1n, holderAmount: 2n, holderNft: null })).toBeNull();
    expect(watchAssetParams('0xabc', 'tELYMUM', 18)).toEqual({ type: 'ERC20', options: { address: '0xabc', symbol: 'tELYMUM', decimals: 18 } });
    expect(watchAssetParams('0xabc', 'AVERYLONGSYMBOL', 18).options.symbol).toHaveLength(11);
  });

  it('a failed claim from a wallet with no ETH says it is the gas, not the contract', () => {
    expect(claimErrorText({ kind: 'revert' }, true, 'The contract refused the transaction.')).toMatch(/no ETH for the network fee/);
    expect(claimErrorText({ kind: 'insufficient-funds' }, false, 'x')).toMatch(/no ETH/);
    expect(claimErrorText({ kind: 'revert' }, false, 'The contract refused the transaction.')).toBe('The contract refused the transaction.');
    expect(claimErrorText({ kind: 'rejected' }, true, 'You cancelled.')).toBe('You cancelled.');
  });

  it("takes the server's faucet settings (GET /api/site/faucet)", () => {
    const f = { enabled: true, chainId: 46630, token: '0x00000000000000000000000000000000000007e5', decimals: 18, amount: (1_000_000n * ONE).toString(), holderAmount: (2_000_000n * ONE).toString(), cooldownSecs: 3600, holderNft: '0x0000000000000000000000000000000000000f7e', gasFaucetUrl: 'https://x' };
    expect(servedConfig(f, f.token)).toMatchObject({ amount: 1_000_000n * ONE, holderAmount: 2_000_000n * ONE, cooldownSecs: 3600, holderNft: f.holderNft });
    expect(servedConfig({ ...f, enabled: false }, f.token)).toBeNull();
    expect(servedConfig({ ...f, amount: null }, f.token)).toBeNull();
  });

  it('a testnet server whose faucet is off shows the not-plumbed note', async () => {
    ({ restore } = mockFetch({
      'GET /api/config': { chain: chainStatus() },
      'GET /api/site/faucet': { enabled: false, chainId: 46630, token: null, decimals: 18, amount: null, holderAmount: null, cooldownSecs: null, holderNft: null, gasFaucetUrl: 'https://x' },
    }));
    ui(<FaucetPage />);
    expect(await screen.findByTestId('fc-no-token')).toBeTruthy();
  });

  it('on mainnet the route says the faucet is testnet only', async () => {
    ({ restore } = mockFetch({ 'GET /api/config': { chain: chainStatus({ chainId: 4663, chainName: 'Robinhood Chain', testnet: false, faucetUrl: null }) } }));
    ui(<FaucetPage />);
    expect(await screen.findByText('Faucet is testnet only')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Site' }).textContent).not.toContain('Faucet');
  });

  it('on testnet without a registered TestToken it says the tap is not plumbed in yet', async () => {
    ({ restore } = mockFetch({
      'GET /api/config': { chain: chainStatus({ token: null }) },
      'GET /api/site/contracts': { arena: null, nft: null, token: null },
    }));
    ui(<FaucetPage />);
    expect(await screen.findByTestId('fc-no-token')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Site' }).textContent).toContain('Faucet'));
  });
});

/* ── NFT utilities ────────────────────────────────────────────────── */

describe('what the emblem does', () => {
  it('on testnet: open game, the WL carry-over and the faucet bonus; never mainnet access as live', () => {
    const t = emblemPerks(true);
    expect(t.map((p) => p.id)).toEqual(['access', 'fee', 'isles', 'wl', 'skin', 'faucet']);
    expect(t[0].note).toMatch(/testnet the ring is open to everyone/);
    // before the server's rates are known: the suggested holder pair (15 % + 0 %) against the defaults (15 % + 5 %)
    expect(t[1].title).toBe('15% fee instead of 20%');
    expect(t[1].note).toMatch(/profit only/);
  });
  it('on testnet: says "open to everyone" only while the server lets everyone in', () => {
    expect(emblemPerks(true, { gameAccess: 'public' })[0].note).toMatch(/open to everyone/);
    expect(emblemPerks(true, { gameAccess: 'holders' })[0].note).toMatch(/open to holders only/);
    expect(emblemPerks(true, { gameAccess: 'admins' })[0].note).not.toMatch(/open to everyone/);
  });
  it('on mainnet: no testnet lines', () => {
    expect(emblemPerks(false).map((p) => p.id)).toEqual(['access', 'fee', 'isles', 'skin']);
    const fees = { ...chainStatus().fees!, holderPerks: true, holderBurnBps: 1000, holderVaultBps: 250 };
    expect(emblemPerks(false, { fees })[1].title).toBe('12.5% fee instead of 20%');
    expect(emblemPerks(true, { fees })[1].note).not.toMatch(/entry fee/);
  });
});

describe('holders-only arenas and the holder fee in the lobby', () => {
  const arenas = [
    { id: 1, entryFee: 1000n * ONE, enabled: true, exists: true },
    { id: 4, entryFee: 250_000n * ONE, enabled: true, exists: true },
  ];
  const gate = (t: TicketModel, holder: boolean | null) =>
    ticketGate({ ticket: t, arenasEnabled: true, walletConnected: true, verified: true, balance: 1_000_000n * ONE, session: null, pending: [], nowS: 0, holder });

  it('marks the arena and refuses to sell it to a wallet without an emblem', () => {
    const tickets = buildTickets([], arenas, [], undefined, [4]);
    const isles = tickets.find((t) => t.arenaId === 4)!;
    expect(isles.holdersOnly).toBe(true);
    expect(tickets.find((t) => t.arenaId === 1)!.holdersOnly).toBeUndefined();
    expect(gate(isles, false)).toEqual({ kind: 'holders' });
    expect(gate(isles, true)).toEqual({ kind: 'buy' });
    // unknown: the contract still checks at join
    expect(gate(isles, null)).toEqual({ kind: 'buy' });
    expect(quickPlayTarget({ walletConnected: true, balance: 1_000_000n * ONE, tickets: [isles], lastArena: 4, holder: false })).toBe('practice');
    expect(quickPlayTarget({ walletConnected: true, balance: 1_000_000n * ONE, tickets: [isles], lastArena: 4, holder: true })).toBe('arena:4');
  });
});

/* ── BOT tags ─────────────────────────────────────────────────────── */

describe('BOT tags', () => {
  it('the kill feed tags bots and says when a bot went home', () => {
    act(() =>
      useUi.setState({
        killfeed: [
          { id: 0, killer: 'marco_88', killerSkin: 1, killerIsBot: true, victim: 'ella', victimSkin: 2, cause: 'eat', at: Date.now() },
          { id: 1, killer: '', killerSkin: 0, victim: 'sophie_m', victimSkin: 3, victimIsBot: true, cause: 'left', at: Date.now() },
        ],
        chat: [],
      }),
    );
    ui(<Feed narrow={false} />);
    const tags = screen.getAllByTestId('bot-tag');
    expect(tags).toHaveLength(2);
    expect(tags[0].textContent).toBe('BOT');
    expect(screen.getByText(/went home/).textContent).toContain('sophie_m');
    act(() => useUi.setState({ killfeed: [] }));
  });
});

/* ── admin ─────────────────────────────────────────────────────────── */

const ctxOf = (over: Partial<ChainCtx> = {}): ChainCtx & { plans: Plan[] } => {
  const plans: Plan[] = [];
  return {
    net: resolveNetwork(chainStatus()),
    status: null,
    refresh: vi.fn(async () => {}),
    reloadNet: vi.fn(async () => {}),
    me: ALICE,
    walletChainId: 46630,
    client: null,
    api: null,
    open: (p: Plan) => plans.push(p),
    plans,
    ...over,
  };
};

describe('admin groups', () => {
  it('maps the old drawers into the groups and back to a hash', () => {
    expect(parseAdminHash('#deploy')).toEqual({ group: 'setup', sub: 'wl' });
    expect(parseAdminHash('#arena').group).toBe('game');
    expect(parseAdminHash('#tasks')).toEqual({ group: 'community', sub: 'tasks' });
    expect(parseAdminHash('#community/collabs')).toEqual({ group: 'community', sub: 'collabs' });
    expect(parseAdminHash('#integrity').group).toBe('safety');
    expect(parseAdminHash('')).toEqual({ group: 'network', sub: 'wl' });
    expect(adminHash('network')).toBe('');
    expect(adminHash('community', 'tasks')).toBe('#community/tasks');
    expect(adminHash('game')).toBe('#game');
  });

  it('opens every drawer with what is true now and the next step', () => {
    const net = resolveNetwork(chainStatus({ nftAddress: null }));
    const status = { block: 12n, arena: { code: 'ok', serverBalance: 0n, config: { token: null, holderNft: null }, arenas: [] }, nft: null } as unknown as StatusSnapshot;
    expect(groupSummary('network', { net, status })).toMatchObject({ next: expect.stringMatching(/Fund the server key/) });
    expect(groupSummary('network', { net, status }).now).toMatch(/Testnet · Robinhood Chain Testnet \(46630\) · block 12/);
    expect(groupSummary('setup', { net, status }).next).toMatch(/Deploy ElymumNFT/);
    // registered: the next step is Finish setup, never "register" or "paste an address"
    const both = resolveNetwork(chainStatus({ nftAddress: '0x0000000000000000000000000000000000000f7e' }));
    const registered = {
      ...status,
      arena: { ...status.arena, address: ARENA, config: { admin: ALICE, serverAuthority: '0x000000000000000000000000000000000000bEEF', token: null, burnBps: 1500, vaultBps: 500, holderNft: null }, token: null, arenas: [] },
      nft: { address: '0x0000000000000000000000000000000000000f7e', code: 'ok', state: { phaseName: 'closed' } },
      testToken: { address: '0x0000000000000000000000000000000000007e57', faucet: { holderNft: null } },
    } as unknown as StatusSnapshot;
    expect(groupSummary('setup', { net: both, status: registered }).next).toMatch(/^Finish setup: 9 steps left/);
    const mainnet = resolveNetwork(chainStatus({ chainId: 4663, chainName: 'Robinhood Chain', testnet: false, faucetUrl: null, nftAddress: '0x0000000000000000000000000000000000000f7e' }));
    const noTt = { ...registered, testToken: null } as unknown as StatusSnapshot;
    expect(groupSummary('setup', { net: mainnet, status: noTt, registry: { token: { address: '0x0000000000000000000000000000000000007e57' } } as never }).next).toMatch(/Confirm the game token/);
    expect(groupSummary('setup', { net: mainnet, status: noTt }).next).toMatch(/TOKEN_ADDRESS/);
    for (const g of ['setup', 'mint', 'game', 'network'] as const) expect(groupSummary(g, { net: both, status: registered }).next ?? '').not.toMatch(/regist|paste/i);
    expect(groupSummary('network', { net: resolveNetwork(chainStatus({ enabled: false, chainId: null })), status: null }).next).toMatch(/EVM_RPC_URL/);
    expect(groupSummary('game', { net, status, settings: { gameAccess: 'admins' } as never }).next).toMatch(/Testnet: open the game to everyone/);
  });

  it('lists the mainnet launch with the Render step first; nothing is ticked on testnet', () => {
    const steps = mainnetChecklist(resolveNetwork(chainStatus()), null);
    expect(steps[0].label).toMatch(/Set EVM_RPC_URL \(and CHAIN_ID\) in Render/);
    expect(steps.filter((s) => s.ok === true)).toHaveLength(0);
    const main = mainnetChecklist(resolveNetwork(chainStatus({ chainId: 4663, chainName: 'Robinhood Chain', testnet: false, faucetUrl: null })), null);
    expect(main[0].ok).toBe(true);
  });

  it('marks an arena holders-only through the transaction preview', () => {
    const status = {
      arena: { config: { admin: ALICE, holderNft: '0x0000000000000000000000000000000000000f7e', decimals: 18 }, arenas: [{ id: 4, exists: true, enabled: true, entryFee: 1n, holdersOnly: false }] },
    } as unknown as StatusSnapshot;
    const ctx = ctxOf({ net: resolveNetwork(chainStatus({ arenaAddress: ARENA })), status });
    ui(<HoldersOnlyCard ctx={ctx} />);
    fireEvent.click(screen.getByTestId('holders-only-4'));
    expect(ctx.plans[0].call).toMatchObject({ functionName: 'setArenaHoldersOnly', args: [4, true] });
    expect(ctx.plans[0].ownerOf?.toLowerCase()).toBe(ARENA);
  });

  it('"Import testnet holders" is disabled with a note while the server has no route', async () => {
    // (mockFetch answers 404 to every route)
    ({ restore } = mockFetch({}));
    ui(<ImportHoldersCard ctx={ctxOf({ api: adminApi('t') })} />);
    expect(await screen.findByTestId('mint-import-missing')).toBeTruthy();
    expect((screen.getByTestId('mint-import') as HTMLButtonElement).disabled).toBe(true);
  });

  it('imports and reports the counts when the route is there', async () => {
    const empty = { entries: [], counts: { wallets: 0, tokens: 0, alsoWl: 0 }, importedAt: null, importedFrom: null };
    let body: unknown = null;
    ({ restore } = mockFetch({
      'GET /api/admin/mint/import-holders': empty,
      'POST /api/admin/mint/import-holders': (c: { body: unknown }) => {
        body = c.body;
        return { entries: [], counts: { wallets: 12, tokens: 15, alsoWl: 3 }, importedAt: Date.UTC(2026, 9, 31, 20, 0), importedFrom: 46630 };
      },
    }));
    ui(<ImportHoldersCard ctx={ctxOf({ api: adminApi('t') })} />);
    await waitFor(() => expect((screen.getByTestId('mint-import') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('mint-import'));
    expect((await screen.findByTestId('mint-import-result')).textContent).toMatch(/^12 wallets \(15 emblems\) · 3 also on the WL · imported .* from chain 46630$/);
    expect(body).toEqual({});
  });

  const MAPS: MapAdminView = {
    settings: {
      practiceRookie: { auto: true, perPlayer: 900, min: 3000, max: 9000 },
      arena: { auto: true, perPlayer: 900, min: 3000, max: 9000 },
    },
    defaults: {
      practiceRookie: { auto: true, perPlayer: 900, min: 3000, max: 9000 },
      arena: { auto: true, perPlayer: 900, min: 3000, max: 9000 },
    },
    rooms: [
      { id: 'r1', kind: 'arena', name: 'Asphodel Meadow', arenaId: 1, humans: 2, bots: 0, mapSide: 3600, mapAuto: true },
      { id: 'c1', kind: 'private', name: 'Bots', humans: 1, bots: 3, mapSide: 3000, mapAuto: true },
    ],
  };

  it('sends only the map fields that changed', () => {
    const draft = structuredClone(MAPS.settings);
    draft.arena.perPlayer = 1000;
    draft.practiceRookie.auto = false;
    expect(mapsPatch(MAPS.settings, draft)).toEqual({ arena: { perPlayer: 1000 }, practiceRookie: { auto: false } });
    expect(mapsPatch(MAPS.settings, structuredClone(MAPS.settings))).toEqual({});
  });

  it('shows the map curve per room kind with a preview and the live rooms, and saves only what changed', async () => {
    let put: unknown = null;
    ({ restore } = mockFetch({
      'GET /api/admin/maps': MAPS,
      'PUT /api/admin/maps': (c: { body: unknown }) => {
        put = c.body;
        return MAPS;
      },
    }));
    ui(<MapsCard ctx={ctxOf({ api: adminApi('t') })} />);
    const table = await screen.findByTestId('maps-table');
    // people only in arenas and practice; the practice bots of a free custom room are counted apart
    expect(screen.getByText('3 people · 2 rooms · 3 practice bots')).toBeTruthy();
    expect(document.body.textContent).toMatch(/Practice bots exist only in free custom rooms/);
    // the curve at 5 / 10 / 25 / 50 / 100 players, and the live room's side
    expect(table.textContent).toContain('3000 / 3000 / 4500 / 6400 / 9000');
    expect(table.textContent).toContain('3600');
    fireEvent.change(screen.getByLabelText('arena map per player'), { target: { value: '1000' } });
    fireEvent.click(screen.getByLabelText('Practice · rookie map auto size'));
    expect(table.textContent).toContain('preset');
    fireEvent.click(screen.getByTestId('maps-save'));
    await waitFor(() => expect(put).toEqual({ arena: { perPlayer: 1000 }, practiceRookie: { auto: false } }));
  });

  it('says so when the server has no map route yet', async () => {
    ({ restore } = mockFetch({}));
    ui(<MapsCard ctx={ctxOf({ api: adminApi('t') })} />);
    expect(await screen.findByText(/no map settings route yet/)).toBeTruthy();
  });
});
