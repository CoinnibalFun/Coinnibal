/**
 * Bell burst: every arena rings at once and the settlement worker must pay every ticket. The real settlement
 * worker (`EvmChain`, production viem client, RPC budget at the production defaults of 4 calls/s, burst 8) talks
 * to a real CoinnibalArena v3 on a hardhat node through `ChaosRpc`. Per scenario: BURST_TICKETS tickets are bought
 * over the four arenas, the bell queues one settlement per ticket at once (payouts redistribute each arena's
 * stakes: the per-arena sum equals what was deposited), and we measure until every ticket is closed on chain:
 *
 * - transactions the server key sent (nonce delta), items per transaction, reverted transactions;
 * - time to the first and the last payout, and the RPC calls / 429s / resets the proxy saw;
 * - correctness: every ticket closed exactly once (one `Settled` per session id), no gap or reuse in the server
 *   key's nonces, the journal empty, nothing settled twice after an ambiguous send.
 *
 * Scenarios: clean; rate-limited (public-RPC style 429s at 10 calls/s + 10 % random 429s + latency spikes);
 * RPC down for 60 s at the bell; ambiguous send (a send that lands but whose answer is lost).
 *
 *   node --import tsx scripts/bench/bell-burst.ts            (from apps/server)
 *   BURST_TICKETS=200 BURST_SCENARIOS=clean,ratelimit,down,ambiguous BURST_BLOCK_MS=250 node --import tsx scripts/bench/bell-burst.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSession } from '@coinnibal/sdk';
import { toLedger } from '@coinnibal/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmChain } from '../../src/chain/evm';
import { configureRpcBudgets } from '../../src/chain/rpc-budget';
import { sessionKey } from '../../src/chain/types';
import { loadConfig } from '../../src/config';
import { Journal, type SettlementItem } from '../../src/stake/journal';
import { ChaosRpc, CLEAN, type ChaosMode } from './chaos-rpc';
import { startHardhatArena } from './hardhat-arena';

const TICKETS = Number(process.env.BURST_TICKETS ?? 200);
const BLOCK_MS = Number(process.env.BURST_BLOCK_MS ?? 250);
const SCENARIOS = (process.env.BURST_SCENARIOS ?? 'clean,ratelimit,down,ambiguous').split(',');
const TIMEOUT_S = Number(process.env.BURST_TIMEOUT_S ?? 600);

const MODES: Record<string, { mode: ChaosMode; downForMs?: number; joins?: boolean }> = {
  clean: { mode: { ...CLEAN } },
  ratelimit: { mode: { ...CLEAN, rateLimitRps: 10, random429: 0.1, latencyMs: 80, spikePct: 0.1, spikeMs: 3000 } },
  down: { mode: { ...CLEAN, down: true }, downForMs: 60_000 },
  ambiguous: { mode: { ...CLEAN, dropSendResponseOnce: true } },
  // the bell AND every player asking for a seat in the next round at once (each paid join reads the ticket
  // on chain, `getSession`, at the same 'high' priority as the settlements)
  joins: { mode: { ...CLEAN }, joins: true },
};

const say = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const hh = await startHardhatArena({ players: TICKETS, intervalMs: BLOCK_MS });
say(`hardhat: arena ${hh.arena}, ${TICKETS} players funded, blocks every ${BLOCK_MS} ms`);
const chaos = new ChaosRpc(hh.url);
const proxyUrl = await chaos.listen();

const dir = mkdtempSync(join(tmpdir(), 'coinnibal-burst-'));
const cfg = loadConfig({
  NODE_ENV: 'production',
  CHAIN_ID: '31337',
  EVM_RPC_URL: proxyUrl,
  SERVER_PRIVATE_KEY: hh.serverKey,
  DATA_DIR: dir,
  ARENA_ADDRESS: hh.arena,
} as unknown as NodeJS.ProcessEnv);
// the production budget (RPC_MAX_RPS / RPC_BURST defaults)
configureRpcBudgets({ ratePerSec: cfg.chain.rpcMaxRps, burst: cfg.chain.rpcBurst });
const journal = new Journal(join(dir, 'journal.json'), () => {});
const logs: string[] = [];
const chain = new EvmChain(cfg, journal, (m) => logs.push(`${new Date().toISOString().slice(11, 19)} ${m}`), {
  account: privateKeyToAccount(hh.serverKey),
  contracts: () => ({ arena: hh.arena, nft: null }),
  cacheDir: dir,
  stateChainId: 31337,
});
await chain.start();
if (!chain.stakeEnabled) throw new Error(`chain not ready: ${logs.join('\n')}`);
say(`settlement worker up (server key ${hh.server.address}, RPC budget ${cfg.chain.rpcMaxRps}/s burst ${cfg.chain.rpcBurst})`);

const arenaOf = (i: number) => (i % 4) + 1;
const results: Record<string, unknown>[] = [];
for (const name of SCENARIOS) {
  const sc = MODES[name];
  if (!sc) throw new Error(`unknown scenario ${name}`);
  const bought = await hh.buyAll(arenaOf);
  const fromBlock = await hh.pub.getBlockNumber();
  // the bell: one settlement per open ticket, payouts redistribute each arena's stakes
  const now = Date.now();
  const items: SettlementItem[] = [];
  const byArena = new Map<number, { i: number; s: Awaited<ReturnType<typeof getSession>> }[]>();
  for (const [i, p] of hh.players.entries()) {
    const id = arenaOf(i);
    const s = await getSession(hh.pub, hh.arena, id, p.address);
    if (s.id === 0n || s.finalized) continue;
    const list = byArena.get(id) ?? [];
    list.push({ i, s });
    byArena.set(id, list);
  }
  for (const [id, list] of byArena) {
    const fee = toLedger(hh.entryFee.get(id)!, 18, 'floor');
    const weights = list.map(() => Math.random() ** 2);
    const sum = weights.reduce((a, b) => a + b, 0);
    let left = fee * list.length;
    list.forEach(({ s }, k) => {
      const payout = k === list.length - 1 ? left : Math.floor((fee * list.length * weights[k]) / sum);
      left -= payout;
      const key = sessionKey(id, s.player, s.id);
      items.push({ kind: 'settle', key, player: s.player, arenaId: id, session: key, sessionId: Number(s.id), payout, entryFee: fee, score: 1, kills: 0, xp: 0, reason: 'round', attempts: 0, nextAttemptAt: now, createdAt: now });
    });
  }
  const nonce0 = await hh.nonce(hh.server.address);
  chaos.resetStats();
  chaos.mode = { ...sc.mode };
  let restoredAt: number | null = null;
  if (sc.downForMs) setTimeout(() => ((chaos.mode = { ...CLEAN }), (restoredAt = Date.now())), sc.downForMs).unref();
  const t0 = Date.now();
  const settledAt: number[] = [];
  const unsub = (e: { player: string }) => settledAt.push(Date.now() - t0);
  chain.onSettled(unsub);
  for (const it of items) journal.enqueue(it);
  chain.kick();
  // players back for the next round: one ticket read per player, spread over the 15 s break after the bell
  const joinMs: number[] = [];
  const joinFailed: string[] = [];
  const joinsDone = sc.joins
    ? Promise.all(
        hh.players.map(async (p, i) => {
          await new Promise((r) => setTimeout(r, Math.random() * 15_000));
          const j0 = Date.now();
          try {
            await chain.getSession(arenaOf(i), p.address);
            joinMs.push(Date.now() - j0);
          } catch (err) {
            joinFailed.push((err as Error).message.slice(0, 80));
          }
        }),
      )
    : Promise.resolve([]);
  let timedOut = false;
  while (journal.pending.some((p) => p.kind === 'settle')) {
    if (Date.now() - t0 > TIMEOUT_S * 1000) {
      timedOut = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const elapsed = Date.now() - t0;
  await joinsDone;
  chaos.mode = { ...CLEAN };
  await new Promise((r) => setTimeout(r, BLOCK_MS * 3));
  const proxy = chaos.resetStats();
  const nonce1 = await hh.nonce(hh.server.address);
  // correctness on chain
  const settled = (await hh.logs('Settled', fromBlock)).filter((l) => true);
  const skipped = await hh.logs('SettleSkipped', fromBlock);
  const bySession = new Map<string, number>();
  for (const l of settled) bySession.set(String(l.args.sessionId), (bySession.get(String(l.args.sessionId)) ?? 0) + 1);
  const wanted = new Set(items.map((i) => String(i.sessionId)));
  const missing = [...wanted].filter((s) => !bySession.has(s));
  const twice = [...bySession].filter(([, n]) => n > 1);
  const paidWrong = settled.filter((l) => {
    const it = items.find((x) => String(x.sessionId) === String(l.args.sessionId));
    return it && toLedger(l.args.payout as bigint, 18, 'floor') !== it.payout;
  });
  const txs = new Set(settled.map((l) => l.transactionHash));
  let reverted = 0;
  for (const h of txs) if ((await hh.pub.getTransactionReceipt({ hash: h })).status !== 'success') reverted++;
  const sorted = [...settledAt].sort((a, b) => a - b);
  const r = {
    scenario: name,
    ticketsBought: bought,
    settlementsQueued: items.length,
    timedOut,
    secondsToLastPayout: Math.round(elapsed / 100) / 10,
    secondsToFirstPayout: sorted.length ? Math.round(sorted[0] / 100) / 10 : null,
    secondsToHalf: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] / 100) / 10 : null,
    secondsAfterRpcBack: restoredAt ? Math.round((t0 + elapsed - restoredAt) / 100) / 10 : null,
    serverTxs: nonce1 - nonce0,
    settleTxsWithEvents: txs.size,
    itemsPerTx: Math.round((settled.length / Math.max(1, txs.size)) * 10) / 10,
    revertedTxs: reverted,
    settledEvents: settled.length,
    skippedEvents: skipped.length,
    missing: missing.length,
    settledTwice: twice.length,
    paidWrongAmount: paidWrong.length,
    journalLeft: journal.pending.length,
    ...(sc.joins
      ? (() => {
          const a = [...joinMs].sort((x, y) => x - y);
          const q = (p: number) => (a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] / 100) / 10 : null);
          return { joinTicketReadSeconds: { n: a.length, p50: q(0.5), p95: q(0.95), max: q(1) }, joinReadsFailed: joinFailed.length };
        })()
      : {}),
    proxy: { requests: proxy.requests, calls: proxy.calls, http429: proxy.limited, resets: proxy.resets, droppedSendAnswers: proxy.droppedAnswers, sendRawTransaction: proxy.sendRaw, byMethod: proxy.byMethod },
  };
  say(JSON.stringify(r));
  results.push(r);
}
const out = { tickets: TICKETS, blockMs: BLOCK_MS, rpcBudget: { rps: cfg.chain.rpcMaxRps, burst: cfg.chain.rpcBurst }, results, notableLogs: logs.filter((l) => /!!!|retry|failed|reverted|not confirmed/i.test(l)).slice(0, 40) };
if (process.env.BURST_OUT) writeFileSync(process.env.BURST_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await chain.stop();
await chaos.close();
hh.stop();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
