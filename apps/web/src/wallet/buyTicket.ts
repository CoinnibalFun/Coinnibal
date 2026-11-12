import { approveCall, getAllowance, getArenaConfig, planJoin, type ArenaConfig } from '@elymum/sdk';
import type { ChainStatus, FeeRates } from '@elymum/shared';
import { encodeFunctionData, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import { useUi } from '../store';
import { loadDevFake } from './devFakeLoader';
import { pinErrorName, verifyArena } from './pinned';
import { approvalIsSafe, approveAmount, joinGasAfterApprove, planErrorName, sameRates, ticketRates, type TicketStep } from './ticket';
import { sendWalletCall, txErrorText, type TxPhase } from './tx';

/** What the player was shown and agreed to (frozen at confirm): the ticket is bought at exactly this or not at all. */
export interface TicketReview {
  /** The entry fee, base units of the game token. */
  fee: bigint;
  /** The fee rates on profit the ticket will be fixed at. */
  rates: FeeRates;
  /** The calls, in order (`ticketSteps`). */
  steps: TicketStep[];
  /** Tickets the approval covers (1, 5, 10 or 20 entry fees). */
  approve: number;
}

export interface TicketPurchase {
  owner: Address;
  chain: ChainStatus;
  /** The read client of the server's chain (null on the dev fake chain). */
  client: PublicClient | null;
  /** The arena contract's config (its game token must be set). */
  config: ArenaConfig;
  arenaId: number;
  review: TicketReview;
  /** The DEV_FAKE_CHAIN stand-in. */
  fake: boolean;
}

export type TicketPurchaseResult = { ok: true; hash: Hash } | { ok: false; text: string };

const failName = (name: string, fallback?: string): TicketPurchaseResult => ({ ok: false, text: txErrorText({ kind: 'unknown', name, message: fallback ?? name }) });

/**
 * Buys one arena ticket: `approve` (only when the allowance is short) then `join`. The one money path of the ticket
 * sheet (`TicketFlow`) and of the paid room creator (`RoomCreator`, the creator's own ticket right after the room
 * opens), so both sign exactly the same checked calls:
 *
 * - the server must not keep the arena closed (vault short of its journal);
 * - the arena, its config and the allowance are re-read right before the wallet opens: the price and the fee rates
 *   signed must be the ones shown (`review`), else nothing is signed (`PriceChanged`, `FeeChanged`);
 * - the arena must be the one this build pins, with the compiled code, and its token the pinned token (`verifyArena`);
 * - the approval names exactly the amount shown (never unlimited) to the pinned arena (`approvalIsSafe`);
 * - the join goes out with its own gas limit once the approval is visible (`joinGasAfterApprove`).
 */
export async function buyTicket(p: TicketPurchase, onPhase: (step: TicketStep | null, phase: TxPhase, hash?: Hash) => void): Promise<TicketPurchaseResult> {
  const { owner, chain, client, config, arenaId, review } = p;
  if (p.fake) {
    const dev = await loadDevFake();
    if (!dev) return failName('NetworkError');
    const res = await dev.fakeSendTicket(owner, arenaId, review.fee, review.steps, review.rates, (s, ph, h) => onPhase(s, ph, h), approveAmount(review.approve, review.fee));
    return res.ok ? { ok: true, hash: res.hash } : failName(res.name);
  }
  const arenaAddress = (chain.arenaAddress ?? null) as Address | null;
  if (!client || !arenaAddress || !config.token) return failName('NetworkError');
  // the server keeps this arena closed (vault short of its journal): never sell a ticket
  if (useUi.getState().blockedArenas.includes(arenaId)) return failName('Maintenance');
  let plan;
  let arena: Address;
  try {
    // re-read the arena, the allowance and the config: the price and the fee rates (fixed into the ticket at join)
    // signed must be the ones shown
    const [pl, fresh] = await Promise.all([
      planJoin(client, { arena: arenaAddress, arenaId, player: owner, token: config.token, approve: 'exact' }),
      getArenaConfig(client, arenaAddress),
    ]);
    // the arena must be the pinned one, with the compiled code, and its token the pinned token: else nothing is signed
    const pin = await verifyArena(client, chain.chainId!, { arena: arenaAddress, token: fresh.token });
    if (!pin.ok) return failName(pinErrorName(pin.reason));
    if (!fresh.token || fresh.token.toLowerCase() !== config.token.toLowerCase()) return failName('PriceChanged');
    arena = pin.arena;
    if (pl.entryFee !== review.fee) return failName('PriceChanged');
    // the rates this ticket will be fixed at: the holder pair for holders (planJoin reads them on chain)
    const now = pl.rates ?? ticketRates({ burnBps: fresh.burnBps, vaultBps: fresh.vaultBps }, fresh, pl.holder).rates;
    if (!sameRates(now, review.rates)) return failName('FeeChanged');
    if (fresh.paused) return failName('Paused');
    plan = pl;
  } catch (err) {
    return err instanceof RangeError ? failName(planErrorName(err.message), err.message) : failName('NetworkError');
  }
  if (useUi.getState().blockedArenas.includes(arenaId)) return failName('Maintenance');
  if (plan.approve) {
    // exactly this ticket (or the capped batch the player ticked), to the pinned arena: checked once more as built
    const amount = approveAmount(review.approve, plan.entryFee);
    const call = approveCall(config.token, arena, amount);
    if (!approvalIsSafe(call, { token: config.token, arena, amount })) return failName('ContractMismatch');
    const ok = await sendWalletCall(call, { chain, onPhase: (ph, h) => onPhase('approve', ph, h) });
    if (!ok.ok) return { ok: false, text: txErrorText(ok.error) };
  }
  // the join goes out with its own gas limit, estimated once the allowance is visible (a wallet whose node has not
  // seen the approval yet would otherwise guess, and the ticket would be refused)
  let joinData: Hex | null = null;
  try {
    joinData = encodeFunctionData({ abi: plan.join.abi, functionName: plan.join.functionName, args: plan.join.args } as never);
  } catch {
    joinData = null;
  }
  const token = config.token;
  const gas = joinData ? await joinGasAfterApprove(client, () => getAllowance(client, token, owner, arena), { owner, arena, data: joinData, fee: plan.entryFee }) : undefined;
  const res = await sendWalletCall(plan.join, { chain, onPhase: (ph, h) => onPhase('join', ph, h), ...(gas !== undefined ? { gas } : {}) });
  if (!res.ok) return { ok: false, text: txErrorText(res.error) };
  return { ok: true, hash: res.hash };
}
