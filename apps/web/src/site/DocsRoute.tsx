import { TOKEN_SYMBOL_DEFAULT, type ChainStatus } from '@coinnibal/shared';
import { useEffect } from 'react';
import { SERVER } from '../config';
import { PlateLabel } from '../design';
import { useUi } from '../store';
import { DocsPage } from '../ui/docs/DocsPage';
import { useT } from '../i18n';
import { SitePage } from './Shell';

/**
 * `/docs`: the player guide, public, inside the site (no game engine). The fee rate comes from `/api/config`. The page
 * title is the page's h1, and amounts always say "tokens": a visitor page shows no ticker, whatever the server's
 * `TOKEN_SYMBOL` is (the lobby's guide keeps the server's symbol).
 */
export function DocsRoute() {
  const t = useT();
  useEffect(() => {
    let live = true;
    fetch(`${SERVER.http}/api/config`)
      .then((r) => (r.ok ? (r.json() as Promise<{ chain?: ChainStatus }>) : null))
      .then((c) => {
        if (live && c?.chain) useUi.setState({ chain: c.chain });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return (
    <SitePage className="st-docs">
      <PlateLabel numeral={8} title={t('site.docs.plate')} className="st-docs__plate" />
      <div className="st-page">
        <DocsPage headingLevel={1} symbol={TOKEN_SYMBOL_DEFAULT} later />
      </div>
    </SitePage>
  );
}
