import type { CSSProperties } from 'react';
import { CoinCharacter, useOffscreenPause } from '../../design';
import { useMedia } from '../../design/useMedia';
import { useReveal } from './reveal';

/**
 * The end of the coin's day: the traveller, full after three bites, rolls onto the footer's ink line and falls asleep
 * on its side, three drawn z's drifting up. It lives at the bottom of the FAQ plate (the site footer is shared).
 * Pure decoration (aria-hidden, pointer-events none, no text). Rest state: asleep with three still z's; it rolls in
 * on its own trigger, and the z's loop only while it is on screen.
 */
export function NapSeam() {
  const phone = useMedia('(max-width: 639px)');
  const [ref, visible] = useOffscreenPause<HTMLDivElement>();
  useReveal(ref);
  const S = phone ? 52 : 96;
  return (
    <div ref={ref} className="ld-nap" aria-hidden="true" data-paused={!visible || undefined} style={{ '--nap': `${S}px` } as CSSProperties}>
      <span className="ld-nap__coin">
        <CoinCharacter paint="sun" mood="sleepy" size={S} blink={false} />
      </span>
      <svg className="ld-nap__z" viewBox="0 0 60 60" focusable="false">
        <path d="M2 44h9l-9 10h9" />
        <path d="M16 24h11l-11 12h11" />
        <path d="M32 0h13l-13 14h13" />
      </svg>
    </div>
  );
}
