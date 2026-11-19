import type { ReactNode } from 'react';
import './PageHead.css';

/**
 * A section front: mono kicker, a display headline, an optional deck and a
 * slot on the right (counters, edition line), over a thick rule. `as`: the headline's level, `h2` inside the lobby
 * and `h1` where it is the page's own title (`/docs`).
 */
export function PageHead({ kicker, title, deck, aside, id, as: Tag = 'h2' }: { kicker: string; title: ReactNode; deck?: ReactNode; aside?: ReactNode; id?: string; as?: 'h1' | 'h2' }) {
  return (
    <header className="pg-head">
      <div className="pg-head__text">
        <span className="pg-head__kicker mono">{kicker}</span>
        <Tag className="pg-head__title" id={id}>
          {title}
        </Tag>
        {deck && <p className="pg-head__deck">{deck}</p>}
      </div>
      {aside && <div className="pg-head__aside">{aside}</div>}
    </header>
  );
}
