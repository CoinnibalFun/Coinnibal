import type { RoundStanding } from '@elymum/shared';
import { useT } from '../../i18n';
import { BotTag } from './BotTag';
import { CoinPortrait } from './CoinPortrait';
import { ordinal, useTokenFormat } from './format';

/** My place on a final board: `ordinal(rank)` when my row is on it, else "outside the top n", else a dash. */
export function boardPlace(rows: readonly RoundStanding[], outside: (n: number) => string): string {
  const mine = rows.find((s) => s.you);
  if (mine) return ordinal(mine.rank);
  return rows.length > 0 ? outside(rows.length) : '—';
}

/**
 * The final standings of a room that ended, the same for an arena's bell and a custom room's end: my place on a sun
 * sticker, then the whole board (rank, name with its BOT / You tags, mass, kills and, in arenas, the payout at the
 * bell) in a scrolling list. My row is highlighted and pinned to the list's top or bottom edge while it is scrolled
 * out of view, so I always see where I finished.
 */
export function FinalBoard({ rows, title, skin }: { rows: readonly RoundStanding[]; title: string; skin: number }) {
  const t = useT();
  const tf = useTokenFormat();
  const shown = rows;
  const value = rows.some((s) => s.value !== undefined);
  return (
    <section className="g-board" aria-label={title}>
      <div className="g-board__landing">
        <CoinPortrait skin={skin} size={76} expression="happy" seed={5} className="g-board__coin" />
        <dl className="g-board__place">
          <dt className="mono">{t('gr.place')}</dt>
          <dd>{boardPlace(rows, (n) => t('gr.placeOut', { n }))}</dd>
        </dl>
      </div>
      <h3 className="g-board__title mono">{title}</h3>
      <div className={`g-board__head mono${value ? ' has-value' : ''}`} aria-hidden="true">
        <span>#</span>
        <span>{t('gr.nameCol')}</span>
        <span>{t('gr.mass')}</span>
        <span>{t('gr.kills')}</span>
        {value && <span>{t('gr.payoutCol')}</span>}
      </div>
      <ol className="g-board__list" data-testid="final-board" tabIndex={0} aria-label={title}>
        {shown.map((s) => (
          <li key={`${s.rank}-${s.name}`} className={`g-board__row${value ? ' has-value' : ''}${s.you ? ' is-me' : ''}`} aria-current={s.you ? 'true' : undefined}>
            <span className="g-board__rank num">{String(s.rank).padStart(2, '0')}</span>
            <span className="g-board__name">
              <span className="g-board__nm" title={s.name}>
                {s.name}
              </span>
              {s.isBot && <BotTag />}
              {s.you && <span className="g-you mono">{t('gr.you')}</span>}
            </span>
            <span className="g-board__num num" aria-label={`${t('gr.mass')} ${s.mass}`}>
              {s.mass.toLocaleString('en-US')}
            </span>
            <span className="g-board__num num" aria-label={`${t('gr.kills')} ${s.kills}`}>
              {s.kills}
            </span>
            {value && <span className="g-board__value num">{s.value !== undefined ? tf.fmt(s.value, { compact: true, maxFrac: 1 }) : '—'}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
