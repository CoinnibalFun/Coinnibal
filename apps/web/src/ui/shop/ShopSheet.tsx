import { BOOST_KEY_LABELS, BPS, DEFAULT_PAYMENT_BURN_BPS, SHOP_DEFAULTS, boostCooldownMs, bpsToPercent, formatUsdCents, type BoostKind, type ShopPack, type ShopView } from '@coinnibal/shared';
import { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Sheet, shortAddress } from '../../design';
import { useT } from '../../i18n';
import { closeModal, openModal, toast, useUi } from '../../store';
import { SHOP_CART_LIMITS, TOKEN_SYMBOL_DEFAULT } from '@coinnibal/shared';
import { ShopError, buyCart, cartTotals, emptyCart, fetchShop, loadPendingClaim, settleCartClaim, settleClaim, type BuyPhase, type Cart, type PendingClaim } from '../../wallet/shop';
import { summaryAmount } from '../amount';
import { BOOST_PATH } from '../game/BoostBar';
import './shop.css';

/**
 * A pack price for display: `210 $NIBAL` (whole tokens, at most two decimals), with its dollar price first when the
 * pack is priced in US dollars (`$0.60 · 740 $NIBAL`): the token amount is what the wallet sends.
 */
export function priceText(raw: string, view: Pick<ShopView, 'token'>, usdCents?: number): string {
  const decimals = view.token?.decimals ?? 18;
  const tokens = `${summaryAmount(BigInt(raw), decimals)} ${view.token?.symbol ?? TOKEN_SYMBOL_DEFAULT}`;
  return usdCents !== undefined ? `${formatUsdCents(usdCents)} · ${tokens}` : tokens;
}

function PackCard({
  pack,
  view,
  owned,
  qty,
  canBuy,
  canAdd,
  onQty,
}: {
  pack: ShopPack;
  view: ShopView;
  owned: number | null;
  /** Packs of it in the cart. */
  qty: number;
  canBuy: boolean;
  /** The cart has room for one more pack. */
  canAdd: boolean;
  onQty: (n: number) => void;
}) {
  const t = useT();
  const kind: BoostKind = pack.kind;
  const discounted = pack.priceRaw !== pack.fullPriceRaw;
  const name = t(`boost.${kind}` as 'boost.magnet');
  return (
    <li className={`sh-pack sh-pack--${kind}${pack.enabled ? '' : ' is-off'}`} data-kind={kind}>
      <span className="sh-pack__glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d={BOOST_PATH[kind]} />
        </svg>
        <kbd className="sh-pack__key mono">{BOOST_KEY_LABELS[kind]}</kbd>
      </span>
      {/* what it does: a small "i" on the icon's corner (the key cap sits on the other corner) */}
      <PackInfo id={`sh-note-${kind}`} label={t('shop.info', { name })}>
        {t(`boost.${kind}.note` as 'boost.magnet.note')}
      </PackInfo>
      <div className="sh-pack__body">
        <h3 className="sh-pack__name">{name}</h3>
        <p className="sh-pack__meta mono">
          {t('shop.cooldown', { s: Math.round(boostCooldownMs(kind) / 1000) })}
          {owned !== null && <> · {t('shop.owned', { n: owned })}</>}
        </p>
      </div>
      <div className="sh-pack__buy">
        {discounted && <s className="sh-pack__was mono">{priceText(pack.fullPriceRaw, view, pack.fullUsdCents)}</s>}
        {/* every pack has its own quantity stepper: pick several, pay once (the cart below) */}
        <span className={`sh-qty${qty > 0 ? ' is-on' : ''}`} role="group" aria-label={t('shop.qtyLabel', { name })}>
          <button type="button" className="kb-iconbtn kb-iconbtn--sm sh-qty__btn" onClick={() => onQty(qty - 1)} disabled={!canBuy || qty === 0} aria-label={t('shop.less', { name })} data-testid={`shop-less-${kind}`}>
            −
          </button>
          <span className="sh-qty__n num" aria-live="polite" data-testid={`shop-qty-${kind}`}>
            {t('shop.packs', { n: qty })}
          </span>
          <button
            type="button"
            className="kb-iconbtn kb-iconbtn--sm sh-qty__btn is-more"
            onClick={() => onQty(qty + 1)}
            disabled={!canBuy || !pack.enabled || !canAdd || qty >= SHOP_CART_LIMITS.perKind}
            aria-label={t('shop.more', { name })}
            title={t('shop.add', { n: pack.charges, price: priceText(pack.priceRaw, view, pack.usdCents) })}
            data-testid={`shop-more-${kind}`}
          >
            +
          </button>
          <span className="sh-qty__price mono">{t('shop.each', { price: priceText(pack.priceRaw, view, pack.usdCents) })}</span>
        </span>
      </div>
    </li>
  );
}

/**
 * What a power-up does, behind a small "i": it opens on hover or keyboard focus (desktop) and on a tap (touch), and
 * closes on a second tap, Escape or when focus leaves. The description stays in the page for screen readers.
 */
function PackInfo({ id, label, children }: { id: string; label: string; children: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`sh-info${open ? ' is-open' : ''}`} onBlur={() => setOpen(false)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button type="button" className="sh-info__btn" aria-label={label} aria-expanded={open} aria-describedby={id} onClick={() => setOpen((o) => !o)} data-testid="shop-info">
        i
      </button>
      <span id={id} role="tooltip" className="sh-info__tip">
        {children}
      </span>
    </span>
  );
}

/**
 * The power-up shop (the lobby's masthead and the HUD's top bar, over the game): the packs priced for the signed-in
 * wallet (holders see the discount). Every pack has a +/− quantity stepper; the cart under them (always on screen,
 * stuck to the sheet's bottom edge) keeps the running total in US dollars and the game token, and "Buy all" pays ONCE
 * (`buyCart`: one `pay` to the arena contract, half burned, half to the fee wallet); the server applies the whole cart
 * and the charges appear on the HUD at once. Guests are asked to sign in.
 */
export function ShopSheet() {
  const t = useT();
  const open = useUi((s) => s.modal === 'shop');
  const auth = useUi((s) => s.auth);
  const chain = useUi((s) => s.chain);
  const live = useUi((s) => s.boosts?.charges ?? null);
  const [view, setView] = useState<ShopView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [buying, setBuying] = useState<{ phase: BuyPhase | null } | null>(null);
  const [cart, setCart] = useState<Cart>(emptyCart);

  const load = useCallback(
    (signal?: AbortSignal) =>
      fetchShop(auth?.token ?? null, signal).then(
        (v) => {
          setView(v);
          setErr(null);
        },
        (e: Error) => {
          if (e.name !== 'AbortError') setErr(e.message);
        },
      ),
    [auth?.token],
  );
  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [open, load]);

  // a pack paid for earlier whose claim did not get through: offered again (never paid twice)
  const [pending, setPending] = useState<PendingClaim | null>(null);
  useEffect(() => {
    if (open) setPending(loadPendingClaim(auth?.address));
  }, [open, auth?.address, buying]);
  const [claiming, setClaiming] = useState(false);
  const claim = async (p: PendingClaim) => {
    if (!auth || claiming) return;
    setClaiming(true);
    try {
      if (p.cart) {
        const r = await settleCartClaim(auth.token, auth.address, p.cart, p.txHash);
        setView((v) => (v ? { ...v, charges: r.charges } : v));
        useUi.setState((s) => (s.boosts ? { boosts: { ...s.boosts, charges: r.charges } } : {}));
        cartToast(r);
      } else {
        const r = await settleClaim(auth.token, auth.address, p.kind, p.txHash);
        setView((v) => (v ? { ...v, charges: r.charges } : v));
        useUi.setState((s) => (s.boosts ? { boosts: { ...s.boosts, charges: r.charges } } : {}));
        toast('success', t('shop.done', { n: r.added, name: t(`boost.${r.kind}` as 'boost.magnet') }));
      }
    } catch (e) {
      toast('error', t('shop.failed', { msg: (e as Error).message }), undefined, 8000);
      // a claim credited meanwhile: the counts on the packs catch up
      void load();
    } finally {
      setClaiming(false);
      setPending(loadPendingClaim(auth.address));
    }
  };

  const charges = live ?? view?.charges ?? null;
  /** What the server applied: the charges added, and a part owed back when a power-up was switched off meanwhile. */
  const cartToast = (r: { added: Record<BoostKind, number>; refund?: { kinds: BoostKind[] } }) => {
    const got = (Object.keys(r.added) as BoostKind[]).filter((k) => r.added[k] > 0).map((k) => `+${r.added[k]} ${t(`boost.${k}` as 'boost.magnet')}`);
    if (got.length) toast('success', t('shop.cartDone', { list: got.join(', ') }));
    if (r.refund) toast('info', t('shop.cartRefund', { list: r.refund.kinds.map((k) => t(`boost.${k}` as 'boost.magnet')).join(', ') }), undefined, 10_000);
  };
  const totals = view ? cartTotals(view, cart) : null;
  const setQty = (kind: BoostKind, n: number) => setCart((c) => ({ ...c, [kind]: Math.max(0, Math.min(SHOP_CART_LIMITS.perKind, n)) }));
  const room = totals ? totals.packs < SHOP_CART_LIMITS.total : true;
  const buy = async () => {
    if (!view || !auth || !chain || !totals || totals.packs === 0) return;
    setBuying({ phase: 'switching' });
    try {
      const r = await buyCart(view, cart, { token: auth.token, owner: auth.address, chain, onPhase: (phase) => setBuying({ phase }) });
      setView((v) => (v ? { ...v, charges: r.charges } : v));
      // the HUD follows at once (the server also pushes `boosts` to a live game)
      useUi.setState((s) => (s.boosts ? { boosts: { ...s.boosts, charges: r.charges } } : {}));
      setCart(emptyCart());
      cartToast(r);
    } catch (e) {
      const msg = e instanceof ShopError ? e.message : (e as Error).message;
      if (!(e instanceof ShopError && e.code === 'rejected')) toast('error', t('shop.failed', { msg }), undefined, 8000);
    } finally {
      setBuying(null);
    }
  };

  const s = view ?? null;
  const max = s?.arenaUsesPerRound ?? SHOP_DEFAULTS.arenaUsesPerRound;
  const pct = s?.holderDiscountPct ?? SHOP_DEFAULTS.holderDiscountPct;
  const extra = s?.holderExtraArenaUses ?? SHOP_DEFAULTS.holderExtraArenaUses;
  const closed = s && !s.open ? (s.closedReason === 'no_token' ? t('shop.closed.no_token') : t('shop.closed')) : null;
  return (
    <Sheet
      open={open}
      onClose={closeModal}
      closeLabel={t('common.close')}
      kicker={t('boost.shop')}
      title={t('shop.title')}
      className="g-sheet sh-sheet"
    >
      <p className="sh-lede">{t('shop.lede', { n: s?.packs[0]?.charges ?? SHOP_DEFAULTS.packSize, sym: s?.token?.symbol ?? TOKEN_SYMBOL_DEFAULT, max })}</p>
      <p className="sh-pick">{t('shop.pick')}</p>
      {s?.holder ? (
        <Chip tone="up" className="sh-holder">
          {t('shop.holder', { pct, extra })}
        </Chip>
      ) : (
        <p className="sh-hint mono">{t('shop.holderHint', { pct, extra })}</p>
      )}
      {pending && auth && (
        <div className="sh-closed sh-pending" role="status" data-testid="shop-pending">
          <p>{t('shop.pending', { name: t(`boost.${pending.kind}` as 'boost.magnet') })}</p>
          <Button variant="primary" size="sm" loading={claiming} disabled={claiming || !!buying} onClick={() => void claim(pending)} data-testid="shop-claim">
            {t('shop.claim')}
          </Button>
        </div>
      )}
      {closed && <p className="sh-closed">{closed}</p>}
      {err && <p className="sh-closed">{err}</p>}
      {s ? (
        <ul className="sh-packs">
          {s.packs.map((p) => (
            <PackCard
              key={p.kind}
              pack={p}
              view={s}
              owned={charges ? charges[p.kind] : null}
              qty={cart[p.kind]}
              canBuy={!!auth && s.open && !buying && !claiming}
              canAdd={room}
              onQty={(n) => setQty(p.kind, n)}
            />
          ))}
        </ul>
      ) : (
        !err && <p className="sh-hint mono">…</p>
      )}
      {s && totals && (
        <div className={`sh-cart${totals.packs > 0 ? ' is-full' : ' is-empty'}`} role="region" aria-label={t('shop.cart')} data-testid="shop-cart">
          <div className="sh-cart__sum">
            <span className="sh-cart__label mono">{t('shop.cartTotal', { n: totals.packs })}</span>
            {totals.packs === 0 ? (
              <span className="sh-cart__empty" data-testid="shop-cart-empty">
                {t('shop.cartEmpty')}
              </span>
            ) : (
              <span className="sh-cart__price">
                {totals.fullRaw !== totals.raw && (
                  <s className="sh-pack__was mono" data-testid="shop-cart-full">
                    {priceText(totals.fullRaw.toString(), s, totals.fullUsdCents ?? undefined)}
                  </s>
                )}
                <b className="num" data-testid="shop-cart-total">
                  {priceText(totals.raw.toString(), s, totals.usdCents ?? undefined)}
                </b>
              </span>
            )}
            {s.holder && totals.fullRaw !== totals.raw && <span className="sh-cart__note mono">{t('shop.cartHolder', { pct: s.holderDiscountPct })}</span>}
          </div>
          <div className="sh-cart__actions">
            {totals.packs > 0 && (
              <Button variant="ghost" size="sm" disabled={!!buying} onClick={() => setCart(emptyCart())} data-testid="shop-cart-clear">
                {t('shop.cartClear')}
              </Button>
            )}
            <Button
              variant="primary"
              size="md"
              lead="wallet"
              loading={!!buying}
              disabled={!auth || !s.open || !!buying || claiming || totals.packs === 0}
              onClick={() => void buy()}
              sub={buying?.phase === 'verifying' ? t('shop.verifying') : buying?.phase === 'confirming' ? t('shop.confirming') : buying ? t('shop.paying') : t('shop.oneTx')}
              data-testid="shop-pay"
            >
              {totals.packs > 0 ? t('shop.buyAll', { price: priceText(totals.raw.toString(), s) }) : t('shop.buyAll', { price: '—' })}
            </Button>
          </div>
        </div>
      )}
      {!auth && (
        <div className="sh-signin">
          <p>{t('shop.signIn')}</p>
          <Button variant="primary" size="md" lead="wallet" onClick={() => openModal('wallet')}>
            {t('shop.signInBtn')}
          </Button>
        </div>
      )}
      {/* fine print at the end of the list: as a fixed footer it took three lines from the packs on
          short screens */}
      {s?.payTo && (
        <p className="sh-foot mono">
          {t('shop.paySplit', { burn: bpsToPercent(s.burnBps ?? DEFAULT_PAYMENT_BURN_BPS), vault: bpsToPercent(BPS - (s.burnBps ?? DEFAULT_PAYMENT_BURN_BPS)), addr: shortAddress(s.payTo) })} {t('shop.keys')}
        </p>
      )}
    </Sheet>
  );
}
