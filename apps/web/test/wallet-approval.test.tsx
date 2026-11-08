import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALICE, ONE, chainStatus, detail, fakeProvider } from './evm-helpers';

const spies = vi.hoisted(() => ({ sendWalletCall: vi.fn(), verifyArena: vi.fn() }));
vi.mock('../src/wallet/pinned', async (orig) => ({ ...(await orig<typeof import('../src/wallet/pinned')>()), verifyArena: spies.verifyArena }));
vi.mock('../src/wallet/tx', async (orig) => ({ ...(await orig<typeof import('../src/wallet/tx')>()), sendWalletCall: spies.sendWalletCall }));

import { Kb } from '../src/design';
import { useUi } from '../src/store';
import { useChainData } from '../src/wallet/chain';
import { useWallet } from '../src/wallet/store';
import { WalletModal } from '../src/wallet/WalletModal';

const TOKEN = '0x0000000000000000000000000000000000007e57';
const ARENA = '0x00000000000000000000000000000000000a4e4a';
const ui0 = useUi.getState();
const data0 = useChainData.getState();

beforeEach(() => {
  spies.verifyArena.mockReset();
  spies.verifyArena.mockImplementation(async (_c: unknown, _id: unknown, a: { arena: string }) => ({ ok: true, arena: a.arena }));
  spies.sendWalletCall.mockReset();
  spies.sendWalletCall.mockResolvedValue({ ok: true, hash: `0x${'9'.repeat(64)}` });
  useWallet.setState({ status: 'connected', address: ALICE, chainId: 46630, current: detail(fakeProvider({ accounts: [ALICE] })) });
  useUi.setState({ modal: 'wallet', chain: chainStatus({ arenaAddress: ARENA }), settings: { ...ui0.settings, lastArena: 2 } });
  useChainData.setState({
    tokenBalance: 12_000n * ONE,
    balance: 10n ** 17n,
    allowance: 9000n * ONE,
    config: { ...(data0.config ?? {}), token: TOKEN } as never,
    arenas: [
      { id: 1, entryFee: 1000n * ONE },
      { id: 2, entryFee: 3000n * ONE },
    ] as never,
  });
});
afterEach(() => {
  act(() => {
    useUi.setState(ui0, true);
    useChainData.setState(data0, true);
  });
});

describe('the wallet sheet: what the arena may still take, and revoking it', () => {
  it('shows the allowance in tickets of the room the player buys, and revokes it to zero (the pinned arena only)', async () => {
    render(
      <Kb>
        <WalletModal />
      </Kb>,
    );
    // 9,000 approved, the last arena (#2) costs 3,000: three more tickets, one transaction each
    expect(screen.getByTestId('wl-approved').textContent).toMatch(/9,000 \$ELYMUM, enough for 3 more tickets of Lethe Shore/);
    await act(async () => screen.getByTestId('wl-revoke').click());
    expect(spies.verifyArena).toHaveBeenCalled();
    expect(spies.sendWalletCall.mock.calls[0][0]).toMatchObject({ address: TOKEN, functionName: 'approve', args: [ARENA, 0n] });
  });

  it('shows nothing when nothing is approved', () => {
    useChainData.setState({ allowance: 0n });
    render(
      <Kb>
        <WalletModal />
      </Kb>,
    );
    expect(screen.queryByTestId('wl-approved')).toBeNull();
  });
});
