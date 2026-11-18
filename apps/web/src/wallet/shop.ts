import { approveCall, getAllowance, payCall } from '@coinnibal/sdk';
import { BOOST_KINDS, shopCartRef, shopPaymentRef, type BoostCounts, type BoostKind, type ChainStatus, type ShopBuyError, type ShopBuyResult, type ShopCartResult, type ShopPack, type ShopView } from '@coinnibal/shared';
import type { Address } from 'viem';
import { SERVER } from '../config';
import { isDevFake, loadDevFake } from './devFakeLoader';
import { publicClientFor } from './network';
import { verifyArena } from './pinned';
import { connected } from './store';
import { sendWalletCall, txErrorText, type TxPhase } from './tx';
import { serverText, t } from '../i18n';
import { storageKey } from '../storageKey';

/**
 * The power-up shop, client side: read the packs priced for the signed-in wallet, pay a pack with
 * `CoinnibalArena.pay(price, shopPaymentRef(kind))` (the arena burns `paymentBurnBps` of it, 50 % by default, and
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
 * Pays a whole cart with ONE `CoinnibalArena.pay(total, shopCartRef(cart))` (an `approve` of exactly the total first when
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
  return payArena({ token: view.token.address, payTo: view.payTo }, amount, ref, ctx);
}

/**
 * Pays `amount` of the game token with `CoinnibalArena.pay(amount, ref)` from the connected wallet: an `approve` of exactly
 * `amount` first when the wallet's allowance for the arena is short (a ticket's larger approval covers it), then `pay`;
 * the arena burns its `paymentBurnBps` share and sends the rest to its fee wallet in that call. Pays the PINNED arena
 * only (the compiled code and its pinned token), never the server's word alone. In a dev build talking to a
 * `DEV_FAKE_CHAIN` server the payment is simulated (the server records a fake `pay`). Used by the power-up shop and the
 * custom room fee. The transaction hash; throws `ShopError` (`txHash` set when the `pay` was sent but did not confirm).
 */
export async function payArena(
  target: { token: string; payTo: string },
  amount: bigint,
  ref: `0x${string}`,
  ctx: { owner: string; chain: ChainStatus; onPhase?: (p: BuyPhase) => void; onStep?: (step: 'approve' | 'pay') => void },
): Promise<string> {
  let hash: string;
  if (isDevFake(ctx.chain)) {
    const dev = await loadDevFake();
    if (!dev) throw new ShopError('tx', 'No fake chain in this build.');
    ctx.onStep?.('pay');
    hash = await dev.fakeShopPay(ctx.owner, amount, ref, (p) => ctx.onPhase?.(p));
  } else {
    const token = target.token as Address;
    const owner = ctx.owner as Address;
    const reader = publicClientFor(ctx.chain, connected()?.provider ?? null);
    if (!reader) throw new ShopError('network', t('api.reach'));
    // the payment goes to the pinned arena only (with the compiled code, and its pinned token): never the server's word alone
    const pin = await verifyArena(reader, ctx.chain.chainId, { arena: target.payTo, token });
    if (!pin.ok) throw new ShopError(pin.reason === 'unreadable' ? 'network' : 'tx', pin.reason === 'unreadable' ? t('api.reach') : t('tf.err.ContractMismatch'));
    const arena = pin.arena;
    // an unknown allowance asks for the approval, to be safe
    const allowance = await getAllowance(reader, token, owner, arena).catch(() => 0n);
    if (allowance < amount) {
      ctx.onStep?.('approve');
      const ok = await sendWalletCall(approveCall(token, arena, amount), { chain: ctx.chain, onPhase: (p) => ctx.onPhase?.(p) });
      if (!ok.ok) throw new ShopError(ok.error.kind === 'rejected' ? 'rejected' : 'tx', txErrorText(ok.error), null);
    }
    ctx.onStep?.('pay');
    const res = await sendWalletCall(payCall(arena, amount, ref), { chain: ctx.chain, onPhase: (p) => ctx.onPhase?.(p) });
    if (!res.ok) throw new ShopError(res.error.kind === 'rejected' ? 'rejected' : 'tx', txErrorText(res.error), res.hash);
    hash = res.hash;
  }
  return hash;
}

/** A paid pack the server has not credited yet (kept in this browser, per wallet and payment). */
export interface PendingClaim {
  owner: string;
  kind: BoostKind;
  /** A cart payment (claimed whole); absent for a single pack. */
  cart?: Cart;
  txHash: string;
  at: number;
}

/**
 * Every kept claim, of every wallet of this browser: a list keyed by wallet and transaction (2026-11 audit S12: one
 * slot for all of them let a second purchase, or another wallet's, overwrite a payment the server never credited).
 */
const CLAIMS_KEY = storageKey('shop.claims.v2');
/** The single slot of earlier builds: its claim moves into the list once. */
const OLD_CLAIM_KEY = storageKey('shop.claim.v1');
/**
 * How long this browser keeps a claim the server never answered for good. The server refuses a payment older than a
 * day for good (`tx_stale`); a week is far past that, so no claim the server would still credit is ever forgotten.
 */
const CLAIM_KEEP_MS = 7 * 24 * 3600_000;
/** Refusals that are final for a payment (it was credited already, or it is not a valid payment). */
const FINAL: readonly ShopBuyError[] = ['tx_used', 'tx_failed', 'no_payment', 'wrong_token', 'wrong_sender', 'wrong_recipient', 'wrong_pack', 'wrong_amount', 'tx_stale'];

const isClaim = (p: unknown): p is PendingClaim => {
  const c = p as PendingClaim | null;
  return !!c && typeof c === 'object' && typeof c.owner === 'string' && typeof c.txHash === 'string' && typeof c.kind === 'string' && typeof c.at === 'number';
};
const sameClaim = (owner: string, txHash: string) => (c: PendingClaim) => c.owner.toLowerCase() === owner.toLowerCase() && c.txHash.toLowerCase() === txHash.toLowerCase();
/** Claims this page could not write (no storage, a full storage): kept for this page at least. */
let unsaved: PendingClaim[] = [];

function readClaims(): PendingClaim[] {
  let list: PendingClaim[] = [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CLAIMS_KEY) ?? '[]');
    if (Array.isArray(raw)) list = raw.filter(isClaim);
  } catch {
    /* no storage, or an unreadable list */
  }
  for (const c of unsaved) if (!list.some(sameClaim(c.owner, c.txHash))) list.push(c);
  try {
    const old: unknown = JSON.parse(localStorage.getItem(OLD_CLAIM_KEY) ?? 'null');
    if (isClaim(old)) {
      if (!list.some(sameClaim(old.owner, old.txHash))) list.push(old);
      // the list first: should that fail, the old slot keeps the claim
      if (!writeClaims(list)) return list;
    }
    localStorage.removeItem(OLD_CLAIM_KEY);
  } catch {
    /* an unreadable old slot holds nothing to keep */
  }
  return list;
}

function writeClaims(list: PendingClaim[]): boolean {
  try {
    if (list.length) localStorage.setItem(CLAIMS_KEY, JSON.stringify(list));
    else localStorage.removeItem(CLAIMS_KEY);
    unsaved = [];
    return true;
  } catch {
    unsaved = list;
    return false;
  }
}

/** Keeps a paid claim beside every other kept one (the same wallet and transaction again: replaced, never doubled). */
export function savePendingClaim(p: PendingClaim): void {
  const now = Date.now();
  const list = readClaims().filter((c) => !sameClaim(p.owner, p.txHash)(c) && now - c.at < CLAIM_KEEP_MS);
  writeClaims([...list, p]);
}

/** Forgets exactly one kept claim: the server credited it, or refused it for good. */
export function dropPendingClaim(owner: string, txHash: string): void {
  const list = readClaims();
  const next = list.filter((c) => !sameClaim(owner, txHash)(c));
  if (next.length !== list.length) writeClaims(next);
}

/** Every claim kept for `owner`, oldest first. */
export function loadPendingClaims(owner: string | null | undefined): PendingClaim[] {
  if (!owner) return [];
  return readClaims()
    .filter((c) => c.owner.toLowerCase() === owner.toLowerCase())
    .sort((a, b) => a.at - b.at);
}

/** Claims a paid pack; this payment's kept claim (and only it) is dropped once credited or finally refused. */
export async function settleClaim(token: string, owner: string, kind: BoostKind, txHash: string, opts: { retryMs?: readonly number[] } = {}): Promise<ShopBuyResult> {
  try {
    const r = await claimPack(token, kind, txHash, opts);
    dropPendingClaim(owner, txHash);
    return r;
  } catch (e) {
    if (e instanceof ShopError && (FINAL as readonly string[]).includes(e.code)) dropPendingClaim(owner, txHash);
    throw e;
  }
}

/** Claims a paid cart; this payment's kept claim (and only it) is dropped once credited or finally refused. */
export async function settleCartClaim(token: string, owner: string, cart: Cart, txHash: string, opts: { retryMs?: readonly number[] } = {}): Promise<ShopCartResult> {
  try {
    const r = await claimCart(token, cart, txHash, opts);
    dropPendingClaim(owner, txHash);
    return r;
  } catch (e) {
    if (e instanceof ShopError && (FINAL as readonly string[]).includes(e.code)) dropPendingClaim(owner, txHash);
    throw e;
  }
}

/** Total charges (the HUD shows the shop button with a count). */
export function totalCharges(c: BoostCounts | null | undefined): number {
  return c ? BOOST_KINDS.reduce((n, k) => n + (c[k] ?? 0), 0) : 0;
}
