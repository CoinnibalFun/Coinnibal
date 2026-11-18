import { activeChain } from '@elymum/shared';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChompMark, CoinMark, Icon, Kb, RingScene, Wordmark as InkWordmark, type IconName } from '../design';
import { FooterLife } from './FooterLife';
import { usePeelLetters } from './peel';
import { Link, usePath } from './router';
import { useServerChain } from './serverChain';
import { plainChainName, useT, type TKey } from '../i18n';
import { strong, T } from '../i18n/rich';
import { DOORS_CLOSED, linkOpen, useDoors, type Doors } from './doors';
import { siteHost, useSiteSettings, xProfile } from './settings';
import { readStoredSession } from './storedSession';
import './site.css';

// the wallet (viem, EIP-6963) loads in its own chunk, after the page has painted
const HeaderConnect = lazy(() => import('./HeaderConnect').then((m) => ({ default: m.HeaderConnect })));

/**
 * The COINNIBAL wordmark for site pages: the hand-built ink letters from the design system
 * (`size` sm = header, xl = hero). `live` lets the letters hop once on load and on hover.
 */
export function Wordmark({ size = 'sm', as: Tag = 'span', live = false }: { size?: 'sm' | 'xl'; as?: 'span' | 'h1'; live?: boolean }) {
  return (
    <Tag className={`st-mark st-mark--${size}${live ? ' is-live' : ''}`}>
      <InkWordmark height={size === 'xl' ? 112 : 30} playful={live} className="st-mark__art" />
    </Tag>
  );
}

export function XIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="st-xicon">
      <path fill="currentColor" d="M17.8 3h3.1l-6.8 7.8 8 10.2h-6.3l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.8 3h6.4l4.4 5.9zm-1.1 16.2h1.7L7.4 4.7H5.6z" />
    </svg>
  );
}

/**
 * A site link drawn as a Storybook button (`kb-btn`): primary sun, secondary cream, teal or
 * ghost. Same press as the design-system Button, but it navigates.
 */
export function SiteLinkButton({
  href,
  variant = 'secondary',
  size = 'md',
  icon,
  lead,
  children,
  className,
  external = false,
  ...rest
}: {
  href: string;
  variant?: 'primary' | 'secondary' | 'teal' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  lead?: IconName;
  children: ReactNode;
  className?: string;
  external?: boolean;
  onClick?: () => void;
  'aria-label'?: string;
}) {
  const iconSize = size === 'lg' ? 24 : size === 'md' ? 20 : 16;
  const cls = `kb-btn kb-btn--${variant} kb-btn--${size} st-btn${className ? ` ${className}` : ''}`;
  const inner = (
    <>
      {lead && <Icon name={lead} size={iconSize} className="kb-btn__lead" />}
      <span className="kb-btn__label">
        <span className="kb-btn__text">{children}</span>
      </span>
      {icon && <Icon name={icon} size={iconSize} className="kb-btn__icon" />}
    </>
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls} {...rest}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} className={cls} {...rest}>
      {inner}
    </Link>
  );
}

/**
 * The site nav, kept short: Play, Mint, WL, Docs. Every link warms its page on hover / touch (router `Link`), so the
 * click turns the page at once. The faucet is never in the header or the footer: it is hidden from visitors (the
 * game's wallet panel links to it where test tokens exist).
 */
export const NAV: { href: string; label: string; key: TKey }[] = [
  { href: '/play', label: 'Play', key: 'site.nav.play' },
  { href: '/mint', label: 'Mint', key: 'site.nav.mint' },
  { href: '/wl', label: 'WL', key: 'site.nav.wl' },
  { href: '/docs', label: 'Docs', key: 'site.nav.docs' },
];

/** The nav for the admin's settings: a link only to what is open (`doors`: Play with the game, Mint, WL; Docs always). */
export const navFor = (doors: Doors = DOORS_CLOSED) => NAV.filter((n) => linkOpen(n.href, doors));

/**
 * Pages that are closed but named in the header with a "Soon" tag, not clickable: the game (beta), the WL and the
 * collab applications. The mint is not among them (it runs on OpenSea).
 */
export const SOON: { href: string; key: TKey; note: TKey }[] = [
  { href: '/play', key: 'site.nav.play', note: 'site.menu.soon.play' },
  { href: '/wl', key: 'site.nav.wl', note: 'site.menu.soon.wl' },
  { href: '/collab', key: 'site.nav.collab', note: 'site.menu.soon.collab' },
];

/** The "Soon" entries for the doors that are still closed. */
export const soonFor = (doors: Doors = DOORS_CLOSED) => SOON.filter((n) => !linkOpen(n.href, doors));

function ConnectFallback() {
  const t = useT();
  return (
    <button type="button" className="kb-btn kb-btn--secondary kb-btn--md st-connect" disabled aria-busy="true">
      <Icon name="wallet" size={20} className="kb-btn__lead" />
      <span className="kb-btn__label">
        <span className="kb-btn__text">{t('site.connect')}</span>
      </span>
    </button>
  );
}

export function SiteHeader({ cta: _cta = true, children }: { cta?: boolean; /** Extras hung under the header line (the landing's seed rail). */ children?: ReactNode }) {
  const t = useT();
  const path = usePath();
  const peel = usePeelLetters<HTMLSpanElement>();
  const doors = useDoors();
  const { settings } = useSiteSettings();
  const nav = navFor(doors);
  const soon = soonFor(doors);
  // one or two entries fit beside the logo on a phone too: no menu button for them
  const few = nav.length + soon.length <= 2 && !doors.game;
  // the wallet button belongs to what needs a wallet (the game, the mint, the applications); a signed-in wallet keeps it
  const [wallet] = useState(() => readStoredSession() !== null);
  const connect = doors.game || doors.mint || doors.wl || doors.collab || wallet;
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menu) return;
    // the page behind the open menu stays put (site.css: html.st-menu-open)
    const root = document.documentElement;
    root.classList.add('st-menu-open');
    return () => root.classList.remove('st-menu-open');
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    // the open menu is modal (a scrim covers the page): Tab cycles between the close button and its
    // links, and Escape hands focus back to the menu button instead of leaving it on the page behind
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(false);
        menuBtn.current?.focus();
        return;
      }
      if (e.key !== 'Tab' || !sheet.current || !menuBtn.current) return;
      const stops = [menuBtn.current, ...sheet.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const next = at === -1 ? 0 : (at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
      e.preventDefault();
      stops[next].focus();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [menu]);
  const links = nav.map((n) => {
    const on = path === n.href;
    return (
      <Link
        key={n.href}
        href={n.href}
        className={`st-nav__link${on ? ' is-on' : ''}`}
        aria-current={on ? 'page' : undefined}
        onClick={() => setMenu(false)}
      >
        {t(n.key)}
      </Link>
    );
  });
  // still not links. The closed parts read as one quiet group (muted names, one "Soon" chip after them); each name
  // can take the keyboard's focus, so a pointer or a Tab shows its own small tip with what it will be (the lines the
  // phone menu shows). Each name still says "Soon" to a screen reader (.st-soon), and its tip describes it. On its own
  // (closed) page an item is marked as the place the visitor is at
  const soonSet = soon.length > 0 && (
    <span className="st-soonset">
      {soon.map((n, i) => {
        const here = path === n.href;
        const tip = `st-tip-${n.href.slice(1)}`;
        return (
          <span
            key={`soon:${n.href}`}
            className={`st-soonitem${i === soon.length - 1 ? ' st-soonitem--end' : ''}`}
            // Escape puts the tip away (it comes back on the next hover or focus)
            onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.setAttribute('data-hush', '')}
            onBlur={(e) => e.currentTarget.removeAttribute('data-hush')}
            onPointerLeave={(e) => e.currentTarget.removeAttribute('data-hush')}
          >
            <span
              className={`st-nav__link st-nav__link--soon${here ? ' is-here' : ''}`}
              tabIndex={0}
              aria-disabled="true"
              aria-current={here ? 'page' : undefined}
              aria-describedby={tip}
            >
              {t(n.key)}
              <span className="st-soon">{t('site.nav.soon')}</span>
            </span>
            <span className="st-tip" role="tooltip" id={tip}>
              {t(n.note)}
            </span>
          </span>
        );
      })}
      <span className="st-soonset__tag" aria-hidden="true">
        {t('site.nav.soon')}
      </span>
    </span>
  );
  const handle = settings.xHandle.replace(/^@/, '');
  const xHref = xProfile(handle);
  return (
    <header className={`st-head${few ? ' st-head--few' : ''}`}>
      <div className="st-head__inner">
        <Link href="/" className="st-head__home" aria-label={t('lo.home')}>
          <CoinMark size={38} className="st-head__coin" />
          <ChompMark size={50} className="st-head__chomp" />
          <span ref={peel.ref} className={peel.className}>
            <Wordmark />
          </span>
        </Link>
        <nav className="st-nav" aria-label={t('site.nav.label')}>
          {links}
          {soonSet}
        </nav>
        <div className="st-head__tools">
          {/* wide screens: the project's X account at the end of the nav (narrower, it is in the menu) */}
          {!few && (
            <a className="st-head__x" href={xHref} target="_blank" rel="noreferrer" aria-label={t('site.nav.x', { handle })}>
              <XIcon size={18} />
            </a>
          )}
          {connect && (
            <Suspense fallback={<ConnectFallback />}>
              <HeaderConnect />
            </Suspense>
          )}
          {!few && (
          <button
            ref={menuBtn}
            type="button"
            className="st-menu-btn"
            aria-expanded={menu}
            aria-controls="st-menu"
            aria-label={menu ? t('site.menu.close') : t('site.menu.open')}
            onClick={() => setMenu((m) => !m)}
          >
            <Icon name={menu ? 'close' : 'menu'} size={22} />
          </button>
          )}
        </div>
      </div>
      {menu && !few && (
        <>
          <button type="button" className="st-menu__scrim" aria-label={t('site.menu.close')} tabIndex={-1} onClick={() => setMenu(false)} />
          {/* phones: a sheet from the bottom edge, so every link and the Play button sit under the thumb; wider: a card
              under the menu button. What is open, each with a line on what is there (the guide, X), then what is
              not open yet and what each will be */}
          <nav ref={sheet} id="st-menu" className="st-menu kb-sticker kb-sticker--cream" aria-label={t('site.menu.label')}>
            {nav
              .filter((n) => n.href !== '/play')
              .map((n) => {
                const on = path === n.href;
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`st-menu__row${on ? ' is-on' : ''}`}
                    aria-current={on ? 'page' : undefined}
                    onClick={() => setMenu(false)}
                  >
                    <span className="st-menu__name">{t(n.key)}</span>
                    {n.href === '/docs' && <span className="st-menu__note">{t('site.menu.note.docs')}</span>}
                    <Icon name="arrow" size={20} className="st-menu__go" />
                  </Link>
                );
              })}
            <a className="st-menu__row" href={xHref} target="_blank" rel="noreferrer">
              <span className="st-menu__name">
                <XIcon size={17} />@{handle}
              </span>
              <span className="st-menu__note">{t('site.menu.note.x')}</span>
              <Icon name="arrow" size={20} className="st-menu__go st-menu__go--out" />
            </a>
            {soon.length > 0 && (
              <div className="st-menu__soon">
                <span className="st-soonset__tag" aria-hidden="true">
                  {t('site.nav.soon')}
                </span>
                {soon.map((n) => {
                  const here = path === n.href;
                  return (
                    <span
                      key={`soon:${n.href}`}
                      className={`st-nav__link st-nav__link--soon st-menu__soonrow${here ? ' is-here' : ''}`}
                      aria-disabled="true"
                      aria-current={here ? 'page' : undefined}
                    >
                      <span className="st-menu__name">{t(n.key)}</span>
                      <span className="st-menu__note">{t(n.note)}</span>
                      <span className="st-soon">{t('site.nav.soon')}</span>
                    </span>
                  );
                })}
              </div>
            )}
            {doors.game && (
              <SiteLinkButton href="/play" variant="primary" size="lg" icon="arrow" className="st-menu__play" onClick={() => setMenu(false)}>
                {t('site.menu.play')}
              </SiteLinkButton>
            )}
          </nav>
        </>
      )}
      {children}
    </header>
  );
}

export function SiteFooter() {
  const t = useT();
  const { settings } = useSiteSettings();
  const handle = settings.xHandle.replace(/^@/, '');
  // the server's chain names the network in the line below: re-render once it is in
  useServerChain();
  const doors = useDoors();
  return (
    <Kb theme="night" paper={false} className="st-foot-kb">
    <footer className="st-foot">
      <div className="st-foot__inner">
        <div className="st-foot__brand">
          <InkWordmark height={64} diecut playful={false} className="st-foot__mark" />
          <p className="st-foot__eco">
            <T k="site.foot.eco" tags={{ strong }} vars={{ chain: plainChainName(activeChain().name) }} />
          </p>
        </div>
        <nav className="st-foot__links" aria-label={t('site.foot.nav')}>
          <a href={xProfile(handle)} target="_blank" rel="noreferrer" className="st-foot__x">
            <XIcon size={18} /> <span>@{handle}</span>
          </a>
          {doors.game && <Link href="/play">{t('site.nav.play')}</Link>}
          {doors.mint && <Link href="/mint">{t('site.nav.mint')}</Link>}
          {doors.wl && <Link href="/wl">{t('site.nav.wl')}</Link>}
          {doors.collab && <Link href="/collab">{t('site.nav.collab')}</Link>}
          <Link href="/docs">{t('site.nav.docs')}</Link>
        </nav>
        <p className="st-foot__small">
          <span>Coinnibal · 2026</span>
          <span>{siteHost()}</span>
          <span>{t('site.foot.safety')}</span>
        </p>
      </div>
      {/* the front terraces under the footer's text (in the flow, so the text never runs onto the ground) */}
      <div className="st-foot__land">
        <RingScene time="night" variant="horizon" clouds={false} animate={false} className="st-foot__ring" />
        <FooterLife />
      </div>
    </footer>
    </Kb>
  );
}

/** A site page: paper stock, the header, the page and the footer. */
export function SitePage({ children, className, cta = true }: { children: ReactNode; className?: string; cta?: boolean }) {
  const t = useT();
  return (
    <Kb theme="paper" className={`st-root${className ? ` ${className}` : ''}`}>
      <a className="st-skip" href="#main">
        {t('site.skip')}
      </a>
      <SiteHeader cta={cta} />
      <main id="main" className="st-main" tabIndex={-1}>
        {children}
      </main>
      <SiteFooter />
    </Kb>
  );
}
