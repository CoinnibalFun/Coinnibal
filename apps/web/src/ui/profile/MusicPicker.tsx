import { useId, type KeyboardEvent } from 'react';
import type { MusicChoice } from '../../audio/tracks';
import { useT, type TKey } from '../../i18n';
import { updateSettings, useUi } from '../../store';

type Option = MusicChoice | 'off';

const OPTIONS: { id: Option; name: TKey }[] = [
  { id: 'classic', name: 'gs.track.classic' },
  { id: 'chill', name: 'gs.track.chill' },
  { id: 'arcade', name: 'gs.track.arcade' },
  { id: 'chiptune', name: 'gs.track.chiptune' },
  { id: 'lofi', name: 'gs.track.lofi' },
  { id: 'off', name: 'gs.track.off' },
];

/** The option the settings stand for: "No music" is the switch. */
export function selectedOption(musicOn: boolean, track: MusicChoice): Option {
  return musicOn ? track : 'off';
}

/**
 * The soundtrack picker (settings, lobby and room alike): a radio group of little tickets, the
 * picked one in sun with a hard shadow. Picking cross-fades at once (that is the preview).
 */
export function MusicPicker({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  const s = useUi((st) => st.settings);
  const labelId = useId();
  const current = selectedOption(s.musicOn, s.musicTrack);

  const choose = (id: Option) => {
    if (id === 'off') return updateSettings({ musicOn: false });
    updateSettings({ musicTrack: id, musicOn: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    // from the focused ticket
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.track;
    const from = OPTIONS.some((o) => o.id === focused) ? focused : current;
    const i = OPTIONS.findIndex((o) => o.id === from);
    const next = OPTIONS[(i + step + OPTIONS.length) % OPTIONS.length];
    const btn = e.currentTarget.querySelector<HTMLButtonElement>(`[data-track="${next.id}"]`);
    btn?.focus();
    choose(next.id);
  };

  return (
    <div className="gs-music">
      <span className="gs-label">
        <span className="g-set__label" id={labelId}>
          {t('gs.music')}
        </span>
      </span>
      <div className="gs-tracks" role="radiogroup" aria-labelledby={labelId} onKeyDown={onKeyDown}>
        {OPTIONS.map((o) => {
          const on = current === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-track={o.id}
              className={`gs-track${on ? ' is-on' : ''}${o.id === 'off' ? ' is-off' : ''}`}
              disabled={disabled}
              onClick={() => choose(o.id)}
            >
              <span className="gs-track__name">{t(o.name)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
