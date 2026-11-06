/**
 * Failure drills against a real ElymumArena v3 (hardhat node, blocks every 250 ms) and the real game server in a
 * child process (`drill-server.ts`, NODE_ENV=production, 3 room workers, the production viem client and RPC
 * budget). DRILL_PLAYERS players buy real tickets over the four arenas, connect over WebSocket, sign in (session
 * tokens), take their seats and steer. Then one failure per drill:
 *
 * - `worker`:   a room worker dies mid-round (`WorkerPool.crash`);
 * - `sigterm`:  the container is stopped mid-round (what `update.sh` / `docker compose up -d` does on a deploy) and a
 *               new one starts at once;
 * - `sigkill`:  the process dies mid-round (OOM kill, `docker kill`, host crash) and is started again;
 * - `disk`:     DATA_DIR (a tmpfs) fills up mid-round, a new ticket is seated while the journal cannot be written,
 *               the RPC goes down, the process is killed, the disk is freed and the server started again.
 *
 * Clients behave like the web client: on a close they reconnect (500 ms, then backing off), sign in again and ask
 * for their arena again (a live coin is reattached). For every drill: shutdown / boot time, per-client downtime
 * and what the reconnect got back (the same coin or not), and on chain: every ticket of the drill closed exactly
 * once (one `Settled` or `Cancelled` per session id), never twice, with the payouts and loot burns adding up to the
 * stakes (vault back to 0).
 *
 *   node --import tsx scripts/bench/drills.ts                     (from apps/server; needs root for the tmpfs drill)
 *   DRILLS=worker,sigterm,sigkill,disk DRILL_PLAYERS=40 node --import tsx scripts/bench/drills.ts
 */
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getArena, getSession } from '@elymum/sdk';
import { PROTOCOL_VERSION, encodeTarget } from '@elymum/shared';
import WebSocket from 'ws';
import { Auth } from '../../src/auth';
import { ChaosRpc, CLEAN } from './chaos-rpc';
import { freePort, startHardhatArena } from './hardhat-arena';

const here = dirname(fileURLToPath(import.meta.url));
const PLAYERS = Number(process.env.DRILL_PLAYERS ?? 40);
const DRILLS = (process.env.DRILLS ?? 'worker,sigterm,sigkill,disk').split(',');
const ROUND_S = 90;
const STALE_S = 90;
const SECRET = 'drill-secret-0123456789abcdef0123456789abcdef';
const say = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hh = await startHardhatArena({ players: PLAYERS, intervalMs: 250 });
const chaos = new ChaosRpc(hh.url);
const rpcUrl = await chaos.listen();
const auth = new Auth(Buffer.from(SECRET, 'utf8'));
const arenaOf = (i: number) => (i % 4) + 1;
say(`hardhat arena ${hh.arena}; ${PLAYERS} players`);

/* ------------------------------------------------------------ server */

let server: ChildProcess | null = null;
let serverLog: string[] = [];
let port = 0;

async function startServer(dataDir: string): Promise<number> {
  port = port || (await freePort());
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    CHAIN_ID: '31337',
    EVM_RPC_URL: rpcUrl,
    SERVER_PRIVATE_KEY: hh.serverKey,
    ARENA_ADDRESS: hh.arena,
    DATA_DIR: dataDir,
    AUTH_SECRET: SECRET,
    GAME_ACCESS: 'public',
    GAME_WORKERS: '3',
    HOST: '127.0.0.1',
    PORT: String(port),
    TRUST_PROXY: '1',
    TRUST_PROXY_HOPS: '1',
    ROUND_SECONDS: String(ROUND_S),
    ROUND_JOIN_CLOSE_SECONDS: '5',
    STALE_SESSION_AFTER_S: String(STALE_S),
    PUBLIC_URL: 'http://127.0.0.1',
  };
  const t0 = Date.now();
  const child = fork(join(here, 'drill-server.ts'), [], { execArgv: ['--import', 'tsx'], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const onLine = (b: Buffer) => {
    for (const l of b.toString().split('\n')) if (l.trim()) serverLog.push(l);
  };
  child.stdout!.on('data', onLine);
  child.stderr!.on('data', onLine);
  server = child;
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`server did not start:\n${serverLog.slice(-20).join('\n')}`)), 90_000);
    child.on('message', (m: { t: string }) => {
      if (m.t === 'ready') {
        clearTimeout(to);
        resolve();
      }
    });
    child.on('exit', (c) => reject(new Error(`server exited ${c}:\n${serverLog.slice(-20).join('\n')}`)));
  });
  return Date.now() - t0;
}

function ask<T>(msg: object, reply: string, timeoutMs = 5000): Promise<T | null> {
  const s = server;
  if (!s || s.exitCode !== null) return Promise.resolve(null);
  return new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), timeoutMs);
    const on = (m: { t: string }) => {
      if (m.t !== reply) return;
      clearTimeout(to);
      s.off('message', on);
      resolve(m as T);
    };
    s.on('message', on);
    s.send(msg);
  });
}

function waitExit(c: ChildProcess): Promise<number | null> {
  // a child killed by a signal has exitCode null and signalCode set
  return new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r(c.exitCode) : c.once('exit', (code) => r(code))));
}

/* ------------------------------------------------------------ clients */

interface Player {
  i: number;
  wallet: string;
  arenaId: number;
  ws: WebSocket | null;
  token: string;
  seatedPid: number | null;
  session: string | null;
  closedAt: number | null;
  events: string[];
  downtimes: number[];
  retry: number;
  steer: NodeJS.Timeout | null;
  stop: boolean;
}

const players: Player[] = hh.players.map((a, i) => ({
  i,
  wallet: a.address,
  arenaId: arenaOf(i),
  ws: null,
  token: auth.issueToken(a.address),
  seatedPid: null,
  session: null,
  closedAt: null,
  events: [],
  downtimes: [],
  retry: 0,
  steer: null,
  stop: false,
}));

function connect(p: Player): void {
  if (p.stop) return;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: false, headers: { 'x-forwarded-for': `10.9.${p.i}.1` } });
  p.ws = ws;
  ws.on('open', () => {
    p.retry = 0;
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
    ws.send(JSON.stringify({ t: 'viewport', w: 1600, h: 900 }));
    ws.send(JSON.stringify({ t: 'auth', token: p.token }));
  });
  ws.on('message', (data: Buffer, binary: boolean) => {
    if (binary) return;
    let m: { t: string; code?: string; playerId?: number; session?: string; reason?: string };
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.t === 'welcome' && p.closedAt !== null) {
      p.downtimes.push(Date.now() - p.closedAt);
      p.closedAt = null;
    }
    if (m.t === 'authed') ws.send(JSON.stringify({ t: 'join', room: `arena:${p.arenaId}`, name: `drill${p.i}`, skin: 1 }));
    if (m.t === 'joined') {
      const same = p.session !== null && m.session === p.session;
      p.events.push(p.session === null ? 'seated' : same ? 'resumed-same-coin' : 'joined-other-session');
      p.seatedPid = m.playerId ?? null;
      p.session = m.session ?? null;
    }
    if (m.t === 'error') p.events.push(`error:${m.code}`);
    if (m.t === 'death') p.events.push('death');
    if (m.t === 'roundOver') p.events.push('roundOver');
  });
  ws.on('close', (code) => {
    p.events.push(`close:${code}`);
    p.ws = null;
    if (p.closedAt === null) p.closedAt = Date.now();
    if (p.stop) return;
    const delay = Math.min(8000, 500 * 2 ** p.retry++);
    setTimeout(() => connect(p), delay).unref();
  });
  ws.on('error', () => undefined);
}

function startSteering(p: Player): void {
  const buf = new ArrayBuffer(9);
  let x = 0;
  let y = 0;
  p.steer = setInterval(() => {
    if (p.ws?.readyState !== WebSocket.OPEN) return;
    x += (Math.random() - 0.5) * 400;
    y += (Math.random() - 0.5) * 400;
    p.ws.send(encodeTarget(x, y, buf));
  }, 50);
  p.steer.unref();
}

function disconnectAll(): void {
  for (const p of players) {
    p.stop = true;
    if (p.steer) clearInterval(p.steer);
    p.ws?.terminate();
  }
}

/* ------------------------------------------------------------ chain checks */

interface Ticket {
  arenaId: number;
  player: `0x${string}`;
  sessionId: bigint;
  entryFee: bigint;
}

async function openTickets(): Promise<Ticket[]> {
  const out: Ticket[] = [];
  for (const [i, a] of hh.players.entries()) {
    const s = await getSession(hh.pub, hh.arena, arenaOf(i), a.address);
    if (s.id !== 0n && !s.finalized) out.push({ arenaId: arenaOf(i), player: a.address, sessionId: s.id, entryFee: s.entryFee });
  }
  return out;
}

async function allClosed(tickets: Ticket[]): Promise<number> {
  let open = 0;
  for (const t of tickets) {
    const s = await getSession(hh.pub, hh.arena, t.arenaId, t.player);
    if (s.id === t.sessionId && !s.finalized) open++;
  }
  return open;
}

async function verify(tickets: Ticket[], fromBlock: bigint) {
  const settled = await hh.logs('Settled', fromBlock);
  const cancelled = await hh.logs('Cancelled', fromBlock);
  const loot = (await hh.pub.getContractEvents({ address: hh.arena, abi: (await import('@elymum/sdk')).elymumArenaAbi, eventName: 'LootBurned', fromBlock })) as unknown as { args: { amount: bigint } }[];
  const count = new Map<string, number>();
  for (const l of [...settled, ...cancelled]) count.set(String(l.args.sessionId), (count.get(String(l.args.sessionId)) ?? 0) + 1);
  const ids = tickets.map((t) => String(t.sessionId));
  const deposits = tickets.reduce((a, t) => a + t.entryFee, 0n);
  const paid = settled.reduce((a, l) => a + (l.args.payout as bigint), 0n) + cancelled.reduce((a, l) => a + (l.args.amount as bigint), 0n);
  const burned = loot.reduce((a, l) => a + l.args.amount, 0n);
  const vaults: string[] = [];
  for (const id of [1, 2, 3, 4]) vaults.push(String((await getArena(hh.pub, hh.arena, id)).vault / 10n ** 18n));
  return {
    tickets: tickets.length,
    closedOnce: ids.filter((s) => count.get(s) === 1).length,
    neverClosed: ids.filter((s) => !count.has(s)).length,
    closedTwice: ids.filter((s) => (count.get(s) ?? 0) > 1).length,
    cancelledAtEntryFee: cancelled.length,
    depositsTokens: String(deposits / 10n ** 18n),
    paidGrossTokens: String(paid / 10n ** 18n),
    lootBurnedTokens: String(burned / 10n ** 18n),
    conservationGapWei: String(deposits - paid - burned),
    vaultLeftTokensByArena: vaults,
  };
}

/* ------------------------------------------------------------ one drill */

async function seatEveryone(): Promise<Ticket[]> {
  const bought = await hh.buyAll(arenaOf);
  const tickets = await openTickets();
  for (const p of players) {
    p.stop = false;
    p.session = null;
    p.events = [];
    p.downtimes = [];
    p.closedAt = null;
    if (!p.ws) connect(p);
    else p.ws.send(JSON.stringify({ t: 'join', room: `arena:${p.arenaId}`, name: `drill${p.i}`, skin: 1 }));
    if (!p.steer) startSteering(p);
  }
  // joins close in the last 5 s of a round: wait for every seat (retrying a join refused at the round's end)
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; ) {
    const unseated = players.filter((p) => p.session === null);
    if (unseated.length === 0) break;
    for (const p of unseated) if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify({ t: 'join', room: `arena:${p.arenaId}`, name: `drill${p.i}`, skin: 1 }));
    await sleep(2000);
  }
  say(`  ${bought} tickets bought, ${players.filter((p) => p.session).length}/${players.length} seated`);
  return tickets;
}

const leftInRound = () => ROUND_S - ((Date.now() / 1000) % ROUND_S);
/** Waits for the start of the next round (a few seconds after its bell), so seats and the failure land mid-round. */
async function nextRoundStart(): Promise<void> {
  while (leftInRound() < ROUND_S - 4) await sleep(250);
  await sleep(1000);
}

async function settleAndVerify(tickets: Ticket[], fromBlock: bigint, waitS: number) {
  const t0 = Date.now();
  let open = tickets.length;
  while (Date.now() - t0 < waitS * 1000) {
    open = await allClosed(tickets);
    if (open === 0) break;
    await sleep(3000);
  }
  const closedAfterS = Math.round((Date.now() - t0) / 1000);
  const check = await verify(tickets, fromBlock);
  return { openAfterWait: open, waitedS: closedAfterS, ...check };
}

function clientSummary() {
  const tally: Record<string, number> = {};
  for (const p of players) for (const e of new Set(p.events)) tally[e] = (tally[e] ?? 0) + 1;
  const downs = players.flatMap((p) => p.downtimes).sort((a, b) => a - b);
  return {
    eventsByPlayers: tally,
    reconnectDowntimeMs: downs.length ? { n: downs.length, p50: downs[Math.floor(downs.length / 2)], max: downs.at(-1) } : null,
  };
}

const results: Record<string, unknown> = {};
let dataDir = mkdtempSync(join(tmpdir(), 'elymum-drill-'));
say(`server boot: ${await startServer(dataDir)} ms`);

for (const drill of DRILLS) {
  say(`drill ${drill}`);
  serverLog = serverLog.slice(-50);
  chaos.mode = { ...CLEAN };
  const fromBlock = await hh.pub.getBlockNumber();
  await nextRoundStart();
  const tickets = await seatEveryone();
  await sleep(8000);
  const r0 = { secondsLeftInRoundAtFailure: Math.round(leftInRound()), seated: players.filter((p) => p.session).length };
  const r: Record<string, unknown> = { ...r0 };
  if (drill === 'worker') {
    const before = (await ask<{ live: unknown[] }>({ t: 'stats' }, 'stats'))?.live.length;
    await ask({ t: 'crash', index: 0 }, 'crashed');
    await sleep(15_000);
    r.liveBefore = before;
    r.serverLog = serverLog.filter((l) => /worker|crash|recover/i.test(l)).slice(-6);
  } else if (drill === 'sigterm' || drill === 'sigkill') {
    const c = server!;
    const closed = new Promise<{ ms: number; pending: number } | null>((res) => {
      c.on('message', (m: { t: string; ms: number; pending: number }) => m.t === 'closed' && res(m));
      c.once('exit', () => setTimeout(() => res(null), 50));
    });
    const k0 = Date.now();
    c.kill(drill === 'sigterm' ? 'SIGTERM' : 'SIGKILL');
    const info = await closed;
    await waitExit(c);
    r.stopMs = Date.now() - k0;
    r.pendingAtExit = info?.pending ?? 'unknown (killed)';
    r.bootMs = await startServer(dataDir);
    r.downtimeMs = Date.now() - k0;
  } else if (drill === 'disk') {
    // a small tmpfs as DATA_DIR: stop, move the data onto it, start again
    server!.kill('SIGTERM');
    await waitExit(server!);
    const tiny = mkdtempSync(join(tmpdir(), 'elymum-tiny-'));
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=48m', 'tmpfs', tiny]);
    execFileSync('cp', ['-a', `${dataDir}/.`, tiny]);
    dataDir = tiny;
    await startServer(dataDir);
    // the SIGTERM above settled the drill's tickets at their current value: buy and seat a fresh set
    await settleAndVerify(tickets, fromBlock, 120);
    const from2 = await hh.pub.getBlockNumber();
    await nextRoundStart();
    const t2 = await seatEveryone();
    await sleep(5000);
    // the disk fills up
    try {
      execFileSync('dd', ['if=/dev/zero', `of=${join(dataDir, 'filler')}`, 'bs=1M', 'count=100'], { stdio: 'ignore' });
    } catch {
      /* full */
    }
    await sleep(3000);
    // one player leaves and buys a ticket in another arena while the journal cannot be written
    const late = players[0];
    const lateArena = late.arenaId === 1 ? 2 : 1;
    const lateWallet = hh.players[0];
    const { joinCall, sendCall, createElymumWalletClient, viemChain } = await import('@elymum/sdk');
    const w = createElymumWalletClient(hh.url, { account: lateWallet, chain: viemChain(31337, { rpcUrl: hh.url }), pollingInterval: 50 });
    const h = await sendCall(w, joinCall(hh.arena, lateArena));
    await hh.pub.waitForTransactionReceipt({ hash: h, pollingInterval: 50 });
    const ls = await getSession(hh.pub, hh.arena, lateArena, lateWallet.address);
    late.ws?.send(JSON.stringify({ t: 'join', room: `arena:${lateArena}`, name: 'late', skin: 1 }));
    await sleep(4000);
    const st = await ask<{ writeFailing: boolean; live: { session: string }[] }>({ t: 'stats' }, 'stats');
    r.journalWriteFailing = st?.writeFailing;
    r.lateTicketSeatedWhileDiskFull = st?.live.some((l) => l.session.endsWith(`:${ls.id}`)) ?? null;
    r.healthWhileDiskFull = await fetch(`http://127.0.0.1:${port}/api/health`).then((x) => x.json()).catch(() => null);
    r.serverLog = serverLog.filter((l) => /journal|ENOSPC|!!!/i.test(l)).slice(-4);
    // the RPC goes down, the process dies (nothing sent, nothing more written), the disk is freed, it starts again
    chaos.mode = { ...CLEAN, down: true };
    server!.kill('SIGKILL');
    await waitExit(server!);
    rmSync(join(dataDir, 'filler'), { force: true });
    chaos.mode = { ...CLEAN };
    await startServer(dataDir);
    const lateTicket: Ticket = { arenaId: lateArena, player: lateWallet.address, sessionId: ls.id, entryFee: ls.entryFee };
    r.result = await settleAndVerify([...t2, lateTicket], from2, ROUND_S * 2 + STALE_S + 120);
    const lateEvents = [...(await hh.logs('Settled', from2)), ...(await hh.logs('Cancelled', from2))].filter((l) => String(l.args.sessionId) === String(ls.id));
    r.lateTicketClosedBy = lateEvents.map((l) => ({ event: (l as unknown as { eventName: string }).eventName, amountTokens: String(((l.args.payout ?? l.args.amount) as bigint) / 10n ** 18n) }));
    r.clients = clientSummary();
    results[drill] = r;
    say(JSON.stringify(r));
    continue;
  }
  r.result = await settleAndVerify(tickets, fromBlock, ROUND_S * 2 + 60);
  r.clients = clientSummary();
  results[drill] = r;
  say(JSON.stringify(r));
}

const out = { players: PLAYERS, roundS: ROUND_S, results };
if (process.env.DRILL_OUT) writeFileSync(process.env.DRILL_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
disconnectAll();
const last = server as ChildProcess | null;
last?.kill('SIGTERM');
if (last) await waitExit(last);
try {
  execFileSync('umount', [dataDir], { stdio: 'ignore' });
} catch {
  /* not a mount */
}
mkdirSync(dataDir, { recursive: true });
rmSync(dataDir, { recursive: true, force: true });
await chaos.close();
hh.stop();
process.exit(0);
