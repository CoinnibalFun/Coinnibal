import { formatCountdown, useRound } from '../../game/round';
import { useT } from '../../i18n';

/**
 * The break after an arena bell (joins closed while the payouts go out): "Next round opens in 0:27", ticking each
 * second, on the round's receipt. Nothing once the floor is open.
 */
export function NextRoundOpens({ arenaId = null, className = '' }: { arenaId?: number | null; className?: string }) {
  const t = useT();
  const round = useRound(arenaId);
  if (!round || round.breakMsLeft <= 0) return null;
  return (
    <p className={`g-break mono ${className}`.trim()} role="timer" aria-live="off" data-testid="next-round-opens">
      {t('gr.nextOpens', { t: formatCountdown(round.breakMsLeft) })}
    </p>
  );
}
