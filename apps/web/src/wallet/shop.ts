import { approveCall, getAllowance, payCall } from '@elymum/sdk';
import { BOOST_KINDS, shopCartRef, shopPaymentRef, type BoostCounts, type BoostKind, type ChainStatus, type ShopBuyError, type ShopBuyResult, type ShopCartResult, type ShopPack, type ShopView } from '@elymum/shared';
import type { Address } from 'viem';
import { SERVER } from '../config';
import { isDevFake, loadDevFake } from './devFakeLoader';
import { publicClientFor } from './network';
import { verifyArena } from './pinned';
import { connected } from './store';
import { sendWalletCall, txErrorText, type TxPhase } from './tx';
import { serverText, t } from '../i18n';

/**
 * The power-up shop, client side: read the packs priced for the signed-in wallet, pay a pack with
 * `ElymumArena.pay(price, shopPaymentRef(kind))` (the arena burns `paymentBurnBps` of it, 50 % by default, and
 * sends the rest to its fee wallet; an `approve` of the arena comes first when the allowance is short), then hand
 * the transaction hash to the server, which checks the `Paid` event and credits the charges.
 */

/** `GET /api/shop` (with the session token when signed in: holder prices and the wallet's charges). */
export async function fetchShop(token: string | null, signal?: AbortSignal): Promise<ShopView> {
  const res = await fetch(`${SERVER.http}/api/shop`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal });
  if (!res.ok) throw new Error(res.status === 404 ? t('api.shopMissing') : t('api.shopLoad'));
  return (await res.json()) as ShopView;
}

/** A refused purchase (`error` is the server's code; `message` is for the player). */
export class ShopError extends Error {
  constructor(
    readonly code: ShopBuyError | 'rejected' | 'tx' | 'network',
    message: string,
    /** The payment went through on chain (its hash), so the player can retry the claim without paying again. */
    readonly txHash: string | null = null,
  ) {
    super(message);
  }
}

/** Packs per power-up in the shop sheet's cart. */
export type Cart = Record<BoostKind, number>;

export const emptyCart = (): Cart => ({ magnet: 0, leap: 0, speed: 0, invis: 0 });

/**
 * A cart's total for this wallet (pure, tested): raw base units at the wallet's prices (holder discount included), the
 * full price before the discount, the packs, and US cents when every pack in it is priced in dollars.
 */
export function cartTotals(view: Pick<ShopView, 'packs'>, cart: Cart): { raw: bigint; fullRaw: bigint; packs: number; usdCents: number | null; fullUsdCents: number | null } {
  let raw = 0n;
  let fullRaw = 0n;
  let packs = 0;
  let usd: number | null = 0;
  let fullUsd: number | null = 0;
  for (const p of view.packs) {
    const n = cart[p.kind] ?? 0;
    if (n <= 0) continue;
    packs += n;
    raw += BigInt(p.priceRaw) * BigInt(n);
    fullRaw += BigInt(p.fullPriceRaw) * BigInt(n);
    usd = usd !== null && p.usdCents !== undefined ? usd + p.usdCents * n : null;
    fullUsd = fullUsd !== null && p.fullUsdCents !== undefined ? fullUsd + p.fullUsdCents * n : null;
  }
  return { raw, fullRaw, packs, usdCents: packs > 0 ? usd : null, fullUsdCents: packs > 0 ? fullUsd : null };
}

/** `POST /api/shop/buy {kind, txHash}` (one pack) or `{cart, txHash}`: retries a few times while the server cannot see the receipt yet. */
export async function claimPack(token: string, kind: BoostKind, txHash: string, opts: { retryMs?: readonly number[] } = {}): Promise<ShopBuyResult> {
  return claimBody<ShopBuyResult>(token, { kind, txHash }, txHash, opts);
}

/** `POST /api/shop/buy {cart, txHash}`: the whole cart, applied at once by the server. */
export async function claimCart(token: string, cart: Cart, txHash: string, opts: { retryMs?: readonly number[] } = {}): Promise<ShopCartResult> {
  return claimBody<ShopCartResult>(token, { cart, txHash }, txHash, opts);
}

async function claimBody<T extends { ok: true }>(token: string, payload: Record<string, unknown>, txHash: string, opts: { retryMs?: readonly number[] }): Promise<T> {
  const waits = opts.retryMs ?? [0, 2_000, 4_000, 6_000];
  let last: ShopError | null = null;
  for (const wait of waits) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let res: Response;
    try {
      res = await fetch(`${SERVER.http}/api/shop/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
    } catch {
      last = new ShopError('network', t('api.reach'), txHash);
      continue;
    }
    const body = (await res.json().catch(() => null)) as (T & { error?: undefined }) | { error?: ShopBuyError; message?: string } | null;
    if (res.ok && body && 'ok' in body) return body;
    const code = (body && 'error' in body && body.error) || 'bad_request';
    last = new ShopError(code, serverText(body && 'message' in body ? body.message : undefined, res.status === 401 ? t('api.expiredVerify') : t('api.shopRefused')), txHash);
    // only "not visible yet" and a busy chain are worth another look
    if (code !== 'tx_pending' && code !== 'chain_busy' && code !== ('network' as ShopBuyError)) break;
  }
  throw last ?? new ShopError('bad_request', t('api.shopRefused'), txHash);
}

export type BuyPhase = TxPhase | 'verifying';

/**
 * Pays `pack` from the connected wallet and claims it: `approve` (exactly the price, only when the wallet's
 * allowance for the arena is short; a ticket's unlimited approval covers it) then `pay`. In a dev build talking to a
 * `DEV_FAKE_CHAIN` server the payment is simulated (the server records a fake `pay`). Throws `ShopError`.
 */
export async function buyPack(
  view: ShopView,
  pack: ShopPack,
  ctx: { token: string; owner: string; chain: ChainStatus; onPhase?: (p: BuyPhase) => void },
): Promise<ShopBuyResult> {
  const hash = await payShop(view, BigInt(pack.priceRaw), shopPaymentRef(pack.kind), ctx);
  ctx.onPhase?.('verifying');
  // the tokens are spent from here on: keep the hash until the server has credited it, so a claim
  // that cannot get through now (network, a slow chain, an expired session) is tried again later
  // instead of the player paying a second time
  savePendingClaim({ owner: ctx.owner, kind: pack.kind, txHash: hash, at: Date.now() });
  return settleClaim(ctx.token, ctx.owner, pack.kind, hash);
}

/**
 * Pays a whole cart with ONE `ElymumArena.pay(total, shopCartRef(cart))` (an `approve` of exactly the total first when
 * the allowance is short), then claims it: the server applies every power-up at once. Throws `ShopError`.
 */
export async function buyCart(
  view: ShopView,
  cart: Cart,
  ctx: { token: string; owner: string; chain: ChainStatus; onPhase?: (p: BuyPhase) => void; retryMs?: readonly number[] },
): Promise<ShopCartResult> {
  const total = cartTotals(view, cart);
  if (total.packs === 0) throw new ShopError('bad_request', t('api.shopRefused'));
  const hash = await payShop(view, total.raw, shopCartRef(cart), ctx);
  ctx.onPhase?.('verifying');
  savePendingClaim({ owner: ctx.owner, kind: BOOST_KINDS.find((k) => cart[k] > 0)!, cart, txHash: hash, at: Date.now() });
  return settleCartClaim(ctx.token, ctx.owner, cart, hash, ctx.retryMs ? { retryMs: ctx.retryMs } : {});
}

/** Pays `amount` to the pinned arena with `ref` (approve first when short); the transaction hash. */
async function payShop(view: ShopView, amount: bigint, ref: `0x${string}`, ctx: { owner: string; chain: ChainStatus; onPhase?: (p: BuyPhase) => void }): Promise<string> {
  if (!view.open || !view.token || !view.payTo) throw new ShopError('shop_closed', t('shop.closed'));
  let hash: string;
  if (isDevFake(ctx.chain)) {
    const dev = await loadDevFake();
    if (!dev) throw new ShopError('tx', 'No fake chain in this build.');
    hash = await dev.fakeShopPay(ctx.owner, amount, ref, (p) => ctx.onPhase?.(p));
  } else {
    const token = view.token.address as Address;
    const owner = ctx.owner as Address;
    const reader = publicClientFor(ctx.chain, connected()?.provider ?? null);
    if (!reader) throw new ShopError('network', t('api.reach'));
    // the shop pays the pinned arena only (with the compiled code, and its pinned token): never the server's word alone
    const pin = await verifyArena(reader, ctx.chain.chainId, { arena: view.payTo, token });
    if (!pin.ok) throw new ShopError(pin.reason === 'unreadable' ? 'network' : 'tx', pin.reason === 'unreadable' ? t('api.reach') : t('tf.err.ContractMismatch'));
    const arena = pin.arena;
    // an unknown allowance asks for the approval, to be safe
    const allowance = await getAllowance(reader, token, owner, arena).catch(() => 0n);
    if (allowance < amount) {
      const ok = await sendWalletCall(approveCall(token, arena, amount), { chain: ctx.chain, onPhase: (p) => ctx.onPhase?.(p) });
      if (!ok.ok) throw new ShopError(ok.error.kind === 'rejected' ? 'rejected' : 'tx', txErrorText(ok.error), null);
    }
    const res = await sendWalletCall(payCall(arena, amount, ref), { chain: ctx.chain, onPhase: (p) => ctx.onPhase?.(p) });
    if (!res.ok) throw new ShopError(res.error.kind === 'rejected' ? 'rejected' : 'tx', txErrorText(res.error), res.hash);
    hash = res.hash;
  }
  return hash;
}

/** A paid pack the server has not credited yet (kept in this browser, per wallet). */
export interface PendingClaim {
  owner: string;
  kind: BoostKind;
  /** A cart payment (claimed whole); absent for a single pack. */
  cart?: Cart;
  txHash: string;
  at: number;
}

const CLAIM_KEY = 'elymum.shop.claim.v1';
/** Refusals that are final for a payment (it was credited already, or it is not a valid payment). */
const FINAL: readonly ShopBuyError[] = ['tx_used', 'tx_failed', 'no_payment', 'wrong_token', 'wrong_sender', 'wrong_recipient', 'wrong_pack', 'wrong_amount', 'tx_stale'];

export function savePendingClaim(p: PendingClaim | null): void {
  try {
    if (p) localStorage.setItem(CLAIM_KEY, JSON.stringify(p));
    else localStorage.removeItem(CLAIM_KEY);
  } catch {
    /* storage unavailable: the claim lasts for this page only */
  }
}

/** The pending claim of `owner`, if one is kept. */
export function loadPendingClaim(owner: string | null | undefined): PendingClaim | null {
  if (!owner) return null;
  try {
    const p = JSON.parse(localStorage.getItem(CLAIM_KEY) ?? 'null') as PendingClaim | null;
    return p && typeof p.txHash === 'string' && typeof p.owner === 'string' && p.owner.toLowerCase() === owner.toLowerCase() ? p : null;
  } catch {
    return null;
  }
}

/** Claims a paid pack; the kept hash is dropped once credited or finally refused. */
export async function settleClaim(token: string, owner: string, kind: BoostKind, txHash: string, opts: { retryMs?: readonly number[] } = {}): Promise<ShopBuyResult> {
  try {
    const r = await claimPack(token, kind, txHash, opts);
    if (loadPendingClaim(owner)?.txHash === txHash) savePendingClaim(null);
    return r;
  } catch (e) {
    if (e instanceof ShopError && (FINAL as readonly string[]).includes(e.code) && loadPendingClaim(owner)?.txHash === txHash) savePendingClaim(null);
    throw e;
  }
}

/** Claims a paid cart; the kept hash is dropped once credited or finally refused. */
export async function settleCartClaim(token: string, owner: string, cart: Cart, txHash: string, opts: { retryMs?: readonly number[] } = {}): Promise<ShopCartResult> {
  try {
    const r = await claimCart(token, cart, txHash, opts);
    if (loadPendingClaim(owner)?.txHash === txHash) savePendingClaim(null);
    return r;
  } catch (e) {
    if (e instanceof ShopError && (FINAL as readonly string[]).includes(e.code) && loadPendingClaim(owner)?.txHash === txHash) savePendingClaim(null);
    throw e;
  }
}

/** Total charges (the HUD shows the shop button with a count). */
export function totalCharges(c: BoostCounts | null | undefined): number {
  return c ? BOOST_KINDS.reduce((n, k) => n + (c[k] ?? 0), 0) : 0;
}
