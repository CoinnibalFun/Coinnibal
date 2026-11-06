import { useEffect, useState } from 'react';
import { Button, CoinCharacter, StampSpinner } from '../../design';
import { engine } from '../../game/instance';
import { useT } from '../../i18n';
import { useUi } from '../../store';
import './connection.css';

/** A drop shorter than this (a quick reconnect) shows nothing: no flash on every blip. */
export const BANNER_DELAY_MS = 700;

/** Whole seconds until `at` (`performance.now()` clock), at least 0. */
export const secondsUntil = (at: number | null, now: number): number => (at === null ? 0 : Math.max(0, Math.ceil((at - now) / 1000)));

/**
 * The game server's socket is down. During play a blocking banner ("Connection lost, reconnecting… your coin is
 * still in the arena") with the attempt and its countdown, and a "Retry now"; inputs go nowhere meanwhile, so the
 * banner takes them. `replaced` (the same wallet opened the game in another tab or window, which took the coin over):
 * no reconnect loop, a choice instead ("Play here" takes it back).
 */
export function ConnectionBanner() {
  const t = useT();
  const down = useUi((s) => s.netDown);
  const screen = useUi((s) => s.screen);
  const arena = useUi((s) => s.room?.mode === 'arena' && (s.screen === 'playing' || s.screen === 'dead'));
  const [shown, setShown] = useState(false);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (!down) {
      setShown(false);
      return;
    }
    if (down.kind === 'replaced') {
      setShown(true);
      return;
    }
    const id = setTimeout(() => setShown(true), BANNER_DELAY_MS);
    return () => clearTimeout(id);
  }, [down]);

  useEffect(() => {
    if (!shown || down?.kind !== 'lost') return;
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, [shown, down]);

  if (!down || !shown) return null;
  // the lobby says "connecting" in its own status line; the banner is for a game in play (and for a takeover)
  if (down.kind === 'lost' && screen === 'lobby') return null;

  if (down.kind === 'replaced') {
    return (
      <div className="g-conn is-replaced" role="alertdialog" aria-modal="true" aria-labelledby="g-conn-h" aria-describedby="g-conn-b" data-testid="net-replaced">
        <div className="g-conn__card">
          <CoinCharacter paint="cyan" mood="sleepy" size={64} />
          <h2 id="g-conn-h" className="g-conn__title">
            {t('net.replaced')}
          </h2>
          <p id="g-conn-b" className="g-conn__body">
            {t('net.replacedBody')}
          </p>
          <div className="g-conn__actions">
            <Button variant="primary" icon="play" onClick={() => engine()?.reconnect()}>
              {t('net.playHere')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const s = secondsUntil(down.retryAt, now);
  return (
    <div className="g-conn" role="alertdialog" aria-modal="true" aria-labelledby="g-conn-h" data-testid="net-lost">
      <div className="g-conn__card" role="status" aria-live="polite">
        <span className="g-conn__spin" aria-hidden="true">
          <StampSpinner size="md" />
        </span>
        <h2 id="g-conn-h" className="g-conn__title">
          {arena ? t('net.lostArena') : t('net.lost')}
        </h2>
        <p className="g-conn__body mono">{s > 0 ? t('net.retryIn', { n: down.attempt, s }) : t('net.retrying', { n: down.attempt })}</p>
        <div className="g-conn__actions">
          <Button variant="secondary" size="sm" onClick={() => engine()?.reconnect()} disabled={s === 0}>
            {t('net.retryNow')}
          </Button>
        </div>
      </div>
    </div>
  );
}
