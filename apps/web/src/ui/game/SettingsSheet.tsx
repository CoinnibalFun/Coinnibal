import { Icon, Sheet } from '../../design';
import { openBrief } from '../../game/brief';
import { roundMinutes } from '../../game/round';
import { useT, type TKey } from '../../i18n';
import { closeModal, useUi } from '../../store';
import { CountryPicker } from '../profile/CountryPicker';
import { SettingsPage } from '../profile/SettingsPage';

/** Settings as a sheet (masthead gear, in-game top bar): the flag first, then plain labels and controls. */
export function SettingsSheet() {
  const t = useT();
  const open = useUi((st) => st.modal === 'settings');
  return (
    <Sheet open={open} onClose={closeModal} closeLabel={t('gs.close')} title={t('gs.title')} className="g-sheet g-settings">
      <CountryPicker className="g-settings__country" />
      <SettingsPage />
    </Sheet>
  );
}

const HOWTO: { icon: Parameters<typeof Icon>[0]['name']; key: TKey }[] = [
  { icon: 'arrow', key: 'howto.move' },
  { icon: 'coin', key: 'howto.eat' },
  { icon: 'split', key: 'howto.split' },
  { icon: 'eject', key: 'howto.eject' },
  { icon: 'flame', key: 'howto.cactus' },
  { icon: 'emote', key: 'howto.powerups' },
  { icon: 'payout', key: 'howto.stakes' },
];

/** How to play: numbered lines with drawn icons (no emoji). */
export function HowToSheet() {
  const t = useT();
  const open = useUi((st) => st.modal === 'howto');
  const rooms = useUi((st) => st.rooms);
  const room = useUi((st) => st.room);
  // the real round length (the server may run shorter rounds)
  const min = roundMinutes(rooms, room);
  return (
    <Sheet open={open} onClose={closeModal} closeLabel={t('lo.close')} kicker={t('st.kicker')} title={t('howto.title')} className="g-sheet g-howto">
      <ol className="g-howto__list">
        {HOWTO.map((h, i) => (
          <li key={h.key}>
            <span className="g-howto__n mono" aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <Icon name={h.icon} size={22} className="g-howto__icon" />
            <span>{t(h.key, { min })}</span>
          </li>
        ))}
      </ol>
      <p className="g-howto__keys mono">{t('lobby.keys')}</p>
      <button
        type="button"
        className="kl-link mono g-howto__brief"
        onClick={() => {
          closeModal();
          openBrief('again');
        }}
      >
        {t('howto.brief')}
      </button>
    </Sheet>
  );
}
