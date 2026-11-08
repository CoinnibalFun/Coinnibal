import { lookForSkin as lookForBasicSkin } from '../../render/looks';
import { AnimatePresence, motion } from 'motion/react';
import { Fragment, useRef, useState, type ReactNode } from 'react';
import { usePreset, useReducedMotion } from '../../design';
import { BotTag } from './BotTag';
import { useT, type TKey } from '../../i18n';
import { useUi, type KillItem } from '../../store';
import { useIdleFade } from './fade';

/** A skin's paint as a tiny inked coin. */
function InkDot({ skin }: { skin: number }) {
  const look = lookForBasicSkin(skin);
  return <span className="g-dot" aria-hidden="true" style={{ ['--dot' as string]: look.body }} />;
}

/** The feed's wry ways of saying "ate" (picked by the event id, so a line never changes its mind). */
const EAT_LINES: readonly TKey[] = ['g.kill.0', 'g.kill.1', 'g.kill.2', 'g.kill.3'];

/** One kill as a sentence: the killer and the victim keep their dots; "you" is printed in sun. */
function KillLine({ k, myName }: { k: KillItem; myName: string | null }) {
  const t = useT();
  const key = k.cause === 'left' ? 'g.wentHome' : k.cause === 'virus' ? 'g.kill.cactus' : EAT_LINES[k.id % EAT_LINES.length];
  const who = (name: string, skin: number, bot: boolean | undefined, mark: string) => {
    const me = myName !== null && name === myName && !bot;
    return (
      <b className={me ? 'is-me' : undefined} key={mark}>
        <InkDot skin={skin} />
        <span className="g-kill__nm" title={me ? undefined : name}>
          {me ? t('g.youName') : name}
        </span>
        {bot && <BotTag />}
      </b>
    );
  };
  // the sentence comes from the copy with two markers for the names
  const text = t(key as 'g.kill.0', { k: '\u0001', v: '\u0002' });
  const parts: ReactNode[] = text.split(/(\u0001|\u0002)/).map((p, i) => {
    if (p === '\u0001') return who(k.killer, k.killerSkin, k.killerIsBot, `k${i}`);
    if (p === '\u0002') return who(k.victim, k.victimSkin, k.victimIsBot, `v${i}`);
    return <Fragment key={i}>{p}</Fragment>;
  });
  return <>{parts}</>;
}

/**
 * The kill feed under the timer: kills as small ink strips with a wry verb (the chat is its own stream on the right
 * edge, `ChatStream`). `narrow` keeps fewer lines. A few seconds after the last new line the area fades to
 * semi-transparent (`useIdleFade`) so it does not cover the floor; the pointer over it, a tap on it or a new line
 * bring it back.
 */
export function Feed({ narrow }: { narrow: boolean; fold?: boolean }) {
  const t = useT();
  const killfeed = useUi((s) => s.killfeed);
  const myName = useUi((s) => s.me?.name ?? null);
  const reduced = useReducedMotion();
  const spring = usePreset('press', { fade: true });
  const [hover, setHover] = useState(false);
  const [poke, setPoke] = useState(0);
  // only a NEW line wakes the area (kill lines also leave by themselves after a few seconds)
  const seen = useRef({ kill: -1, n: 0 });
  const newestKill = killfeed.at(-1)?.id ?? -1;
  if (newestKill > seen.current.kill) seen.current = { kill: newestKill, n: seen.current.n + 1 };
  const faded = useIdleFade(`${seen.current.n}:${poke}`, hover);
  const kills = narrow ? killfeed.slice(-2) : killfeed.slice(-5);
  return (
    <div
      className={`g-feed${faded ? ' is-faded' : ''}`}
      aria-label={t('g.feed')}
      role="log"
      aria-live="polite"
      data-testid="feed"
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={() => setPoke((n) => n + 1)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <ul className="g-kills">
        <AnimatePresence initial={false}>
          {kills.map((k) => (
            <motion.li
              key={k.id}
              className="g-kill mono"
              initial={reduced ? { opacity: 0 } : { opacity: 0, x: -18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={spring}
            >
              <KillLine k={k} myName={myName} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
