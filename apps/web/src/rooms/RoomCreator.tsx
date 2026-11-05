import { CUSTOM_DEFAULTS, CUSTOM_DIFFICULTIES, CUSTOM_DURATIONS_MIN, CUSTOM_DURATION_LIMITS, CUSTOM_FOOD, CUSTOM_KINDS, CUSTOM_LIMITS, CUSTOM_MAP_CHOICES, CUSTOM_MAP_WIDTH, MAP_SCALE_DEFAULT, CUSTOM_TRAPS, arenaMeta, customCapacityChoices, customCapacityTiers, customRoomFee, quotePrice, validateCustomConfig, type CustomArenaTier, type CustomRoomConfig, type CustomRoomQuote, type CustomRoomView, activeChain, GAS_SYMBOL } from '@elymum/shared';
import { useEffect, useId, useRef, useState } from 'react';
import type { Address, Hash } from 'viem';
import { AddressChip, Button, Chip, CoinCharacter, Field, GasAmount, QuantityStepper, Receipt, Sheet, Stamp, StampSpinner } from '../design';
import { engine } from '../game/instance';
import { sound } from '../audio';
import { useT, type TKey } from '../i18n';
import { openModal, toast, useUi } from '../store';
import { useTokenText, type TokenText } from '../ui/lobby/useLobby';
import { isFakeHash } from '../wallet/devFake';
import { explorerTx } from '../wallet/links';
import { serverChainInfo } from '../wallet/network';
import { signInWithWallet } from '../wallet/signIn';
import { useAddress } from '../wallet/store';
import type { TxPhase } from '../wallet/tx';
import { RoomApiError, loadPendingPayment, roomLink, roomsApi, savePendingPayment } from './api';
import { seatInPaidRoom } from './invite';
import { gasDecimals, gasText } from './gas';
import { payRoomFee } from './pay';
import './rooms.css';

export { gasText };

type Step = 'setup' | 'pay' | 'working' | 'done';

/** One row of choices (a toggle chip each). */
function Choice<T extends string | number>({ label, options, value, onPick, text }: { label: string; options: readonly T[]; value: T; onPick: (v: T) => void; text: (v: T) => string }) {
  return (
    <div className="cr-row" role="group" aria-label={label}>
      <span className="cr-row__label mono">{label}</span>
      <div className="cr-row__chips">
        {options.map((o) => (
          <Chip key={String(o)} selected={o === value} onClick={() => onPick(o)} data-value={String(o)}>
            {text(o)}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/** Practice bots a free room starts with when the creator turns them on. */
const BOTS_SUGGESTED = 6;

const MAP_KEY: Record<CustomRoomConfig['mapSize'], TKey> = { auto: 'cr.map.auto', XS: 'cr.map.XS', S: 'cr.map.S', M: 'cr.map.M', L: 'cr.map.L', XL: 'cr.map.XL' };
const TRAPS_KEY: Record<CustomRoomConfig['traps'], TKey> = { none: 'cr.traps.none', few: 'cr.traps.few', normal: 'cr.traps.normal', many: 'cr.traps.many' };
const DIFF_KEY: Record<CustomRoomConfig['difficulty'], TKey> = { easy: 'cr.diff.easy', mixed: 'cr.diff.mixed', hard: 'cr.diff.hard' };
const FOOD_KEY: Record<CustomRoomConfig['food'], TKey> = { low: 'cr.food.low', normal: 'cr.food.normal', high: 'cr.food.high' };
const KIND_KEY: Record<CustomRoomConfig['kind'], TKey> = { free: 'cr.kind.free', paid: 'cr.kind.paid' };

/** "Arena · 10,000 $ELYMUM": a paid room's tier. */
const tierText = (x: CustomArenaTier, tok: TokenText) => `${arenaMeta(x.arenaId).name} · ${tok.wire(x.entryFee)} ${tok.symbol}`;

/** The fee multiplier of a capacity as text: "1.5" for x1.5 (`stepPct` per started 10 players above 10). */
const multText = (capacity: number, stepPct: number) => String((100 + stepPct * (customCapacityTiers(capacity) - 1)) / 100);

/**
 * The capacity: a slider over the sensible steps (2 to the server's biggest room) with the count
 * written large. Its fee multiplier shows under it, the price box above the footer follows live.
 */
function Capacity({ value, steps, onPick, label, note }: { value: number; steps: number[]; onPick: (n: number) => void; label: string; note: string }) {
  const id = useId();
  const t = useT();
  const idx = Math.max(0, steps.findIndex((n) => n >= value));
  const max = steps.length - 1;
  return (
    <div className="cr-row cr-cap" data-testid="cr-capacity">
      <label className="cr-row__label mono" htmlFor={id}>
        {label}
      </label>
      <div className="cr-cap__body">
        <b className="cr-cap__n num" aria-hidden="true">
          {value}
        </b>
        <input
          id={id}
          className="cr-range"
          type="range"
          min={0}
          max={max}
          step={1}
          value={idx}
          aria-valuetext={t('cr.capValue', { n: value })}
          style={{ ['--v' as string]: max > 0 ? idx / max : 1 }}
          onChange={(e) => onPick(steps[Number(e.target.value)] ?? value)}
          data-testid="cr-capacity-range"
        />
      </div>
      <div className="cr-cap__scale mono" aria-hidden="true">
        <span>{steps[0]}</span>
        <span>{steps[max]}</span>
      </div>
      <p className="cr-hint mono" data-testid="cr-capacity-note">
        {note}
      </p>
    </div>
  );
}

/**
 * "Create your own room": the creator picks the rules, pays the small gas-token fee to the treasury
 * (one native transfer; NFT holders get the perk the admin chose), the server checks the payment
 * on chain and opens the room; the sheet ends on the invite code and share link.
 *
 * Money safety: one in-flight guard (a ref), the price and treasury are frozen at "Continue", and a
 * payment that went through but did not open a room yet is kept (this browser) and offered again,
 * so the creator never pays twice.
 */
export function RoomCreator({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const chain = useUi((s) => s.chain);
  const auth = useUi((s) => s.auth);
  const address = useAddress();
  const tok = useTokenText();
  const [cfg, setCfg] = useState<CustomRoomConfig>(() => ({ ...CUSTOM_DEFAULTS, name: '' }));
  const [step, setStep] = useState<Step>('setup');
  const [quote, setQuote] = useState<CustomRoomQuote | null>(null);
  const [frozen, setFrozen] = useState<{ wei: bigint; to: Address } | null>(null);
  const [phase, setPhase] = useState<TxPhase | 'creating' | null>(null);
  const [hash, setHash] = useState<Hash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [made, setMade] = useState<CustomRoomView | null>(null);
  const inFlight = useRef(false);

  const signedIn = !!auth && !!address && auth.address.toLowerCase() === address.toLowerCase();
  const token = signedIn ? auth!.token : null;
  const pending = signedIn ? loadPendingPayment(address) : null;

  useEffect(() => {
    if (!open) return;
    inFlight.current = false;
    setStep('setup');
    setPhase(null);
    setError(null);
    setHash(null);
    setMade(null);
    setFrozen(null);
    let live = true;
    roomsApi.quote(token).then(
      (q) => live && setQuote(q),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [open, token]);

  // the server's biggest room (an older server without the setting: the old private-room size)
  const maxPlayers = quote?.maxPlayers ?? 20;
  const steps = customCapacityChoices(maxPlayers);
  useEffect(() => {
    if (cfg.maxPlayers > maxPlayers) setCfg((c) => ({ ...c, maxPlayers }));
  }, [maxPlayers, cfg.maxPlayers]);

  const set = <K extends keyof CustomRoomConfig>(k: K, v: CustomRoomConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  // bots switched off and on again come back at the count the creator had (first time: BOTS_SUGGESTED)
  const lastBots = useRef(cfg.bots > 0 ? cfg.bots : BOTS_SUGGESTED);
  if (cfg.bots > 0) lastBots.current = cfg.bots;
  // paid rooms: the arena tiers offered (a holders-only tier to emblem holders only)
  const tiers = (quote?.tiers ?? []).filter((x) => !x.holdersOnly || quote?.holder);
  const paidOpen = !!quote?.paidRooms && tiers.length > 0;
  const tier = cfg.kind === 'paid' ? (tiers.find((x) => x.arenaId === cfg.arenaId) ?? null) : null;
  // practice bots play free rooms only (no value, no stakes): a ticket room has none
  const setKind = (kind: CustomRoomConfig['kind']) =>
    setCfg((c) => ({ ...c, kind, arenaId: kind === 'paid' ? (c.arenaId ?? tiers[0]?.arenaId ?? null) : null, bots: kind === 'paid' ? 0 : c.bots }));
  // the tiers came after "Ticket room" was picked (or the picked one is gone): the first one offered
  const firstTier = tiers[0]?.arenaId ?? null;
  useEffect(() => {
    if (cfg.kind === 'paid' && !tier && firstTier !== null) setCfg((c) => ({ ...c, arenaId: firstTier }));
  }, [cfg.kind, tier, firstTier]);
  const stepPct = quote?.capacityStepPct ?? 0;
  // the price follows the capacity live; the server computes it again and checks the payment
  const youPay = quote ? quotePrice({ ...quote, capacityStepPct: stepPct }, cfg.maxPlayers) : null;
  const base = quote ? customRoomFee(BigInt(quote.priceWei), cfg.maxPlayers, stepPct) : null;
  const free = youPay === 0n;
  const full = !!quote && quote.live >= quote.maxLive;
  const capped = !!quote && quote.mine >= quote.maxPerWallet;
  const noSeats = !!quote && typeof quote.seatsLeft === 'number' && cfg.maxPlayers > quote.seatsLeft;
  const paidBlocked = cfg.kind === 'paid' && !tier;
  const chainName = serverChainInfo(chain)?.name ?? activeChain().name;
  // a kept payment opens only a room it covers (a bigger room costs more)
  const kept = pending && (!frozen || BigInt(pending.wei) >= frozen.wei) ? pending : null;

  const toPay = () => {
    const v = validateCustomConfig(cfg);
    if (!v.ok) {
      if (v.field === 'name') setNameError(v.message);
      else setError(v.message);
      return;
    }
    setNameError(null);
    setError(null);
    if (!quote?.treasury || youPay === null) return;
    if (noSeats || (v.config.kind === 'paid' && !tier)) return;
    setCfg(v.config);
    setFrozen({ wei: youPay, to: quote.treasury as Address });
    setStep('pay');
  };

  const create = async (txHash: string | null) => {
    setPhase('creating');
    try {
      const r = await roomsApi.create(token!, cfg, txHash);
      savePendingPayment(null);
      setMade(r.room);
      setStep('done');
      sound.punch();
    } catch (e) {
      const err = e as RoomApiError;
      // the payment is fine but no room opened: keep it for "Open the room" later (never pay twice)
      if (txHash && !(err instanceof RoomApiError && ['payment_invalid', 'payment_used', 'payment_low', 'payment_stale'].includes(err.code))) {
        setError(`${err.message} ${t('cr.keptPayment')}`);
      } else {
        if (txHash) savePendingPayment(null);
        setError(err.message);
      }
      setStep('pay');
    } finally {
      setPhase(null);
      inFlight.current = false;
    }
  };

  const pay = async () => {
    if (inFlight.current || !frozen || !chain || !token || !address) return;
    inFlight.current = true;
    setError(null);
    setStep('working');
    if (frozen.wei === 0n) return create(null);
    if (kept) return create(kept.hash);
    const res = await payRoomFee(chain, frozen.to, frozen.wei, (p, h) => {
      setPhase(p);
      if (h) setHash(h);
    });
    if (!res.ok) {
      inFlight.current = false;
      setPhase(null);
      setStep('pay');
      setError(res.message);
      return;
    }
    savePendingPayment({ hash: res.hash, wallet: address, wei: frozen.wei.toString(), at: Date.now() });
    setHash(res.hash);
    // the server may lag the receipt by a block: a few quiet retries before giving up
    for (let i = 0; i < 4; i++) {
      try {
        setPhase('creating');
        const r = await roomsApi.create(token, cfg, res.hash);
        savePendingPayment(null);
        setMade(r.room);
        setStep('done');
        setPhase(null);
        inFlight.current = false;
        sound.punch();
        return;
      } catch (e) {
        if (e instanceof RoomApiError && (e.code === 'payment_pending' || e.code === 'chain_busy') && i < 3) {
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }
        const err = e as RoomApiError;
        const final = err instanceof RoomApiError && ['payment_invalid', 'payment_low', 'payment_stale', 'payment_used'].includes(err.code);
        // a payment the server refuses for good is not offered again ("Use the kept payment")
        if (final) savePendingPayment(null);
        setError(`${err.message}${final ? '' : ` ${t('cr.keptPayment')}`}`);
        break;
      }
    }
    setPhase(null);
    setStep('pay');
    inFlight.current = false;
  };

  const enter = () => {
    if (!made) return;
    onClose();
    // a paid room is entered with a ticket of its arena: the lobby opens that ticket, seated here
    if (made.kind === 'paid' && made.arenaId) seatInPaidRoom(made);
    else engine()?.play(`private:${made.code}`);
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toast('success', t('cr.copied')),
      () => {},
    );
  };

  const link = made ? roomLink(made.code) : '';
  const phaseText =
    phase === 'switching' ? t('cr.phase.switching', { chain: chainName }) : phase === 'signing' ? t('cr.phase.signing') : phase === 'confirming' ? t('cr.phase.confirming') : phase === 'creating' ? t('cr.phase.creating') : '';
  const txLink = hash && !isFakeHash(hash) ? explorerTx(hash) : null;

  const gate = !address ? (
    <Button variant="primary" size="lg" block lead="wallet" onClick={() => openModal('wallet')}>
      {t('cr.connect')}
    </Button>
  ) : !signedIn ? (
    <Button variant="primary" size="lg" block lead="lock" onClick={() => void signInWithWallet(true)}>
      {t('cr.verify')}
    </Button>
  ) : null;

  let footer;
  if (step === 'setup') {
    footer = gate ?? (
      <Button
        variant="primary"
        size="lg"
        block
        icon="arrow"
        disabled={!quote || !quote.enabled || full || capped || noSeats || paidBlocked}
        onClick={toPay}
        sub={quote ? (free ? t('cr.freeSub') : t('cr.paySub', { chain: chainName })) : undefined}
        data-testid="cr-continue"
      >
        {full ? t('cr.full') : capped ? t('cr.capped', { n: quote!.maxPerWallet }) : noSeats ? t('cr.seatsFull') : free ? t('cr.createFree') : t('cr.continue')}
      </Button>
    );
  } else if (step === 'pay' || step === 'working') {
    footer = (
      <div className="cr-foot">
        <Button variant="ghost" onClick={() => setStep('setup')} disabled={step === 'working'}>
          {t('cr.back')}
        </Button>
        <Button variant="primary" size="lg" loading={step === 'working'} onClick={() => void pay()} data-testid="cr-pay" lead={kept || free ? 'key' : 'wallet'}>
          {free ? t('cr.createFree') : kept ? t('cr.useKept') : t('cr.pay', { amount: gasText(frozen?.wei ?? 0n) })}
        </Button>
      </div>
    );
  } else {
    footer = (
      <Button variant="primary" size="lg" block icon="arrow" onClick={enter} data-testid="cr-enter">
        {made?.kind === 'paid' ? t('cr.enterPaid') : t('cr.enter')}
      </Button>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      closeLabel={t('cr.close')}
      kicker={step === 'done' ? t('cr.kicker.done') : t('cr.kicker')}
      title={step === 'done' ? t('cr.title.done') : step === 'setup' ? t('cr.title') : t('cr.title.pay')}
      footer={footer}
      className="cr-sheet"
    >
      {step === 'setup' && (
        <div className="cr-form" data-testid="cr-setup">
          <p className="cr-lede">{t('cr.lede')}</p>
          <Field
            label={t('cr.name')}
            value={cfg.name}
            maxLength={CUSTOM_LIMITS.nameMax}
            placeholder={t('cr.namePlaceholder')}
            error={nameError ?? undefined}
            onChange={(e) => set('name', e.target.value)}
            data-autofocus
          />
          <Choice label={t('cr.kind')} options={CUSTOM_KINDS} value={cfg.kind} onPick={setKind} text={(v) => t(KIND_KEY[v])} />
          {cfg.kind === 'free' ? (
            <p className="cr-hint mono" data-testid="cr-kind-hint">
              {t('cr.kindFreeHint')}
            </p>
          ) : paidOpen ? (
            <>
              <div className="cr-row" role="group" aria-label={t('cr.tier')}>
                <span className="cr-row__label mono">{t('cr.tier')}</span>
                <div className="cr-row__chips">
                  {tiers.map((x) => (
                    <Chip key={x.arenaId} selected={x.arenaId === cfg.arenaId} onClick={() => set('arenaId', x.arenaId)} data-value={String(x.arenaId)} icon={x.holdersOnly ? 'lock' : undefined}>
                      {tierText(x, tok)}
                    </Chip>
                  ))}
                </div>
              </div>
              <p className="cr-hint mono" data-testid="cr-price-range">
                {t('cr.priceRange', { min: `${tok.wire(Math.min(...tiers.map((x) => x.entryFee)))} ${tok.symbol}`, max: `${tok.wire(Math.max(...tiers.map((x) => x.entryFee)))} ${tok.symbol}` })}
              </p>
              <p className="cr-note cr-paid" data-testid="cr-kind-hint">
                {t('cr.kindPaidHint', { arena: tier ? arenaMeta(tier.arenaId).name : '', fee: tier ? `${tok.wire(tier.entryFee)} ${tok.symbol}` : '' })}
              </p>
            </>
          ) : (
            <p className="cr-error" role="alert" data-testid="cr-paid-off">
              {t('cr.paidOff')}
            </p>
          )}
          <div className="cr-row" role="group" aria-label={t('cr.duration')} data-testid="cr-duration">
            <span className="cr-row__label mono">{t('cr.duration')}</span>
            <div className="cr-row__chips">
              {CUSTOM_DURATIONS_MIN.map((n) => (
                <Chip key={n} selected={n === cfg.durationMin} onClick={() => set('durationMin', n)} data-value={String(n)}>
                  {t('cr.minutes', { n })}
                </Chip>
              ))}
              <QuantityStepper
                value={cfg.durationMin}
                min={CUSTOM_DURATION_LIMITS.min}
                max={CUSTOM_DURATION_LIMITS.max}
                step={CUSTOM_DURATION_LIMITS.step}
                onChange={(v) => set('durationMin', v)}
                label={t('cr.durationCustom')}
              />
            </div>
          </div>
          <Choice label={t('cr.map')} options={CUSTOM_MAP_CHOICES} value={cfg.mapSize} onPick={(v) => set('mapSize', v)} text={(v) => t(MAP_KEY[v])} />
          <p className="cr-hint mono" data-testid="cr-map-hint">
            {cfg.mapSize === 'auto'
              ? t('cr.mapHintAuto', { min: MAP_SCALE_DEFAULT.base.toLocaleString('en-US'), max: MAP_SCALE_DEFAULT.max.toLocaleString('en-US') })
              : t('cr.mapHint', { w: CUSTOM_MAP_WIDTH[cfg.mapSize].toLocaleString('en-US') })}
          </p>
          <Choice label={t('cr.traps')} options={CUSTOM_TRAPS} value={cfg.traps} onPick={(v) => set('traps', v)} text={(v) => t(TRAPS_KEY[v])} />
          <Capacity
            value={cfg.maxPlayers}
            steps={steps}
            onPick={(n) => set('maxPlayers', n)}
            label={t('cr.players')}
            note={customCapacityTiers(cfg.maxPlayers) > 1 && stepPct > 0 ? t('cr.capFee', { x: multText(cfg.maxPlayers, stepPct) }) : t('cr.capBase')}
          />
          {noSeats && (
            <p className="cr-error" role="alert" data-testid="cr-seats">
              {t('cr.seatsLeft', { n: quote!.seatsLeft })}
            </p>
          )}
          {cfg.kind === 'free' && (
            <Choice
              label={t('cr.bots')}
              options={['on', 'off'] as const}
              value={cfg.bots > 0 ? 'on' : 'off'}
              onPick={(v) => set('bots', v === 'on' ? Math.max(1, lastBots.current) : 0)}
              text={(v) => t(v === 'on' ? 'cr.on' : 'cr.off')}
            />
          )}
          {cfg.kind === 'free' && cfg.bots > 0 && <p className="cr-hint mono">{t('cr.botsHint')}</p>}
          {cfg.kind === 'free' && cfg.bots > 0 && (
            <div className="cr-row">
              <span className="cr-row__label mono">{t('cr.botCount')}</span>
              <QuantityStepper value={cfg.bots} min={1} max={CUSTOM_LIMITS.botsMax} onChange={(v) => set('bots', v)} label={t('cr.botCount')} />
            </div>
          )}
          {cfg.kind === 'free' && cfg.bots > 0 && <Choice label={t('cr.difficulty')} options={CUSTOM_DIFFICULTIES} value={cfg.difficulty} onPick={(v) => set('difficulty', v)} text={(v) => t(DIFF_KEY[v])} />}
          <Choice label={t('cr.food')} options={CUSTOM_FOOD} value={cfg.food} onPick={(v) => set('food', v)} text={(v) => t(FOOD_KEY[v])} />
          <Choice label={t('cr.powerUps')} options={['on', 'off'] as const} value={cfg.powerUps ? 'on' : 'off'} onPick={(v) => set('powerUps', v === 'on')} text={(v) => t(v === 'on' ? 'cr.on' : 'cr.off')} />
          {quote && (
            <div className="cr-price" data-testid="cr-price">
              <span className="cr-row__label mono">{t('cr.price')}</span>
              {free ? <b className="cr-price__free">{t('cr.free')}</b> : <GasAmount wei={youPay ?? 0n} decimals={gasDecimals(youPay ?? 0n)} />}
              {base !== null && youPay !== null && youPay < base && !free && <s className="cr-price__was mono">{gasText(base)} {GAS_SYMBOL}</s>}
              <span className="cr-price__for mono">{t('cr.priceFor', { n: cfg.maxPlayers })}</span>
              <span className="cr-price__note">{perkNote(quote, t, cfg.maxPlayers)}</span>
            </div>
          )}
          {quote && <p className="cr-slots mono">{t('cr.slots', { live: quote.live, max: quote.maxLive })}</p>}
          {!quote?.enabled && quote && <p className="cr-error" role="alert">{t('cr.closedNow')}</p>}
          {!address || !signedIn ? <p className="cr-note">{t('cr.guestNote')}</p> : null}
          {error && <p className="cr-error" role="alert">{error}</p>}
        </div>
      )}

      {(step === 'pay' || step === 'working') && frozen && (
        <div className="cr-pay" data-testid="cr-payment">
          <Receipt
            title={t('cr.receipt')}
            meta={cfg.name}
            lines={[
              { label: t('cr.duration'), value: t('cr.minutes', { n: cfg.durationMin }) },
              { label: t('cr.map'), value: `${t(MAP_KEY[cfg.mapSize])} · ${t('cr.trapsShort', { traps: t(TRAPS_KEY[cfg.traps]).toLowerCase() })}` },
              { label: t('cr.bots'), value: cfg.bots > 0 ? `${cfg.bots} · ${t(DIFF_KEY[cfg.difficulty])}` : t('cr.noBots') },
              { label: t('cr.players'), value: t('cr.upTo', { n: cfg.maxPlayers }) },
              { label: t('cr.powerUps'), value: t(cfg.powerUps ? 'cr.on' : 'cr.off'), muted: true },
              ...(tier
                ? [
                    { label: t('cr.arena'), value: arenaMeta(tier.arenaId).name },
                    { label: t('cr.stakes'), value: `${tok.wire(tier.entryFee)} ${tok.symbol}` },
                  ]
                : [{ label: t('cr.stakes'), value: t('cr.noStakes'), muted: true }]),
              { label: t('cr.total'), value: frozen.wei === 0n ? t('cr.free') : `${gasText(frozen.wei)} ${GAS_SYMBOL}`, strong: true },
            ]}
          />
          {frozen.wei > 0n && (
            <div className="cr-to">
              <span className="cr-row__label mono">{t('cr.to')}</span>
              <AddressChip address={frozen.to} label={t('cr.treasury')} size="sm" copyLabel={t('cr.copy')} />
            </div>
          )}
          {tier && <p className="cr-note cr-paid">{t('cr.paidNote', { arena: arenaMeta(tier.arenaId).name })}</p>}
          <p className="cr-note">{kept ? t('cr.keptNote') : frozen.wei === 0n ? t('cr.freeNote') : t('cr.payNote', { chain: chainName })}</p>
          {step === 'working' && (
            <p className="cr-phase" role="status">
              <StampSpinner size="sm" /> {phaseText}
              {txLink && (
                <a className="cr-phase__link mono" href={txLink} target="_blank" rel="noreferrer">
                  {t('tf.viewTx')}
                </a>
              )}
            </p>
          )}
          {error && <p className="cr-error" role="alert">{error}</p>}
        </div>
      )}

      {step === 'done' && made && (
        <div className="cr-done" data-testid="cr-done">
          <div className="cr-done__art" aria-hidden="true">
            <CoinCharacter paint="sun" mood="smile" size={72} bob />
            <Stamp text={t('cr.stamp')} tone="up" animateIn size="md" rotate={-10} />
          </div>
          <p className="cr-lede">
            {made.kind === 'paid' && made.arenaId
              ? t('cr.doneLedePaid', { name: made.name, arena: arenaMeta(made.arenaId).name })
              : t('cr.doneLede', { name: made.name, n: made.durationMin })}
          </p>
          <div className="cr-code" aria-label={t('cr.codeLabel')}>
            <span className="cr-row__label mono">{t('cr.codeLabel')}</span>
            <button type="button" className="cr-code__value mono" onClick={() => copy(made.code)} data-testid="cr-code">
              {made.code}
            </button>
          </div>
          <div className="cr-link">
            <input className="cr-link__input mono" readOnly value={link} aria-label={t('cr.link')} onFocus={(e) => e.currentTarget.select()} />
            <Button size="sm" onClick={() => copy(link)} lead="docs">
              {t('cr.copyLink')}
            </Button>
            {typeof navigator !== 'undefined' && 'share' in navigator && (
              <Button size="sm" variant="ghost" onClick={() => void navigator.share({ title: made.name, text: t('cr.shareText', { name: made.name }), url: link }).catch(() => {})}>
                {t('cr.share')}
              </Button>
            )}
          </div>
          <p className="cr-note">{t('cr.doneNote')}</p>
        </div>
      )}
    </Sheet>
  );
}

function perkNote(q: CustomRoomQuote, t: ReturnType<typeof useT>, capacity: number): string {
  if (q.holderPerk === 'none') return t('cr.perk.none');
  if (q.holder && q.holderPerk === 'free_daily' && q.freeAvailable && customCapacityTiers(capacity) > 1) return t('cr.perk.freeSmall');
  if (q.holder) return q.holderPerk === 'discount' ? t('cr.perk.youDiscount', { pct: q.holderDiscountPct }) : q.freeAvailable ? t('cr.perk.youFree') : t('cr.perk.freeUsed');
  return q.holderPerk === 'discount' ? t('cr.perk.discount', { pct: q.holderDiscountPct }) : t('cr.perk.free');
}
