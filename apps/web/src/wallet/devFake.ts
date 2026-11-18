import { MAX_ALLOWANCE, type ArenaConfig, type SessionInfo } from '@elymum/sdk';
import { DEFAULT_FEE_RATES, DEFAULT_PAYMENT_BURN_BPS, type ChainStatus, type FeeRates } from '@elymum/shared';
import type { Address, Hash } from 'viem';
import { SERVER } from '../config';
import { DEV_FAKE_ARENA_ADDRESS } from './devFakeLoader';
import type { TicketStep } from './ticket';
import type { TxPhase } from './tx';

/**
 * DEV ONLY. The game server's `DEV_FAKE_CHAIN=1` mode advertises `DEV_FAKE_ARENA_ADDRESS` and
 * hands every signed-in wallet free tickets. When the web dev build sees it, the lobby reads a
 * local stand-in for the chain (balances, allowance, open tickets) and "sends" ticket
 * transactions by waiting, so the whole lobby and ticket flow can be driven (and screenshot)
 * without a node or a wallet that sends transactions. The game token follows the server: unset
 * until `DEV_FAKE_TOKEN=1` or `POST /api/dev/token` (then the server pushes `chain`). Production
 * builds never enter this path (`import.meta.env.DEV` is false there).
 */

export interface FakeWallet {
  /** Game-token balance, base units of an 18-decimal token. */
  tokenBalance: bigint;
  /** The chain's gas token, wei. */
  wei: bigint;
  /** Allowance granted to the arena, base units. */
  allowance: bigint;
  sessions: Record<number, SessionInfo | null>;
  /** The next settled payout is "finalized" instead of paid (the collect flow, for screenshots). */
  failPayouts: boolean;
  /** Simulated wallet + network delay per phase (ms). */
  delayMs: number;
  /** Next "transaction" fails with this SDK error name (e.g. `ArenaFull`), then clears. */
  failNext: string | null;
}

const ONE = 10n ** 18n;

/** The fake chain's emblem contract (holder perks are on). */
export const FAKE_HOLDER_NFT = '0x000000000000000000000000000000000000E1B1' as Address;

export const fakeWallet: FakeWallet = {
  tokenBalance: 12_450n * ONE,
  wei: 42n * 10n ** 16n,
  allowance: 0n,
  sessions: {},
  failPayouts: false,
  delayMs: 900,
  failNext: null,
};

/** The config the fake chain stands for: the token as the server reports it (unset until it is set). */
export function fakeConfig(chain: ChainStatus): ArenaConfig {
  const token = chain.tokenReady ? chain.token : null;
  const addr = DEV_FAKE_ARENA_ADDRESS as Address;
  return {
    address: addr,
    admin: addr,
    pendingAdmin: null,
    serverAuthority: (chain.serverKey as Address | null) ?? addr,
    feeWallet: addr,
    token: (token?.address as Address | undefined) ?? null,
    decimals: token?.decimals ?? 18,
    burnBps: chain.fees?.burnBps ?? DEFAULT_FEE_RATES.burnBps,
    vaultBps: chain.fees?.vaultBps ?? DEFAULT_FEE_RATES.vaultBps,
    paused: false,
    totals: { sessions: 0n, games: 0n, staked: 0n, paidOut: 0n, feeBurned: 0n, feeToVault: 0n, lootBurned: 0n, payments: 0n, paymentBurned: 0n },
    holderNft: FAKE_HOLDER_NFT,
    holderBurnBps: fakePerks.holderRates.burnBps,
    holderVaultBps: fakePerks.holderRates.vaultBps,
    burnMode: chain.fees?.burnMode ?? 0,
    paymentBurnBps: chain.fees?.paymentBurnBps ?? DEFAULT_PAYMENT_BURN_BPS,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeHash = (): Hash => `0x${'de7fa4e0'.padEnd(56, '0')}${Date.now().toString(16).padStart(8, '0').slice(-8)}` as Hash;
/** Fake hashes never get explorer links. */
export const isFakeHash = (h: string | null | undefined): boolean => !!h && h.startsWith('0xde7fa4e0');

let nextSession = 1n;

/**
 * "Signs" and "confirms" a ticket (approve if needed, then join): applies its effects to the fake
 * wallet. `approveAmount` is what the approval grants (the entry fee, or `MAX_ALLOWANCE` once for
 * every later ticket); the join spends the entry fee from it like `transferFrom` (an unlimited
 * allowance stays unlimited, like OpenZeppelin's ERC-20).
 */
export async function fakeSendTicket(
  owner: Address,
  arenaId: number,
  entryFee: bigint,
  steps: readonly TicketStep[],
  rates: FeeRates,
  onPhase: (step: TicketStep, phase: TxPhase, hash?: Hash) => void,
  approveAmount: bigint = entryFee,
): Promise<{ ok: true; hash: Hash } | { ok: false; name: string }> {
  let last: Hash = fakeHash();
  for (const step of steps) {
    onPhase(step, 'signing');
    await sleep(fakeWallet.delayMs);
    if (fakeWallet.failNext) {
      const name = fakeWallet.failNext;
      fakeWallet.failNext = null;
      return { ok: false, name };
    }
    last = fakeHash();
    onPhase(step, 'confirming', last);
    await sleep(fakeWallet.delayMs);
    if (step === 'approve') fakeWallet.allowance = approveAmount;
  }
  fakeWallet.tokenBalance -= entryFee;
  if (fakeWallet.allowance !== MAX_ALLOWANCE) fakeWallet.allowance = fakeWallet.allowance >= entryFee ? fakeWallet.allowance - entryFee : 0n;
  fakeWallet.sessions[arenaId] = {
    arenaId,
    player: owner,
    id: nextSession++,
    entryFee,
    openedAt: Math.floor(Date.now() / 1000),
    burnBps: rates.burnBps,
    vaultBps: rates.vaultBps,
    finalized: false,
    owed: 0n,
  };
  return { ok: true, hash: last };
}

/** Simulated refund / collect transaction (`apply` moves the fake tokens). */
export async function fakeSimpleTx(onPhase: (p: TxPhase) => void, apply: () => void): Promise<boolean> {
  onPhase('signing');
  await sleep(fakeWallet.delayMs);
  onPhase('confirming');
  await sleep(fakeWallet.delayMs);
  apply();
  return true;
}

/** The fake TestToken faucet (the `/faucet` page on a DEV_FAKE_CHAIN server). */
export const fakeFaucet = {
  amount: 1_000_000n * ONE,
  holderAmount: 2_000_000n * ONE,
  cooldownSecs: 3600,
  /** Unix seconds of the next claim (0: never claimed). */
  nextAt: 0,
  /** The fake wallet holds an emblem (2x faucet, the holder rates, holders-only arenas). */
  holder: false,
};

/** The fake chain's holder perks: arena ids reserved for emblem holders, and the holder rates on profit (15 % + 0 %). */
export const fakePerks = { holdersOnly: [4] as number[], holderRates: { burnBps: 1_500, vaultBps: 0 } as FeeRates };

/** "Claims" from the fake faucet. */
export async function fakeFaucetClaim(onPhase: (p: TxPhase, hash?: Hash) => void): Promise<Hash> {
  onPhase('signing');
  await sleep(fakeWallet.delayMs);
  const h = fakeHash();
  onPhase('confirming', h);
  await sleep(fakeWallet.delayMs);
  fakeWallet.tokenBalance += fakeFaucet.holder ? fakeFaucet.holderAmount : fakeFaucet.amount;
  fakeFaucet.nextAt = Math.floor(Date.now() / 1000) + fakeFaucet.cooldownSecs;
  return h;
}

/**
 * "Pays" a power-up pack or a custom room fee: the game server's fake chain records the `CoinnibalArena.pay`
 * (`POST /api/dev/pay`) and answers its hash, which the shop (or the room sheet) then claims like a real one.
 */
export async function fakeShopPay(from: string, value: bigint, ref: string, onPhase: (p: TxPhase) => void): Promise<Hash> {
  onPhase('signing');
  await sleep(fakeWallet.delayMs);
  if (fakeWallet.failNext) {
    const name = fakeWallet.failNext;
    fakeWallet.failNext = null;
    throw Object.assign(new Error(name), { name });
  }
  const res = await fetch(`${SERVER.http}/api/dev/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, value: value.toString(), ref }),
  });
  const body = (await res.json().catch(() => null)) as { hash?: Hash } | null;
  if (!res.ok || !body?.hash) throw new Error('The fake chain refused the payment.');
  onPhase('confirming');
  await sleep(fakeWallet.delayMs);
  fakeWallet.tokenBalance -= value;
  return body.hash;
}
