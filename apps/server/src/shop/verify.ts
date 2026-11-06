import type { ShopBuyError } from '@elymum/shared';
import type { TokenReceipt } from '../chain/types';

/** What a purchase transaction must contain. */
export interface PurchaseExpectation {
  /** The game token (any case). */
  token: string;
  /** The signed-in wallet that claims the purchase (any case). */
  from: string;
  /** The arena contract the payment was made to (`ElymumArena.pay`, any case). */
  arena: string;
  /** The pack's payment ref (`shopPaymentRef(kind)`). */
  ref: string;
  /** Accepted amounts, raw base units: the wallet's price (and the full price, for a holder whose discount was not seen). */
  amounts: readonly bigint[];
  /** Wall clock (unix ms): with it, a payment mined more than `maxAgeMs` ago is refused (`tx_stale`). */
  now?: number;
  /** Default `SHOP_PAYMENT_MAX_AGE_MS`. */
  maxAgeMs?: number;
}

/**
 * Oldest payment a purchase may claim (24 h). The used-hash list lives on the server's disk: should it be
 * lost, only the payments of the last day could be credited a second time, never the whole history (and an
 * old transfer of the right amount to the sink can never be claimed as a new purchase).
 */
export const SHOP_PAYMENT_MAX_AGE_MS = 24 * 3600_000;

export type PurchaseCheck =
  | { ok: true; paid: bigint }
  | { ok: false; code: Extract<ShopBuyError, 'tx_pending' | 'tx_failed' | 'no_payment' | 'wrong_token' | 'wrong_sender' | 'wrong_recipient' | 'wrong_pack' | 'wrong_amount' | 'tx_stale'> };

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Checks a receipt against a purchase: it is mined and succeeded, the arena contract emitted `Paid` for the
 * signed-in wallet with the pack's ref and exactly one of the accepted amounts, and the game token moved that amount
 * from the wallet to the arena in the same transaction (the contract burned half and paid the fee wallet the rest
 * in that call). The most specific reason is reported when nothing matches. (Replays are the inventory's job: a
 * hash is credited once.)
 */
export function verifyPurchase(receipt: TokenReceipt | null, exp: PurchaseExpectation): PurchaseCheck {
  if (!receipt) return { ok: false, code: 'tx_pending' };
  if (receipt.status !== 'success') return { ok: false, code: 'tx_failed' };
  const payments = receipt.payments ?? [];
  if (payments.length === 0) return { ok: false, code: 'no_payment' };
  const toArena = payments.filter((p) => eq(p.contract, exp.arena));
  if (toArena.length === 0) return { ok: false, code: 'wrong_recipient' };
  const mine = toArena.filter((p) => eq(p.payer, exp.from));
  if (mine.length === 0) return { ok: false, code: 'wrong_sender' };
  const forPack = mine.filter((p) => eq(p.ref, exp.ref));
  if (forPack.length === 0) return { ok: false, code: 'wrong_pack' };
  const hit = forPack.find((p) => exp.amounts.includes(p.amount));
  if (!hit) return { ok: false, code: 'wrong_amount' };
  // the tokens really moved: the game token's transfer from the wallet to the arena, of that amount
  const moved = receipt.transfers.some((t) => eq(t.token, exp.token) && eq(t.from, exp.from) && eq(t.to, exp.arena) && t.value === hit.amount);
  if (!moved) return { ok: false, code: 'wrong_token' };
  if (exp.now !== undefined && receipt.timestamp !== undefined && exp.now - receipt.timestamp > (exp.maxAgeMs ?? SHOP_PAYMENT_MAX_AGE_MS)) {
    return { ok: false, code: 'tx_stale' };
  }
  return { ok: true, paid: hit.amount };
}
