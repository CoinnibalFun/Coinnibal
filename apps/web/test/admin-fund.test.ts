import { deployArenaParams, deployNftParams, deployTestTokenParams } from '@elymum/sdk';
import { getAddress } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { arenaDeployArgs, defaultNftForm, nftDeployArgs } from '../src/admin/deploy';
import { deployOwner, deployRefusal, planRefusals, previewOf, sendPlan, type Plan } from '../src/admin/plan';

const KEY = '0xabec7B8ed9b87989106f6d0510ec9Dd9DEE0a1FC' as const;
const ME = '0x08b2B32E932D5f429073A441E6EfD8e3d42369b2' as const;

describe('fund the server key', () => {
  const plan: Plan = { title: 'Fund the server key', contract: 'Server key', transfer: { to: KEY, value: 10n ** 18n } };

  it('previews a plain 1 ETH transfer to the server key', () => {
    const p = previewOf(plan);
    expect(p.to).toBe(KEY);
    expect(p.value).toBe(10n ** 18n);
    expect(p.valueText).toBe('1 ETH');
    expect(p.args).toEqual([]);
  });

  it('asks the wallet for a value transfer, not a contract call', async () => {
    const sendTransaction = vi.fn().mockResolvedValue('0xhash');
    const wallet = { sendTransaction, chain: { id: 46630 } } as never;
    await expect(sendPlan(plan, wallet, ME)).resolves.toBe('0xhash');
    expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: KEY, value: 10n ** 18n, account: ME }));
  });
});

describe('a refused settings save reads in the panel words', () => {
  it('names the field by its label, never the raw key path', async () => {
    const { saveErrorText, fieldLabel } = await import('../src/admin/ui');
    const err = (message: string, field: string | null) => Object.assign(new Error(message), { field });
    expect(saveErrorText(err('prices.magnet must be above 0 and at most 1000000000', 'prices.magnet'))).toBe('Pack price Magnet must be above 0 and at most 1000000000');
    expect(saveErrorText(err('kinds.practiceRookie.massCap must be 0 (no cap) or at least 200', 'kinds.practiceRookie.massCap'))).toBe('Practice · rookie mass cap must be 0 (no cap) or at least 200');
    expect(saveErrorText(err('priceGas must be an amount of the gas token like "0.05"', 'priceGas'))).toBe('Price (gas token) must be an amount of the gas token like "0.05"');
    expect(saveErrorText(err('Not allowed', 'testnet.arenas.2.bankroll'))).toBe('Staked bots arena #2 bankroll: Not allowed');
    expect(saveErrorText(err('The server is busy', null))).toBe('The server is busy');
    expect(fieldLabel('someNewKey')).toBe('Some new key');
  });
});

describe('the server key balance after funding', () => {
  it("shows this page's own chain read first: the server's figure lags until its next balance check", async () => {
    const { serverKeyBalance } = await import('../src/admin/NetworkTab');
    const info = { serverBalanceWei: (10n ** 17n).toString(), low: false };
    // 0.1 ETH on the server's last check; 1.1 ETH read just now after sending 1 ETH
    expect(serverKeyBalance(info, 11n * 10n ** 17n)).toEqual({ wei: 11n * 10n ** 17n, low: false });
    expect(serverKeyBalance(info, null)).toEqual({ wei: 10n ** 17n, low: false });
    expect(serverKeyBalance({ serverBalanceWei: '0', low: true }, 10n ** 18n).low).toBe(false);
    expect(serverKeyBalance({ serverBalanceWei: null, low: true }, null)).toEqual({ wei: null, low: true });
    expect(serverKeyBalance(null, 1n).low).toBe(true);
  });
});

describe('the deploy wizard: plain contract creations from the owner wallet', () => {
  const OWNER = getAddress(ME.toLowerCase());
  const OTHER = '0x1111111111111111111111111111111111111111' as const;
  const plans: Plan[] = [
    { title: 'Deploy TestToken', contract: 'TestToken', deploy: { name: 'TestToken', params: deployTestTokenParams({ owner: OWNER }) } },
    { title: 'Deploy CoinnibalArena', contract: 'CoinnibalArena', deploy: { name: 'CoinnibalArena', params: deployArenaParams(arenaDeployArgs(OWNER, KEY)) } },
    { title: 'Deploy CoinnibalNFT', contract: 'CoinnibalNFT', deploy: { name: 'CoinnibalNFT', params: deployNftParams(nftDeployArgs({ ...defaultNftForm('https://site.test', '1000', OWNER), priceGas: '0.01' }, OWNER)) } },
  ];

  it('each deploy is viem deployContract from the connected wallet (EOA CREATE: no factory, no CREATE2, no proxy), owned by that wallet', async () => {
    for (const plan of plans) {
      const deployContract = vi.fn().mockResolvedValue('0xhash');
      const sendTransaction = vi.fn();
      const wallet = { deployContract, sendTransaction, chain: { id: 46630 } } as never;
      await expect(sendPlan(plan, wallet, OWNER)).resolves.toBe('0xhash');
      expect(deployContract).toHaveBeenCalledTimes(1);
      const sent = deployContract.mock.calls[0][0] as { account: string; bytecode: string; args: unknown[] };
      expect(sent.account, plan.title).toBe(OWNER);
      // the bundled bytecode itself, sent with no `to`: a creation, not a call to a deployer contract
      expect(sent.bytecode, plan.title).toBe(plan.deploy!.params.bytecode);
      expect(sent).not.toHaveProperty('to');
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(deployOwner(plan.deploy!), plan.title).toBe(OWNER);
      expect(planRefusals(plan, { me: OWNER, blockers: [] }), plan.title).toEqual([]);
      // a wallet may report its address in lower case: the same owner
      expect(deployRefusal(plan.deploy!, OWNER.toLowerCase() as `0x${string}`), plan.title).toBeNull();
    }
    // the server key is only the arena's settler: admin and fee wallet are the owner
    expect(plans[1].deploy!.params.args).toEqual([OWNER, KEY, OWNER]);
  });

  it('refuses a deploy whose owner is not the wallet signing it (the account changed after the preview opened)', async () => {
    for (const plan of plans) {
      const deployContract = vi.fn().mockResolvedValue('0xhash');
      const wallet = { deployContract, chain: { id: 46630 } } as never;
      await expect(sendPlan(plan, wallet, OTHER)).rejects.toThrow(/would be owned by .*but the wallet signing is/);
      expect(deployContract).not.toHaveBeenCalled();
      expect(deployRefusal(plan.deploy!, OTHER)).toMatch(/Deploy again from the owner wallet|deploy again from the owner wallet/);
      expect(planRefusals(plan, { me: OTHER, blockers: [] }).join(' ')).toMatch(/Owner check: .* would be owned by/);
    }
  });
});
