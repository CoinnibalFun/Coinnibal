import { ELYSIUM, NFT_SUPPLY, SHADE } from '@elymum/shared';
import { CoinCharacter, Icon, useOffscreenPause, useReducedMotion } from '../../design';
import { useT } from '../../i18n';
import { SiteLinkButton, SitePage, XIcon } from '../Shell';
import { SoonStamp } from '../SoonStamp';
import { useSiteSettings, xProfile } from '../settings';
import './mintclosed.css';

const INK = ELYSIUM.abyss;
const S = { stroke: INK, strokeWidth: 3, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
/** The top of the ground the whole scene stands on (viewBox units). */
const GROUND = 362;

/** A velvet-rope post: a sun pole on a round foot, a ball on top. */
function Post({ x }: { x: number }) {
  return (
    <g {...S} strokeWidth={2.6}>
      <ellipse cx={x} cy={GROUND} rx={15} ry={4.5} fill={SHADE.sun} />
      <rect x={x - 4} y={300} width={8} height={GROUND - 302} rx={3} fill={ELYSIUM.sun} />
      <circle cx={x} cy={298} r={7} fill={ELYSIUM.sun} />
    </g>
  );
}

/**
 * The mint, shut: a screw press on its stone plinth with a chain and a padlock round its screw, a sealed crate of
 * blanks beside it (the collection's size stencilled on it), and a queue already waiting along a velvet rope, the last
 * coin camping in a tent. The coins and the Soon stamp are HTML laid over the drawing (MintClosed). Decoration
 * (aria-hidden); the words live in the page.
 */
function MintPress({ supply }: { supply: string }) {
  const chain = Array.from({ length: 9 }, (_, i) => i);
  return (
    <svg className="mc-art" viewBox="0 40 760 390" aria-hidden="true" focusable="false">
      {/* a chubby cloud over the queue */}
      <g className="mc-art__cloud" {...S}>
        <path d="M118 120 q-30 0 -30 -24 q0 -24 30 -22 q8 -30 44 -26 q30 2 34 30 q30 -4 30 20 q0 22 -28 22z" fill={ELYSIUM.white} />
        <path d="M110 112 h96" stroke={ELYSIUM.mist} strokeWidth={5} />
      </g>

      {/* the ground: one terrace bed, its ends rounded off */}
      <path d={`M14 ${GROUND} H746 Q758 ${GROUND} 758 ${GROUND + 12} V${GROUND + 44} Q758 ${GROUND + 58} 744 ${GROUND + 58} H16 Q2 ${GROUND + 58} 2 ${GROUND + 44} V${GROUND + 12} Q2 ${GROUND} 14 ${GROUND}Z`} fill={ELYSIUM.verdant} {...S} />
      <path d={`M14 ${GROUND} H746 Q758 ${GROUND} 758 ${GROUND + 12} V${GROUND + 14} H2 V${GROUND + 12} Q2 ${GROUND} 14 ${GROUND}Z`} fill={ELYSIUM.meadow} {...S} />
      <path d={`M24 ${GROUND + 36} H736`} fill="none" stroke={ELYSIUM.forest} strokeWidth={3} strokeDasharray="14 12" />

      {/* the tent at the end of the queue: somebody camped out for this */}
      <g {...S}>
        <path d={`M2 ${GROUND} L50 292 L98 ${GROUND}Z`} fill={ELYSIUM.coral} />
        <path d={`M50 292 L38 ${GROUND} H62Z`} fill={INK} />
        <path d={`M50 292 L62 ${GROUND} L80 ${GROUND}Z`} fill={ELYSIUM.cream} />
        <path d="M50 292 V270" />
        <path d="M50 270 l16 5 l-16 5z" fill={ELYSIUM.sun} strokeWidth={2.4} />
        <path d={`M2 ${GROUND} l-6 4 M98 ${GROUND} l6 4`} strokeWidth={2.4} />
      </g>

      {/* the velvet rope the queue keeps to */}
      <path d="M128 304 Q182 332 236 304 Q290 332 344 304" fill="none" stroke={INK} strokeWidth={9} strokeLinecap="round" />
      <path d="M128 304 Q182 332 236 304 Q290 332 344 304" fill="none" stroke={ELYSIUM.coral} strokeWidth={4.5} strokeLinecap="round" />
      <Post x={128} />
      <Post x={236} />
      <Post x={344} />

      {/* the press: the balance bar with its two iron weights, turning the screw */}
      <g {...S}>
        <path d="M398 88 H642" strokeWidth={17} />
        <path d="M398 88 H642" stroke={ELYSIUM.stone} strokeWidth={10} />
        <path d="M404 84 H636" stroke={ELYSIUM.sand2} strokeWidth={2.5} opacity={0.7} />
        {[392, 648].map((x) => (
          <g key={x}>
            <circle cx={x + 3} cy={91} r={22} fill={INK} stroke="none" />
            <circle cx={x} cy={88} r={22} fill={ELYSIUM.stone} />
            <path d={`M${x - 12} 80 a14 14 0 0 1 10 -9`} fill="none" stroke={ELYSIUM.sand2} strokeWidth={4} />
          </g>
        ))}
        {/* the screw, threads and all */}
        <rect x={512} y={72} width={16} height={188} rx={3} fill={ELYSIUM.sand2} />
        <path d="M512 196 l16 -6 M512 206 l16 -6 M512 216 l16 -6 M512 226 l16 -6 M512 236 l16 -6 M512 112 l16 -6 M512 122 l16 -6 M512 132 l16 -6" stroke={ELYSIUM.stone} strokeWidth={2} />
        <circle cx={520} cy={88} r={12} fill={ELYSIUM.sun} />
        <circle cx={520} cy={88} r={4} fill={INK} stroke="none" />
        {/* the iron frame */}
        <path d="M456 308 H584 V318 H456Z" fill={INK} transform="translate(4 4)" stroke="none" />
        <path d="M452 308 V176 Q452 148 480 148 H560 Q588 148 588 176 V308 H560 V190 Q560 180 550 180 H490 Q480 180 480 190 V308Z" fill={ELYSIUM.teal} />
        <path d="M460 300 V180 Q460 158 480 156" fill="none" stroke={ELYSIUM.spray} strokeWidth={4} opacity={0.75} />
        <rect x={500} y={134} width={40} height={16} rx={4} fill={ELYSIUM.current} />
        <circle cx={466} cy={164} r={3.5} fill={ELYSIUM.sun} strokeWidth={2} />
        <circle cx={574} cy={164} r={3.5} fill={ELYSIUM.sun} strokeWidth={2} />
        {/* the ram, the die and one blank waiting on it */}
        <rect x={498} y={258} width={44} height={16} rx={4} fill={ELYSIUM.sand2} />
        <rect x={504} y={290} width={32} height={18} rx={3} fill={ELYSIUM.sand2} />
        <ellipse cx={520} cy={289} rx={15} ry={4.5} fill={ELYSIUM.sun} strokeWidth={2.4} />
        {/* the plinth */}
        <rect x={432} y={308} width={176} height={GROUND - 308} rx={4} fill={INK} transform="translate(4 0)" stroke="none" />
        <rect x={432} y={314} width={176} height={GROUND - 314} rx={3} fill={ELYSIUM.sand2} />
        <rect x={424} y={304} width={192} height={14} rx={4} fill={ELYSIUM.sand} />
      </g>

      {/* chained and locked: the chain loops round the screw, the padlock hangs off it (and sways a little) */}
      <g fill="none" stroke={INK} strokeWidth={2.4}>
        {chain.map((i) => {
          const t = i / (chain.length - 1);
          const x = 482 + t * 76;
          const y = 200 + Math.sin(t * Math.PI) * 14;
          return <ellipse key={i} cx={x} cy={y} rx={5.5} ry={3.2} transform={`rotate(${(t - 0.5) * -40 + (i % 2 ? 90 : 0)} ${x} ${y})`} fill={ELYSIUM.sand2} />;
        })}
      </g>
      <g className="mc-art__lock" {...S}>
        <path d="M508 224 V212 a12 12 0 0 1 24 0 V224" fill="none" strokeWidth={4.5} />
        <rect x={500} y={220} width={44} height={36} rx={7} fill={INK} transform="translate(3 3)" stroke="none" />
        <rect x={498} y={220} width={44} height={36} rx={7} fill={ELYSIUM.sun} />
        <path d="M505 228 h30" stroke={SHADE.sun} strokeWidth={3} />
        <circle cx={520} cy={237} r={4.5} fill={INK} stroke="none" />
        <path d="M520 239 V248" strokeWidth={4} />
      </g>

      {/* the sealed crate of blanks, with the collection's size on its side */}
      <g {...S}>
        <rect x={630} y={302} width={92} height={GROUND - 302} rx={3} fill={INK} transform="translate(4 0)" stroke="none" />
        <rect x={626} y={298} width={92} height={GROUND - 298} rx={3} fill={SHADE.sun} />
        <path d={`M626 318 H718 M626 342 H718`} strokeWidth={2.4} opacity={0.55} />
        <rect x={620} y={292} width={104} height={12} rx={3} fill={ELYSIUM.sun} />
        <path d="M664 292 V304" strokeWidth={2.4} />
        <circle cx={672} cy={298} r={7} fill={ELYSIUM.coral} strokeWidth={2.4} />
        <text className="mc-art__stencil" x={672} y={337} textAnchor="middle" stroke="none" fill={INK}>
          {supply}
        </text>
      </g>
    </svg>
  );
}

/**
 * `/mint` while the mint is not open: its own scene in the site's art (the press locked, a queue waiting for it), the
 * page's one heading, one line in the coins' voice, the OpenSea-only rule as a callout of its own, then the same ways on
 * as the other closed pages (the guide, home, X). Nothing about when or how much: only where, and which link to trust.
 */
export function MintClosed() {
  const t = useT();
  const reduced = useReducedMotion();
  const { settings } = useSiteSettings();
  const [ref, visible] = useOffscreenPause<HTMLDivElement>();
  return (
    <SitePage className="mc-root">
      <section className="mc" aria-labelledby="mc-title" data-testid="closed-page">
        <div className="mc__copy">
          <h1 className="mc__title" id="mc-title">
            {t('site.closed.titleMint')}
          </h1>
          <p className="mc__lede">{t('site.closed.mint')}</p>
          <aside className="mc-note" aria-labelledby="mc-note-title">
            <span className="mc-note__icon" aria-hidden="true">
              <Icon name="lock" size={20} />
            </span>
            <p className="mc-note__text">
              <strong id="mc-note-title">{t('site.closed.mintNoteTitle')}</strong> {t('site.closed.mintNote')}
            </p>
          </aside>
          <div className="mc__ctas">
            <SiteLinkButton href="/docs" variant="primary" icon="arrow">
              {t('site.nf.guide')}
            </SiteLinkButton>
            <SiteLinkButton href="/">{t('site.nf.home')}</SiteLinkButton>
          </div>
          <a className="cl__x mc__x" href={xProfile(settings.xHandle)} target="_blank" rel="noreferrer">
            <XIcon size={16} /> <span>{t('pg.follow')}</span>
          </a>
        </div>
        <div ref={ref} className="mc__scene" aria-hidden="true" data-paused={!visible || reduced || undefined}>
          <MintPress supply={NFT_SUPPLY.toLocaleString('en-US')} />
          <SoonStamp className="mc__soon" />
          {/* the queue, front to back: a small coin first in line, glancing back at the big one behind it */}
          <span className="mc-coin mc-coin--1">
            <CoinCharacter paint="cyan" mood="scared" size={70} look={[-4, 0]} sweat feet ground />
          </span>
          <span className="mc-coin mc-coin--2">
            <CoinCharacter paint="sun" mood="smug" size={112} look={[4, 2]} feet ground bob={!reduced} phase={0.6} />
          </span>
          <span className="mc-coin mc-coin--3">
            <CoinCharacter paint="coral" mood="smile" size={78} look={[4, -1]} feet ground />
          </span>
          <span className="mc-coin mc-coin--4">
            <CoinCharacter paint="teal" mood="happy" size={68} feet ground />
          </span>
        </div>
      </section>
    </SitePage>
  );
}
