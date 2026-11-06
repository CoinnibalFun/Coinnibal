import { eatenLine, shareIntentUrl, shareName, type EatenName } from '@elymum/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { SERVER } from '../../config';
import { useReducedMotion } from '../../design';
import { useT, type TKey, type TVars } from '../../i18n';
import { useUi } from '../../store';

/** The kill card's sticker stays on the HUD this long (ms). */
export const KILL_SHARE_MS = 8000;

/** The post ends on the game's coin (the copy itself carries no emoji). */
export const SHARE_COIN = '\u{1FA99}';

/** The public page of a share card (`/share/<id>`: its Open Graph image is what X shows). */
export const shareUrl = (id: string): string => `${SERVER.http}/share/${id}`;

type Translate = (key: TKey, vars?: TVars) => string;

/**
 * The X post of a result: my place, the coins I ate (the first few, then "+N"; names cleaned by `shareName`: no
 * address, mention, hashtag or link), and TEST for a testnet test arena.
 */
export function resultShareText(t: Translate, r: { rank: number; n: number; room: string; eaten?: readonly EatenName[]; eatenMore?: number; test?: boolean }): string {
  const names = eatenLine(r.eaten ?? [], r.eatenMore ?? 0, t('g.botTag'));
  const line = names ? t('share.resultAte', { rank: r.rank, n: r.n, room: r.room, names }) : t('share.result', { rank: r.rank, n: r.n, room: r.room });
  return r.test ? `${line} ${t('share.test')}` : line;
}

/** A kill's coin as the sticker and the post name it: cleaned, with its BOT tag (test arenas only). */
const victimLabel = (t: Translate, s: { victim?: string; victimIsBot?: boolean }) => `${shareName(s.victim ?? '')}${s.victimIsBot ? ` (${t('g.botTag')})` : ''}`;

/** The coins I ate this game, on a result sheet: name chips (BOT tagged, ×2 when eaten twice) and "+N more". */
export function EatenNames({ eaten, more = 0 }: { eaten?: readonly EatenName[]; more?: number }) {
  const t = useT();
  const list = eaten ?? [];
  if (list.length === 0 && more <= 0) return null;
  return (
    <div className="g-eaten" data-testid="eaten">
      <span className="g-eaten__label mono">{t('share.eaten')}</span>
      <ul className="g-eaten__list">
        {list.map((e, i) => (
          <li key={i} className="g-eaten__name">
            <bdi>{shareName(e.name)}</bdi>
            {e.bot && <span className="g-eaten__tag mono">{t('g.botTag')}</span>}
            {(e.n ?? 1) > 1 && <span className="g-eaten__n mono">×{e.n}</span>}
          </li>
        ))}
        {more > 0 && <li className="g-eaten__more mono">{t('share.more', { n: more })}</li>}
      </ul>
    </div>
  );
}

/** X's mark (the letter), drawn: no icon font needed. */
function XMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="g-share__x">
      <path fill="currentColor" d="M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.9 3h6.4l4.4 5.8L17.8 3zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5z" />
    </svg>
  );
}

/**
 * "Share on X": opens X's web composer in a new tab with `text` (and the coin) and the card's link (no X API; nothing is posted
 * unless the player posts it). The server made the card from its own records (`share` message).
 */
export function ShareOnX({ id, text, size = 'lg' }: { id: string; text: string; size?: 'md' | 'lg' }) {
  const t = useT();
  return (
    <a
      className={`kb-btn kb-btn--secondary kb-btn--${size} g-share`}
      href={shareIntentUrl(`${text} ${SHARE_COIN}`, shareUrl(id))}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="share-x"
    >
      <span className="kb-btn__label">
        <span className="kb-btn__text">{t('share.button')}</span>
      </span>
      <XMark size={size === 'lg' ? 22 : 18} />
    </a>
  );
}

/** The share card of this kind that arrived for the result on screen (null until the server sent it). */
export function useShare(kind: 'round' | 'room' | 'kill'): { id: string; victim?: string; victimIsBot?: boolean; test?: boolean; at: number } | null {
  return useUi((s) => (s.share && s.share.kind === kind ? s.share : null));
}

/**
 * A notable kill (eating a big coin): a sticker on the HUD for a few seconds, "You ate Nakamoto!" with "Share on X".
 */
export function KillShare() {
  const t = useT();
  const share = useShare('kill');
  const reduced = useReducedMotion();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!share) return;
    const left = share.at + KILL_SHARE_MS - Date.now();
    if (left <= 0) return;
    const id = setTimeout(() => setNow(Date.now()), left + 10);
    return () => clearTimeout(id);
  }, [share]);
  const on = !!share && now < share.at + KILL_SHARE_MS && Date.now() < share.at + KILL_SHARE_MS;
  return (
    <AnimatePresence>
      {on && share && (
        <motion.div
          key={share.id}
          className="g-killshare"
          role="status"
          data-testid="kill-share"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, rotate: -2 }}
          animate={{ opacity: 1, y: 0, rotate: -1 }}
          exit={{ opacity: 0 }}
        >
          <strong className="g-killshare__title">
            {t('share.ate', { name: victimLabel(t, share) })}
            {share.test && <span className="g-test-tag mono">TEST</span>}
          </strong>
          <ShareOnX id={share.id} text={`${t('share.kill', { name: victimLabel(t, share) })}${share.test ? ` ${t('share.test')}` : ''}`} size="md" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
