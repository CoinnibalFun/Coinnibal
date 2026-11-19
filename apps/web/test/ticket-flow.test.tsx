import type { ArenaInfo, ContractCall, SessionInfo } from '@coinnibal/sdk';
import type { JoinPermit } from '@coinnibal/shared';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kb } from '../src/design';
import { useUi } from '../src/store';
import { useChainData } from '../src/wallet/chain';
import { fakeConfig } from '../src/wallet/devFake';
import { resetWallets, useWallet } from '../src/wallet/store';
import { TicketFlow } from '../src/wallet/TicketFlow';
import type { TicketModel } from '../src/wallet/ticket';
import { ALICE, ONE, chainStatus, detail, fakeProvider } from './evm-helpers';

const ARENA = '0x00000000000000000000000000000000000a4e4a';
const TOKEN = '0x0000000000000000000000000000000000007e57';
const HASH = `0x${'ab'.repeat(32)}` as const;

const approveCall = { address: TOKEN, abi: [], functionName: 'approve', args: [ARENA, 1000n * ONE] } as unknown as ContractCall;
const joinCall = { address: ARENA, abi: [], functionName: 'join', args: [1] } as unknown as ContractCall;

const spies = vi.hoisted(() => ({
  planJoin: vi.fn(),
  getArenaConfig: vi.fn(),
  getSession: vi.fn(),
  sendWalletCall: vi.fn(),
  verifyArena: vi.fn(),
  fetchJoinPermit: vi.fn(),
}));
// the game server's join permit (CoinnibalArena v4): granted unless a test says otherwise
vi.mock('../src/wallet/permit', async (orig) => ({ ...(await orig<typeof import('../src/wallet/permit')>()), fetchJoinPermit: spies.fetchJoinPermit }));
// the money path's network edges: the fresh chain reads and the wallet send
vi.mock('@coinnibal/sdk', async (orig) => ({
  ...(await orig<typeof import('@coinnibal/sdk')>()),
  planJoin: spies.planJoin,
  getArenaConfig: spies.getArenaConfig,
  getSession: spies.getSession,
  // the approval is visible at once (the join waits for it before estimating its gas)
  getAllowance: async () => 10n ** 30n,
}));
vi.mock('../src/wallet/chain', async (orig) => ({ ...(await orig<typeof import('../src/wallet/chain')>()), useReadClient: () => ({ estimateGas: async () => 130_000n }) }));
vi.mock('../src/wallet/tx', async (orig) => ({ ...(await orig<typeof import('../src/wallet/tx')>()), sendWalletCall: spies.sendWalletCall }));
// the pin and code-hash check (tested on its own in pinned.test.ts): this arena passes unless a test says otherwise
vi.mock('../src/wallet/pinned', async (orig) => ({ ...(await orig<typeof import('../src/wallet/pinned')>()), verifyArena: spies.verifyArena }));

const CHAIN = chainStatus();
/** The permit the game server grants ALICE for a room of the pinned arena. */
const permitOf = (arenaId: number, o: Partial<JoinPermit> = {}): JoinPermit => ({ arena: ARENA, chainId: CHAIN.chainId!, player: ALICE, arenaId, nonce: '0', deadline: Math.floor(Date.now() / 1000) + 600, signature: `0x${'ef'.repeat(65)}`, ...o });
const PENNY: TicketModel = { key: 'arena:1', arenaId: 1, entryFee: 1000n * ONE, humans: 3, bots: 10, loot: 0, open: true };
const arena = (id: number, entryFee: bigint): ArenaInfo => ({
  id,
  entryFee,
  vault: 0n,
  owed: 0n,
  maxSessions: 300,
  openSessions: 0,
  enabled: true,
  exists: true,
  totalDeposited: 0n,
  totalPaidOut: 0n,
  totalBurned: 0n,
  totalFees: 0n,
  lastSweepId: 0n,
  holdersOnly: false,
});
const session = (o: Partial<SessionInfo> = {}): SessionInfo => ({ arenaId: 1, player: ALICE, id: 9n, entryFee: 1000n * ONE, openedAt: 1, burnBps: 1500, vaultBps: 500, finalized: false, owed: 0n, ...o });
const ui0 = useUi.getState();
const chain0 = useChainData.getState();
const config = () => ({ ...fakeConfig(CHAIN), address: ARENA as `0x${string}`, token: TOKEN as `0x${string}` });
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

beforeEach(() => {
  spies.planJoin.mockReset();
  spies.planJoin.mockImplementation(async () => ({ entryFee: 1000n * ONE, allowance: 0n, balance: 12_450n * ONE, approve: approveCall, join: joinCall, calls: [approveCall, joinCall] }));
  spies.getArenaConfig.mockReset();
  spies.getArenaConfig.mockImplementation(async () => config());
  spies.getSession.mockReset();
  spies.getSession.mockImplementation(async (_c: unknown, _a: unknown, id: number) => useChainData.getState().sessions[id] ?? session({ id: 0n }));
  spies.verifyArena.mockReset();
  spies.verifyArena.mockImplementation(async () => ({ ok: true, arena: ARENA }));
  spies.fetchJoinPermit.mockReset();
  spies.fetchJoinPermit.mockImplementation(async (_token: string, arenaId: number) => ({ ok: true, permit: permitOf(arenaId) }));
  spies.sendWalletCall.mockReset();
  spies.sendWalletCall.mockImplementation(async (_call: unknown, opts: { onPhase?: (p: string, h?: string) => void }) => {
    opts.onPhase?.('signing');
    opts.onPhase?.('confirming', HASH);
    return { ok: true, hash: HASH, receipt: { status: 'success', logs: [] } };
  });
  resetWallets();
  useWallet.setState({ status: 'connected', address: ALICE, chainId: 46630, current: detail(fakeProvider({ chainId: 46630, known: [46630] })) });
  useUi.setState({ settings: { ...ui0.settings, name: 'Daphne', skin: 4 }, chain: CHAIN, auth: { address: ALICE, token: 'tok', profile: null } });
  useChainData.setState({
    config: config(),
    sessions: {},
    tokenBalance: 12_450n * ONE,
    balance: 42n * 10n ** 16n,
    allowance: 0n,
    profile: null,
    pending: [],
    fake: false,
    arenas: [arena(1, 1000n * ONE), arena(3, 50_000n * ONE)],
  });
});
afterEach(() => {
  act(() => {
    useUi.setState(ui0, true);
    useChainData.setState(chain0, true);
    resetWallets();
  });
});

const open = (ticket: TicketModel, mode: 'buy' | 'refund' | 'collect' = 'buy') =>
  render(
    <Kb>
      <TicketFlow open mode={mode} ticket={ticket} onClose={() => {}} />
    </Kb>,
  );

describe('ticket confirm sheet', () => {
  it('shows the exact amount, the fee policy, the network fee and both calls before signing', () => {
    open(PENNY);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByText('1,000 $NIBAL').length).toBeGreaterThan(0);
    // arena v3: no entry fee; the fee is on profit only, split burned / fee wallet
    expect(within(dialog).getByText('20% · on profit only · fixed for this ticket · 15% burned · 5% to the team wallet')).toBeTruthy();
    expect(within(dialog).queryByText('Your coin starts at')).toBeNull();
    expect(within(dialog).getByText(/No profit, no fee/)).toBeTruthy();
    expect(within(dialog).getByText(/paid in ETH on Robinhood Chain Testnet · you have 0.42 ETH/)).toBeTruthy();
    expect(within(dialog).getByText('12,450 → 11,450 $NIBAL')).toBeTruthy();
    const steps = within(within(dialog).getByRole('region', { name: 'Your wallet signs' })).getAllByRole('listitem');
    // no allowance yet: an approval for 5 tickets of this room first (preselected; what the wallet will show), then the ticket
    expect(steps.map((s) => s.textContent)).toEqual(['1Allow the arena to take up to 5,000 $NIBAL (5 tickets of this room)', '2Buy the ticket · $1 Room']);
    expect((within(dialog).getByRole('button', { name: /Pay 1,000 \$NIBAL/ }) as HTMLButtonElement).disabled).toBe(false);
    // the approval covers 1, 5, 10 or 20 tickets, 5 preselected
    expect(within(dialog).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['1 ticket', '5 tickets', '10 tickets', '20 tickets']);
    expect(within(dialog).getByRole('radio', { name: '5 tickets' }).getAttribute('aria-checked')).toBe('true');
  });

  it('approves 5 tickets by default (an exact amount, to the pinned arena); 1 ticket approves exactly the entry fee', async () => {
    const view = open(PENNY);
    act(() => screen.getByRole('button', { name: /^Pay / }).click());
    await settle();
    expect(spies.verifyArena).toHaveBeenCalledWith(expect.anything(), CHAIN.chainId, { arena: ARENA, token: TOKEN });
    expect(spies.sendWalletCall.mock.calls[0][0]).toMatchObject({ address: TOKEN, functionName: 'approve', args: [ARENA, 5000n * ONE] });
    view.unmount();
    spies.sendWalletCall.mockClear();
    open(PENNY);
    act(() => screen.getByRole('radio', { name: '1 ticket' }).click());
    expect(screen.getByText(/your wallet asks for an approval every time/)).toBeTruthy();
    act(() => screen.getByRole('button', { name: /^Pay / }).click());
    await settle();
    expect(spies.sendWalletCall.mock.calls[0][0]).toMatchObject({ functionName: 'approve', args: [ARENA, 1000n * ONE] });
  });

  it('"Approve for 1 / 5 / 10 / 20 tickets": the amount follows the choice (capped at 20), remembered for next time', async () => {
    const view = open(PENNY);
    act(() => screen.getByRole('radio', { name: '10 tickets' }).click());
    expect(useUi.getState().settings.approveTickets).toBe(10);
    const steps = within(screen.getByRole('region', { name: 'Your wallet signs' })).getAllByRole('listitem');
    expect(steps[0].textContent).toBe('1Allow the arena to take up to 10,000 $NIBAL (10 tickets of this room)');
    expect(screen.getByText(/your next 9 tickets here need a single transaction each/)).toBeTruthy();
    act(() => screen.getByRole('button', { name: /^Pay / }).click());
    await settle();
    expect(spies.sendWalletCall.mock.calls[0][0]).toMatchObject({ functionName: 'approve', args: [ARENA, 10_000n * ONE] });
    view.unmount();
    // the next sheet starts with the same choice
    open(PENNY);
    expect(screen.getByRole('radio', { name: '10 tickets' }).getAttribute('aria-checked')).toBe('true');
  });

  it('refuses an arena that is not the pinned one (or not the compiled code) before anything is signed', async () => {
    spies.verifyArena.mockImplementation(async () => ({ ok: false, reason: 'arena_mismatch' }));
    open(PENNY);
    act(() => screen.getByRole('button', { name: /^Pay / }).click());
    await settle();
    expect(spies.sendWalletCall).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/does not recognise the arena contract/);
    // a chain that cannot be read is a network error, not a mismatch
    spies.verifyArena.mockImplementation(async () => ({ ok: false, reason: 'unreadable' }));
    act(() => screen.getByRole('button', { name: 'Try again' }).click());
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/Could not reach the Robinhood Chain Testnet network/);
    expect(spies.sendWalletCall).not.toHaveBeenCalled();
  });

  it('shows the price in US dollars with its age, and calls out an old one', () => {
    const at = Date.now() - 30 * 60_000;
    useChainData.setState({ prices: { source: 'manual', usdPerToken: '0.001', at, tiers: [], sigFigs: 2 } });
    const view = open(PENNY);
    const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    expect(screen.getByTestId('tf-usd').textContent).toBe(`In US dollars≈ $1 · price set ${time}`);
    expect(screen.queryByTestId('tf-usd-stale')).toBeNull();
    view.unmount();
    useChainData.setState({ prices: { source: 'manual', usdPerToken: '0.001', at: Date.now() - 7 * 3600_000, tiers: [], sigFigs: 2 } });
    const old = open(PENNY);
    expect(screen.getByTestId('tf-usd-stale').textContent).toMatch(/more than 6 hours ago/);
    old.unmount();
    // no price set: no dollar figure at all
    useChainData.setState({ prices: { source: 'manual', usdPerToken: null, at: null, tiers: [], sigFigs: 2 } });
    open(PENNY);
    expect(screen.queryByTestId('tf-usd')).toBeNull();
    expect(screen.queryByTestId('tf-usd-stale')).toBeNull();
  });

  it("shows the server's live rates, and an emblem holder's lower pair against the normal one", () => {
    act(() => useUi.setState({ chain: { ...useUi.getState().chain!, fees: { ...useUi.getState().chain!.fees!, burnBps: 1000, vaultBps: 200 } } }));
    const view = open(PENNY);
    expect(within(screen.getByRole('dialog')).getByText('12% · on profit only · fixed for this ticket · 10% burned · 2% to the team wallet')).toBeTruthy();
    view.unmount();
    act(() => useUi.setState({ chain: chainStatus() }));
    useChainData.setState({ holder: true, config: { ...config(), holderBurnBps: 1500, holderVaultBps: 0 } });
    open(PENNY);
    expect(within(screen.getByRole('dialog')).getByText('15% · on profit only · fixed for this ticket · 15% burned · 0% to the team wallet · holder rate, not 20%')).toBeTruthy();
  });

  it('a ticket headed for a private ticket room says, before it is paid, that the room can end early', () => {
    useUi.setState({ paidSeat: { code: 'AB2CD', arenaId: 1, name: 'Friday Pond', endsAt: Date.now() + 20 * 60_000 } });
    open(PENNY);
    expect(screen.getByTestId('tf-paid-seat').textContent).toMatch(
      /seated in the private room "Friday Pond" \(AB2CD\)\. Its creator or an admin can end the room early, with a 10-second warning: every ticket is settled at that moment\./,
    );
  });

  it('one call only when the allowance already covers the entry fee', () => {
    useChainData.setState({ allowance: 5000n * ONE });
    open(PENNY);
    const steps = within(screen.getByRole('region', { name: 'Your wallet signs' })).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual(['1Buy the ticket · $1 Room']);
    // nothing to approve: no approval choice either
    expect(screen.queryByRole('checkbox', { name: /Approve 5 tickets at once/ })).toBeNull();
  });

  it('cannot sign without a wallet', () => {
    act(() => resetWallets());
    open(PENNY);
    expect((screen.getByRole('button', { name: /^Pay / }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('never offers to sign a price the arena does not confirm', () => {
    useChainData.setState({ arenas: [arena(1, 1200n * ONE)] });
    open(PENNY);
    expect((screen.getByRole('button', { name: /^Pay / }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('cannot sign while the game token is not set on chain', () => {
    useUi.setState({ chain: { ...CHAIN, tokenReady: false, token: null, arenasEnabled: false } });
    useChainData.setState({ config: { ...config(), token: null } });
    const view = open(PENNY);
    expect((screen.getByRole('button', { name: /^Pay / }) as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
    useChainData.setState({ config: config() });
    open({ ...PENNY, soon: true, open: false });
    expect((screen.getByRole('button', { name: /^Pay / }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('no ETH for gas: Pay is off, with the testnet faucet one tap away', () => {
    useChainData.setState({ balance: 0n });
    open(PENNY);
    expect(screen.getByText(/You have no ETH on Robinhood Chain Testnet/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Pay / }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: /Get test ETH from the official .* faucet/ }).getAttribute('href')).toBe(CHAIN.faucetUrl);
  });

  it('the collect sheet shows the payout and one refund call', () => {
    useChainData.setState({ sessions: { 1: session({ finalized: true, owed: 2150n * ONE }) } });
    open(PENNY, 'collect');
    expect(screen.getAllByText('2,150 $NIBAL').length).toBeGreaterThan(0);
    const steps = within(screen.getByRole('region', { name: 'Your wallet signs' })).getAllByRole('listitem');
    expect(steps.map((li) => li.textContent)).toEqual([expect.stringContaining('Collect your payout')]);
    expect(screen.getByRole('button', { name: /Collect · 2,150 \$NIBAL/ })).toBeTruthy();
  });
});

describe('ticket flow: two prompts, progress and races', () => {
  it('approve then join, each through the wallet, with "Step n of 2" progress', async () => {
    let release: () => void = () => {};
    spies.sendWalletCall.mockImplementationOnce(async (_c: unknown, opts: { onPhase?: (p: string) => void }) => {
      opts.onPhase?.('signing');
      await new Promise<void>((r) => (release = r));
      return { ok: true, hash: HASH, receipt: { status: 'success', logs: [] } };
    });
    open(PENNY);
    act(() => screen.getByRole('button', { name: /^Pay / }).click());
    await settle();
    expect(screen.getByTestId('tf-step').textContent).toBe('Step 1 of 2 · Allow the arena to take up to 5,000 $NIBAL (5 tickets of this room)');
    expect(screen.getByText('Approve the game token in your wallet')).toBeTruthy();
    expect(screen.getByText(/Your wallet shows 5,000 \$NIBAL: enough for 5 tickets of this room/)).toBeTruthy();
    // the plan is always exact (the batch, when ticked, is built here and checked call by call)
    expect(spies.planJoin.mock.calls[0][1]).toMatchObject({ approve: 'exact' });
    await act(async () => release());
    await settle();
    expect(spies.sendWalletCall).toHaveBeenCalledTimes(2);
    expect(spies.sendWalletCall.mock.calls[0][0]).toMatchObject({ address: TOKEN, functionName: 'approve', args: [ARENA, 5000n * ONE] });
    expect(spies.sendWalletCall.mock.calls[1][0]).toBe(joinCall);
    // the server's chain rides along: the wallet is switched to it before each prompt
    expect(spies.sendWalletCall.mock.calls[0][1]).toMatchObject({ chain: CHAIN });
  });

  it('asks the game server for the join permit first, and joins with it (CoinnibalArena v4)', async () => {
    useChainData.setState({ allowance: 5000n * ONE });
    spies.planJoin.mockImplementation(async () => ({ entryFee: 1000n * ONE, allowance: 5000n * ONE, balance: 12_450n * ONE, approve: null, join: joinCall, calls: [joinCall] }));
    open(PENNY);
    act(() => screen.getByRole('button', { name: /Pay 1,000 \$NIBAL/ }).click());
    await settle();
    expect(spies.fetchJoinPermit).toHaveBeenCalledWith('tok', 1, null);
    const permit = spies.planJoin.mock.calls[0][1].permit as { deadline: bigint; signature: string };
    expect(permit).toEqual({ deadline: BigInt(permitOf(1).deadline), signature: permitOf(1).signature });
    expect(spies.sendWalletCall).toHaveBeenCalledTimes(1);
  });

  it('a ticket headed for a paid room asks the permit for that room (audit R4-M1: its refund, should the room close first, is no no-show)', async () => {
    useChainData.setState({ allowance: 5000n * ONE });
    spies.planJoin.mockImplementation(async () => ({ entryFee: 1000n * ONE, allowance: 5000n * ONE, balance: 12_450n * ONE, approve: null, join: joinCall, calls: [joinCall] }));
    useUi.setState({ paidSeat: { code: 'AB2CD', arenaId: 1, name: 'Friday Pond', endsAt: Date.now() + 20 * 60_000 } });
    open(PENNY);
    act(() => screen.getByRole('button', { name: /Pay 1,000 \$NIBAL/ }).click());
    await settle();
    expect(spies.fetchJoinPermit).toHaveBeenCalledWith('tok', 1, 'AB2CD');
  });

  it('a refused permit says why and signs nothing (no-shows, an open ticket, a full room)', async () => {
    spies.fetchJoinPermit.mockImplementation(async () => {
      const { permitRefusalText } = await vi.importActual<typeof import('../src/wallet/permit')>('../src/wallet/permit');
      return { ok: false, code: 'no_show', text: permitRefusalText('no_show', Date.UTC(2026, 10, 19, 15, 30)) };
    });
    open(PENNY);
    act(() => screen.getByRole('button', { name: /^Pay / }).click());
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/Your last tickets were bought but never played, so new tickets pause until .+\. Nothing was signed\./);
    expect(spies.planJoin).not.toHaveBeenCalled();
    expect(spies.sendWalletCall).not.toHaveBeenCalled();
  });

  it('each refusal has its own words: a network at its share of the room is told so', async () => {
    const { permitRefusalText } = await vi.importActual<typeof import('../src/wallet/permit')>('../src/wallet/permit');
    // honest about the wait (audit R4b-M1): a network is held only while its permits are valid and its tickets unplayed
    expect(permitRefusalText('network_busy')).toMatch(/asked from your network and are not played yet\. Places free up as they are played or run out, within half an hour: try again soon, or from another connection\. Nothing was signed\./);
    // one wallet's own unused permits pause that wallet only, and the sheet says until when
    expect(permitRefusalText('unused_permits', Date.UTC(2026, 10, 20, 9, 15))).toMatch(/^You asked for tickets for this room several times today and bought none, so new tickets for this room pause until .+\. A ticket bought in another room starts afresh\. Nothing was signed\.$/);
    expect(permitRefusalText('unused_permits')).toMatch(/pause for a while\./);
    expect(permitRefusalText('arena_busy')).toMatch(/as many tickets waiting for a seat/);
    // a new wallet without the entry fee (round 4): told to get tokens, nothing signed
    expect(permitRefusalText('no_funds')).toMatch(/does not hold the entry fee for this room yet\. Get tokens first, then buy the ticket\. Nothing was signed\./);
    // standing covers one unplayed ticket at a time (audit R4-M2): the other ticket is named, never a day's block
    expect(permitRefusalText('ticket_elsewhere')).toBe('You hold a ticket for another room that is not played yet. Play it first, then buy this one. Nothing was signed.');
  });

  it('a permit for another wallet, room or arena signs nothing', async () => {
    for (const bad of [{ player: '0x2222222222222222222222222222222222222222' }, { arenaId: 3 }, { arena: '0x0000000000000000000000000000000000000bad' }, { chainId: 1 }]) {
      spies.fetchJoinPermit.mockImplementation(async (_t: string, arenaId: number) => ({ ok: true, permit: permitOf(arenaId, bad) }));
      const view = open(PENNY);
      act(() => screen.getByRole('button', { name: /^Pay / }).click());
      await settle();
      expect(screen.getByRole('alert').textContent).toMatch(/does not recognise the arena contract/);
      view.unmount();
    }
    expect(spies.sendWalletCall).not.toHaveBeenCalled();
  });

  it('a double click (or two Enters) plans and sends once', async () => {
    useChainData.setState({ allowance: 5000n * ONE });
    spies.planJoin.mockImplementation(async () => ({ entryFee: 1000n * ONE, allowance: 5000n * ONE, balance: 12_450n * ONE, approve: null, join: joinCall, calls: [joinCall] }));
    open(PENNY);
    const pay = screen.getByRole('button', { name: /Pay 1,000 \$NIBAL/ });
    act(() => {
      pay.click();
      pay.click();
      pay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      pay.click();
    });
    await settle();
    expect(spies.planJoin).toHaveBeenCalledTimes(1);
    expect(spies.sendWalletCall).toHaveBeenCalledTimes(1);
    expect(spies.planJoin.mock.calls[0][1]).toEqual({ arena: ARENA, arenaId: 1, player: ALICE, token: TOKEN, approve: 'exact', permit: { deadline: expect.any(BigInt), signature: permitOf(1).signature } });
    expect(spies.fetchJoinPermit).toHaveBeenCalledTimes(1);
  });

  it('a failed approval stops before the join, and the retry re-plans', async () => {
    spies.sendWalletCall.mockImplementationOnce(async () => ({ ok: false, hash: null, error: { kind: 'rejected', name: 'UserRejectedRequestError', args: [], code: 4001, message: 'declined' } }));
    open(PENNY);
    act(() => screen.getByRole('button', { name: /^Pay / }).click());
    await settle();
    expect(spies.sendWalletCall).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toMatch(/You cancelled in your wallet/);
    act(() => screen.getByRole('button', { name: 'Try again' }).click());
    await settle();
    expect(spies.planJoin).toHaveBeenCalledTimes(2);
  });

  it('re-reads the config right before the wallet and refuses changed fee rates', async () => {
    spies.getArenaConfig.mockImplementation(async () => ({ ...config(), vaultBps: 1_000 }));
    open(PENNY);
    act(() => screen.getByRole('button', { name: /^Pay / }).click());
    await settle();
    expect(spies.sendWalletCall).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/The fee changed a moment ago/);
  });

  it('re-reads the arena and refuses a changed price, a full room or a short balance', async () => {
    spies.planJoin.mockImplementationOnce(async () => ({ entryFee: 1500n * ONE, allowance: 0n, balance: 0n, approve: approveCall, join: joinCall, calls: [] }));
    open(PENNY);
    act(() => screen.getByRole('button', { name: /^Pay / }).click());
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/changed a moment ago/);
    spies.planJoin.mockImplementationOnce(async () => {
      throw new RangeError('arena #1 is full');
    });
    act(() => screen.getByRole('button', { name: 'Try again' }).click());
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/The room is full/);
    expect(spies.sendWalletCall).not.toHaveBeenCalled();
  });

  it('never sells a ticket for an arena the server keeps closed', async () => {
    open(PENNY);
    act(() => useUi.setState({ blockedArenas: [1] }));
    expect((screen.getByRole('button', { name: /^Pay / }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/This room is under maintenance right now/)).toBeTruthy();
    act(() => screen.getByRole('button', { name: /^Pay / }).click());
    await settle();
    expect(spies.planJoin).not.toHaveBeenCalled();
  });

  it('collect is guarded and re-checks the session on chain', async () => {
    useChainData.setState({ sessions: { 1: session({ finalized: true, owed: 2150n * ONE }) } });
    open(PENNY, 'collect');
    const btn = screen.getByRole('button', { name: /Collect · 2,150/ });
    act(() => {
      btn.click();
      btn.click();
    });
    await settle();
    expect(spies.getSession).toHaveBeenCalledTimes(1);
    expect(spies.sendWalletCall).toHaveBeenCalledTimes(1);
    expect(spies.sendWalletCall.mock.calls[0][0]).toMatchObject({ address: ARENA, functionName: 'refund', args: [1] });
  });

  it('collect refuses when the on-chain session changed since the sheet opened', async () => {
    useChainData.setState({ sessions: { 1: session({ finalized: true, owed: 2150n * ONE }) } });
    spies.getSession.mockImplementation(async () => session({ finalized: true, owed: 1n }));
    open(PENNY, 'collect');
    act(() => screen.getByRole('button', { name: /Collect · 2,150/ }).click());
    await settle();
    expect(spies.sendWalletCall).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/This ticket changed a moment ago/);
  });

  it('a refund before 24 h is refused before the wallet opens', async () => {
    const fresh = session({ openedAt: Math.floor(Date.now() / 1000) - 60 });
    useChainData.setState({ sessions: { 1: fresh } });
    open(PENNY, 'refund');
    act(() => screen.getByRole('button', { name: /Refund · 1,000/ }).click());
    await settle();
    expect(spies.sendWalletCall).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Refunds open 24 hours/);
  });

  it('focus never starts on the pay button', async () => {
    open(PENNY);
    await settle();
    const pay = screen.getByRole('button', { name: /^Pay / });
    expect(document.activeElement).not.toBe(pay);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('offers "Resume" instead of paying again when the ticket turns out to be open', () => {
    useChainData.setState({ sessions: { 1: session() } });
    open(PENNY);
    expect(screen.getByRole('button', { name: /Resume/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull();
  });
});
