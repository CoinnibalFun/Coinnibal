import { CUSTOM_HOLDER_PERKS, CUSTOM_LIMITS, CUSTOM_SETTINGS_LIMITS, arenaMeta, customRoomFee, type CustomHolderPerk, type CustomRoomSettings, type CustomRoomView, GAS_SYMBOL } from '@elymum/shared';
import { parseEther } from 'viem';
import { gasText } from '../rooms/gas';
import { useCallback, useEffect, useState } from 'react';
import { SiteApiError, type CustomRoomsAdminView } from '../site/api';
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

/** "free" or "paid · Lethe Shore #2" (a paid room is an invite-only instance of that arena). */
export const roomKindText = (r: Pick<CustomRoomView, 'kind' | 'arenaId'>): string => (r.kind === 'paid' && r.arenaId ? `paid · ${arenaMeta(r.arenaId).name} #${r.arenaId}` : 'free');

/** The fee a room paid, in the gas token ("0" for a free one). */
export const feeText = (r: Pick<CustomRoomView, 'feeWei'>): string => {
  try {
    const wei = BigInt(r.feeWei ?? '0');
    return wei === 0n ? '0' : gasText(wei);
  } catch {
    return '?';
  }
};

/** What the base price makes at a few capacities with this step ("10: 0.05 · 20: 0.075 · ..."), or null for a bad price. */
export function feeLadder(priceGas: string, stepPct: number, maxPlayers: number): string | null {
  let base: bigint;
  try {
    base = parseEther(priceGas);
  } catch {
    return null;
  }
  const caps = [10, 20, 50, 100].filter((n) => n <= maxPlayers);
  if (!caps.includes(maxPlayers)) caps.push(maxPlayers);
  return caps.map((n) => `${n}: ${gasText(customRoomFee(base, n, stepPct))}`).join(' · ');
}

/**
 * Game → custom rooms: the price (in the chain's gas token), the treasury the fee goes to (empty: the owner wallet),
 * the NFT holder perk, the caps (the server is small) and the live rooms, each with a close button.
 */
export function CustomRoomsCard({ ctx }: { ctx: ChainCtx }) {
  const [view, setView] = useState<CustomRoomsAdminView | null>(null);
  const [draft, setDraft] = useState<CustomRoomSettings | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!ctx.api) return;
    ctx.api.customRooms().then(
      (v) => {
        setView(v);
        setDraft({ ...v.settings });
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
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const v = await ctx.api!.saveCustomRooms(patch);
      setView(v);
      setDraft({ ...v.settings });
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
  const num = (k: 'holderDiscountPct' | 'maxLive' | 'maxPerWallet' | 'capacityStepPct' | 'maxPlayers' | 'maxSeats', max: number, min = 0) => (
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
      lede={`Players pay a small ${GAS_SYMBOL} fee to open a private room with their own rules: a free room (no stakes) or a ticket room (an invite-only instance of an arena: players buy that arena's normal ticket, settled at its bell). The fee grows with the room's size. The server checks every payment on chain before the room opens.`}
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
      <div className="ad-form2 ad-form3">
        <label className="ad-field">
          <span className="ad-field__label mono">Base price ({GAS_SYMBOL}, up to 10 players)</span>
          <input className="ad-input num" value={draft.priceGas} onChange={(e) => setDraft({ ...draft, priceGas: e.target.value.trim() })} data-testid="cr-price" />
        </label>
        <label className="ad-field">
          <span className="ad-field__label mono">Treasury (empty: owner)</span>
          <input
            className="ad-input mono ad-hex"
            value={draft.treasury ?? ''}
            placeholder={view.treasury ?? '0x…'}
            onChange={(e) => setDraft({ ...draft, treasury: e.target.value.trim() || null })}
            spellCheck={false}
            data-testid="cr-treasury"
          />
        </label>
      </div>
      <p className="ad-note">
        Fees go to <span className="mono ad-hex">{view.treasury ?? 'nobody yet (set ADMIN_WALLETS or a treasury)'}</span>.
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
        Fee by size ({GAS_SYMBOL}, before holder perks): <span className="mono">{feeLadder(draft.priceGas, draft.capacityStepPct, draft.maxPlayers) ?? 'enter a valid price'}</span>. Seats cap the players of all live custom rooms
        together (the server is sized for about 500 at once, public rooms included).
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
                <th>Fee ({GAS_SYMBOL})</th>
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
                    {feeText(r)} · {r.paidWith}
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
        <Btn sun disabled={!dirty || busy} onClick={() => void save()} testId="cr-save">
          {busy ? 'Saving…' : 'Save custom rooms'}
        </Btn>
        {dirty && <Btn onClick={() => setDraft({ ...view.settings })}>Undo</Btn>}
        {msg && !dirty && <span className="ad-note">{msg}</span>}
      </div>
      <FormError error={err} />
    </Card>
  );
}
