import { arenaMeta } from '@elymum/shared';
import { useEffect, useState } from 'react';
import { Button } from '../design';
import { useT } from '../i18n';
import { useUi } from '../store';
import { leavePaidSeat } from './invite';

/**
 * The lobby's note while a paid room's invite is open: the next ticket of its arena (bought or
 * resumed) is seated in that private room. Gone when the room's time is up or the player lets go.
 */
export function PaidSeatBanner() {
  const t = useT();
  const seat = useUi((s) => s.paidSeat);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!seat) return;
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [seat]);
  if (!seat || seat.endsAt <= now) return null;
  const minutes = Math.max(1, Math.ceil((seat.endsAt - now) / 60_000));
  return (
    <section className="kl-owed kl-seat" aria-labelledby="kl-seat-k" data-testid="paid-seat">
      <div className="kl-owed__slip">
        <div className="kl-owed__top">
          <span id="kl-seat-k" className="kl-owed__kicker mono">
            {t('cr.seat.kicker', { code: seat.code })}
          </span>
          <span className="kl-seat__left mono">{t('cr.seat.left', { n: minutes })}</span>
        </div>
        <p className="kl-owed__title">{t('cr.seat.title', { name: seat.name })}</p>
        <p className="kl-owed__note">{t('cr.seat.note', { arena: arenaMeta(seat.arenaId).name })}</p>
        <Button variant="ghost" size="sm" onClick={leavePaidSeat} data-testid="paid-seat-leave">
          {t('cr.seat.leave')}
        </Button>
      </div>
    </section>
  );
}
