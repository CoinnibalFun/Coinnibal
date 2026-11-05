import { EMOTE_BAR, emoteEmoji } from '@elymum/shared';
import { engine } from '../../game/instance';
import { useT, type TKey } from '../../i18n';

/** The emoji bar: eight emoji, keys 1-8 on desktop; on phones a tap grid. */
export function EmoteBar({ onPick, keys = true }: { onPick?: () => void; keys?: boolean }) {
  const t = useT();
  return (
    <ul className="g-emotes" aria-label={t('g.emotes')}>
      {EMOTE_BAR.map((id, i) => {
        const label = t(`g.emote.${id}` as TKey);
        return (
          <li key={id}>
            <button
              type="button"
              className="g-emote"
              onClick={() => {
                engine()?.emote(id);
                onPick?.();
              }}
              aria-label={label}
              title={keys ? `${label} · ${i + 1}` : label}
              aria-keyshortcuts={keys ? String(i + 1) : undefined}
            >
              <span className="g-emote__glyph" aria-hidden="true">
                {emoteEmoji(id)}
              </span>
              {keys && <span className="g-emote__key mono">{i + 1}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
