import { customRoomPaymentRef, type ChainStatus, type CustomRoomQuote } from '@elymum/shared';
import type { Hash } from 'viem';
import { ShopError, payArena, type BuyPhase } from '../wallet/shop';

/**
 * `ok`: the fee was paid (`hash`). Not ok: `rejected` (the player declined in the wallet), and `hash` when the `pay` was
 * sent but did not confirm here (a timeout, a revert): the server is asked about it all the same, never a second payment.
 */
export type PayResult = { ok: true; hash: Hash } | { ok: false; message: string; rejected: boolean; hash: Hash | null };

/**
 * Pays the room fee in the game token, exactly like a power-up cart (`payArena`): an `approve` of exactly `raw` when the
 * allowance is short, then `CoinnibalArena.pay(raw, customRoomPaymentRef(request))` to the pinned arena the quote names
 * (half burned, half to the fee wallet in that call). `request` is this room request's own id: the server opens one
 * room for it. On a DEV_FAKE_CHAIN server the payment is simulated (the server records a fake `pay`).
 */
export async function payRoomFee(
  pay: NonNullable<CustomRoomQuote['pay']>,
  raw: bigint,
  request: string,
  ctx: { owner: string; chain: ChainStatus; onPhase: (p: BuyPhase) => void; onStep?: (step: 'approve' | 'pay') => void },
): Promise<PayResult> {
  try {
    const hash = await payArena({ token: pay.token.address, payTo: pay.payTo }, raw, customRoomPaymentRef(request), { owner: ctx.owner, chain: ctx.chain, onPhase: ctx.onPhase, onStep: ctx.onStep });
    return { ok: true, hash: hash as Hash };
  } catch (e) {
    const err = e instanceof ShopError ? e : new ShopError('tx', (e as Error)?.message ?? String(e));
    return { ok: false, rejected: err.code === 'rejected', hash: (err.txHash as Hash | null) ?? null, message: err.message };
  }
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A fresh room request id (`CUSTOM_REQUEST_RE`: 16 base32 characters, 80 random bits): one per room the player pays for. */
export function newRoomRequest(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += B32[b & 31];
  return out;
}
