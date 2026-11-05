import { describe, expect, it } from 'vitest';
import { JOIN_GAS_FALLBACK, joinGasAfterApprove } from '../src/wallet/ticket';

const p = { owner: '0x0000000000000000000000000000000000000001', arena: '0x0000000000000000000000000000000000000002', data: '0x' as const, fee: 100n } as const;

describe('join gas after an approval', () => {
  it('waits until the approval is visible, then sends the estimate with a 30 % margin (never under the fallback)', async () => {
    let reads = 0;
    const seen: number[] = [];
    const gas = await joinGasAfterApprove(
      { estimateGas: async () => (seen.push(reads), 400_000n) },
      async () => (++reads >= 3 ? 100n : 0n),
      p,
      { stepMs: 1 },
    );
    expect(seen).toEqual([3]);
    expect(gas).toBe(520_000n);
    expect(await joinGasAfterApprove({ estimateGas: async () => 120_000n }, async () => 100n, p)).toBe(JOIN_GAS_FALLBACK);
  });

  it('a failed estimate or an allowance that never shows still sends, with the fallback limit', async () => {
    const gas = await joinGasAfterApprove({ estimateGas: async () => { throw new Error('reverted'); } }, async () => 0n, p, { waitMs: 5, stepMs: 1 });
    expect(gas).toBe(JOIN_GAS_FALLBACK);
  });
});
