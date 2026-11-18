import {
  BPS,
  PRACTICE_ROOM,
  CUSTOM_HOLDER_PERKS,
  CUSTOM_LIMITS,
  CUSTOM_SETTINGS_DEFAULT,
  CUSTOM_SETTINGS_LIMITS,
  GAS_SYMBOL,
  arenaMeta,
  bpsToPercent,
  customRoomBaseRaw,
  customRoomFee,
  formatToken,
  formatUsd,
  formatUsdCents,
  parseUsdPrice,
  tokenRawToUsd,
  type CustomHolderPerk,
  type CustomRoomAdminView,
  type CustomRoomSettings,
  type CustomRoomView,
} from '@elymum/shared';
import { useCallback, useEffect, useState } from 'react';
import { usdTextToCents } from './ShopCard';
import { SiteApiError } from '../site/api';
import { SwitchRow } from './GameTab';
import { Btn, Card, FormError, saveErrorText, type ChainCtx } from './ui';

const PERK_LABEL: Record<CustomHolderPerk, { label: string; note: string }> = {
  discount: { label: 'Discount', note: 'NFT holders pay less (the percent below).' },
  free_daily: { label: 'One free a day', note: 'NFT holders open one room a day (UTC) without paying.' },
  none: { label: 'No perk', note: 'Everyone pays the same.' },
};

/** The fields that changed (a partial PUT). */
export function customRoomsPatch(saved: CustomRoomSettings, draft: CustomRoomSettings): Partial<CustomRoomSettings> {
  const out: Partial<CustomRoomSettings> = {};
  for (const k of Object.keys(draft) as (keyof CustomRoomSettings)[]) if (draft[k] !== saved[k]) (out as Record<string, unknown>)[k] = draft[k];
  return out;
}

const minutesLeft = (endsAt: number) => Math.max(0, Math.ceil((endsAt - Date.now()) / 60_000));

/** "free", "practice with bots" or "paid · Lethe Shore #2" (a paid room is an invite-only instance of that arena). */
export const roomKindText = (r: Pick<CustomRoomView, 'kind' | 'arenaId' | 'practice'>): string =>
  r.kind === 'paid' && r.arenaId ? `paid · ${arenaMeta(r.arenaId).name} #${r.arenaId}` : r.practice ? 'practice with bots' : 'free';

/**
 * The fee a room paid ("0" for a free one): whole game tokens; a room opened before rooms were paid in tokens shows its
 * ETH fee as such (`feeIn: 'gas'`).
 */
export const feeText = (r: Pick<CustomRoomView, 'feeRaw' | 'feeIn'>, decimals: number): string => {
  try {
    const raw = BigInt(r.feeRaw ?? '0');
    if (raw === 0n) return '0';
    return r.feeIn === 'gas' ? `${formatToken(raw, 18, { maxFrac: 6 })} ${GAS_SYMBOL}` : formatToken(raw, decimals, { maxFrac: 2 });
  } catch {
    return '?';
  }
};

/**
 * What the base price makes at a few capacities with this step, in whole tokens ("10: 1,500 · 20: 2,250 · ..."), and in
 * dollars when the base is (pure, tested).
 */
export function feeLadder(baseRaw: bigint, decimals: number, stepPct: number, maxPlayers: number, usdCents: number | null = null): string {
  const caps = [10, 20, 50, 100].filter((n) => n <= maxPlayers);
  if (!caps.includes(maxPlayers)) caps.push(maxPlayers);
  return caps
    .map((n) => {
      const tokens = formatToken(customRoomFee(baseRaw, n, stepPct), decimals, { maxFrac: 2 });
      return usdCents !== null ? `${n}: ${formatUsdCents(Number(customRoomFee(BigInt(usdCents), n, stepPct)))} (${tokens})` : `${n}: ${tokens}`;
    })
    .join(' · ');
}

/**
 * The base price the draft would charge, raw base units: the server's base when the price fields are unchanged, else
 * the server's own conversion (`customRoomBaseRaw`) at the token price and rounding it uses; null for a half-typed price.
 */
export function draftBase(view: Pick<CustomRoomAdminView, 'base' | 'settings'>, draft: CustomRoomSettings): { raw: bigint; usdCents: number | null } | null {
  const s = view.settings;
  if (draft.priceIn === s.priceIn && draft.usdCents === s.usdCents && draft.priceTokens === s.priceTokens) return { raw: BigInt(view.base.raw), usdCents: view.base.usdCents ?? null };
  // the server's rule for a token price ("1500", "12.5": at most 6 decimals)
  if (!/^\d{1,10}(\.\d{1,6})?$/.test(draft.priceTokens)) return null;
  try {
    const usd = view.base.usdPerToken ? { price: parseUsdPrice(view.base.usdPerToken), sigFigs: view.base.sigFigs ?? 2 } : null;
    return customRoomBaseRaw(draft, view.base.decimals, usd);
  } catch {
    return null;
  }
}

const dollarsOf = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

/** An older server sends the ETH price only: the card shows the token fields at their defaults. */
function withTokenPrice(s: CustomRoomSettings): CustomRoomSettings {
  return {
    ...s,
    priceIn: s.priceIn ?? CUSTOM_SETTINGS_DEFAULT.priceIn,
    usdCents: s.usdCents ?? CUSTOM_SETTINGS_DEFAULT.usdCents,
    priceTokens: s.priceTokens ?? CUSTOM_SETTINGS_DEFAULT.priceTokens,
  };
}

/**
 * Game → custom rooms: the price (in US dollars converted like the tickets, or in whole tokens), where it is paid (the
 * arena contract: half burned, half to its fee wallet, like a power-up pack), the NFT holder perk, the caps (the
 * server is small) and the live rooms, each with a close button.
 */
export function CustomRoomsCard({ ctx }: { ctx: ChainCtx }) {
  const [view, setView] = useState<CustomRoomAdminView | null>(null);
  const [draft, setDraft] = useState<CustomRoomSettings | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [usdText, setUsdText] = useState('');
  const adopt = (v: CustomRoomAdminView) => {
    const settings = withTokenPrice(v.settings);
    setView({ ...v, settings });
    setDraft({ ...settings });
    setUsdText(dollarsOf(settings.usdCents));
  };
  const load = useCallback(() => {
    if (!ctx.api) return;
    ctx.api.customRooms().then(
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
  useEffect(() => {
    if (!ctx.api || state !== 'ok') return;
    const id = window.setInterval(() => ctx.api!.customRooms().then((v) => setView((cur) => (cur ? { ...cur, rooms: v.rooms } : v)), () => {}), 15_000);
    return () => clearInterval(id);
  }, [ctx.api, state]);

  if (!ctx.api) return <Card title="Custom rooms" id="custom-rooms" tone="quiet" lede="Sign in as the admin (top right) to see and change the custom rooms." />;
  if (state === 'missing') return <Card title="Custom rooms" id="custom-rooms" tone="quiet" lede="This server has no custom rooms route yet (/api/admin/custom-rooms). Update the game server." />;
  if (!view || !draft) return <Card title="Custom rooms" id="custom-rooms" tone="quiet" lede={state === 'error' ? `Cannot load the custom rooms: ${err}` : 'Loading the custom rooms…'} />;

  const patch = customRoomsPatch(view.settings, draft);
  const dirty = Object.keys(patch).length > 0;
  const badUsd = draft.priceIn === 'usd' && usdTextToCents(usdText) === null;
  const base = draftBase(view, draft);
  const baseUsd = base && view.base.usdPerToken ? tokenRawToUsd(base.raw, parseUsdPrice(view.base.usdPerToken), view.base.decimals) : null;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      adopt(await ctx.api!.saveCustomRooms(patch));
      setMsg('Saved: new rooms use it at once.');
    } catch (e) {
      setErr(saveErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const close = async (code: string, paid = false) => {
    const ask = paid
      ? `Close ticket room ${code}? It takes no new seat now and closes at its next bell, once every ticket in it is settled.`
      : `Close room ${code} for everyone in it now?`;
    if (!window.confirm(ask)) return;
    setErr(null);
    try {
      const r = await ctx.api!.closeCustomRoom(code);
      setView({ ...view, rooms: r.rooms });
      setMsg(paid ? `Room ${code} closes at its next bell.` : `Room ${code} closed.`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const num = (k: 'holderDiscountPct' | 'maxLive' | 'maxPerWallet' | 'capacityStepPct' | 'maxPlayers' | 'maxSeats' | 'practiceMaxLive', max: number, min = 0) => (
    <input
      className="ad-input ad-input--num num"
      type="number"
      min={min}
      max={max}
      value={draft[k]}
      aria-label={k}
      data-testid={`cr-${k}`}
      onChange={(e) => setDraft({ ...draft, [k]: Math.max(min, Math.min(max, Math.floor(Number(e.target.value) || 0))) })}
    />
  );

  return (
    <Card
      title="Custom rooms"
      id="custom-rooms"
      lede="Players pay a small fee in the game token to open a private room with their own rules: a free room (no stakes) or a ticket room (an invite-only instance of an arena: players buy that arena's normal ticket, settled at its end). Like a power-up pack it is one CoinnibalArena.pay: half burned, half to the fee wallet. The fee grows with the room's size. The server checks every payment on chain (its Paid event, the room request it names) before the room opens; NFT holders open one room a day for free by default."
    >
      <SwitchRow
        label="Creating rooms"
        options={[
          { id: 'on', label: 'Open' },
          { id: 'off', label: 'Closed' },
        ]}
        value={draft.enabled ? 'on' : 'off'}
        onPick={(v) => setDraft({ ...draft, enabled: v === 'on' })}
        testId="cr-enabled"
      />
      <SwitchRow
        label="Ticket rooms"
        options={[
          { id: 'on', label: 'Open', note: 'Creators may open invite-only instances of the arenas.' },
          { id: 'off', label: 'Closed', note: 'Free rooms only.' },
        ]}
        value={draft.paidRooms ? 'on' : 'off'}
        onPick={(v) => setDraft({ ...draft, paidRooms: v === 'on' })}
        testId="cr-paid-rooms"
      />
      <SwitchRow
        label="Practice with bots"
        options={[
          { id: 'on', label: 'Open', note: `One click from a quiet pond: a free ${PRACTICE_ROOM.durationMin}-minute room with ${PRACTICE_ROOM.bots} practice bots for the player (guests too) and up to ${PRACTICE_ROOM.maxPlayers - 1} friends; closes after ${PRACTICE_ROOM.idleMs / 60_000} minutes empty.` },
          { id: 'off', label: 'Closed', note: 'The ponds only.' },
        ]}
        value={draft.practiceRooms ? 'on' : 'off'}
        onPick={(v) => setDraft({ ...draft, practiceRooms: v === 'on' })}
        testId="cr-practice-rooms"
      />
      <div className="ad-form2 ad-form3">
        <label className="ad-field">
          <span className="ad-field__label mono">Practice rooms at once</span>
          {num('practiceMaxLive', CUSTOM_SETTINGS_LIMITS.practiceMaxLive)}
        </label>
      </div>
      <p className="ad-note">
        Practice rooms are free and limited instead: one per player, {PRACTICE_ROOM.perIp} per IP every {PRACTICE_ROOM.perIpWindowMs / 60_000} minutes, and this many at once (outside the slots and seats above).
      </p>
      <SwitchRow
        label="Priced in"
        options={[
          { id: 'usd', label: 'US dollars' },
          { id: 'token', label: 'Tokens' },
        ]}
        value={draft.priceIn}
        onPick={(v) => setDraft({ ...draft, priceIn: v === 'usd' ? 'usd' : 'token' })}
        testId="cr-price-in"
      />
      <div className="ad-form2 ad-form3">
        <label className="ad-field">
          <span className="ad-field__label mono">Base price (USD, up to 10 players)</span>
          <input
            className={`ad-input ad-input--num num${badUsd ? ' is-bad' : ''}`}
            value={usdText}
            inputMode="decimal"
            disabled={draft.priceIn !== 'usd'}
            aria-invalid={badUsd}
            onChange={(e) => {
              setUsdText(e.target.value);
              const c = usdTextToCents(e.target.value);
              if (c !== null) setDraft({ ...draft, usdCents: Math.min(c, CUSTOM_SETTINGS_LIMITS.usdCents) });
            }}
            data-testid="cr-price-usd"
          />
        </label>
        <label className="ad-field">
          <span className="ad-field__label mono">{draft.priceIn === 'usd' ? 'Tokens (until a token price is set)' : 'Base price (tokens, up to 10 players)'}</span>
          <input className="ad-input ad-input--num num" value={draft.priceTokens} inputMode="decimal" onChange={(e) => setDraft({ ...draft, priceTokens: e.target.value.trim() })} data-testid="cr-price-tokens" />
        </label>
      </div>
      <p className="ad-note" data-testid="cr-price-note">
        {draft.priceIn === 'usd'
          ? 'The fee is its dollar price converted to tokens at the token price of Arena prices (USD) and its rounding, like the tickets and the power-ups. Until a token price is set, the token price applies.'
          : 'The fee is its token price. The dollar price is kept for when you switch back.'}
      </p>
      <p className="ad-note mono" data-testid="cr-pay-to">
        {view.pay ? (
          <>
            Paid to the arena <span className="ad-hex">{view.pay.payTo}</span>
            {view.pay.burnBps !== null && ` · ${bpsToPercent(view.pay.burnBps)} % burned, ${bpsToPercent(BPS - view.pay.burnBps)} % to the fee wallet`}
          </>
        ) : view.payClosed === 'no_token' ? (
          'Not payable yet: the game token is not set on the arena. Until it is, only the free room of the day (NFT holders) opens.'
        ) : (
          'Not payable here: the server has no chain or no arena registered.'
        )}
      </p>
      <div className="ad-form2 ad-form3">
        <label className="ad-field">
          <span className="ad-field__label mono">Step % per 10 players</span>
          {num('capacityStepPct', CUSTOM_SETTINGS_LIMITS.capacityStepPct)}
        </label>
        <label className="ad-field">
          <span className="ad-field__label mono">Biggest room (players)</span>
          {num('maxPlayers', CUSTOM_SETTINGS_LIMITS.maxPlayers, CUSTOM_LIMITS.playersMin)}
        </label>
        <label className="ad-field">
          <span className="ad-field__label mono">Seats, all rooms</span>
          {num('maxSeats', CUSTOM_SETTINGS_LIMITS.maxSeats, CUSTOM_SETTINGS_LIMITS.maxSeatsMin)}
        </label>
      </div>
      <p className="ad-note" data-testid="cr-fee-ladder">
        Fee by size (tokens, before holder perks{base && base.usdCents !== null && view.base.usdPerToken ? `, at $${view.base.usdPerToken} a token` : ''}):{' '}
        <span className="mono">{base ? feeLadder(base.raw, view.base.decimals, draft.capacityStepPct, draft.maxPlayers, base.usdCents) : 'enter a valid price'}</span>
        {baseUsd !== null && <> (base about {formatUsd(baseUsd)})</>}. Seats cap the players of all live custom rooms together (the server is sized for about 500 at once, public rooms included).
      </p>
      <SwitchRow
        label="NFT holder perk"
        options={CUSTOM_HOLDER_PERKS.map((p) => ({ id: p, label: PERK_LABEL[p].label, note: PERK_LABEL[p].note }))}
        value={draft.holderPerk}
        onPick={(p) => setDraft({ ...draft, holderPerk: p })}
        testId="cr-perk"
      />
      <div className="ad-form2 ad-form3">
        {draft.holderPerk === 'discount' && (
          <label className="ad-field">
            <span className="ad-field__label mono">Holder discount %</span>
            {num('holderDiscountPct', 100)}
          </label>
        )}
        <label className="ad-field">
          <span className="ad-field__label mono">Live rooms (server)</span>
          {num('maxLive', CUSTOM_SETTINGS_LIMITS.maxLive)}
        </label>
        <label className="ad-field">
          <span className="ad-field__label mono">Per wallet</span>
          {num('maxPerWallet', CUSTOM_SETTINGS_LIMITS.maxPerWallet, 1)}
        </label>
      </div>

      <h3 className="ad-h3">
        Live rooms <span className="ad-dim num">· {view.rooms.length} of {view.settings.maxLive}</span>
      </h3>
      {view.rooms.length === 0 ? (
        <p className="ad-note">No custom room is open.</p>
      ) : (
        <div className="ad-tablewrap">
          <table className="ad-table" data-testid="cr-rooms">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Kind</th>
                <th>Creator</th>
                <th>Players</th>
                <th>Left</th>
                <th>Fee (tokens)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.rooms.map((r) => (
                <tr key={r.code}>
                  <td className="mono">{r.code}</td>
                  <td>{r.name}</td>
                  <td className="mono" data-testid={`cr-kind-${r.code}`}>
                    {roomKindText(r)}
                  </td>
                  <td className="mono ad-hex">{`${r.creator.slice(0, 6)}…${r.creator.slice(-4)}`}</td>
                  <td className="num">
                    {r.players}/{r.maxPlayers} · {r.bots} bots
                  </td>
                  <td className="num">{r.closing ? 'at the bell' : `${minutesLeft(r.endsAt)} min`}</td>
                  <td className="mono" data-testid={`cr-fee-${r.code}`}>
                    {feeText(r, view.base.decimals)} · {r.paidWith}
                  </td>
                  <td>
                    <Btn danger onClick={() => void close(r.code, r.kind === 'paid')} testId={`cr-close-${r.code}`}>
                      Close
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="ad-actions">
        <Btn sun disabled={!dirty || busy || badUsd} onClick={() => void save()} testId="cr-save">
          {busy ? 'Saving…' : 'Save custom rooms'}
        </Btn>
        {dirty && <Btn onClick={() => adopt(view)}>Undo</Btn>}
        {badUsd && <span className="ad-bad">A dollar price is a plain amount from $0.01, at most two decimals.</span>}
        {msg && !dirty && <span className="ad-note">{msg}</span>}
      </div>
      <FormError error={err} />
    </Card>
  );
}
