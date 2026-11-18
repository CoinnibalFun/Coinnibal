/**
 * Gas of the server key's transactions on the real CoinnibalArena v3 (hardhat node): one `settle` batch of 1, 10 and
 * 40 tickets (the worker's chunk size), so the server key's ETH budget can be planned:
 *   ETH per bell ~= sum over arenas of ceil(tickets / 40) batches x gas per batch x gas price (+ the L1 data fee
 *   of an Orbit chain, which this local node does not charge).
 *
 *   node --import tsx scripts/bench/settle-gas.ts      (from apps/server)
 */
import { createElymumWalletClient, getSession, sendCall, settleCall, viemChain } from '@coinnibal/sdk';
import { startHardhatArena } from './hardhat-arena';

const hh = await startHardhatArena({ players: 51 });
const wallet = createElymumWalletClient(hh.url, { account: hh.server, chain: viemChain(31337, { rpcUrl: hh.url }), pollingInterval: 20 });
const out: Record<string, number> = {};
let offset = 0;
for (const n of [1, 10, 40]) {
  const group = hh.players.slice(offset, offset + n);
  offset += n;
  await hh.buyAll((i) => (i >= offset - n && i < offset ? 1 : 2));
  const items: { arenaId: number; player: `0x${string}`; sessionId: bigint; payout: bigint }[] = [];
  for (const p of group) {
    const s = await getSession(hh.pub, hh.arena, 1, p.address);
    // a winner's payout (2x the entry fee) for half of them, 0 for the others: profit fees and plain transfers both run
    const k: number = items.length;
    const payout: bigint = k === n - 1 && n % 2 === 1 ? s.entryFee : k % 2 === 0 ? s.entryFee * 2n : 0n;
    items.push({ arenaId: 1, player: p.address, sessionId: s.id, payout });
  }
  // the vault must cover the winners: the losers' stakes do, as at a real bell
  const hash = await sendCall(wallet, settleCall(hh.arena, items));
  const r = await hh.pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  out[`settle_${n}_items_gas`] = Number(r.gasUsed);
  out[`settle_${n}_items_status_ok`] = r.status === 'success' ? 1 : 0;
}
console.log(JSON.stringify(out, null, 2));
hh.stop();
process.exit(0);
