import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kb } from '../src/design';
import { useUi } from '../src/store';
import { GetTokensSheet } from '../src/wallet/GetTokensSheet';
import { chainStatus } from './evm-helpers';

// the owner's signed pins are read from the server (tested in pinned.test.ts): none here, the server's token stands
vi.mock('../src/wallet/pinned', async (orig) => {
  const real = await orig<typeof import('../src/wallet/pinned')>();
  return { ...real, pinsFor: async () => real.PINS };
});

const ui0 = useUi.getState();
afterEach(() => act(() => useUi.setState(ui0, true)));

const sheet = (testnet: boolean) => {
  useUi.setState({ modal: 'tokens', chain: chainStatus({ testnet, chainId: testnet ? 46630 : 4663, chainName: testnet ? 'Robinhood Chain Testnet' : 'Robinhood Chain' }) });
  render(
    <Kb>
      <GetTokensSheet />
    </Kb>,
  );
  return screen.getByTestId('get-tokens');
};

describe('"How to get tokens": the token address line', () => {
  it('on a testnet the tokens come from the faucet, not a swap: the address is there to add to the wallet', () => {
    const body = sheet(true);
    const line = body.querySelector('.gt-token')!;
    expect(line.textContent).toContain("The test token's address, to add it to your wallet:");
    expect(line.textContent).toContain('0x0000000000000000000000000000000000007e57');
    expect(body.textContent).not.toMatch(/swap/i);
  });

  it('on mainnet the token is swapped for: check its address first', () => {
    const line = sheet(false).querySelector('.gt-token')!;
    expect(line.textContent).toContain('Check the token address before you swap:');
  });
});
