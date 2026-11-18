import type { EmblemClaims } from '../site/emblem-claims';
import {
  BOOST_KINDS,
  boostCooldownMs,
  emptyBoostCounts,
  cartTotal,
  normalizeBoostKind,
  normalizeCart,
  packPriceRaw,
  roundSigFigs,
  shopCartRefs,
  shopPaymentRefs,
  usdToTokenRaw,
  type BoostCounts,
  type BoostKind,
  type BoostRefusal,
  type BoostState,
  type ShopBuyError,
  type ShopBuyResult,
  type ShopCartResult,
  type ShopPack,
  type ShopSettings,
  type ShopView,
} from '@coinnibal/shared';
import { ChainBusyError, type ChainGateway } from '../chain/types';
import { InventoryError, type BoostInventory } from './inventory';
import type { ShopSettingsStore } from './settings';
import { verifyPurchase } from './verify';

/** A shown pack price is accepted for a purchase this long (the wallet prompt, a slow block, a token price change). */
export const QUOTE_VALID_MS = 15 * 60_000;

/** A refused purchase: HTTP status, the `ShopBuyError` code and a player-facing message. */
export class ShopFail extends Error {
  constructor(
    readonly status: number,
    readonly code: ShopBuyError,
    message: string,
  ) {
    super(message);
  }
}

const BUY_MESSAGES: Record<ShopBuyError, string> = {
  shop_closed: 'The power-up shop is closed right now.',
  kind_disabled: 'This power-up is not sold right now.',
  bad_request: 'That purchase request is not valid.',
  tx_used: 'This transaction was already used for a purchase.',
  tx_pending: 'The payment is not confirmed on chain yet. Try again in a moment.',
  tx_failed: 'The payment transaction failed on chain.',
  no_payment: 'That transaction is not a power-up payment.',
  wrong_token: 'That transaction did not move the game token.',
  wrong_sender: 'That payment was not sent from your signed-in wallet.',
  wrong_recipient: 'That payment did not go to the Coinnibal arena contract.',
  wrong_pack: 'That payment was made for another power-up.',
  wrong_amount: 'That payment does not match the pack price.',
  tx_stale: 'That payment is too old to be credited as a new purchase.',
  chain_busy: 'The network is busy. Your payment is safe: try again in a moment.',
};

/** Where a player is when they press a power-up key. */
export interface UseContext {
  /** The signed-in wallet (null: a guest). */
  wallet: string | null;
  isBot: boolean;
  /** A paid arena (per-round cap). */
  arena: boolean;
  /** The arena round in play (arena rooms). */
  round: number | null;
  /** The player wears the emblem laurel (`PlayerFlag.Holder`). */
  holder: boolean;
}

export interface ShopDeps {
  settings: ShopSettingsStore;
  inventory: BoostInventory;
  chain: ChainGateway;
  /** Emblem holder check (cached; `fresh` re-reads the chain). */
  holder: (wallet: string, fresh?: boolean) => Promise<boolean>;
  /** The emblem token ids a wallet owns (null: unknown); with `claims`, the discount is one wallet per token id a day. */
  emblemTokens?: (wallet: string, fresh?: boolean) => Promise<string[] | null>;
  claims?: EmblemClaims;
  /**
   * The token's USD price and the significant figures of the arenas' sync (`ArenaPriceStore`: Game → Arena prices):
   * packs priced in dollars (`priceIn: 'usd'`) are converted with them. Null / absent: the token prices apply.
   */
  usdPrice?: () => Promise<{ price: bigint; usdPerToken: string; sigFigs: number } | null>;
  /** Wall clock (cooldowns). */
  now?: () => number;
  /** Waits before re-reading a receipt that is not visible yet (default 0, 1.5 s, 3 s, 5 s). */
  receiptRetryMs?: readonly number[];
  log?: (m: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/**
 * The power-up shop: prices and packs (`GET /api/shop`), purchase verification (`POST /api/shop/buy`: the receipt
 * of an `CoinnibalArena.pay` from the signed-in wallet, exactly the pack price and the pack's ref, a hash credited
 * once; the contract burned half and sent half to the fee wallet in that call) and the in-room rules (charges,
 * cooldowns per power-up and wallet, the paid arenas' per-round cap). Bots never use bought power-ups.
 */
export class ShopService {
  private readonly now: () => number;
  /** `<wallet lower>:<kind>` → wall-clock ms it can be used again. */
  private readonly readyAt = new Map<string, number>();
  /** Paid arenas: wallet lower → uses this round. */
  private readonly arenaUses = new Map<string, { round: number; used: number }>();
  private readonly inflight = new Set<string>();
  private readonly chargeListeners: ((wallet: string) => void)[] = [];

  /** Prices quoted lately (pack kind → raw amounts and until when they are accepted): a price that moved between the
   * quote and the payment (a new token price) is still credited for a while, never refused after the player paid. */
  private readonly quoted = new Map<BoostKind, { raw: bigint; holder: boolean; until: number }[]>();
  /** Whole price tables quoted lately (a cart is priced from one table: every pack at the same token price). */
  private readonly tables: { full: Record<BoostKind, bigint>; discounted: Record<BoostKind, bigint>; until: number }[] = [];

  /** Remembers a whole price table (accepted for a cart for `QUOTE_VALID_MS`). */
  private rememberTable(full: Record<BoostKind, bigint>, discounted: Record<BoostKind, bigint>): void {
    const now = this.now();
    const same = (a: Record<BoostKind, bigint>, b: Record<BoostKind, bigint>) => BOOST_KINDS.every((k) => a[k] === b[k]);
    for (let i = this.tables.length - 1; i >= 0; i--) if (this.tables[i].until <= now) this.tables.splice(i, 1);
    const t = this.tables.find((x) => same(x.full, full) && same(x.discounted, discounted));
    if (t) t.until = now + QUOTE_VALID_MS;
    else this.tables.push({ full, discounted, until: now + QUOTE_VALID_MS });
    if (this.tables.length > 12) this.tables.splice(0, this.tables.length - 12);
  }

  /** Every pack's price now (full and discounted), raw base units; remembered as a quoted table. */
  private async priceTable(s: ShopSettings, decimals: number): Promise<{ full: Record<BoostKind, bigint>; discounted: Record<BoostKind, bigint> }> {
    const full = {} as Record<BoostKind, bigint>;
    const discounted = {} as Record<BoostKind, bigint>;
    for (const k of BOOST_KINDS) {
      const p = await this.priceOf(s, k, decimals);
      full[k] = p.full;
      discounted[k] = p.discounted;
    }
    this.rememberTable(full, discounted);
    return { full, discounted };
  }

  constructor(private readonly deps: ShopDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * One pack's price now, raw base units: full and with the holder discount, and in US cents when priced in dollars.
   * Dollars are converted at the arenas' token price and rounded to their significant figures (the discounted price
   * too, so a holder's pack is as round as a ticket).
   */
  private async priceOf(s: ShopSettings, kind: BoostKind, decimals: number): Promise<{ full: bigint; discounted: bigint; usdCents: number | null; usdPerToken: string | null }> {
    const usd = s.priceIn === 'usd' ? await this.deps.usdPrice?.().catch(() => null) : null;
    if (usd) {
      const cents = s.usdCents[kind];
      const full = usdToTokenRaw(cents, usd.price, decimals, usd.sigFigs);
      const pct = BigInt(Math.max(0, Math.min(100, Math.floor(s.holderDiscountPct))));
      const discounted = pct > 0n ? roundSigFigs((full * (100n - pct)) / 100n, usd.sigFigs) : full;
      return { full, discounted, usdCents: cents, usdPerToken: usd.usdPerToken };
    }
    return { full: packPriceRaw(s.prices[kind], decimals, 0), discounted: packPriceRaw(s.prices[kind], decimals, s.holderDiscountPct), usdCents: null, usdPerToken: null };
  }

  /** Remembers the prices that were shown (accepted for a purchase for `QUOTE_VALID_MS`). */
  private remember(kind: BoostKind, full: bigint, discounted: bigint): void {
    const now = this.now();
    const list = (this.quoted.get(kind) ?? []).filter((q) => q.until > now);
    for (const [raw, holder] of [
      [full, false],
      [discounted, true],
    ] as const) {
      const q = list.find((x) => x.raw === raw && x.holder === holder);
      if (q) q.until = now + QUOTE_VALID_MS;
      else list.push({ raw, holder, until: now + QUOTE_VALID_MS });
    }
    this.quoted.set(kind, list.slice(-12));
  }

  get settings(): ShopSettings {
    return this.deps.settings.settings;
  }

  /** `fn(wallet)`: the wallet's charges changed outside a room (a purchase): live rooms push the new state. */
  onCharges(fn: (wallet: string) => void): void {
    this.chargeListeners.push(fn);
  }

  /** The arena contract payments are made to (`pay`); null while none is registered. */
  payTo(): string | null {
    return this.deps.chain.status().arenaAddress;
  }

  private token(): { address: string; symbol: string; decimals: number } | null {
    const st = this.deps.chain.status();
    return st.tokenReady && st.token ? st.token : null;
  }

  private closedReason(s: ShopSettings): ShopView['closedReason'] | null {
    if (!s.enabled) return 'disabled';
    if (!this.deps.chain.enabled || !this.deps.chain.tokenReceipt) return 'no_chain';
    if (!this.token()) return 'no_token';
    if (!this.payTo()) return 'no_arena';
    return null;
  }

  /**
   * Whether `wallet` gets the holder discount today: it holds the emblem, and (with the token index) one of its token
   * ids has not given the discount to another wallet today. `commit`: the discounted purchase happens now.
   */
  private async discountFor(wallet: string, fresh: boolean, commit = false): Promise<boolean> {
    const holds = (await this.deps.holder(wallet).catch(() => false)) || (fresh && (await this.deps.holder(wallet, true).catch(() => false)));
    if (!holds) return false;
    const claims = this.deps.claims;
    const tokens = claims && this.deps.emblemTokens ? await this.deps.emblemTokens(wallet, fresh).catch(() => null) : null;
    // the index cannot name the wallet's token yet: balanceOf decides alone
    if (!claims || !tokens || tokens.length === 0) return true;
    return claims.daily('shop', wallet, tokens, commit) !== null;
  }

  /** `GET /api/shop`: packs priced for `wallet` (public prices for guests) and its charges. */
  async view(wallet: string | null): Promise<ShopView> {
    const s = this.settings;
    const token = this.token();
    const holder = wallet ? await this.discountFor(wallet, false) : false;
    const closed = this.closedReason(s);
    const decimals = token?.decimals ?? 18;
    let usdPerToken: string | null = null;
    const packs: ShopPack[] = [];
    for (const kind of BOOST_KINDS) {
      const p = await this.priceOf(s, kind, decimals);
      const mine = holder ? p.discounted : p.full;
      if (token) this.remember(kind, p.full, p.discounted);
      usdPerToken ??= p.usdPerToken;
      const usd =
        p.usdCents !== null
          ? { fullUsdCents: p.usdCents, usdCents: holder ? Math.round((p.usdCents * (100 - Math.max(0, Math.min(100, s.holderDiscountPct)))) / 100) : p.usdCents }
          : {};
      packs.push({ kind, charges: s.packSize, priceRaw: mine.toString(), fullPriceRaw: p.full.toString(), ...usd, enabled: s.enabled && s.kinds[kind] });
    }
    if (token) await this.priceTable(s, decimals);
    return {
      open: closed === null,
      ...(closed ? { closedReason: closed } : {}),
      token,
      payTo: this.payTo(),
      burnBps: this.deps.chain.status().fees?.paymentBurnBps ?? null,
      packs,
      holder,
      holderDiscountPct: s.holderDiscountPct,
      ...(usdPerToken ? { usdPerToken } : {}),
      arenaUsesPerRound: s.arenaUsesPerRound + (holder ? s.holderExtraArenaUses : 0),
      holderExtraArenaUses: s.holderExtraArenaUses,
      ...(wallet ? { charges: this.deps.inventory.get(wallet) } : {}),
    };
  }

  /**
   * `POST /api/shop/buy {kind, txHash}`: verifies the payment and credits a pack to `wallet`.
   * Throws `ShopFail` with the reason; never credits a hash twice (also not two requests at once).
   */
  async buy(wallet: string, body: Record<string, unknown>): Promise<ShopBuyResult> {
    const s = this.settings;
    const fail = (status: number, code: ShopBuyError): never => {
      throw new ShopFail(status, code, BUY_MESSAGES[code]);
    };
    // a claim a client saved before the Shockwave was retired names `shock`: it buys the Leap (same price)
    const kind = normalizeBoostKind(body.kind);
    const txHash = typeof body.txHash === 'string' ? body.txHash.toLowerCase() : '';
    if (!kind || !/^0x[0-9a-f]{64}$/.test(txHash)) return fail(400, 'bad_request');
    if (this.closedReason(s)) return fail(403, 'shop_closed');
    if (!s.kinds[kind]) return fail(403, 'kind_disabled');
    const token = this.token()!;
    const arena = this.payTo()!;
    if (this.deps.inventory.isUsed(txHash) || this.inflight.has(txHash)) return fail(409, 'tx_used');
    this.inflight.add(txHash);
    try {
      // the price now, and the prices shown in the last minutes (a token price that moved meanwhile)
      const now = await this.priceOf(s, kind, token.decimals);
      this.remember(kind, now.full, now.discounted);
      const fulls = new Set<bigint>([now.full]);
      const discounts = new Set<bigint>([now.discounted]);
      for (const q of this.quoted.get(kind) ?? []) if (q.until > this.now()) (q.holder ? discounts : fulls).add(q.raw);
      const full = now.full;
      let receipt = null;
      for (const wait of this.deps.receiptRetryMs ?? [0, 1_500, 3_000, 5_000]) {
        if (wait > 0) await sleep(wait);
        try {
          receipt = await this.deps.chain.tokenReceipt!(txHash);
        } catch (err) {
          if (err instanceof ChainBusyError) return fail(503, 'chain_busy');
          throw err;
        }
        if (receipt) break;
      }
      const check = verifyPurchase(receipt, {
        token: token.address,
        from: wallet,
        arena,
        ref: shopPaymentRefs(kind),
        amounts: [...new Set([...fulls, ...discounts])],
        now: this.now(),
      });
      if (!check.ok) return fail(check.code === 'tx_pending' ? 409 : 400, check.code);
      // the discounted price is only for emblem holders (re-read on chain when the cache says no), and one emblem
      // token id gives it to one wallet a day (passing the emblem around does not discount every wallet)
      if (!fulls.has(check.paid) && !(await this.discountFor(wallet, true, true))) return fail(400, 'wrong_amount');
      let charges: BoostCounts;
      try {
        charges = this.deps.inventory.credit(wallet, kind, s.packSize, txHash, check.paid);
      } catch (err) {
        if (err instanceof InventoryError) return fail(err.code === 'tx_used' ? 409 : 400, err.code);
        throw err;
      }
      for (const fn of this.chargeListeners) {
        try {
          fn(wallet);
        } catch (err) {
          this.deps.log?.(`shop: charge listener failed: ${(err as Error).message}`);
        }
      }
      return { ok: true, kind, added: s.packSize, charges };
    } finally {
      this.inflight.delete(txHash);
    }
  }

  /**
   * `POST /api/shop/buy {cart, txHash}`: several power-ups paid with ONE `CoinnibalArena.pay(total, shopCartRef(cart))`.
   * The payment must name exactly this cart (its ref) and pay exactly its total at one quoted price table (full, or
   * discounted for an emblem holder). The whole cart is then applied in one write (`creditCart`): every power-up that
   * is still sold gets its charges; a power-up switched off between the quote and the payment cannot be applied, and
   * its exact share of the payment is recorded as owed back to the wallet (the admin sees it and sends it back),
   * never kept. A hash is credited once.
   */
  async buyCart(wallet: string, body: Record<string, unknown>): Promise<ShopCartResult> {
    const s = this.settings;
    const fail = (status: number, code: ShopBuyError): never => {
      throw new ShopFail(status, code, BUY_MESSAGES[code]);
    };
    const cart = normalizeCart(body.cart);
    const txHash = typeof body.txHash === 'string' ? body.txHash.toLowerCase() : '';
    if (!cart || !/^0x[0-9a-f]{64}$/.test(txHash)) return fail(400, 'bad_request');
    // without a chain, a token or an arena the payment cannot be checked (the claim is retried later); a shop the admin
    // switched off is checked anyway, so a payment made just before is owed back, not lost
    const closed = this.closedReason(s);
    if (closed && closed !== 'disabled') return fail(403, 'shop_closed');
    const token = this.token()!;
    const arena = this.payTo()!;
    if (this.deps.inventory.isUsed(txHash) || this.inflight.has(txHash)) return fail(409, 'tx_used');
    this.inflight.add(txHash);
    try {
      await this.priceTable(s, token.decimals);
      const now = this.now();
      const tables = this.tables.filter((t) => t.until > now);
      const fulls = tables.map((t) => ({ table: t.full, total: cartTotal(cart, (k) => t.full[k]) }));
      const discounts = tables.map((t) => ({ table: t.discounted, total: cartTotal(cart, (k) => t.discounted[k]) }));
      let receipt = null;
      for (const wait of this.deps.receiptRetryMs ?? [0, 1_500, 3_000, 5_000]) {
        if (wait > 0) await sleep(wait);
        try {
          receipt = await this.deps.chain.tokenReceipt!(txHash);
        } catch (err) {
          if (err instanceof ChainBusyError) return fail(503, 'chain_busy');
          throw err;
        }
        if (receipt) break;
      }
      const check = verifyPurchase(receipt, {
        token: token.address,
        from: wallet,
        arena,
        ref: shopCartRefs(cart),
        amounts: [...new Set([...fulls, ...discounts].map((x) => x.total))],
        now: this.now(),
      });
      if (!check.ok) return fail(check.code === 'tx_pending' ? 409 : 400, check.code);
      let priced = fulls.find((x) => x.total === check.paid);
      if (!priced) {
        // the discounted total is for emblem holders only (one token id discounts one wallet a day)
        if (!(await this.discountFor(wallet, true, true))) return fail(400, 'wrong_amount');
        priced = discounts.find((x) => x.total === check.paid)!;
      }
      const add: Partial<Record<BoostKind, number>> = {};
      const refunded: BoostKind[] = [];
      let refundRaw = 0n;
      for (const k of BOOST_KINDS) {
        if (cart[k] === 0) continue;
        if (s.enabled && s.kinds[k]) add[k] = cart[k] * s.packSize;
        else {
          refunded.push(k);
          refundRaw += priced.table[k] * BigInt(cart[k]);
        }
      }
      let charges: BoostCounts;
      try {
        charges = this.deps.inventory.creditCart(wallet, add, txHash, check.paid, refundRaw);
      } catch (err) {
        if (err instanceof InventoryError) return fail(err.code === 'tx_used' ? 409 : 400, err.code);
        throw err;
      }
      for (const fn of this.chargeListeners) {
        try {
          fn(wallet);
        } catch (err) {
          this.deps.log?.(`shop: charge listener failed: ${(err as Error).message}`);
        }
      }
      const added = emptyBoostCounts();
      for (const k of BOOST_KINDS) added[k] = add[k] ?? 0;
      return { ok: true, cart, added, charges, ...(refundRaw > 0n ? { refund: { kinds: refunded, raw: refundRaw.toString() } } : {}) };
    } finally {
      this.inflight.delete(txHash);
    }
  }

  private arenaMax(s: ShopSettings, holder: boolean): number {
    return s.arenaUsesPerRound + (holder ? s.holderExtraArenaUses : 0);
  }

  private arenaUsed(wallet: string, round: number | null): number {
    const u = this.arenaUses.get(wallet.toLowerCase());
    return u && u.round === round ? u.used : 0;
  }

  /** The in-room state of a player (`boosts` message). */
  state(ctx: UseContext): BoostState {
    const s = this.settings;
    const now = this.now();
    const charges = ctx.wallet && !ctx.isBot ? this.deps.inventory.get(ctx.wallet) : emptyBoostCounts();
    const cooldownMs = emptyBoostCounts();
    if (ctx.wallet) for (const k of BOOST_KINDS) cooldownMs[k] = Math.max(0, (this.readyAt.get(`${ctx.wallet.toLowerCase()}:${k}`) ?? 0) - now);
    const disabled = BOOST_KINDS.filter((k) => !s.kinds[k]);
    const state: BoostState = { usable: s.enabled && !!ctx.wallet && !ctx.isBot, signedIn: !!ctx.wallet, charges, cooldownMs };
    if (ctx.arena) {
      const max = this.arenaMax(s, ctx.holder);
      state.arena = { max, left: ctx.wallet ? Math.max(0, max - this.arenaUsed(ctx.wallet, ctx.round)) : 0 };
    }
    if (disabled.length) state.disabled = disabled;
    return state;
  }

  /**
   * A press of a power-up key: checks the rules, then `apply` (the world's effect; false when the
   * player is not alive), and only then takes the charge, starts the cooldown and counts the arena use.
   */
  use(ctx: UseContext, kind: BoostKind, apply: () => boolean): { ok: true } | { ok: false; reason: BoostRefusal } {
    const s = this.settings;
    if (ctx.isBot) return { ok: false, reason: 'bot' };
    if (!s.enabled || !s.kinds[kind]) return { ok: false, reason: 'disabled' };
    if (!ctx.wallet) return { ok: false, reason: 'guest' };
    const wallet = ctx.wallet.toLowerCase();
    if (this.deps.inventory.get(wallet)[kind] <= 0) return { ok: false, reason: 'no_charges' };
    const now = this.now();
    if ((this.readyAt.get(`${wallet}:${kind}`) ?? 0) > now) return { ok: false, reason: 'cooldown' };
    if (ctx.arena && this.arenaUsed(wallet, ctx.round) >= this.arenaMax(s, ctx.holder)) return { ok: false, reason: 'round_limit' };
    if (!apply()) return { ok: false, reason: 'dead' };
    this.deps.inventory.consume(wallet, kind);
    this.readyAt.set(`${wallet}:${kind}`, now + boostCooldownMs(kind));
    if (ctx.arena) this.arenaUses.set(wallet, { round: ctx.round ?? 0, used: this.arenaUsed(wallet, ctx.round) + 1 });
    this.prune(now);
    return { ok: true };
  }

  /**
   * Undoes a `use` whose effect could not be applied after all (a room worker found the player dead
   * by the time the effect arrived): the charge comes back, the cooldown and the arena use are
   * cleared.
   */
  refund(ctx: UseContext, kind: BoostKind): void {
    if (!ctx.wallet) return;
    const wallet = ctx.wallet.toLowerCase();
    this.deps.inventory.restore(wallet, kind);
    this.readyAt.delete(`${wallet}:${kind}`);
    if (ctx.arena) {
      const used = this.arenaUsed(wallet, ctx.round);
      if (used > 0) this.arenaUses.set(wallet, { round: ctx.round ?? 0, used: used - 1 });
    }
  }

  private prune(now: number): void {
    if (this.readyAt.size < 4096) return;
    for (const [k, t] of this.readyAt) if (t <= now) this.readyAt.delete(k);
  }
}
