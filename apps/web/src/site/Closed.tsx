import type { ReactNode } from 'react';
import { CoinCharacter, Sticker, useReducedMotion } from '../design';
import { useT, type TKey } from '../i18n';
import { SiteLinkButton, SitePage, XIcon } from './Shell';
import { useSiteSettings, xProfile } from './settings';
import './closed.css';

/**
 * The sentence of each page that can be closed in `/admin`, Settings. Any other closed path (the faucet, hidden from
 * visitors) gets the neutral line and is not named anywhere on its page.
 */
const WHAT: Record<string, TKey> = {
  '/mint': 'site.closed.mint',
  '/collab': 'site.closed.collab',
};

/** The heading of each such page: it says what is not open (the neutral page says only that). */
const TITLE: Record<string, TKey> = {
  '/mint': 'site.closed.titleMint',
  '/collab': 'site.closed.titleCollab',
};

/**
 * The shared "not open yet" notice: a sleepy coin with a "Closed" tag on a cream card, its heading, one sentence,
 * the guide, the way home and the project's X account (`children`: anything a page adds under them, inside the card).
 * One label: the heading (no title strip above the page). Nothing here links to another closed part of the site.
 */
export function ClosedNotice({ title, lede, children }: { title: ReactNode; lede: ReactNode; children?: ReactNode }) {
  const t = useT();
  const reduced = useReducedMotion();
  const { settings } = useSiteSettings();
  return (
    <section className="cl" aria-labelledby="cl-title" data-testid="closed-page">
      <div className="cl__art" aria-hidden="true">
        <Sticker tone="sun" pad="sm" tilt={-4} lift="md" className="cl__sign">
          <span className="mono">{t('site.closed.sign')}</span>
        </Sticker>
        <CoinCharacter paint="cream" mood="sleepy" size={120} feet ground bob={!reduced} />
      </div>
      <Sticker tone="cream" pad="lg" lift="lg" round="lg" className="cl__card">
        <h1 className="cl__title" id="cl-title">
          {title}
        </h1>
        <p className="cl__lede">{lede}</p>
        <div className="cl__ctas">
          <SiteLinkButton href="/docs" variant="primary" icon="arrow">
            {t('site.nf.guide')}
          </SiteLinkButton>
          <SiteLinkButton href="/">{t('site.nf.home')}</SiteLinkButton>
        </div>
        <a className="cl__x" href={xProfile(settings.xHandle)} target="_blank" rel="noreferrer">
          <XIcon size={16} /> <span>{t('pg.follow')}</span>
        </a>
        {children}
      </Sticker>
    </section>
  );
}

/** A page the admin has not opened yet (`/mint`, `/faucet`, `/collab`): the shared notice. */
export function ClosedPage({ path }: { path: string }) {
  const t = useT();
  return (
    <SitePage className="cl-root">
      <ClosedNotice title={t(TITLE[path] ?? 'site.closed.title')} lede={t(WHAT[path] ?? 'site.closed.page')} />
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
