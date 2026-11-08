/**
 * Gas of every call the server authority pays for (`settle`, `cancel`, `sweepLoot`), in the shapes the game server
 * sends them on mainnet, measured on the in-process Hardhat network with the real ElymumArena v3, the real ElymumNFT
 * as the holder NFT and an OpenZeppelin ERC-20 as the game token (a Pons token is a plain fixed-supply ERC-20):
 *
 *   pnpm -F @elymum/contracts gas:mainnet            # prints JSON
 *   GAS_OUT=../../apps/server/test/mainnet-gas.json pnpm -F @elymum/contracts gas:mainnet
 *
 * The figures are L2 execution gas (21k base, calldata and cold storage included). Arbitrum's L1 data fee comes on
 * top and depends on the (compressed) calldata: `inputBytes` is recorded for each shape so the economic simulation
 * (`apps/server/test/mainnet-econ-sim.ts`) can price it. Steady state: the fee wallet, 0x…dEaD and the players
 * already hold tokens (no zero-to-nonzero balance writes), as they do after the first hour on mainnet.
 */
import { writeFileSync } from 'node:fs';
import { network } from 'hardhat';
import { parseEther, type Address, type Hex } from 'viem';

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const testClient = await viem.getTestClient();
const [admin, server, feeWallet] = await viem.getWalletClients();

interface Measured {
  gas: number;
  inputBytes: number;
}
async function measure(hash: Hex): Promise<Measured> {
  const [r, tx] = await Promise.all([publicClient.waitForTransactionReceipt({ hash }), publicClient.getTransaction({ hash })]);
  if (r.status !== 'success') throw new Error(`transaction ${hash} reverted`);
  return { gas: Number(r.gasUsed), inputBytes: (tx.input.length - 2) / 2 };
}

const token = await viem.deployContract('TestToken', [admin.account.address]);
const arena = await viem.deployContract('ElymumArena', [admin.account.address, server.account.address, feeWallet.account.address]);
const nft = await viem.deployContract('ElymumNFT', [admin.account.address, 10_000, parseEther('0.0003'), 2, 3, 'https://x/api/nft/', admin.account.address]);
await arena.write.setToken([token.address]);
await arena.write.setHolderPerks([nft.address, 800, 200]);
const FEE = parseEther('10000');
await arena.write.createArena([1, FEE, 2000]);
await arena.write.createArena([4, FEE, 2000]);
await arena.write.setArenaHoldersOnly([4, true]);

let nextAddr = 0x9000;
const fresh = async (): Promise<Address> => {
  const a = `0x${(nextAddr++).toString(16).padStart(40, '0')}` as Address;
  await testClient.impersonateAccount({ address: a });
  await testClient.setBalance({ address: a, value: parseEther('10') });
  await token.write.mint([a, FEE * 20n]);
  await token.write.approve([arena.address, FEE * 20n], { account: a });
  return a;
};
const joinGas: number[] = [];
async function joined(n: number, arenaId = 1): Promise<{ player: Address; sessionId: bigint }[]> {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = await fresh();
    joinGas.push((await measure(await arena.write.join([arenaId], { account: p }))).gas);
    const s = (await arena.read.getSession([arenaId, p])) as { id: bigint };
    out.push({ player: p, sessionId: s.id });
  }
  return out;
}
/** Every ticket of a measured call must be closed by it (a skipped item would make the figure meaningless). */
async function closed(items: { player: Address }[], arenaId = 1): Promise<void> {
  for (const t of items) if (((await arena.read.getSession([arenaId, t.player])) as { id: bigint }).id !== 0n) throw new Error(`ticket of ${t.player} still open: the measured call skipped it`);
}
async function settle(items: { player: Address; sessionId: bigint }[], payout: (i: number) => bigint, arenaId = 1): Promise<Measured> {
  const m = await measure(await arena.write.settle([items.map((t, i) => ({ arenaId, player: t.player, sessionId: t.sessionId, payout: payout(i) }))], { account: server.account }));
  await closed(items, arenaId);
  return m;
}

// warm-up: the fee wallet and 0x…dEaD get their first tokens (steady state afterwards); 60 lost tickets leave the
// vault the value the winners below are paid from (in the game, winners are paid what the eaten lost)
{
  const w = await joined(2);
  await settle(w, (i) => (i === 0 ? FEE * 2n : 0n));
  await settle(await joined(60), () => 0n);
}

const out: Record<string, Measured | number | string> = {};
// a death mid-round: the eaten ticket settles at 0 (no transfer at all), usually alone in its transaction
out.settle_death_1 = await settle(await joined(1), () => 0n);
for (const k of [2, 3, 5, 10]) out[`settle_death_${k}`] = await settle(await joined(k), () => 0n);
// a ticket that ends with a profit: the burn, the fee-wallet share and the net payout move
out.settle_winner_1 = await settle(await joined(1), () => FEE * 2n);
// the bell: everyone alive is settled; about half of them end above the entry fee (sim: mainnet-econ-sim)
for (const k of [1, 2, 5, 10, 20, 40]) {
  const t = await joined(k);
  out[`settle_bell_${k}`] = await settle(t, (i) => (i % 2 === 0 ? (FEE * 23n) / 10n : (FEE * 6n) / 10n));
}
// unplayed tickets (the stale sweeper): full entry fee back
{
  const c1 = await joined(1);
  out.cancel_1 = await measure(await arena.write.cancel([c1.map((t) => ({ arenaId: 1, player: t.player, sessionId: t.sessionId }))], { account: server.account }));
  await closed(c1);
  const c10 = await joined(10);
  out.cancel_10 = await measure(await arena.write.cancel([c10.map((t) => ({ arenaId: 1, player: t.player, sessionId: t.sessionId }))], { account: server.account }));
  await closed(c10);
}
out.sweepLoot = await measure(await arena.write.sweepLoot([1, 1n, parseEther('100')], { account: server.account }));

// the player side, for the abuse figures: a holder's join of the holders-only arena and passing the emblem on
await nft.write.setPhase([2]);
const holderA = await fresh();
const holderB = await fresh();
await nft.write.mintPublic([1n], { account: holderA, value: parseEther('0.0003') });
out.join_holder_arena4 = await measure(await arena.write.join([4], { account: holderA }));
out.nft_transfer = await measure(await nft.write.transferFrom([holderA, holderB, 1n], { account: holderA }));
out.join_holder_arena4_after_transfer = await measure(await arena.write.join([4], { account: holderB }));
const sorted = [...joinGas].sort((a, b) => a - b);
out.join_typical = sorted[Math.floor(sorted.length / 2)];
out.network = 'hardhat (in-process), ElymumArena v3, TestToken (OpenZeppelin ERC-20), ElymumNFT holder NFT, burn mode 0 (0x…dEaD)';
out.measuredAt = new Date().toISOString().slice(0, 10);

const json = JSON.stringify(out, null, 2);
if (process.env.GAS_OUT) writeFileSync(process.env.GAS_OUT, `${json}\n`);
console.log(json);
