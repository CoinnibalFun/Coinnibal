import { CoinCharacter, PlateLabel, Sticker, useReducedMotion } from '../design';
import { useT, type TKey } from '../i18n';
import { SiteLinkButton, SitePage, XIcon } from './Shell';
import { useSiteSettings, xProfile } from './settings';
import './closed.css';

/** The sentence of each page that can be closed in `/admin`, Settings. */
const WHAT: Record<string, TKey> = {
  '/mint': 'site.closed.mint',
  '/faucet': 'site.closed.faucet',
  '/collab': 'site.closed.collab',
};

/**
 * A page the admin has not opened yet (`/mint`, `/faucet`, `/collab`): one sentence, the way home, the guide and
 * the project's X account. Nothing here links to another closed part of the site.
 */
export function ClosedPage({ path }: { path: string }) {
  const t = useT();
  const reduced = useReducedMotion();
  const { settings } = useSiteSettings();
  return (
    <SitePage className="cl-root">
      <PlateLabel numeral="·" title={t('site.closed.plate')} aside={path} />
      <section className="cl" aria-labelledby="cl-title" data-testid="closed-page">
        <div className="cl__art" aria-hidden="true">
          <Sticker tone="sun" pad="sm" tilt={-4} lift="md" className="cl__sign">
            <span className="mono">{t('site.closed.sign')}</span>
          </Sticker>
          <CoinCharacter paint="cream" mood="sleepy" size={120} feet ground bob={!reduced} />
        </div>
        <Sticker tone="cream" pad="lg" lift="lg" round="lg" className="cl__card">
          <p className="kicker">{t('site.closed.kicker')}</p>
          <h1 className="cl__title" id="cl-title">
            {t('site.closed.title')}
          </h1>
          <p className="cl__lede">{t(WHAT[path] ?? 'site.closed.page')}</p>
          <div className="cl__ctas">
            <SiteLinkButton href="/docs" variant="primary" icon="arrow">
              {t('site.nf.guide')}
            </SiteLinkButton>
            <SiteLinkButton href="/">{t('site.nf.home')}</SiteLinkButton>
          </div>
          <a className="cl__x" href={xProfile(settings.xHandle)} target="_blank" rel="noreferrer">
            <XIcon size={16} /> <span>{t('pg.follow')}</span>
          </a>
        </Sticker>
      </section>
    </SitePage>
  );
}

/** The owner's own view of a page that visitors do not see yet: a small tag over the real page. */
export function AdminPreviewTag() {
  const t = useT();
  return (
    <p className="cl-preview mono" role="note" data-testid="admin-preview">
      {t('site.closed.preview')}
    </p>
  );
}
