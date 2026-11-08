import { eatenLabel, eatenLine, shareIntentUrl, xMention, type EatenName } from '@elymum/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { SERVER } from '../../config';
import { useReducedMotion } from '../../design';
import { useT, type TKey, type TVars } from '../../i18n';
import { useUi } from '../../store';
import { roomName } from './format';

/** The kill card's sticker stays on the HUD this long (ms). */
export const KILL_SHARE_MS = 8000;

/** The post ends on the game's coin (the copy itself carries no emoji). */
export const SHARE_COIN = '\u{1FA99}';

/** The public page of a share card (`/share/<id>`: its Open Graph image is what X shows). */
export const shareUrl = (id: string): string => `${SERVER.http}/share/${id}`;

/** The way into the game on this site (a post with no server card links here: X shows the site's own picture). */
export const siteLink = (): string => `${window.location.origin}/play`;

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

/**
 * The X post of a game with no card of its own (a death, an operator exit, a sheet whose card has not come yet): the
 * mass reached, the coins eaten and the room; TEST in a testnet test arena.
 */
export function gameShareText(t: Translate, g: { mass: number; eaten: number; room: string; test?: boolean }): string {
  const line = t('share.game', { mass: Math.floor(g.mass).toLocaleString('en-US'), eaten: g.eaten, room: g.room });
  return g.test ? `${line} ${t('share.test')}` : line;
}

/** The X post of the game in play (the HUD's button): my place when ranked, my mass, the coins eaten so far. */
export function liveShareText(t: Translate, g: { mass: number; rank: number; n: number; eaten: number; room: string; test?: boolean }): string {
  const mass = Math.floor(g.mass).toLocaleString('en-US');
  const line = g.rank > 0 && g.n > 0 ? t('share.live', { rank: g.rank, n: g.n, mass, eaten: g.eaten, room: g.room }) : t('share.liveMass', { mass, eaten: g.eaten, room: g.room });
  return g.test ? `${line} ${t('share.test')}` : line;
}

/**
 * A kill's coin as the sticker and the post name it: its linked X `@handle` (the server's record; linking is consent to
 * be tagged), else its cleaned name, with its BOT tag (test arenas only; bots never have a handle).
 */
export const victimLabel = (t: Translate, s: { victim?: string; victimIsBot?: boolean; victimX?: string }) =>
  (!s.victimIsBot && xMention(s.victimX)) || `${eatenLabel({ name: s.victim ?? '' })}${s.victimIsBot ? ` (${t('g.botTag')})` : ''}`;

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
            <bdi>{eatenLabel(e)}</bdi>
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
export function XMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="g-share__x">
      <path fill="currentColor" d="M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.9 3h6.4l4.4 5.8L17.8 3zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5z" />
    </svg>
  );
}

/**
 * "Share on X": opens X's web composer in a new tab with `text` (and the coin) and the card's link (no X API; nothing is posted
 * unless the player posts it). The server made the card from its own records (`share` message); with no card (`id`
 * null) the post links the site's way into the game.
 */
export function ShareOnX({ id, text, size = 'lg' }: { id: string | null; text: string; size?: 'md' | 'lg' }) {
  const t = useT();
  return (
    <a
      className={`kb-btn kb-btn--secondary kb-btn--${size} g-share`}
      href={shareIntentUrl(`${text} ${SHARE_COIN}`, id ? shareUrl(id) : siteLink())}
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
export function useShare(kind: 'round' | 'room' | 'kill'): { id: string; victim?: string; victimIsBot?: boolean; victimX?: string; test?: boolean; at: number } | null {
  return useUi((s) => (s.share && s.share.kind === kind ? s.share : null));
}

/**
 * The HUD's own "Share on X" (always there while playing, every room): the game as it stands, my place, mass and the
 * coins eaten so far, with the site's link. The line is read when the button is used, so the HUD does not re-render
 * with every bite. `label`: the word next to the mark (desktop); phones show the mark alone.
 */
export function HudShare({ label }: { label: boolean }) {
  const t = useT();
  const room = useUi((s) => s.room);
  const url = () => {
    const s = useUi.getState();
    const text = liveShareText(t, { mass: s.hud.mass, rank: s.hud.rank, n: s.hud.players, eaten: s.myEaten, room: roomName(s.room), test: !!s.room?.test });
    return shareIntentUrl(`${text} ${SHARE_COIN}`, siteLink());
  };
  // the href is refreshed as the pointer comes near and on the click itself (the browser reads it after the handler)
  const refresh = (e: { currentTarget: HTMLAnchorElement }) => {
    e.currentTarget.href = url();
  };
  return (
    <a
      className={`kb-iconbtn g-topbar__btn g-hudshare${label ? ' has-label' : ''}`}
      href={room ? url() : siteLink()}
      target="_blank"
      rel="noopener noreferrer"
      onPointerEnter={refresh}
      onFocus={refresh}
      onClick={refresh}
      aria-label={t('share.hudLabel')}
      title={t('share.hudLabel')}
      data-testid="hud-share"
    >
      <XMark size={18} />
      {label && <span className="g-hudshare__text">{t('share.button')}</span>}
    </a>
  );
}

/**
 * A kill (every person eaten; a practice bot in a test arena only): a sticker on the HUD for a few seconds,
 * "You ate Nakamoto!" with "Share on X".
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
