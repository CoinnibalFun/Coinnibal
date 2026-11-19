import type { StatusSnapshot } from '@coinnibal/sdk/ops';
import { LOCALNET_CHAIN_ID, ROBINHOOD_CHAIN_ID } from '@coinnibal/shared';
import { act, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { getAddress } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeployTab } from '../src/admin/DeployTab';
import { launchChecklist } from '../src/admin/LaunchTab';
import { mainnetChecklist } from '../src/admin/NetworkTab';
import { resolveNetwork } from '../src/admin/net';
import { PIN_REBUILD, PIN_VPS_KEY, pinReport, pinSummary, registeredPinReport } from '../src/admin/pins';
import { PinsCard } from '../src/admin/PinsCard';
import { NO_TEST_TOKEN_YET } from '../src/admin/setup';
import { SetupTab } from '../src/admin/SetupTab';
import type { ChainCtx } from '../src/admin/ui';
import { Kb } from '../src/design';
import { buildPins } from '../src/wallet/pinned';
import { resetWallets } from '../src/wallet/store';
import { ALICE, chainStatus } from './evm-helpers';

const ARENA = getAddress('0x00000000000000000000000000000000000a4e4a');
const NFT = getAddress('0x0000000000000000000000000000000000000f7e');
const TOKEN = getAddress('0x0000000000000000000000000000000000007e57');
const OTHER = getAddress('0x000000000000000000000000000000000000bEEF');
const TESTNET = 46630;

afterEach(() => act(() => resetWallets()));
const ui = (node: ReactElement) => render(<Kb>{node}</Kb>);

/** The panel's status read: the arena (with its token or none), the NFT and, when given, a registered TestToken. */
const status = (o: { token?: string | null; testToken?: string | null } = {}): StatusSnapshot =>
  ({
    block: 1n,
    arena: { address: ARENA, code: 'ok', config: { admin: ALICE, serverAuthority: OTHER, token: o.token ?? null, burnBps: 1500, vaultBps: 500, holderNft: null, holderBurnBps: 800, holderVaultBps: 200, decimals: 18 }, token: null, arenas: [], serverBalance: 10n ** 17n },
    nft: { address: NFT, code: 'ok', state: { phaseName: 'closed', price: 1n, root: `0x${'0'.repeat(64)}` } },
    testToken: o.testToken ? { address: o.testToken, code: 'ok', faucet: null } : null,
  }) as unknown as StatusSnapshot;

const registered = (over: Record<string, unknown> = {}) => resolveNetwork(chainStatus({ arenaAddress: ARENA, nftAddress: NFT, ...over }));

function ctxOf(over: Partial<ChainCtx> = {}): ChainCtx {
  return {
    net: registered(),
    status: status(),
    refresh: vi.fn(async () => {}),
    reloadNet: vi.fn(async () => {}),
    me: ALICE,
    walletChainId: TESTNET,
    client: null,
    api: null,
    open: vi.fn(),
    ...over,
  };
}

describe('site pins against the registered contracts', () => {
  it('all pinned: nothing to do, and the lines still name the registered addresses', () => {
    const r = pinReport({ chainId: TESTNET, arena: ARENA.toLowerCase(), nft: NFT, token: TOKEN }, buildPins({ arena: ARENA, nft: NFT.toLowerCase(), token: TOKEN }));
    expect(r.ok).toBe(true);
    expect(r.rows.map((x) => x.state)).toEqual(['match', 'match', 'match']);
    expect(r.todo).toEqual([]);
    expect(r.envLines).toEqual([`COINNIBAL_PIN_ARENA=${ARENA}`, `COINNIBAL_PIN_NFT=${NFT}`, `COINNIBAL_PIN_TOKEN=${TOKEN}`]);
    expect(r.viteLines).toEqual([`VITE_CHAIN_ID=${TESTNET}`, `VITE_ARENA_ADDRESS=${ARENA}`, `VITE_NFT_ADDRESS=${NFT}`, `VITE_TOKEN_ADDRESS=${TOKEN}`]);
    expect(pinSummary(r)).toBe('Built with the registered CoinnibalArena, CoinnibalNFT, game token.');
  });

  it("the owner's new deploy: nothing pinned yet, each contract named, the token only once it is set", () => {
    const fresh = buildPins({});
    const r = pinReport({ chainId: TESTNET, arena: ARENA, nft: NFT, token: null }, fresh);
    expect(r.ok).toBe(false);
    expect(r.rows.map((x) => [x.kind, x.state])).toEqual([
      ['arena', 'missing'],
      ['nft', 'missing'],
    ]);
    expect(r.envLines).toEqual([`COINNIBAL_PIN_ARENA=${ARENA}`, `COINNIBAL_PIN_NFT=${NFT}`]);
    expect(pinSummary(r)).toBe(`Not pinned in this build: CoinnibalArena, CoinnibalNFT. Setup → Site pins: the lines for /opt/elymum/.env, then ${PIN_REBUILD} on the VPS.`);
    // after setToken: the arena and NFT are pinned, the token is not yet
    const after = pinReport({ chainId: TESTNET, arena: ARENA, nft: NFT, token: TOKEN }, buildPins({ arena: ARENA, nft: NFT }));
    expect(after.ok).toBe(false);
    expect(after.todo.map((x) => x.kind)).toEqual(['token']);
    expect(after.envLines.at(-1)).toBe(`COINNIBAL_PIN_TOKEN=${TOKEN}`);
    expect(PIN_REBUILD).toBe('coinnibal-compose up -d --build app');
    expect(PIN_VPS_KEY).toEqual({ arena: 'COINNIBAL_PIN_ARENA', nft: 'COINNIBAL_PIN_NFT', token: 'COINNIBAL_PIN_TOKEN' });
  });

  it('a pin of an older deployment is named as different', () => {
    const r = pinReport({ chainId: TESTNET, arena: ARENA, nft: NFT, token: null }, buildPins({ arena: OTHER, nft: NFT }));
    expect(r.rows.find((x) => x.kind === 'arena')).toMatchObject({ state: 'differs', pinned: OTHER });
    expect(pinSummary(r)).toMatch(/^Pinned to another address: CoinnibalArena\./);
  });

  it('a broken pin, a build for another chain, the local node, and nothing to compare', () => {
    const broken = pinReport({ chainId: TESTNET, arena: ARENA, nft: NFT, token: null }, buildPins({ arena: ARENA, nft: NFT, token: 'token.eth' }));
    expect(broken.ok).toBe(false);
    expect(broken.invalid).toEqual([{ env: 'VITE_TOKEN_ADDRESS', key: 'COINNIBAL_PIN_TOKEN' }]);
    // the token is not set yet: its line clears the broken pin
    expect(broken.envLines).toEqual([`COINNIBAL_PIN_ARENA=${ARENA}`, `COINNIBAL_PIN_NFT=${NFT}`, 'COINNIBAL_PIN_TOKEN=']);
    expect(pinSummary(broken)).toMatch(/^VITE_TOKEN_ADDRESS of this build is not an address: the site signs nothing\./);
    // a testnet build on a server that moved to the mainnet: nothing is pinned there
    const moved = pinReport({ chainId: ROBINHOOD_CHAIN_ID, arena: ARENA, nft: NFT, token: null }, buildPins({ arena: ARENA, nft: NFT }));
    expect(moved).toMatchObject({ ok: false, buildChainId: TESTNET, chainId: ROBINHOOD_CHAIN_ID });
    expect(moved.viteLines[0]).toBe(`VITE_CHAIN_ID=${ROBINHOOD_CHAIN_ID}`);
    // the local node may run unpinned
    const local = pinReport({ chainId: LOCALNET_CHAIN_ID, arena: ARENA, nft: NFT, token: TOKEN }, buildPins({}));
    expect(local.ok).toBe(true);
    expect(local.rows.every((x) => x.state === 'local')).toBe(true);
    expect(pinSummary(local)).toMatch(/local node runs unpinned/);
    expect(pinReport({ chainId: null, arena: ARENA, nft: NFT, token: null }).ok).toBeNull();
    expect(pinSummary(pinReport({ chainId: TESTNET, arena: null, nft: null, token: null }))).toBe('Nothing registered yet.');
  });

  it("reads the arena's token from the panel's read, the server's only while that is not in", () => {
    // the arena has no token yet (the server's status names one: the panel's read wins)
    expect(registeredPinReport(registered(), status({ token: null }), buildPins({})).rows.map((x) => x.kind)).toEqual(['arena', 'nft']);
    expect(registeredPinReport(registered(), status({ token: TOKEN }), buildPins({})).rows.map((x) => x.kind)).toEqual(['arena', 'nft', 'token']);
    expect(registeredPinReport(registered(), null, buildPins({})).rows.map((x) => x.kind)).toEqual(['arena', 'nft', 'token']);
  });
});

describe('the launch checklist line and the mainnet step', () => {
  const lines = (pins = buildPins({}), st = status()) => launchChecklist({ net: registered(), status: st, allowlist: null, settings: null, quote: null, pins });

  it('"The site trusts the registered contracts" goes green only with the registered addresses pinned', () => {
    const todo = lines().find((x) => x.id === 'pins')!;
    expect(todo).toMatchObject({ label: 'The site trusts the registered contracts', ok: false, tab: 'deploy' });
    expect(todo.detail).toMatch(/Not pinned in this build: CoinnibalArena, CoinnibalNFT\. Setup → Site pins/);
    expect(lines(buildPins({ arena: ARENA, nft: NFT })).find((x) => x.id === 'pins')?.ok).toBe(true);
    // once the token is set it needs its pin too
    expect(lines(buildPins({ arena: ARENA, nft: NFT }), status({ token: TOKEN })).find((x) => x.id === 'pins')?.ok).toBe(false);
  });

  it('the testnet token line: deploy a TestToken first while none is registered', () => {
    expect(lines().find((x) => x.id === 'token')?.detail).toBe(NO_TEST_TOKEN_YET);
    expect(NO_TEST_TOKEN_YET).toBe('Deploy a TestToken first (the TestToken card in Setup); then Finish setup sets it, with one confirmation.');
    expect(lines(buildPins({}), status({ testToken: TOKEN })).find((x) => x.id === 'token')?.detail).toBe('Setup → Finish setup (it sets the registered TestToken).');
  });

  it('the mainnet launch pins the contracts right after the deploys, before the mint', () => {
    const main = resolveNetwork(chainStatus({ chainId: ROBINHOOD_CHAIN_ID, chainName: 'Robinhood Chain', testnet: false, faucetUrl: null, arenaAddress: ARENA, nftAddress: NFT }));
    const steps = mainnetChecklist(main, status(), buildPins({ chainId: String(ROBINHOOD_CHAIN_ID) }));
    expect(steps.map((s) => s.id).slice(3, 7)).toEqual(['arena', 'nft', 'pins', 'allowlist']);
    expect(steps.find((s) => s.id === 'pins')).toMatchObject({ ok: false, where: 'Server', detail: expect.stringContaining(PIN_REBUILD) });
    expect(mainnetChecklist(main, status(), buildPins({ chainId: String(ROBINHOOD_CHAIN_ID), arena: ARENA, nft: NFT })).find((s) => s.id === 'pins')?.ok).toBe(true);
    expect(steps.find((s) => s.id === 'token')?.detail).toMatch(/Then pin it: COINNIBAL_PIN_TOKEN/);
    // on the testnet nothing of the mainnet list is ticked
    expect(mainnetChecklist(registered(), status(), buildPins({ arena: ARENA, nft: NFT })).find((s) => s.id === 'pins')?.ok).toBe(false);
  });
});

describe('Setup → Site pins', () => {
  it('pins match: one green line', () => {
    ui(<PinsCard ctx={ctxOf({ status: status({ token: TOKEN }) })} pins={buildPins({ arena: ARENA, nft: NFT, token: TOKEN })} />);
    expect(screen.getByTestId('site-pins-ok').textContent).toBe('The site trusts the registered contracts.');
    expect(screen.queryByTestId('site-pins-todo')).toBeNull();
    expect([...document.querySelectorAll('[data-pin]')].map((e) => e.getAttribute('data-state'))).toEqual(['match', 'match', 'match']);
  });

  it('pins differ: names each contract, the .env lines, the wallet check, the rebuild and the build outside Docker', () => {
    ui(<PinsCard ctx={ctxOf()} pins={buildPins({ arena: OTHER })} />);
    const todo = screen.getByTestId('site-pins-todo');
    expect(todo.textContent).toMatch(/CoinnibalArena is pinned to another address; CoinnibalNFT is not pinned\./);
    // each row: the state in a pill, what it means under it
    expect([...document.querySelectorAll('[data-pin]')].map((e) => e.textContent)).toEqual(['pinned to another address', 'not pinned']);
    expect(screen.getByText(`This build pins ${OTHER}: the site refuses the registered arena.`)).toBeTruthy();
    expect(screen.getByText('The mint page signs nothing until it is pinned.')).toBeTruthy();
    expect(todo.textContent).toContain('Check each address against the deploy transaction in your own wallet before you paste it.');
    expect(todo.textContent).toContain('/opt/elymum/.env');
    expect(todo.textContent).toContain(`COINNIBAL_PIN_ARENA=${ARENA}`);
    expect(todo.textContent).toContain(`COINNIBAL_PIN_NFT=${NFT}`);
    // no token line before the arena's token is set
    expect(todo.textContent).not.toContain('COINNIBAL_PIN_TOKEN');
    expect(todo.textContent).toContain(PIN_REBUILD);
    expect(todo.textContent).toContain(`VITE_CHAIN_ID=${TESTNET}`);
    expect(todo.textContent).toContain(`VITE_ARENA_ADDRESS=${ARENA}`);
    expect(screen.getByText(/The game token gets its line here once it is set on the arena/)).toBeTruthy();
    expect(within(todo).getAllByRole('button', { name: /Copy the (lines|command)/ })).toHaveLength(3);
  });

  it('sits in Setup once the contracts are registered (this build pins nothing in tests)', () => {
    ui(<SetupTab ctx={ctxOf({ registry: { arena: { address: ARENA }, nft: { address: NFT }, token: null } as never })} />);
    const card = document.querySelector('[data-card="site-pins"]')!;
    expect(card).toBeTruthy();
    expect(card.closest('details')).toBeNull();
    expect(within(card as HTMLElement).getByTestId('site-pins-todo')).toBeTruthy();
  });
});

describe('Setup → Advanced, the token step of the wizard (testnet)', () => {
  it('says to deploy a TestToken first while none is registered, and keeps today\'s text once one is', () => {
    const view = ui(<DeployTab ctx={ctxOf()} advanced />);
    expect(document.querySelector('[data-card="deploy-token-note"]')?.textContent).toContain(NO_TEST_TOKEN_YET);
    view.unmount();
    ui(<DeployTab ctx={ctxOf({ status: status({ testToken: TOKEN }) })} advanced />);
    expect(document.querySelector('[data-card="deploy-token-note"]')?.textContent).toContain('Finish setup (top of Setup) sets it, or the game token card in this section with one confirmation.');
  });
});
