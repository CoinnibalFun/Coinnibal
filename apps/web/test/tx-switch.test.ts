import { approveCall, joinCall } from '@coinnibal/sdk';
import { describe, expect, it } from 'vitest';
import { sendWalletCall, txErrorText } from '../src/wallet/tx';
import { allowanceTooHigh } from '../src/wallet/WalletModal';
import { ALICE, ONE, chainStatus, fakeProvider } from './evm-helpers';

const TOKEN = '0x0000000000000000000000000000000000007e57';
const ARENA = '0x00000000000000000000000000000000000a4e4a';

describe('a declined network switch', () => {
  it('says "Switch to Robinhood Chain … to continue", not "you cancelled", and nothing is sent', async () => {
    const wallet = fakeProvider({ chainId: 1, known: [1, 46630] });
    wallet.handlers.wallet_switchEthereumChain = () => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    };
    const res = await sendWalletCall(approveCall(TOKEN, ARENA, 1000n * ONE), { chain: chainStatus(), wallet: { provider: wallet, address: ALICE } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.name).toBe('SwitchRejected');
    expect(txErrorText(res.error)).toBe('Switch to Robinhood Chain Testnet to continue. Nothing was signed.');
    expect(wallet.calls.map((c) => c.method)).not.toContain('eth_sendTransaction');
  });

  it('a rejection in the wallet prompt itself is still "you cancelled"', async () => {
    const wallet = fakeProvider({ chainId: 46630, known: [46630] });
    wallet.handlers.eth_sendTransaction = () => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    };
    const res = await sendWalletCall(approveCall(TOKEN, ARENA, 1000n * ONE), { chain: chainStatus(), wallet: { provider: wallet, address: ALICE } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(txErrorText(res.error)).toBe('You cancelled in your wallet. No ticket was bought.');
  });
});

describe('a join the arena refuses', () => {
  it('names an expired or too-far-ahead permit, from the custom error in the node message (no revert data passed on)', async () => {
    const permit = { deadline: 1_790_000_600n, signature: `0x${'11'.repeat(65)}` as const };
    const texts: string[] = [];
    for (const selector of ['0x1a15a3cc', '0x096b0b8a']) {
      const wallet = fakeProvider({ chainId: 46630, known: [46630] });
      // a Hardhat node's wording, through a wallet that passes only the message on (the 2026-11 play-test)
      wallet.handlers.eth_sendTransaction = () => {
        throw Object.assign(new Error(`VM Exception while processing transaction: reverted with an unrecognized custom error (return data: ${selector})`), { code: -32603 });
      };
      const res = await sendWalletCall(joinCall(ARENA, 1, permit), { chain: chainStatus(), wallet: { provider: wallet, address: ALICE }, gas: 300_000n });
      expect(res.ok).toBe(false);
      if (!res.ok) texts.push(txErrorText(res.error));
    }
    expect(texts).toEqual([
      'The ticket permit ran out before the ticket went through. Nothing was charged; try again.',
      'The ticket permit does not match the network clock. Nothing was charged; try again.',
    ]);
  });
});

describe('an allowance left from the old unlimited approval', () => {
  it('is flagged when it is more than a capped batch of the dearest arena could need', () => {
    const fees = [1000n * ONE, 250_000n * ONE];
    expect(allowanceTooHigh(null, fees)).toBe(false);
    expect(allowanceTooHigh(0n, fees)).toBe(false);
    expect(allowanceTooHigh(5n * 250_000n * ONE, fees)).toBe(false);
    expect(allowanceTooHigh((1n << 256n) - 1n, fees)).toBe(true);
    expect(allowanceTooHigh(10n ** 30n, [])).toBe(false);
  });
});
