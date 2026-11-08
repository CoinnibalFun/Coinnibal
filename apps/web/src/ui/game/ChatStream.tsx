import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../design';
import { engine } from '../../game/instance';
import { useT } from '../../i18n';
import { useUi, type ChatItem } from '../../store';

/** Lines on screen at most (the newest at the bottom). */
export const CHAT_LINES = 8;
/** A line stays this long (ms), then fades out over `CHAT_FADE_MS`; with the chat line open the last lines stay. */
export const CHAT_SHOW_MS = 12_000;
export const CHAT_FADE_MS = 2_500;

/** System lines are UI chrome: no emoji there; player text stays as typed. */
const stripEmoji = (s: string) =>
  s
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

/** A bright, readable colour per name (the same name keeps its colour), like a stream chat (pure, tested). */
export function nameColor(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return `hsl(${(h >>> 0) % 360} 85% 70%)`;
}

/** The lines to show at `now`: the newest `CHAT_LINES`, without the ones that faded out (all of them while typing). */
export function visibleLines(chat: readonly ChatItem[], now: number, open: boolean): ChatItem[] {
  const last = chat.slice(-CHAT_LINES);
  return open ? last : last.filter((c) => now - c.at < CHAT_SHOW_MS + CHAT_FADE_MS);
}

/** The HUD pieces the chat must never cover. */
const OBSTACLES = '.g-corner--tr, .g-center > *, .g-map, .g-boosts, .g-boosts-dock, .g-touch, .g-touch__emotes, .g-stick, .g-dock, .g-spectate';

/**
 * The free band of the right edge between the HUD's pieces (standings, worth, minimap, power-ups, thumb cluster):
 * the chat's top and bottom insets, measured from the layout (pure on rects, tested).
 */
export function freeBand(
  viewport: { w: number; h: number },
  column: { left: number; right: number },
  rects: readonly { top: number; bottom: number; left: number; right: number }[],
  gap = 10,
): { top: number; bottom: number } {
  let top = gap;
  let bottom = viewport.h - gap;
  const mid = viewport.h * 0.55;
  for (const r of rects) {
    if (r.right <= column.left || r.left >= column.right || r.bottom <= r.top) continue;
    // a piece hanging from the top pushes the band down; one standing on the bottom pushes it up
    if ((r.top + r.bottom) / 2 < mid) top = Math.max(top, r.bottom + gap);
    else bottom = Math.min(bottom, r.top - gap);
  }
  return { top, bottom: Math.max(top, bottom) };
}

/**
 * The in-game chat as a stream overlay on the right edge (Twitch / Kick style): no panel, each line outlined so it
 * reads on any floor, coloured names, the newest at the bottom, at most `CHAT_LINES`, each fading out after a while.
 * It sits in the free band between the standings and worth above and the minimap, power-ups and thumb cluster below,
 * measured live, so it never covers them. Enter (or the chat button) opens the line under it. Guests' lines stay
 * muted; the server's scam filter and the chat setting apply as before.
 */
export function ChatStream() {
  const t = useT();
  const chat = useUi((s) => s.chat);
  const chatOpen = useUi((s) => s.chatOpen);
  const showChat = useUi((s) => s.settings.showChat);
  const [text, setText] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [band, setBand] = useState<{ top: number; bottom: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // re-render as lines age out (a second is fine for a fade of 2.5 s done by CSS)
  const newest = chat.at(-1)?.at ?? 0;
  useEffect(() => {
    if (chatOpen || Date.now() - newest > CHAT_SHOW_MS + CHAT_FADE_MS) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [newest, chatOpen]);
  useEffect(() => setNow(Date.now()), [chat]);
  useEffect(() => {
    if (chatOpen) inputRef.current?.focus();
  }, [chatOpen]);

  // the free band of the right edge, re-measured as the HUD moves (standings grow, the minimap, a resize)
  useLayoutEffect(() => {
    const el = ref.current;
    const hud = el?.closest('.g-hud');
    if (!el || !hud) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const rects = [...hud.querySelectorAll(OBSTACLES)].filter((x) => !el.contains(x) && !x.contains(el)).map((x) => x.getBoundingClientRect());
      const next = freeBand({ w: window.innerWidth, h: window.innerHeight }, { left: box.left, right: box.right }, rects);
      setBand((b) => (b && b.top === next.top && b.bottom === next.bottom ? b : next));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(hud);
    for (const x of hud.querySelectorAll(OBSTACLES)) ro?.observe(x);
    const id = setInterval(measure, 1000);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      clearInterval(id);
      window.removeEventListener('resize', measure);
    };
  }, []);

  if (!showChat) return null;
  const lines = visibleLines(chat, now, chatOpen);
  const send = () => {
    engine()?.chat(text);
    setText('');
    useUi.setState({ chatOpen: false });
  };
  const style = band ? { top: band.top, height: Math.max(0, band.bottom - band.top) } : undefined;
  return (
    <div ref={ref} className={`g-stream${chatOpen ? ' is-open' : ''}`} style={style} data-testid="chat-stream">
      <ol className="g-stream__lines" role="log" aria-live="polite" aria-label={t('g.chat')}>
        {lines.map((c) => {
          const age = now - c.at;
          // the fade is CSS: a line already past its time starts faded part-way
          const delay = chatOpen ? 0 : Math.max(0, CHAT_SHOW_MS - age);
          return (
            <li
              key={c.id}
              className={`g-stream__line${c.system ? ' is-system' : c.guest ? ' is-guest' : ''}${chatOpen ? '' : ' is-fading'}`}
              style={chatOpen ? undefined : { animationDelay: `${delay}ms`, animationDuration: `${CHAT_FADE_MS}ms` }}
            >
              {!c.system && (
                <b className="g-stream__name" style={c.guest ? undefined : { color: nameColor(c.from) }}>
                  {c.from}
                  {c.guest && <span className="g-stream__guest mono">{t('g.chatGuest')}</span>}
                </b>
              )}
              <span className="g-stream__text">{c.system ? stripEmoji(c.text) : c.text}</span>
            </li>
          );
        })}
      </ol>
      {chatOpen && (
        <form
          className="g-stream__form"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            ref={inputRef}
            className="g-chat__input"
            value={text}
            maxLength={100}
            placeholder={t('hud.chat')}
            aria-label={t('g.chat')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') useUi.setState({ chatOpen: false });
              e.stopPropagation();
            }}
            onBlur={() => useUi.setState({ chatOpen: false })}
          />
          <button type="submit" className="kb-iconbtn kb-iconbtn--sm g-chat__send" aria-label={t('g.chatSend')} onMouseDown={(e) => e.preventDefault()}>
            <Icon name="arrow" size={18} />
          </button>
        </form>
      )}
    </div>
  );
}
