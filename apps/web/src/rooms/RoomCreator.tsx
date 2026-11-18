import {
  BPS,
  CUSTOM_DEFAULTS,
  CUSTOM_DIFFICULTIES,
  CUSTOM_DURATIONS_MIN,
  CUSTOM_DURATION_LIMITS,
  CUSTOM_FOOD,
  CUSTOM_KINDS,
  CUSTOM_LIMITS,
  CUSTOM_MAP_CHOICES,
  CUSTOM_MAP_WIDTH,
  DEFAULT_PAYMENT_BURN_BPS,
  MAP_SCALE_DEFAULT,
  CUSTOM_TRAPS,
  arenaMeta,
  bpsToPercent,
  customCapacityChoices,
  customCapacityTiers,
  customRoomFee,
  parseUsdPrice,
  quotePrice,
  tokenRawToUsd,
  validateCustomConfig,
  type CustomArenaTier,
  type CustomRoomConfig,
  type CustomRoomQuote,
  type CustomRoomView,
  activeChain,
} from '@coinnibal/shared';
import { useEffect, useId, useRef, useState } from 'react';
import type { Address, Hash } from 'viem';
import { AddressChip, Button, Chip, CoinCharacter, Field, GasAmount, QuantityStepper, Receipt, Sheet, Stamp, StampSpinner, formatUsd } from '../design';
import { engine } from '../game/instance';
import { sound } from '../audio';
import { useT, type TKey } from '../i18n';
import { openModal, toast, updateSettings, useUi } from '../store';
import { tokenText, useTokenText, type TokenText } from '../ui/lobby/useLobby';
import { buyTicket, type TicketReview } from '../wallet/buyTicket';
import { refreshChain, useChainData, useReadClient } from '../wallet/chain';
import { isFakeHash } from '../wallet/devFake';
import { explorerTx } from '../wallet/links';
import { serverChainInfo } from '../wallet/network';
import { signInWithWallet } from '../wallet/signIn';
import { useAddress } from '../wallet/store';
import { approveTickets, arenaRates, ledgerToBase, sessionKey, ticketRates, ticketSteps, type TicketStep } from '../wallet/ticket';
import type { TxPhase } from '../wallet/tx';
import { RoomApiError, dropPendingPayment, keptPaymentFor, loadPendingPayments, roomLink, roomsApi, savePendingPayment } from './api';
import { arenaTarget, seatInPaidRoom } from './invite';
import { newRoomRequest, payRoomFee } from './pay';
import './rooms.css';

/** `ticket`: a paid room just opened and the creator's own arena ticket is being bought (or failed and can be retried). */
type Step = 'setup' | 'pay' | 'working' | 'ticket' | 'done';

/** What the creator's own ticket of a paid room needs: buy one (as reviewed), resume the open one, or nothing possible yet. */
type SeatPlan = { kind: 'buy'; review: TicketReview } | { kind: 'resume' } | { kind: 'blocked'; text: string };

/** After the ticket is stamped, this long before the room opens (the stamp is seen). */
const SEATED_MS = 900;

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

/** "Arena · 10,000 $NIBAL": a paid room's tier. */
const tierText = (x: CustomArenaTier, tok: TokenText) => `${arenaMeta(x.arenaId).name} · ${tok.wire(x.entryFee)} ${tok.symbol}`;

/**
 * How the sheet writes a room fee: the token amount (`1,500 $NIBAL`), and its dollar value when the server knows the
 * token's price (`$1.50`), from the quote (pure, tested).
 */
export function roomFeeText(q: Pick<CustomRoomQuote, 'pay' | 'usdPerToken'> | null, fallback: TokenText): { tokens: (raw: bigint) => string; usd: (raw: bigint) => number | null; symbol: string; tok: TokenText } {
  const tok = q?.pay ? tokenText(q.pay.token.decimals, q.pay.token.symbol || fallback.symbol) : fallback;
  let price: bigint | null = null;
  try {
    price = q?.usdPerToken ? parseUsdPrice(q.usdPerToken) : null;
  } catch {
    price = null;
  }
  return {
    tokens: (raw) => `${tok.fee(raw)} ${tok.symbol}`,
    usd: (raw) => (price !== null && raw > 0n ? tokenRawToUsd(raw, price, tok.decimals) : null),
    symbol: tok.symbol,
    tok,
  };
}

/** A fee's dollar value as the price box shows it (`≈ $1.50`), or null without a token price. */
const usdText = (f: ReturnType<typeof roomFeeText>, raw: bigint): string | null => {
  const usd = f.usd(raw);
  return usd !== null ? `≈ ${formatUsd(usd)}` : null;
};

/** Refusals that are final for a payment: it is not one, it opened a room already, or it is too old. */
const FINAL_PAYMENT = ['payment_invalid', 'payment_used', 'payment_stale'];

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
 * "Create your own room": the creator picks the rules, pays the small fee in the game token (approve when the
 * allowance is short, then one `CoinnibalArena.pay` to the arena, like the power-up cart: half burned, half to the team
 * wallet; NFT holders get the perk the admin chose, by default one free room a day without any payment), the server
 * checks the payment on chain and opens the room; the sheet ends on the invite code and share link. Before the game
 * token is live a room that costs something cannot be paid: the sheet says so (Practice with bots stays free).
 *
 * A paid (ticket) room goes on in the same sheet straight into the creator's own arena ticket (approve if needed,
 * then join, the same checked path as the ticket sheet: `buyTicket`) and ends with the creator seated in the room.
 * A few wallet signatures (the fee, then the ticket) in one guided flow. The ticket is checked BEFORE the fee is paid
 * (enough tokens for both, no payout waiting in that arena), so the fee is never paid for a room its creator cannot
 * sit in; a ticket that fails or is rejected leaves the room open and the creator retries here (or later from the
 * lobby, where the room's seat stays remembered).
 *
 * Money safety: one in-flight guard (a ref) per payment, the price, the arena and the room request (the payment's
 * ref) and the ticket's fee, rates and calls are frozen at "Continue", and a payment that was sent but did not open a
 * room yet is kept (this browser, with its request) and offered again, so the creator never pays twice. A ticket that
 * landed after all (the receipt timed out) is resumed, never bought again.
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
  /** Frozen at "Continue": the price, where it is paid (null: a free room) and this payment's own request id. */
  const [frozen, setFrozen] = useState<{ raw: bigint; pay: CustomRoomQuote['pay']; request: string } | null>(null);
  const [phase, setPhase] = useState<TxPhase | 'creating' | null>(null);
  /** Which wallet call of the fee is open: the token approval or the payment. */
  const [payStep, setPayStep] = useState<'approve' | 'pay' | null>(null);
  const [hash, setHash] = useState<Hash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [made, setMade] = useState<CustomRoomView | null>(null);
  const inFlight = useRef(false);
  /** The creator's ticket (paid rooms): frozen at "Continue" with the fee. */
  const [seat, setSeat] = useState<SeatPlan | null>(null);
  const [ticketPhase, setTicketPhase] = useState<TxPhase | 'preparing' | 'seated' | null>(null);
  const [ticketStep, setTicketStep] = useState<TicketStep | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const ticketInFlight = useRef(false);
  const data = useChainData();
  const client = useReadClient();
  const serverFees = useUi((s) => s.chain?.fees ?? null);
  const blockedArenas = useUi((s) => s.blockedArenas);
  const approveN = useUi((s) => approveTickets(s.settings.approveTickets));

  const signedIn = !!auth && !!address && auth.address.toLowerCase() === address.toLowerCase();
  const token = signedIn ? auth!.token : null;
  // every payment kept for this wallet (a list: a new payment or a free room never erases another one)
  const pendings = signedIn ? loadPendingPayments(address) : [];

  useEffect(() => {
    if (!open) return;
    inFlight.current = false;
    setStep('setup');
    setPhase(null);
    setError(null);
    setHash(null);
    setMade(null);
    setFrozen(null);
    setPayStep(null);
    setSeat(null);
    setTicketPhase(null);
    setTicketStep(null);
    setTicketError(null);
    ticketInFlight.current = false;
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
  // the price follows the capacity live (the server's own price function); the server computes it again and checks the payment
  const youPay = quote ? quotePrice({ ...quote, capacityStepPct: stepPct }, cfg.maxPlayers) : null;
  const base = quote ? customRoomFee(BigInt(quote.priceRaw), cfg.maxPlayers, stepPct) : null;
  const free = youPay === 0n;
  const fee = roomFeeText(quote, tok);
  // a fee is due but cannot be paid yet: the game token is not live (or the chain is off here)
  const payClosed = !!quote && !free && !quote.pay;
  const full = !!quote && quote.live >= quote.maxLive;
  const capped = !!quote && quote.mine >= quote.maxPerWallet;
  const noSeats = !!quote && typeof quote.seatsLeft === 'number' && cfg.maxPlayers > quote.seatsLeft;
  const paidBlocked = cfg.kind === 'paid' && !tier;
  const chainName = serverChainInfo(chain)?.name ?? activeChain().name;
  // a kept payment opens only a room it covers (a bigger room costs more): the smallest that covers the frozen fee
  const kept = frozen && frozen.raw > 0n && signedIn ? keptPaymentFor(address, frozen.raw) : null;
  // kept payments too small for this room: they stay kept (said on the pay step), the room needs a new payment
  const keptSmaller = frozen && frozen.raw > 0n && !kept && pendings.length > 0 ? pendings[pendings.length - 1] : null;

  /**
   * The creator's own ticket of a paid room on `arenaId`, from the live chain data: an open ticket is resumed (no new
   * payment); a payout waiting there, too few tokens or an arena the server keeps closed block it (said before any fee
   * is paid); else one ticket at the arena's price on chain, with the rates and calls the ticket sheet would show.
   */
  const seatPlan = (arenaId: number, entryFee: number): SeatPlan => {
    const session = data.sessions[arenaId] ?? null;
    if (session?.finalized) return { kind: 'blocked', text: t('cr.tk.collect') };
    const key = session && address ? sessionKey(arenaId, address, session.id) : null;
    if (data.pending.some((p) => p.arenaId === arenaId || p.key === key)) return { kind: 'blocked', text: t('cr.tk.settling') };
    if (session) return { kind: 'resume' };
    if (blockedArenas.includes(arenaId)) return { kind: 'blocked', text: t('tf.err.Maintenance') };
    const config = data.config?.token ? data.config : null;
    // the price signed is the arena's on chain (the dev fake chain: the server's listing)
    const onChain = data.arenas.find((a) => a.id === arenaId)?.entryFee ?? null;
    const fee = onChain ?? (data.fake ? ledgerToBase(entryFee, tok.decimals) : null);
    if (!config || fee === null || fee <= 0n) return { kind: 'blocked', text: t('cr.tk.unknown') };
    // the room fee is paid in the same token first: the wallet needs both
    const both = fee + (youPay ?? 0n);
    if (data.tokenBalance !== null && data.tokenBalance < both) return { kind: 'blocked', text: t(youPay ? 'cr.tk.shortBoth' : 'cr.tk.short', { fee: tok.exact(both), sym: tok.symbol }) };
    const rates = ticketRates(arenaRates(serverFees, config), config, data.holder).rates;
    return { kind: 'buy', review: { fee, rates, steps: ticketSteps(data.allowance, fee), approve: approveN } };
  };

  const toPay = () => {
    const v = validateCustomConfig(cfg);
    if (!v.ok) {
      if (v.field === 'name') setNameError(v.message);
      else setError(v.message);
      return;
    }
    setNameError(null);
    setError(null);
    if (!quote || youPay === null) return;
    if (noSeats || (v.config.kind === 'paid' && !tier)) return;
    if (youPay > 0n && !quote.pay) {
      setError(t('cr.tokenSoon'));
      return;
    }
    // a ticket room: the creator's own ticket must be possible before the fee is paid
    const plan = v.config.kind === 'paid' && tier ? seatPlan(tier.arenaId, tier.entryFee) : null;
    if (plan?.kind === 'blocked') {
      setError(plan.text);
      return;
    }
    // the fee itself: a kept payment covers it, else the wallet needs the tokens (said before any signature)
    const keptCovers = youPay > 0n && pendings.some((p) => BigInt(p.raw) >= youPay);
    if (youPay > 0n && !keptCovers && !plan && data.tokenBalance !== null && data.tokenBalance < youPay) {
      setError(t('cr.short', { fee: fee.tokens(youPay), have: fee.tokens(data.tokenBalance) }));
      return;
    }
    setCfg(v.config);
    setSeat(plan);
    setFrozen({ raw: youPay, pay: youPay > 0n ? quote.pay : null, request: newRoomRequest() });
    setPayStep(null);
    setStep('pay');
  };

  /** The creator sits down in the paid room that just opened: their open ticket is resumed, else seated by the join. */
  const seatMe = (room: CustomRoomView, awaitTicket: boolean) => {
    if (!room.arenaId) return;
    updateSettings({ lastArena: room.arenaId });
    onClose();
    engine()?.play(arenaTarget(room.arenaId), awaitTicket ? { awaitTicket: true } : {});
  };

  /**
   * The creator's own ticket of the paid room `room` (just opened): bought with the checked ticket path, then the
   * creator is seated. `plan` is the one frozen at "Continue" (a retry reads the chain again: an approval that went
   * through is not asked again, a ticket that landed after all is resumed).
   */
  const ticket = async (room: CustomRoomView, plan: SeatPlan | null) => {
    if (ticketInFlight.current || !room.arenaId || !address || !chain) return;
    const p = plan ?? seatPlan(room.arenaId, tier?.entryFee ?? 0);
    if (p.kind === 'resume') return seatMe(room, false);
    if (p.kind === 'blocked') {
      setTicketError(p.text);
      return;
    }
    const config = data.config?.token ? data.config : null;
    if (!config) {
      setTicketError(t('cr.tk.unknown'));
      return;
    }
    ticketInFlight.current = true;
    setTicketError(null);
    setTicketPhase('preparing');
    const res = await buyTicket({ owner: address, chain, client, config, arenaId: room.arenaId, review: p.review, fake: data.fake }, (s, ph, h) => {
      setTicketStep(s);
      setTicketPhase(ph);
      if (h) setHash(h);
    });
    if (!res.ok) {
      ticketInFlight.current = false;
      setTicketPhase(null);
      setTicketStep(null);
      setTicketError(res.text);
      refreshChain();
      return;
    }
    setHash(res.hash);
    setTicketPhase('seated');
    setTicketStep(null);
    sound.punch();
    const href = isFakeHash(res.hash) ? null : explorerTx(res.hash);
    toast('success', t('tf.ticketOk'), href ? { href, label: t('tf.viewTx') } : undefined, 6000);
    refreshChain();
    window.setTimeout(() => {
      ticketInFlight.current = false;
      seatMe(room, true);
    }, SEATED_MS);
  };

  /**
   * A room opened: a free room ends on its invite; a ticket room goes on to the creator's own ticket at once. Only the
   * payment that opened it (`usedHash`) is forgotten: a free room never touches a kept payment.
   */
  const opened = (room: CustomRoomView, usedHash: string | null) => {
    if (usedHash && address) dropPendingPayment(address, usedHash);
    setMade(room);
    if (room.kind === 'paid' && room.arenaId) {
      // the lobby remembers the seat too: "Later" (or a closed sheet) still sends this arena's next ticket here
      useUi.setState({ paidSeat: { code: room.code, arenaId: room.arenaId, name: room.name, endsAt: room.endsAt } });
      setStep('ticket');
      void ticket(room, seat);
      return;
    }
    setStep('done');
    sound.punch();
  };

  /**
   * Asks the server to open the room: free (`payment` null), or with the fee's payment. The server may lag the
   * receipt by a block: a few quiet retries while it says "pending" or the network is busy. A payment it refuses for
   * good is dropped (never offered again); any other failure keeps it for "Open with my payment" (never pay twice).
   */
  const create = async (payment: { txHash: string; request: string } | null) => {
    try {
      for (let i = 0; ; i++) {
        try {
          setPhase('creating');
          const r = await roomsApi.create(token!, cfg, payment);
          setPhase(null);
          opened(r.room, payment?.txHash ?? null);
          return;
        } catch (e) {
          if (payment && e instanceof RoomApiError && (e.code === 'payment_pending' || e.code === 'chain_busy') && i < 3) {
            await new Promise((r) => setTimeout(r, 2500));
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      const err = e as RoomApiError;
      const final = err instanceof RoomApiError && FINAL_PAYMENT.includes(err.code);
      if (payment && final && address) dropPendingPayment(address, payment.txHash);
      setError(payment && !final ? `${err.message} ${t('cr.keptPayment')}` : err.message);
      setStep('pay');
    } finally {
      setPhase(null);
      setPayStep(null);
      inFlight.current = false;
    }
  };

  const pay = async () => {
    if (inFlight.current || !frozen || !chain || !token || !address) return;
    inFlight.current = true;
    setError(null);
    setStep('working');
    if (frozen.raw === 0n) return create(null);
    if (kept) return create({ txHash: kept.hash, request: kept.request });
    if (!frozen.pay) {
      inFlight.current = false;
      setStep('pay');
      setError(t('cr.tokenSoon'));
      return;
    }
    const res = await payRoomFee(frozen.pay, frozen.raw, frozen.request, {
      owner: address,
      chain,
      onPhase: (p) => setPhase(p === 'verifying' ? 'creating' : p),
      onStep: setPayStep,
    });
    // nothing was sent (declined, no tokens, a failed approval): try again, nothing to keep
    if (!res.ok && !res.hash) {
      inFlight.current = false;
      setPhase(null);
      setPayStep(null);
      setStep('pay');
      setError(res.message);
      return;
    }
    // sent (and confirmed, or not seen confirming here): the tokens may be spent, so the payment is kept until a room
    // opens with it or the server refuses it for good
    const sent = res.hash!;
    savePendingPayment({ hash: sent, wallet: address, request: frozen.request, raw: frozen.raw.toString(), at: Date.now() });
    setHash(sent);
    return create({ txHash: sent, request: frozen.request });
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
    phase === 'switching'
      ? t('cr.phase.switching', { chain: chainName })
      : phase === 'signing'
        ? t(payStep === 'approve' ? 'cr.phase.approving' : 'cr.phase.signing', { fee: frozen ? fee.tokens(frozen.raw) : '' })
        : phase === 'confirming'
          ? t(payStep === 'approve' ? 'cr.phase.approveConfirming' : 'cr.phase.confirming')
          : phase === 'creating'
            ? t('cr.phase.creating')
            : '';
  const txLink = hash && !isFakeHash(hash) ? explorerTx(hash) : null;
  // where the creator's own ticket is (paid rooms)
  const ticketText =
    ticketPhase === 'seated'
      ? t('cr.tk.seated')
      : ticketPhase === 'preparing'
        ? t('tf.preparing')
        : ticketPhase === 'switching'
          ? t('tf.switching', { chain: chainName })
          : ticketPhase === 'signing'
            ? ticketStep === 'approve'
              ? t('tf.approving')
              : t('tf.signing')
            : t('tf.confirming');

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
        disabled={!quote || !quote.enabled || full || capped || noSeats || paidBlocked || payClosed}
        onClick={toPay}
        sub={quote ? (free ? t('cr.freeSub') : payClosed ? t('cr.tokenSoonSub') : t('cr.paySub', { sym: fee.symbol, chain: chainName })) : undefined}
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
          {free ? t('cr.createFree') : kept ? t('cr.useKept') : seat ? t('cr.payTicket', { amount: fee.tokens(frozen?.raw ?? 0n) }) : t('cr.pay', { amount: fee.tokens(frozen?.raw ?? 0n) })}
        </Button>
      </div>
    );
  } else if (step === 'ticket') {
    const busy = ticketPhase !== null;
    footer = busy ? (
      <Button variant="primary" size="lg" block loading disabled data-testid="cr-ticket-busy">
        {ticketText}
      </Button>
    ) : (
      <div className="cr-foot">
        <Button variant="ghost" onClick={onClose} data-testid="cr-ticket-later">
          {t('cr.tk.later')}
        </Button>
        <Button variant="primary" size="lg" lead="ticket" onClick={() => made && void ticket(made, null)} data-testid="cr-ticket-retry">
          {t('cr.tk.retry')}
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
      onClose={() => (step === 'working' || (step === 'ticket' && ticketPhase !== null) ? undefined : onClose())}
      closeLabel={t('cr.close')}
      kicker={step === 'done' || step === 'ticket' ? t('cr.kicker.done') : t('cr.kicker')}
      title={step === 'done' ? t('cr.title.done') : step === 'ticket' ? t('cr.tk.title') : step === 'setup' ? t('cr.title') : t('cr.title.pay')}
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
              {free ? (
                <b className="cr-price__free">{t('cr.free')}</b>
              ) : (
                <GasAmount figure={fee.tok.fee(youPay ?? 0n)} unit={fee.symbol} usd={fee.usd(youPay ?? 0n)} data-testid="cr-price-amount" />
              )}
              {base !== null && youPay !== null && youPay < base && !free && <s className="cr-price__was mono">{fee.tokens(base)}</s>}
              <span className="cr-price__for mono">{t('cr.priceFor', { n: cfg.maxPlayers })}</span>
              <span className="cr-price__note">{perkNote(quote, t, cfg.maxPlayers)}</span>
            </div>
          )}
          {quote && <p className="cr-slots mono">{t('cr.slots', { live: quote.live, max: quote.maxLive })}</p>}
          {!quote?.enabled && quote && <p className="cr-error" role="alert">{t('cr.closedNow')}</p>}
          {quote?.enabled && payClosed && (
            <p className="cr-error" role="alert" data-testid="cr-token-soon">
              {t('cr.tokenSoon')}
            </p>
          )}
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
              { label: t('cr.total'), value: frozen.raw === 0n ? t('cr.free') : fee.tokens(frozen.raw), strong: true },
              // the same tokens in dollars, at the token price the server converts with
              ...(frozen.raw > 0n && usdText(fee, frozen.raw) ? [{ label: t('cr.inDollars'), value: usdText(fee, frozen.raw)!, muted: true }] : []),
              // then the creator's own ticket of the room's arena (its own signatures, right after the fee)
              ...(seat?.kind === 'buy' ? [{ label: t('cr.yourTicket'), value: `${tok.exact(seat.review.fee)} ${tok.symbol}`, strong: true }] : []),
              ...(seat?.kind === 'resume' ? [{ label: t('cr.yourTicket'), value: t('cr.ticketResume'), muted: true }] : []),
            ]}
          />
          {frozen.raw > 0n && frozen.pay && (
            <div className="cr-to">
              <span className="cr-row__label mono">{t('cr.to')}</span>
              <AddressChip address={frozen.pay.payTo as Address} label={t('cr.arenaContract')} size="sm" copyLabel={t('cr.copy')} />
            </div>
          )}
          {tier && <p className="cr-note cr-paid">{t('cr.paidNote', { arena: arenaMeta(tier.arenaId).name })}</p>}
          <p className="cr-note" data-testid="cr-pay-note">
            {kept
              ? t('cr.keptNote')
              : frozen.raw === 0n
                ? t('cr.freeNote')
                : t('cr.payNote', {
                    chain: chainName,
                    burn: bpsToPercent(frozen.pay?.burnBps ?? DEFAULT_PAYMENT_BURN_BPS),
                    team: bpsToPercent(BPS - (frozen.pay?.burnBps ?? DEFAULT_PAYMENT_BURN_BPS)),
                  })}
          </p>
          {keptSmaller && (
            <p className="cr-note" data-testid="cr-kept-smaller">
              {t('cr.keptSmaller', { amount: fee.tokens(BigInt(keptSmaller.raw)) })}
            </p>
          )}
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

      {step === 'ticket' && made && made.arenaId && (
        <div className="cr-done cr-ticket" data-testid="cr-ticket">
          <p className="cr-lede">{t('cr.tk.lede', { name: made.name, arena: arenaMeta(made.arenaId).name })}</p>
          {seat?.kind === 'buy' && (
            <section className="tf-steps cr-tsteps" aria-label={t('tf.signs')}>
              <ol>
                <li className="is-done">
                  <span className="tf-steps__n num" aria-hidden="true">
                    1
                  </span>
                  <span>
                    {t('cr.receipt')} · {frozen && frozen.raw > 0n ? fee.tokens(frozen.raw) : t('cr.free')}
                  </span>
                </li>
                {seat.review.steps.map((s, i) => (
                  <li key={s} className={ticketPhase === 'seated' || (ticketStep !== null && seat.review.steps.indexOf(ticketStep) > i) ? 'is-done' : ticketStep === s ? 'is-active' : undefined}>
                    <span className="tf-steps__n num" aria-hidden="true">
                      {i + 2}
                    </span>
                    <span>
                      {s === 'approve'
                        ? t('tf.step.approve', { fee: tok.exact(seat.review.fee), sym: tok.symbol })
                        : t('tf.step.join', { room: arenaMeta(made.arenaId ?? 0).name })}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {ticketPhase !== null && (
            <p className="cr-phase" role="status" data-testid="cr-ticket-phase">
              {ticketPhase !== 'seated' && <StampSpinner size="sm" />} {ticketText}
              {txLink && (
                <a className="cr-phase__link mono" href={txLink} target="_blank" rel="noreferrer">
                  {t('tf.viewTx')}
                </a>
              )}
            </p>
          )}
          {ticketError && (
            <>
              <p className="cr-error" role="alert" data-testid="cr-ticket-error">
                {t('cr.tk.failed', { error: ticketError })}
              </p>
              <p className="cr-note">{t('cr.tk.laterNote')}</p>
            </>
          )}
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
          </div>
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
