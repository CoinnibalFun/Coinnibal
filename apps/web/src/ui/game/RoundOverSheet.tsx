import { activeChain, bpsToPercent, profitFee, totalFeeBps, type FeeRates } from '@elymum/shared';
import { AnimatePresence, motion, type TargetAndTransition } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { Button, Icon, Receipt, Sheet, Stamp, useReducedMotion, type ReceiptLine } from '../../design';
import { FinalBoard } from './FinalBoard';
import { NextRoundOpens } from './NextRoundOpens';
import { EatenNames, ShareOnX, resultShareText, useShare } from './ShareOnX';
import { engine } from '../../game/instance';
import { roundStartLabel } from '../../game/round';
import { useChainData } from '../../wallet/chain';
import { isFakeHash } from '../../wallet/devFake';
import { arenaRates, ledgerToBase } from '../../wallet/ticket';
import { PRICE_STALE_HOURS, usdQuote } from '../../wallet/usdPrice';
import { announce, sound } from '../../audio';
import { useT } from '../../i18n';
import { explorerTx } from '../../wallet/links';
import { requestTicket, useUi } from '../../store';
import { formatClock, roomName, useTokenFormat } from './format';

/** The receipt waits for the bell to swing in and ring over the frozen world (ms). */
export const ROUND_SHEET_DELAY_MS = 1500;


/**
 * Receipt numbers: the settlement's own `fee` / `net` once it arrives, an estimate before, at `rates` (the rates fixed
 * into this ticket at join, else the live ones). `gross` is the till at the bell; arena v3 takes the fee from the
 * profit only (`gross - entryFee`): nothing when the ticket did not win.
 */
export function receiptNumbers(gross: number, entryFee: number, rates: FeeRates, settled: { fee?: number; net?: number } | null) {
  const est = profitFee(entryFee, gross, rates);
  const final = settled?.fee !== undefined;
  const fee = settled?.fee ?? est.fee;
  return {
    gain: gross - entryFee,
    fee,
    net: settled?.net ?? est.net,
    pct: totalFeeBps(rates) / 100,
    final,
  };
}

/** The settlement for this ticket: matched by its session key only. */
export function settlementFor<T extends { session: string | null }>(settled: T | null, ticketSession: string | null | undefined): T | null {
  return settled && ticketSession && settled.session === ticketSession ? settled : null;
}

/**
 * "Round over", the landing report: the bell rang while my coin was alive, so the till is paid.
 * After a beat (the bell wave over the frozen world) the report flies out of the worth sticker: the
 * till, the fee on its profit and what was paid (an estimate until `settled` arrives, then a PAID
 * stamp and the transaction link), my place and the room's whole board at the bell (`FinalBoard`, the same board a custom
 * room shows at its end: value, mass and kills). "Next round"
 * goes back to the lobby with this arena's ticket ready to buy.
 *
 * The same receipt, without the standings, serves an operator exit (`exit`: an admin kick or
 * a server shutdown pays the current value).
 */
export function RoundOverSheet() {
  const t = useT();
  const tf = useTokenFormat();
  const res = useUi((s) => s.roundResult);
  const room = useUi((s) => s.room);
  const ticket = useUi((s) => s.ticket);
  const chain = useUi((s) => s.chain);
  const settledRaw = useUi((s) => s.lastSettlement);
  const config = useChainData((s) => s.config);
  const prices = useChainData((s) => s.prices);
  const serverFees = useUi((s) => s.chain?.fees ?? null);
  // the rates fixed into this ticket at join (its session), else the live rates
  const session = useChainData((s) => (ticket?.arenaId != null ? (s.sessions[ticket.arenaId] ?? null) : null));
  const over = useUi((s) => s.screen === 'roundover' && s.roundResult !== null);
  const reduced = useReducedMotion();
  const exit = res?.kind === 'exit';
  const mySkin = useUi((s) => s.me?.skin ?? s.settings.skin);

  // the bell first, then the receipt (at once with reduced motion or after an operator exit)
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!over) {
      setOpen(false);
      return;
    }
    if (reduced || exit) {
      setOpen(true);
      return;
    }
    const id = setTimeout(() => setOpen(true), ROUND_SHEET_DELAY_MS);
    return () => clearTimeout(id);
  }, [over, reduced, exit]);

  // the receipt slips out of the till and grows into this sheet (read while the till is on screen)
  const fromTill = useMemo(() => (open ? receiptOrigin() : null), [open]);
  const [since, setSince] = useState(() => Date.now());
  const [printed, setPrinted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSince(Date.now());
    setPrinted(false);
    // the slip feeds out of the till's printer
    if (!reduced) sound.print(1300);
    return () => sound.stopPrint();
  }, [open]);

  const settled = settlementFor(settledRaw, ticket?.session);
  useEffect(() => {
    if (!settled || !printed) return;
    sound.stamp('paid');
    // the till paid out: the announcer calls it
    if ((res?.payout ?? 0) > 0) announce('paid');
  }, [settled, printed]);

  const toLobby = () => engine()?.backToLobby();
  const nextRound = () => {
    if (room?.arenaId !== undefined) requestTicket(room.arenaId);
    engine()?.backToLobby();
  };

  // the till at the bell: the server's `stats.gross` when a fee was due, else what it paid (no fee)
  const gross = res?.stats?.gross ?? res?.payout ?? 0;
  const entry = ticket?.entryFee ?? room?.entryFee ?? 0;
  const rates = session && session.id > 0n ? { burnBps: session.burnBps, vaultBps: session.vaultBps } : arenaRates(serverFees, config);
  const n = receiptNumbers(gross, entry, rates, settled);
  const roundTime = res?.round != null ? roundStartLabel(res.round, room?.round) : '';
  const approx = n.final ? '' : `${t('gr.estimate')} `;
  const lines: ReceiptLine[] = [
    { label: t('gr.till'), value: tf.fmt(gross) },
    {
      label: <>{t('gr.fee', { pct: n.pct.toLocaleString('en-US', { maximumFractionDigits: 2 }) })}</>,
      // the fee on profit (burned + to the fee wallet); a ticket that did not win pays none
      value: n.fee > 0 ? `${approx}−${tf.fmt(n.fee)}` : tf.fmt(0),
      muted: true,
    },
    {
      label: t('gr.paidLine'),
      value: (
        <span className="g-receipt__net">
          {approx}
          {tf.fmt(n.net)}
          <small className="mono">{tf.symbol}</small>
        </span>
      ),
      strong: true,
    },
  ];
  const date = new Date(since).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const txHref = settled && !isFakeHash(settled.txHash) ? explorerTx(settled.txHash, chain?.explorerUrl) : null;
  const footer = settled ? (
    txHref ? (
      <a className="g-receipt__tx" href={txHref} target="_blank" rel="noreferrer">
        {t('gr.viewTx')} · {settled.txHash.slice(0, 6)}…{settled.txHash.slice(-4)}
        <Icon name="arrow" size={14} />
      </a>
    ) : (
      <span className="g-receipt__tx mono">
        {settled.txHash.slice(0, 6)}…{settled.txHash.slice(-4)}
      </span>
    )
  ) : (
    <span className="g-receipt__pending" role="status">
      {t('gr.settling')}
      <span className="g-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );

  // what was paid, in US dollars with the age of the price (nothing when the server has none)
  const decimals = chain?.token?.decimals ?? config?.decimals ?? 18;
  const usd = usdQuote(prices, ledgerToBase(n.net, decimals), decimals, since);
  const standings = res?.standings ?? [];
  const share = useShare('round');

  return (
    <Sheet
      open={open}
      onClose={toLobby}
      closeLabel={t('gr.close')}
      kicker={exit ? t('gr.exitKicker', { room: roomName(room) }) : t('gr.kicker', { time: roundTime, room: roomName(room) })}
      title={<span className="g-roundover__title">{exit ? t('gr.exitTitle') : t('gr.title')}</span>}
      className={`g-sheet g-roundover${exit ? '' : ' has-board'}`}
      enterFrom={fromTill}
      footer={
        <>
          <Button variant="primary" size="lg" icon="ticket" onClick={nextRound} data-autofocus>
            {exit ? t('gr.newTicket') : t('gr.next')}
          </Button>
          <Button variant="secondary" size="lg" icon="menu" onClick={toLobby}>
            {t('gr.lobby')}
          </Button>
          {share && !exit && res?.stats?.finalRank && (
            <ShareOnX
              id={share.id}
              text={resultShareText(t, {
                rank: res.stats.finalRank,
                n: res.stats.finalOf ?? res.stats.finalRank,
                room: roomName(room),
                eaten: res.stats.eaten,
                eatenMore: res.stats.eatenMore,
                test: !!(share.test || room?.test),
              })}
            />
          )}
        </>
      }
    >
      <div className="g-roundover__body">
        <div className="g-roundover__slip">
          <Receipt
            printing
            onPrinted={() => setPrinted(true)}
            title={exit ? t('gr.receiptExit') : t('gr.receipt', { time: roundTime })}
            meta={`${date}${res?.stats ? ` · ${formatClock(res.stats.aliveMs)}` : ''}`}
            lines={lines}
            code={settled?.txHash ?? `pending-${since}`}
            footer={footer}
          />
          <AnimatePresence>
            {settled && printed && (
              <motion.div className="g-roundover__stamp" initial={false} exit={{ opacity: 0 }}>
                <Stamp text={t('gr.paid')} sub={activeChain().name.toUpperCase()} round size="md" tone="up" rotate={-12} animateIn={!reduced} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {usd && (
          <p className="g-roundover__usd mono" data-testid="gr-usd">
            {usd.text}
            {usd.setAt ? ` · ${t('usd.setAt', { time: usd.setAt })}` : ''}
            {usd.stale && <span className="g-roundover__stale">{usd.setAt ? t('usd.stale', { h: PRICE_STALE_HOURS }) : t('usd.staleUnknown')}</span>}
          </p>
        )}
        {!exit && <NextRoundOpens arenaId={room?.arenaId ?? null} className="g-roundover__break" />}
        <EatenNames eaten={res?.stats?.eaten} more={res?.stats?.eatenMore} />
        {settled?.collect && (
          <p className="g-roundover__note" role="status">
            {t('gr.collect')}
          </p>
        )}
        <p className="g-roundover__note mono">{exit ? t('gr.exitNote') : t('gr.feeNote', { pct: bpsToPercent(totalFeeBps(rates)), burn: bpsToPercent(rates.burnBps), vault: bpsToPercent(rates.vaultBps) })}</p>

        {!exit && <FinalBoard rows={standings} title={t('gr.board', { n: standings.length })} skin={mySkin} />}
      </div>
    </Sheet>
  );
}

/**
 * Start of the receipt's flight: the till on the HUD. A strip at that spot, as a motion target
 * relative to where the sheet settles (centred, or a bottom sheet).
 */
function receiptOrigin(): TargetAndTransition | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('.g-till');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bottom = window.matchMedia?.('(max-width: 639px)').matches === true;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  return { x: cx - vw / 2, y: bottom ? cy - vh * 0.62 : cy - vh / 2, scaleX: 0.24, scaleY: 0.08, rotate: -4, opacity: 1, '--lift': 0 };
}
