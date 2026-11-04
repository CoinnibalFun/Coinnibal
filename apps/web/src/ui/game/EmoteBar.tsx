import { EMOTE_SETS, emotesOf } from '@elymum/shared';
import { engine } from '../../game/instance';
import { useT, type TKey } from '../../i18n';
import { setEmoteSet, useUi } from '../../store';
import { stickerUrl } from './stickers';

/**
 * Sticker sheet: two pages of eight die-cut stickers, "Hype" and "Trash talk", behind a small
 * switch (desktop: key 9 flips it). Keys 1-8 fire the page on show; on phones it is a tap grid.
 */
export function EmoteBar({ onPick, keys = true }: { onPick?: () => void; keys?: boolean }) {
  const t = useT();
  const set = useUi((s) => s.emoteSet);
  return (
    <ul className="g-emotes" aria-label={t('g.emotes')} data-set={set}>
      <li className="g-emotes__pages" role="group" aria-label={t('g.emotes.sets')}>
        {EMOTE_SETS.map((s) => (
          <button
            key={s}
            type="button"
            className={`g-emotes__page${s === set ? ' is-on' : ''}`}
            aria-pressed={s === set}
            onClick={() => setEmoteSet(s)}
            title={keys ? `${t(`g.emotes.${s}`)} · 9` : undefined}
            data-testid={`emote-page-${s}`}
          >
            {t(`g.emotes.${s}`)}
          </button>
        ))}
      </li>
      {emotesOf(set).map((e, i) => {
        const label = t(`g.emote.${e.id}` as TKey);
        return (
          <li key={e.id}>
            <button
              type="button"
              className="g-emote"
              onClick={() => {
                engine()?.emote(e.id);
                onPick?.();
              }}
              aria-label={label}
              title={keys ? `${label} · ${i + 1}` : label}
              aria-keyshortcuts={keys ? String(i + 1) : undefined}
            >
              <img src={stickerUrl(e.id)} alt="" width={40} height={40} draggable={false} />
              {keys && <span className="g-emote__key mono">{i + 1}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
