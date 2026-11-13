import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../design';
import { engine } from '../../game/instance';
import { useT } from '../../i18n';
import { useUi, type ChatItem } from '../../store';

/** Lines on screen at most (the newest at the bottom). */
export const CHAT_LINES = 8;
/** A line stays this long (ms), then fades to transparent over `CHAT_FADE_MS`; with the chat line open the last lines stay. */
export const CHAT_SHOW_MS = 5_000;
export const CHAT_FADE_MS = 1_200;

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

/** The HUD pieces the chat must never cover (touch and small windows, where it stands on its own). */
const OBSTACLES = '.g-corner--tl, .g-corner--tr, .g-center > *, .g-under > *, .g-map, .g-rdock > *, .g-touch, .g-touch .g-boost, .g-touch__emotes, .g-stick, .g-dock, .g-spectate';

/**
 * The chat's free band in its column (pure on rects, tested): from `anchor` (its bottom edge as the CSS places it)
 * up to the lowest HUD piece hanging from the top (the top-left corner with the kill feed, a notice), each `gap` clear.
 * A piece standing on the bottom half that reaches into the column (the power-up row of a phone's thumb cluster)
 * lifts the bottom edge above it.
 */
export function freeBand(
  viewport: { w: number; h: number },
  column: { left: number; right: number },
  anchor: number,
  rects: readonly { top: number; bottom: number; left: number; right: number }[],
  gap = 10,
): { top: number; bottom: number } {
  let top = gap;
  let bottom = anchor;
  const mid = viewport.h * 0.55;
  for (const r of rects) {
    if (r.right <= column.left || r.left >= column.right || r.bottom <= r.top) continue;
    if ((r.top + r.bottom) / 2 < mid) top = Math.max(top, r.bottom + gap);
    else if (r.top < bottom + gap) bottom = Math.min(bottom, r.top - gap);
  }
  return { top, bottom: Math.max(top, bottom) };
}

/**
 * Whole lines only: the oldest lines that would not fit in `max` px (with the chat line, if open) step out, so the
 * top of the block never shows half a line cut through.
 */
function fitLines(el: HTMLElement, max: number) {
  const list = el.querySelector('.g-stream__lines');
  if (!list) return;
  const form = el.querySelector<HTMLElement>('.g-stream__form');
  let room = max - (form ? form.offsetHeight + 6 : 0);
  const lines = [...list.children] as HTMLElement[];
  for (const li of lines) li.classList.remove('is-cut');
  for (let i = lines.length - 1; i >= 0; i--) {
    room -= lines[i].offsetHeight + (i < lines.length - 1 ? 3 : 0);
    if (room < 0) lines[i].classList.add('is-cut');
  }
}

/**
 * The in-game chat at the bottom left (Twitch / Kick style): no panel, transparent, each line with a soft shadow so it
 * reads on any floor, coloured names, the newest at the bottom, at most `CHAT_LINES`; a line fades to transparent
 * `CHAT_SHOW_MS` after it came in. On a desktop it is `docked` in the bottom-left column between the kill feed and
 * the key hints; on touch screens and small windows it stands above the thumb stick (beside it on a landscape phone),
 * in the band the HUD pieces leave free (`freeBand`, measured live: under the top-left corner, over the power-up row),
 * so it never covers them. Enter (or the chat button) opens
 * the line under it, at the bottom left. Guests' lines stay muted; the server's scam filter and the chat setting apply
 * as before.
 */
export function ChatStream({ docked = false }: { docked?: boolean }) {
  const t = useT();
  const chat = useUi((s) => s.chat);
  const chatOpen = useUi((s) => s.chatOpen);
  const showChat = useUi((s) => s.settings.showChat);
  const [text, setText] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // re-render as lines age out (the fade itself is CSS)
  const newest = chat.at(-1)?.at ?? 0;
  useEffect(() => {
    if (chatOpen || Date.now() - newest > CHAT_SHOW_MS + CHAT_FADE_MS) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [newest, chatOpen]);
  useEffect(() => setNow(Date.now()), [chat]);
  useEffect(() => {
    if (chatOpen) inputRef.current?.focus();
  }, [chatOpen]);

  // standing on its own: the room above it (docked: its height cap), re-measured as the HUD moves (the feed grows, a notice, a resize)
  useLayoutEffect(() => {
    const el = ref.current;
    const hud = el?.closest('.g-hud');
    if (!el || !hud) return;
    const measure = () => {
      // docked in the desktop column: its CSS height cap, whole lines only
      if (docked) return fitLines(el, parseFloat(getComputedStyle(el).maxHeight) || Infinity);
      // the place the CSS gives it, from the offsets (the lift below is a transform: it does not move them)
      const at = hud.getBoundingClientRect();
      const left = at.left + el.offsetLeft;
      const anchor = at.top + el.offsetTop + el.offsetHeight;
      const rects: { top: number; bottom: number; left: number; right: number }[] = [...hud.querySelectorAll(OBSTACLES)]
        .filter((x) => !el.contains(x) && !x.contains(el))
        .map((x) => x.getBoundingClientRect());
      // my coin and its name tag in the middle of the screen: the chat stays under them, never over them
      const coin = engine()?.myCoinBox();
      if (coin) rects.push({ top: coin.top, bottom: coin.bottom + 6, left: coin.left, right: coin.right });
      const band = freeBand({ w: window.innerWidth, h: window.innerHeight }, { left, right: left + el.offsetWidth }, anchor, rects);
      const lift = Math.round(anchor - band.bottom);
      el.style.transform = lift > 0 ? `translateY(${-lift}px)` : '';
      const max = Math.floor(band.bottom - band.top);
      el.style.maxHeight = `${max}px`;
      fitLines(el, max);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(hud);
    for (const x of hud.querySelectorAll(OBSTACLES)) ro?.observe(x);
    // a piece coming or going (the power-up row, a notice, a new chat line): measured again on the next frame
    let raf = 0;
    const soon = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), measure()));
    };
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(soon) : null;
    mo?.observe(hud, { childList: true, subtree: true });
    const id = setInterval(measure, 1000);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      mo?.disconnect();
      cancelAnimationFrame(raf);
      clearInterval(id);
      window.removeEventListener('resize', measure);
    };
  }, [docked]);

  if (!showChat) return null;
  const lines = visibleLines(chat, now, chatOpen);
  const send = () => {
    engine()?.chat(text);
    setText('');
    useUi.setState({ chatOpen: false });
  };
  return (
    <div ref={ref} className={`g-stream${docked ? ' is-docked' : ''}${chatOpen ? ' is-open' : ''}`} data-testid="chat-stream">
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
