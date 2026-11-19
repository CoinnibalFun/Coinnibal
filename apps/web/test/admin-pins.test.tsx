import type { StatusSnapshot } from '@coinnibal/sdk/ops';
import { LOCALNET_CHAIN_ID, OWNER_WALLET, ROBINHOOD_CHAIN_ID } from '@coinnibal/shared';
import { act, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeployTab } from '../src/admin/DeployTab';
import { launchChecklist } from '../src/admin/LaunchTab';
import { mainnetChecklist } from '../src/admin/NetworkTab';
import { resolveNetwork } from '../src/admin/net';
import { PIN_BUILD_FIRST, PIN_REBUILD, PIN_SWAP, PIN_VPS_KEY, pinReport, pinSummary, pinTodoLine, registeredPinReport } from '../src/admin/pins';
import { PinsCard } from '../src/admin/PinsCard';
import { NO_TEST_TOKEN_YET } from '../src/admin/setup';
import { SetupTab } from '../src/admin/SetupTab';
import type { ChainCtx } from '../src/admin/ui';
import { Kb } from '../src/design';
import { buildPins, verifySignedPins } from '../src/wallet/pinned';
import { pinSignRefusal, signSitePins } from '../src/admin/sign-pins';
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
    expect(pinSummary(r)).toBe('Pinned in the build: CoinnibalArena, CoinnibalNFT, the game token.');
    expect(r.rows.map((x) => x.source)).toEqual(['build', 'build', 'build']);
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
    expect(pinSummary(r)).toBe('Not signed yet: CoinnibalArena, CoinnibalNFT. Setup → Site pins: sign them with the owner wallet (free, no transaction).');
    // after setToken: the arena and NFT are pinned, the token is not yet
    const after = pinReport({ chainId: TESTNET, arena: ARENA, nft: NFT, token: TOKEN }, buildPins({ arena: ARENA, nft: NFT }));
    expect(after.ok).toBe(false);
    expect(after.todo.map((x) => x.kind)).toEqual(['token']);
    expect(after.envLines.at(-1)).toBe(`COINNIBAL_PIN_TOKEN=${TOKEN}`);
    // the token's name in mid-sentence is lower case; it opens a sentence only when it comes first
    expect(pinTodoLine(after)).toBe('The game token is not signed yet.');
    const none = pinReport({ chainId: TESTNET, arena: ARENA, nft: NFT, token: TOKEN }, fresh);
    expect(pinTodoLine(none)).toBe('CoinnibalArena is not signed yet; CoinnibalNFT is not signed yet; the game token is not signed yet.');
    expect(pinSummary(none)).toMatch(/^Not signed yet: CoinnibalArena, CoinnibalNFT, the game token\. Setup → Site pins/);
    expect(pinTodoLine(pinReport({ chainId: TESTNET, arena: ARENA, nft: NFT, token: TOKEN }, buildPins({ arena: ARENA, nft: NFT, token: TOKEN })))).toBeNull();
    expect(PIN_REBUILD).toBe('coinnibal-compose up -d --build app');
    expect([PIN_BUILD_FIRST, PIN_SWAP]).toEqual(['coinnibal-compose build app', 'coinnibal-compose up -d app']);
    expect(PIN_VPS_KEY).toEqual({ arena: 'COINNIBAL_PIN_ARENA', nft: 'COINNIBAL_PIN_NFT', token: 'COINNIBAL_PIN_TOKEN' });
  });

  it('a pin of an older deployment is named as different', () => {
    const r = pinReport({ chainId: TESTNET, arena: ARENA, nft: NFT, token: null }, buildPins({ arena: OTHER, nft: NFT }));
    expect(r.rows.find((x) => x.kind === 'arena')).toMatchObject({ state: 'differs', pinned: OTHER });
    expect(pinSummary(r)).toBe('Signed for another address: CoinnibalArena. COINNIBAL_PIN_ARENA in /opt/elymum/.env names another address: clear it and rebuild (Setup → Site pins → Advanced).');
    expect(r.overridden.map((x) => x.kind)).toEqual(['arena']);
    const token = pinReport({ chainId: TESTNET, arena: ARENA, nft: NFT, token: TOKEN }, buildPins({ arena: ARENA, nft: NFT, token: OTHER }));
    expect(pinSummary(token)).toMatch(/^Signed for another address: the game token\. COINNIBAL_PIN_TOKEN/);
    expect(pinTodoLine(token)).toBe('The game token is pinned to another address in the build.');
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
    expect(todo.detail).toMatch(/Not signed yet: CoinnibalArena, CoinnibalNFT\. Setup → Site pins: sign them/);
    // the owner's signed record counts the same as the build's pins
    expect(launchChecklist({ net: registered(), status: status(), allowlist: null, settings: null, quote: null, pins: buildPins({}), signed: { arena: ARENA, nft: NFT, token: null } }).find((x) => x.id === 'pins')?.ok).toBe(true);
    expect(lines(buildPins({ arena: ARENA, nft: NFT })).find((x) => x.id === 'pins')?.ok).toBe(true);
    // once the token is set it needs its pin too
    expect(lines(buildPins({ arena: ARENA, nft: NFT }), status({ token: TOKEN })).find((x) => x.id === 'pins')?.ok).toBe(false);
  });

  it('the testnet token line: deploy a TestToken first while none is registered', () => {
    expect(lines().find((x) => x.id === 'token')?.detail).toBe(NO_TEST_TOKEN_YET);
    expect(NO_TEST_TOKEN_YET).toBe('Deploy the contracts deploys a test token and sets it (by hand: the TestToken card in Setup, then Finish setup).');
    expect(lines(buildPins({}), status({ testToken: TOKEN })).find((x) => x.id === 'token')).toMatchObject({ detail: 'Deploy the contracts sets it (the registered TestToken).', tab: 'deploy' });
  });

  it('the mainnet launch pins the contracts right after the deploys, before the mint', () => {
    const main = resolveNetwork(chainStatus({ chainId: ROBINHOOD_CHAIN_ID, chainName: 'Robinhood Chain', testnet: false, faucetUrl: null, arenaAddress: ARENA, nftAddress: NFT }));
    const steps = mainnetChecklist(main, status(), buildPins({ chainId: String(ROBINHOOD_CHAIN_ID) }));
    expect(steps.map((s) => s.id).slice(3, 7)).toEqual(['arena', 'nft', 'pins', 'allowlist']);
    expect(steps.find((s) => s.id === 'pins')).toMatchObject({ ok: false, where: 'Setup', detail: expect.stringContaining('one free signature from the owner wallet') });
    expect(mainnetChecklist(main, status(), buildPins({ chainId: String(ROBINHOOD_CHAIN_ID) }), { arena: ARENA, nft: NFT, token: null }).find((s) => s.id === 'pins')?.ok).toBe(true);
    expect(mainnetChecklist(main, status(), buildPins({ chainId: String(ROBINHOOD_CHAIN_ID), arena: ARENA, nft: NFT })).find((s) => s.id === 'pins')?.ok).toBe(true);
    expect(steps.find((s) => s.id === 'token')?.detail).toMatch(/Then sign the site pins again/);
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

  it('pins differ: names each contract and offers the signature; the .env override, the rebuild and the build outside Docker sit under Advanced', () => {
    ui(<PinsCard ctx={ctxOf()} pins={buildPins({ arena: OTHER })} />);
    const todo = screen.getByTestId('site-pins-todo');
    expect(todo.textContent).toMatch(/CoinnibalArena is pinned to another address in the build; CoinnibalNFT is not signed yet\./);
    // each row: the state in a pill, what it means under it
    expect([...document.querySelectorAll('[data-pin]')].map((e) => e.textContent)).toEqual(['another address in the build', 'not signed yet']);
    expect(screen.getByText(`The build pins ${OTHER}: the site refuses the registered arena.`)).toBeTruthy();
    expect(screen.getByText('The mint page signs nothing until you sign it.')).toBeTruthy();
    expect(screen.getByTestId('sign-pins').textContent).toContain('Sign the site pins');
    expect(todo.textContent).toContain("The build's own pin wins over a signature here");
    const adv = screen.getByTestId('site-pins-advanced');
    expect(adv.tagName).toBe('DETAILS');
    expect((adv as HTMLDetailsElement).open).toBe(false);
    expect(adv.textContent).toContain('Check each address against the deploy transaction in your own wallet before you paste it.');
    expect(adv.textContent).toContain('/opt/elymum/.env');
    expect(adv.textContent).toContain(`COINNIBAL_PIN_ARENA=${ARENA}`);
    expect(adv.textContent).toContain(`COINNIBAL_PIN_NFT=${NFT}`);
    // no token line before the arena's token is set
    expect(adv.textContent).not.toContain('COINNIBAL_PIN_TOKEN');
    expect(adv.textContent).toContain(PIN_REBUILD);
    // with players in the arenas: build first, swap in the break (up -d --build swaps only once the build is done)
    expect(screen.getByTestId('site-pins-break').textContent).toBe(
      `Once players are in the arenas: the build takes minutes, longer than the break after a bell, so build first (${PIN_BUILD_FIRST}), then swap in the break (${PIN_SWAP}).`,
    );
    expect(adv.textContent).toContain(`VITE_CHAIN_ID=${TESTNET}`);
    expect(adv.textContent).toContain(`VITE_ARENA_ADDRESS=${ARENA}`);
    expect(screen.getByText(/Once the game token is set on the arena, sign again/)).toBeTruthy();
    expect(within(adv).getAllByRole('button', { name: /Copy the (lines|command)/ })).toHaveLength(3);
  });

  it("signed by the owner: green, the pill says signed, nothing to sign", () => {
    ui(<PinsCard ctx={ctxOf({ status: status({ token: TOKEN }), signed: { chainId: TESTNET, arena: ARENA, nft: NFT, token: TOKEN, signedAt: '2026-11-19T10:00:00.000Z' } })} pins={buildPins({})} />);
    expect(screen.getByTestId('site-pins-ok')).toBeTruthy();
    expect([...document.querySelectorAll('[data-pin]')].map((e) => e.textContent)).toEqual(['signed', 'signed', 'signed']);
    expect(screen.queryByTestId('sign-pins')).toBeNull();
  });

  it('the token set and nothing pinned: the row label is capitalised, the red line names the token in lower case', () => {
    ui(<PinsCard ctx={ctxOf({ status: status({ token: TOKEN }) })} pins={buildPins({})} />);
    expect(screen.getByTestId('site-pins-todo').textContent).toContain('CoinnibalArena is not signed yet; CoinnibalNFT is not signed yet; the game token is not signed yet.');
    expect(screen.getByText('The game token')).toBeTruthy();
    expect(screen.queryByText(/Once the game token is set on the arena, sign again/)).toBeNull();
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

describe('signing the site pins (one free signature from the owner wallet)', () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const targets = { arena: ARENA, nft: NFT, token: null };

  it('refuses before the wallet opens: no owner wallet, another wallet, no session, nothing deployed', () => {
    const base = { me: owner.address, owner: owner.address, chainId: TESTNET, targets, api: {} as never };
    expect(pinSignRefusal(base)).toBeNull();
    expect(pinSignRefusal({ ...base, owner: null })).toMatch(/no valid owner wallet/);
    expect(pinSignRefusal({ ...base, me: null })).toMatch(/^Connect the owner wallet/);
    expect(pinSignRefusal({ ...base, me: ALICE })).toBe(`Sign with the owner wallet ${owner.address.slice(0, 6)}…${owner.address.slice(-4)}. The connected wallet is ${ALICE.slice(0, 6)}…${ALICE.slice(-4)}.`);
    expect(pinSignRefusal({ ...base, api: null })).toMatch(/Sign in at the top right/);
    expect(pinSignRefusal({ ...base, targets: { arena: ARENA, nft: null, token: null } })).toMatch(/Deploy and register/);
  });

  it('signs the checksummed fields and stores them; the record verifies against the owner for that chain only', async () => {
    const saved: unknown[] = [];
    const api = { savePins: vi.fn(async (r: unknown) => (saved.push(r), r)) } as never;
    const now = new Date('2026-11-19T10:00:00.000Z');
    const rec = await signSitePins({ api, me: owner.address, owner: owner.address, chainId: TESTNET, targets: { arena: ARENA.toLowerCase() as never, nft: NFT, token: TOKEN }, now, sign: (m) => owner.signMessage({ message: m }) });
    expect(rec).toMatchObject({ chainId: TESTNET, arena: ARENA, nft: NFT, token: TOKEN, signedAt: now.toISOString() });
    expect(saved).toHaveLength(1);
    expect(await verifySignedPins(rec, TESTNET, owner.address)).toMatchObject({ arena: ARENA, nft: NFT, token: TOKEN });
    expect(await verifySignedPins(rec, ROBINHOOD_CHAIN_ID, owner.address)).toBeNull();
    expect(await verifySignedPins(rec, TESTNET, ALICE)).toBeNull();
    // a cancelled signature says so, and nothing is stored
    await expect(signSitePins({ api, me: owner.address, owner: owner.address, chainId: TESTNET, targets, sign: async () => Promise.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 })) })).rejects.toThrow(/Signature cancelled/);
    expect(saved).toHaveLength(1);
  });

  it('the button names the owner wallet when another wallet is connected (this build trusts the built-in owner)', async () => {
    ui(<PinsCard ctx={ctxOf({ api: {} as never })} pins={buildPins({})} />);
    act(() => screen.getByTestId('sign-pins').click());
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(document.body.textContent).toContain(`Sign with the owner wallet ${OWNER_WALLET.slice(0, 6)}…${OWNER_WALLET.slice(-4)}.`);
  });
});
