import { BOOST_KINDS, BPS, SHOP_DEFAULTS, SHOP_LIMITS, bpsToPercent, formatToken, formatUsdCents, type BoostKind, type ShopSettings } from '@elymum/shared';
import { useCallback, useEffect, useState } from 'react';
import { SiteApiError, type ShopAdminView } from '../site/api';
import { SwitchRow } from './GameTab';
import { Btn, Card, FormError, saveErrorText, type ChainCtx } from './ui';

const KIND_LABEL: Record<BoostKind, string> = { magnet: 'Magnet', leap: 'Leap', speed: 'Speed burst', invis: 'Invisibility' };
/** Purchase records may name the retired Shockwave (its charges now count as Leap). */
const PURCHASE_LABEL: Record<BoostKind | 'shock' | 'cart', string> = { ...KIND_LABEL, shock: 'Shockwave (now Leap)', cart: 'cart' };

/** What a purchase added: "3 Magnet" or, for a cart, "6 Magnet + 3 Leap" (pure). */
export function purchaseText(p: { kind: BoostKind | 'shock' | 'cart'; charges: number; cart?: Partial<Record<BoostKind, number>> }): string {
  if (p.kind === 'cart' && p.cart) {
    const parts = (Object.entries(p.cart) as [BoostKind, number][]).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${KIND_LABEL[k]}`);
    return parts.length ? `cart: ${parts.join(' + ')}` : 'cart: nothing applied';
  }
  return `${p.charges} ${PURCHASE_LABEL[p.kind] ?? p.kind}`;
}

/** The fields that changed (a partial PUT). */
export function shopPatch(saved: ShopSettings, draft: ShopSettings): Partial<ShopSettings> {
  const out: Record<string, unknown> = {};
  for (const f of ['enabled', 'packSize', 'holderDiscountPct', 'arenaUsesPerRound', 'holderExtraArenaUses', 'priceIn'] as const) if (draft[f] !== saved[f]) out[f] = draft[f];
  const prices: Record<string, string> = {};
  const kinds: Record<string, boolean> = {};
  const usdCents: Record<string, number> = {};
  for (const k of BOOST_KINDS) {
    if (draft.prices[k] !== saved.prices[k]) prices[k] = draft.prices[k];
    if (draft.kinds[k] !== saved.kinds[k]) kinds[k] = draft.kinds[k];
    if (draft.usdCents && draft.usdCents[k] !== saved.usdCents?.[k]) usdCents[k] = draft.usdCents[k];
  }
  if (Object.keys(prices).length) out.prices = prices;
  if (Object.keys(kinds).length) out.kinds = kinds;
  if (Object.keys(usdCents).length) out.usdCents = usdCents;
  return out as Partial<ShopSettings>;
}

/** `"0.60"` / `"1"` → cents; null when it is not a dollar amount (at most two decimals). */
export function usdTextToCents(text: string): number | null {
  const m = /^\s*\$?\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const c = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return c >= 1 && c <= SHOP_LIMITS.usdCents ? c : null;
}
const dollarsOf = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

/** An older server sends no USD fields: the card shows token prices only, as before. */
function withUsd(s: ShopSettings): ShopSettings {
  return { ...s, priceIn: s.priceIn ?? 'token', usdCents: s.usdCents ?? { ...SHOP_DEFAULTS.usdCents } };
}

function Num({ value, onChange, label, min, max }: { value: number; onChange: (n: number) => void; label: string; min: number; max: number }) {
  return (
    <input
      className="ad-input ad-input--num num"
      type="number"
      min={min}
      max={max}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(Math.max(min, Math.min(max, Math.floor(Number(e.target.value) || 0))))}
    />
  );
}

/**
 * Game → power-ups: on/off (all, and per power-up), pack prices in whole tokens, the holder discount and the paid
 * arenas' per-round limit, and the last purchases. Every pack is paid to the arena contract (`pay`), which burns
 * its `paymentBurnBps` share (50 % by default; Advanced on the arena) and sends the rest to the fee wallet. Saved on the server (`DATA_DIR/site/shop.json`), applied at once.
 */
export function ShopCard({ ctx }: { ctx: ChainCtx }) {
  const [view, setView] = useState<ShopAdminView | null>(null);
  const [draft, setDraft] = useState<ShopSettings | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [usdText, setUsdText] = useState<Record<BoostKind, string> | null>(null);
  const adopt = (v: ShopAdminView) => {
    const settings = withUsd(v.settings);
    setView({ ...v, settings });
    setDraft(structuredClone(settings));
    setUsdText(Object.fromEntries(BOOST_KINDS.map((k) => [k, dollarsOf(settings.usdCents[k])])) as Record<BoostKind, string>);
  };
  const load = useCallback(() => {
    if (!ctx.api) return;
    ctx.api.shop().then(
      (v) => {
        adopt(v);
        setState('ok');
      },
      (e) => {
        if (e instanceof SiteApiError && e.status === 404) setState('missing');
        else {
          setState('error');
          setErr((e as Error).message);
        }
      },
    );
  }, [ctx.api]);
  useEffect(load, [load]);

  if (!ctx.api) return <Card title="Power-ups" id="shop" tone="quiet" lede="Sign in as the admin (top right) to see and change the power-up shop." />;
  if (state === 'missing') return <Card title="Power-ups" id="shop" tone="quiet" lede="This server has no power-up shop yet (/api/admin/shop). Update the game server." />;
  if (!view || !draft || !usdText) return <Card title="Power-ups" id="shop" tone="quiet" lede={state === 'error' ? `Cannot load the shop: ${err}` : 'Loading the shop…'} />;

  const patch = shopPatch(view.settings, draft);
  const dirty = Object.keys(patch).length > 0;
  const usd = draft.priceIn === 'usd';
  const badUsd = usd && BOOST_KINDS.some((k) => usdTextToCents(usdText[k]) === null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      adopt(await ctx.api!.saveShop(patch));
      setMsg('Shop saved: prices and limits apply at once.');
    } catch (e) {
      setErr(saveErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const decimals = ctx.status?.arena?.config?.decimals ?? 18;
  return (
    <Card
      title="Power-ups"
      id="shop"
      kicker={`${view.purchaseCount} purchases`}
      lede="Players buy packs of power-up charges with the game token: one ElymumArena.pay call (the server checks its Paid event). Practice and private rooms: free use with cooldowns. Paid arenas: a per-round limit. Practice bots never use them."
    >
      <SwitchRow
        label="Shop"
        options={[
          { id: 'on', label: 'Selling' },
          { id: 'off', label: 'Off' },
        ]}
        value={draft.enabled ? 'on' : 'off'}
        onPick={(v) => setDraft({ ...draft, enabled: v === 'on' })}
        testId="shop-enabled"
      />
      <SwitchRow
        label="Priced in"
        options={[
          { id: 'usd', label: 'US dollars' },
          { id: 'token', label: 'Tokens' },
        ]}
        value={draft.priceIn}
        onPick={(v) => setDraft({ ...draft, priceIn: v === 'usd' ? 'usd' : 'token' })}
        testId="shop-price-in"
      />
      <p className="ad-note" data-testid="shop-price-note">
        {usd
          ? 'Each pack costs its dollar price, converted to tokens at the token price of Arena prices (USD) and its rounding, so packs keep their value when the token moves. Until a token price is set, the token prices apply.'
          : 'Each pack costs its token price. The dollar prices are kept for when you switch back.'}
      </p>
      <p className="ad-note mono" data-testid="shop-pay-to">
        Paid to the arena <span className="ad-hex">{view.payTo ?? 'none (deploy the arena first)'}</span>
        {view.burnBps !== null && ` · ${bpsToPercent(view.burnBps)} % burned, ${bpsToPercent(BPS - view.burnBps)} % to the fee wallet`}
      </p>
      <div className="ad-tablewrap">
        <table className="ad-table" data-testid="shop-table">
          <thead>
            <tr>
              <th scope="col">Power-up</th>
              <th scope="col">On</th>
              <th scope="col" className="is-num">
                Pack price (USD)
              </th>
              <th scope="col" className="is-num">
                {usd ? 'Tokens (until a token price is set)' : 'Pack price (tokens)'}
              </th>
              <th scope="col" className="is-num">
                Holders pay
              </th>
            </tr>
          </thead>
          <tbody>
            {BOOST_KINDS.map((k) => {
              let holder = '—';
              if (usd) {
                const c = usdTextToCents(usdText[k]);
                if (c !== null) holder = formatUsdCents(Math.round((c * (100 - draft.holderDiscountPct)) / 100));
              } else
                try {
                  const full = BigInt(Math.round(Number(draft.prices[k]) * 1e6));
                  holder = formatToken((full * BigInt(100 - draft.holderDiscountPct)) / 100n, 6, { maxFrac: 2 });
                } catch {
                  /* a half-typed price */
                }
              const centsBad = usdTextToCents(usdText[k]) === null;
              return (
                <tr key={k} data-kind={k}>
                  <td>
                    <strong>{KIND_LABEL[k]}</strong>
                  </td>
                  <td>
                    <label className="ad-switch ad-switch--inline">
                      <input type="checkbox" role="switch" checked={draft.kinds[k]} onChange={() => setDraft({ ...draft, kinds: { ...draft.kinds, [k]: !draft.kinds[k] } })} aria-label={`${KIND_LABEL[k]} on`} />
                    </label>
                  </td>
                  <td className="is-num">
                    <input
                      className={`ad-input ad-input--num num${centsBad ? ' is-bad' : ''}`}
                      value={usdText[k]}
                      inputMode="decimal"
                      disabled={!usd}
                      aria-invalid={usd && centsBad}
                      aria-label={`${KIND_LABEL[k]} price in USD`}
                      onChange={(e) => {
                        setUsdText({ ...usdText, [k]: e.target.value });
                        const c = usdTextToCents(e.target.value);
                        if (c !== null) setDraft({ ...draft, usdCents: { ...draft.usdCents, [k]: c } });
                      }}
                    />
                  </td>
                  <td className="is-num">
                    <input className="ad-input ad-input--num num" value={draft.prices[k]} aria-label={`${KIND_LABEL[k]} price`} onChange={(e) => setDraft({ ...draft, prices: { ...draft.prices, [k]: e.target.value.trim() } })} />
                  </td>
                  <td className="num is-num">{holder}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="ad-form2 ad-form3">
        <label className="ad-field">
          <span className="ad-field__label mono">Charges per pack</span>
          <Num value={draft.packSize} min={1} max={SHOP_LIMITS.packSize} label="Charges per pack" onChange={(n) => setDraft({ ...draft, packSize: n })} />
        </label>
        <label className="ad-field">
          <span className="ad-field__label mono">Holder discount %</span>
          <Num value={draft.holderDiscountPct} min={0} max={SHOP_LIMITS.holderDiscountPct} label="Holder discount" onChange={(n) => setDraft({ ...draft, holderDiscountPct: n })} />
        </label>
        <label className="ad-field">
          <span className="ad-field__label mono">Arena uses per round</span>
          <Num value={draft.arenaUsesPerRound} min={0} max={SHOP_LIMITS.arenaUsesPerRound} label="Arena uses per round" onChange={(n) => setDraft({ ...draft, arenaUsesPerRound: n })} />
        </label>
        <label className="ad-field">
          <span className="ad-field__label mono">Extra arena uses for holders</span>
          <Num value={draft.holderExtraArenaUses} min={0} max={SHOP_LIMITS.holderExtraArenaUses} label="Extra arena uses for holders" onChange={(n) => setDraft({ ...draft, holderExtraArenaUses: n })} />
        </label>
      </div>
      {view.purchases.length > 0 && (
        <details className="ad-rooms">
          <summary className="mono">Recent purchases ({view.purchases.length})</summary>
          <ul className="ad-rooms__list">
            {view.purchases.map((p) => (
              <li key={p.tx}>
                <span className="mono">
                  {p.wallet.slice(0, 8)}… · {purchaseText(p)}
                </span>
                <span className="num ad-dim">
                  {formatToken(BigInt(p.paid), decimals, { maxFrac: 2 })} · {new Date(p.at).toISOString().slice(0, 16).replace('T', ' ')}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {(view.refundsOwed?.length ?? 0) > 0 && (
        <div className="ad-warn" data-testid="shop-refunds">
          <strong>Owed back to players.</strong> A power-up was switched off after these players saw its price: that part of their payment could not be applied. Send it back from the fee wallet, then mark it sent.
          <ul className="ad-rooms__list">
            {view.refundsOwed!.map((p) => (
              <li key={p.tx}>
                <span className="mono">
                  {p.wallet} · {formatToken(BigInt(p.refund ?? '0'), decimals, { maxFrac: 2 })} · tx {p.tx.slice(0, 10)}…
                </span>
                <Btn
                  testId={`shop-refund-${p.tx}`}
                  onClick={() =>
                    void ctx.api!.markRefunded(p.tx).then(
                      (refundsOwed) => setView({ ...view, refundsOwed }),
                      (e) => setErr(saveErrorText(e)),
                    )
                  }
                >
                  Mark as sent
                </Btn>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="ad-actions">
        <Btn sun disabled={!dirty || busy || badUsd} onClick={() => void save()} testId="shop-save">
          {busy ? 'Saving…' : 'Save power-ups'}
        </Btn>
        {dirty && <Btn onClick={() => adopt(view)}>Undo</Btn>}
        {badUsd && <span className="ad-bad">A dollar price is a plain amount from $0.01, at most two decimals.</span>}
        {msg && !dirty && <span className="ad-note">{msg}</span>}
      </div>
      <FormError error={err} />
    </Card>
  );
}
