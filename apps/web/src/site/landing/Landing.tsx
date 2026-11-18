import { DEFAULT_ARENAS, NFT_SUPPLY, TOKEN_SYMBOL_DEFAULT, activeChain, arenaMeta, formatUsdCents, type GameAccess } from '@elymum/shared';
import { motion, useInView } from 'motion/react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import {
  CoinCharacter,
  FoodBit,
  Icon,
  Kb,
  OrbitDots,
  RingScene,
  Seigaiha,
  Stamp,
  StatusPill,
  Sticker,
  Wordmark,
  useMoves,
  useOffscreenPause,
  useReducedMotion,
  type CoinMood,
  type CoinPaint,
} from '../../design';
import { plainChainName, useT, type TKey } from '../../i18n';
import { em, renderRich, T } from '../../i18n/rich';
import { FACTS } from '../../ui/docs/facts';
import { usePeelLetters } from '../peel';
import { Link } from '../router';
import { useMedia } from '../../design/useMedia';
import { useDoors, type Doors } from '../doors';
import { SiteFooter, SiteHeader, SiteLinkButton, XIcon } from '../Shell';
import { useSiteSettings, xProfile } from '../settings';
import { BITES, BiteSeam, biteVars } from './BiteSeam';
import { CoinPond } from './CoinPond';
import { DuskSeam } from './DuskSeam';
import { GazeCoin } from './GazeCoin';
import { HeroScreen } from './HeroScreen';
import { useIdleBudget } from './idle';
import { NapSeam } from './NapSeam';
import { BITE_GULP_MS, SEAL_GULP_MS, gulp, useReveal, useRevealEach } from './reveal';
import { SealSeam } from './SealSeam';
import { SeedRail } from './SeedRail';
import { WhyNft } from '../nft/WhyNft';
import { isTestnetChain, useServerChain } from '../serverChain';
import { useLandingSound } from './sound';
import './landing.css';
import './reveal.css';

/** The game token's display symbol (server `TOKEN_SYMBOL`; the landing has no chain status). */
const SYMBOL = TOKEN_SYMBOL_DEFAULT;
const pct = (bps: number) => `${bps / 100}%`;
/** Inline custom properties (`--rv-n`, `--tilt`, ...). */
const v = (o: Record<string, string | number>) => o as CSSProperties;

/*
 * Scrolling down, every plate is printed in one rhythm (reveal.ts arms it, reveal.css plays it): the section's ink
 * rule draws while a bite, the seal or the tablecloth plays on the seam; then each content stage lays down heading
 * (rv-h, fed out top-down), visual (rv-v, settling up with the scroll), body (rv-b) and items (rv-i). Each section has
 * one label, its H2: no caption bar or kicker repeats it. Text is never hidden longer than about 0.6 s; reduced motion
 * is never armed and sees the finished page.
 */

const NO_REF: RefObject<Element | null> = { current: null };
/**
 * motion's `useInView`, minus its crash where there is no IntersectionObserver (an old browser): there the element
 * simply counts as in view, so the page still renders whole.
 */
function useInViewSafe(ref: RefObject<Element | null>, opts: Parameters<typeof useInView>[1]): boolean {
  const io = typeof IntersectionObserver !== 'undefined';
  return useInView(io ? ref : NO_REF, opts) || !io;
}

/** A plate section: its seam plays when its top crosses 90 % of the viewport, and the header's coin gulps with it. */
const usePlate = (gulpAt: number) => useReveal<HTMLElement>(undefined, { attr: 'data-seam', onIn: () => gulp(gulpAt) });

/* ── the hero ─────────────────────────────────────────────────────────── */

/** A round's length in words for the hero line ("Five minutes later"), digits past ten. */
const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const spelled = (n: number) => WORDS[n] ?? String(n);

/**
 * The hero. Its buttons follow what is open (`doors`): with everything closed the main action is "How it works" (the
 * round, further down this page), then the NFT's perks and the project's X account; "Join the WL", Collab and Play come
 * back as the admin opens them. Nothing here points at a closed page. Beside the card (under it on a phone) the screen
 * plays real gameplay; the pond's coins wait at the foot of the first screen.
 */
function Hero({ doors, gameAccess, handle, sound }: { doors: Doors; gameAccess: GameAccess; handle: string; sound: ReturnType<typeof useLandingSound> }) {
  const reduced = useReducedMotion();
  const m = useMoves();
  // on a phone the card fills the width: a smaller tilt keeps its corners off the screen's edges
  const phone = useMedia('(max-width: 479px)');
  // a mouse clicks the pond's coins, a finger taps them
  const fine = useMedia('(hover: hover) and (pointer: fine)');
  const peel = usePeelLetters<HTMLHeadingElement>();
  const t = useT();
  return (
    <section className="ld-hero" aria-labelledby="ld-hero-title">
      <RingScene time="dawn" variant="full" animate={!reduced} className="ld-hero__ring">
        <div className="ld-hero__inner">
          <motion.div className="ld-hero__drop" variants={m.stickerDrop} custom={phone ? -0.8 : -1.6} initial="hidden" animate="shown">
            <Sticker pad="lg" lift="lg" tape className="ld-hero__card">
              <h1 id="ld-hero-title" ref={peel.ref} className={`ld-hero__title ${peel.className}`}>
                <Wordmark height={104} playful={!reduced} className="ld-hero__mark" />
              </h1>
              <p className="ld-hero__tag">
                {t('ld.hero.tag')} <span className="ld-hero__motto">{t('brand.tagline')}</span>
              </p>
              {/* the ticket and what eating costs, in one paragraph: a paid room takes a ticket, getting eaten loses it */}
              <p className="ld-hero__lede" data-testid="ld-money">
                {t('ld.hero.lede', { sym: SYMBOL, mins: spelled(FACTS.rules.roundMin) })}
              </p>
              <div className="ld-hero__ctas">
                {doors.wl && (
                  <SiteLinkButton href="/wl" variant="primary" icon="arrow" onClick={sound.click}>
                    {t('ld.cta.wl')}
                  </SiteLinkButton>
                )}
                {!doors.wl && (
                  <a href="#round" className="kb-btn kb-btn--primary kb-btn--md st-btn" onClick={sound.click} data-testid="ld-how-link">
                    <span className="kb-btn__label">
                      <span className="kb-btn__text">{t('ld.cta.how')}</span>
                    </span>
                    <Icon name="arrow" size={20} className="kb-btn__icon ld-hero__down" />
                  </a>
                )}
                <a href="#why-nft" className="kb-btn kb-btn--secondary kb-btn--md st-btn" onClick={sound.click} data-testid="ld-why-link">
                  <span className="kb-btn__label">
                    <span className="kb-btn__text">{t('ld.cta.perks')}</span>
                  </span>
                </a>
                {doors.collab && (
                  <SiteLinkButton href="/collab" onClick={sound.click}>
                    {t('site.nav.collab')}
                  </SiteLinkButton>
                )}
                {doors.game && gameAccess !== 'maintenance' && (
                  <a href="/play" className="kb-btn kb-btn--teal kb-btn--md st-btn" onClick={sound.click}>
                    <Icon name="play" size={20} className="kb-btn__lead" />
                    <span className="kb-btn__label">
                      <span className="kb-btn__text">{gameAccess === 'holders' ? t('ld.cta.playHolders') : t('site.nav.play')}</span>
                    </span>
                  </a>
                )}
              </div>
              {doors.wl ? (
                <p className="ld-hero__note">
                  {doors.mint && doors.game && <span className="ld-flowline">{t('ld.flowline')}</span>}
                  <span>{t('ld.wlOpen')}</span>
                </p>
              ) : (
                <p className="ld-hero__note ld-hero__note--x">
                  <a href={xProfile(handle)} target="_blank" rel="noreferrer" className="ld-hero__x" onClick={sound.click} data-testid="ld-x-link">
                    <XIcon size={16} /> <span>{t('pg.follow')}</span>
                  </a>
                </p>
              )}
            </Sticker>
          </motion.div>
          <motion.div className="ld-hero__screen" variants={m.popIn} custom={0.35} initial="hidden" animate="shown">
            <HeroScreen />
          </motion.div>
        </div>
        <CoinPond still={reduced} events={{ onEat: sound.chomp }} />
        {!reduced && (
          <p className="ld-pond__hint" aria-hidden="true">
            {t(fine ? 'ld.pondHintClick' : 'ld.pondHint')}
          </p>
        )}
        {/* the pond's chomps (the clip has no sound): off until the visitor turns them on */}
        <button type="button" className="ld-sound" aria-pressed={sound.on} onClick={sound.toggle}>
          <Icon name={sound.on ? 'sound' : 'mute'} size={16} />
          <span>{sound.on ? t('ld.soundOn') : t('ld.soundOff')}</span>
        </button>
      </RingScene>
    </section>
  );
}

/* ── what Coinnibal is ───────────────────────────────────────────────────── */

function MenuLine({ i, art, dish, note, price }: { i: number; art: ReactNode; dish: string; note: string; price: string }) {
  return (
    <li className="ld-menu__line rv-i" style={v({ '--rv-n': i })}>
      <span className="ld-menu__art" aria-hidden="true">
        {art}
      </span>
      <span className="ld-menu__dish">
        <strong>{dish}</strong>
        <span className="ld-menu__note">{note}</span>
      </span>
      <span className="ld-menu__dots" aria-hidden="true" />
      <span className="ld-menu__price">{price}</span>
    </li>
  );
}

/** A counter that runs from `from` to `to` once it is in view (the end value at once with reduced motion). */
function useCountUp(from: number, to: number, on: boolean, ms = 900): number {
  const reduce = useReducedMotion();
  const [v, setV] = useState(reduce ? to : from);
  useEffect(() => {
    if (!on || reduce) {
      if (reduce) setV(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      setV(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    // a short beat first: the gulp, then the tokens pour in
    const wait = setTimeout(() => (raf = requestAnimationFrame(step)), 450);
    return () => {
      clearTimeout(wait);
      cancelAnimationFrame(raf);
    };
  }, [on, reduce, from, to, ms]);
  return v;
}

/**
 * The core rule in one picture, straight on the page: a smaller coin worth 1,000 is eaten, and the eater's value runs
 * from 1,000 to 2,000. "Eat a coin, take its tokens."
 */
function TakeStrip() {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInViewSafe(ref, { once: true, amount: 0.6 });
  const value = useCountUp(1000, 2000, seen);
  const fmt = (n: number) => n.toLocaleString('en-US');
  return (
    <div ref={ref} className={`ld-take${seen ? ' is-on' : ''}`} role="img" aria-label={t('ld.take.aria', { sym: SYMBOL })}>
      <p className="ld-take__h">{t('ld.take.h')}</p>
      <div className="ld-take__row" aria-hidden="true">
        <span className="ld-take__coin ld-take__coin--prey">
          <CoinCharacter paint="foam" mood="scared" size={58} blink={false} />
          <span className="ld-take__tag mono">
            {fmt(1000)} <small>{SYMBOL}</small>
          </span>
        </span>
        <span className="ld-take__flow">
          <span className="ld-take__gain mono">+{fmt(1000)}</span>
          <svg viewBox="0 0 120 24" className="ld-take__arrow">
            <path d="M4 14 C 34 2, 74 2, 108 12" fill="none" />
            <path d="M100 5 L110 12 L100 19" fill="none" />
          </svg>
        </span>
        <span className="ld-take__coin ld-take__coin--eater">
          <CoinCharacter paint="sun" mood="chomp" size={82} />
          <span className="ld-take__tag ld-take__tag--you mono">
            {fmt(value)} <small>{SYMBOL}</small>
          </span>
        </span>
      </div>
    </div>
  );
}

function Feast() {
  const t = useT();
  const plate = usePlate(BITE_GULP_MS);
  const copy = useReveal<HTMLDivElement>();
  const menu = useReveal<HTMLDivElement>();
  return (
    <section ref={plate} className="ld-plate ld-feast has-bite" style={biteVars(BITES.feast)} id="feast" aria-labelledby="ld-feast-h">
      <i className="ld-rule" aria-hidden="true" />
      <BiteSeam at="feast" />
      <div className="ld-wrap ld-feast__grid">
        <div ref={copy} className="ld-feast__copy">
          <h2 className="ld-h2 rv-h" id="ld-feast-h">
            <T k="ld.feast.h" tags={{ u: (c) => <span className="ld-ul">{c}</span> }} />
          </h2>
          <p className="lede rv-b">{t('ld.feast.lede', { sym: SYMBOL, n: FACTS.capacity.arena })}</p>
          <div className="rv-b" style={v({ '--rv-at': 4 })}>
            <TakeStrip />
          </div>
        </div>
        <div ref={menu} className="ld-feast__menu-wrap rv-v">
          <Sticker tone="white" pad="lg" lift="lg" className="ld-menu">
            <h3 className="ld-menu__title">{t('ld.menu.title')}</h3>
            <ul className="ld-menu__list">
              <MenuLine i={0} art={<FoodBit kind="pear" size={44} />} dish={t('ld.menu.food')} note={t('ld.menu.foodNote')} price={t('ld.menu.foodPrice')} />
              <MenuLine i={1} art={<CoinCharacter paint="foam" mood="scared" size={46} blink={false} />} dish={t('ld.menu.small')} note={t('ld.menu.smallNote')} price={t('ld.menu.smallPrice')} />
              <MenuLine i={2} art={<CoinCharacter paint="sun" mood="smug" size={46} blink={false} />} dish={t('ld.menu.big')} note={t('ld.menu.bigNote')} price={t('ld.menu.bigPrice')} />
            </ul>
            <p className="ld-menu__foot rv-b" style={v({ '--rv-at': 5 })}>
              <T k="ld.menu.foot" tags={{ b: (c) => <b className="num">{c}</b> }} vars={{ r: FACTS.rules.eatRatio }} />
            </p>
          </Sticker>
        </div>
      </div>
    </section>
  );
}

/* ── how a round works ────────────────────────────────────────────────── */

const STATIONS: { no: string; title: TKey; body: TKey }[] = [
  { no: '01', title: 'ld.stop.ticket', body: 'ld.stop.ticketBody' },
  { no: '02', title: 'ld.stop.eat', body: 'ld.stop.eatBody' },
  { no: '03', title: 'ld.stop.bell', body: 'ld.stop.bellBody' },
  { no: '04', title: 'ld.stop.paid', body: 'ld.stop.paidBody' },
];
const stationVars = () => ({ sym: SYMBOL, min: FACTS.rules.roundMin, s: FACTS.rules.joinCloseS, b: FACTS.rules.breakS });

/**
 * How far the visitor has read down the steps: the index of the last step whose top has passed 60 % of the viewport
 * (-1 before the first). Steps above the viewport stay read, so a jump past the section lights them all. Without an
 * IntersectionObserver every step counts as read (the finished page).
 */
function useStepsRead(list: RefObject<HTMLOListElement | null>): number {
  const [at, setAt] = useState(-1);
  useEffect(() => {
    const ol = list.current;
    if (!ol) return;
    const items = [...ol.children];
    if (typeof IntersectionObserver === 'undefined') {
      setAt(items.length - 1);
      return;
    }
    const read = items.map(() => false);
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          const i = items.indexOf(e.target);
          if (i >= 0) read[i] = e.isIntersecting || (e.boundingClientRect?.top ?? 1) < 0;
        }
        setAt(read.lastIndexOf(true));
      },
      { rootMargin: '0px 0px -40% 0px' },
    );
    for (const el of items) io.observe(el);
    return () => io.disconnect();
  }, [list]);
  return at;
}

function Round({ live }: { live: boolean }) {
  const t = useT();
  const plate = usePlate(0);
  const orbit = useReveal<HTMLDivElement>();
  const copy = useReveal<HTMLDivElement>();
  // the orbit's stations and the step numbers light up as the visitor reads down the steps (the card stays beside them)
  const stops = useRef<HTMLOListElement>(null);
  const read = useStepsRead(stops);
  return (
    <section ref={plate} className="ld-plate ld-round" id="round" aria-labelledby="ld-round-h">
      <i className="ld-rule" aria-hidden="true" />
      <div className="ld-wrap ld-round__grid">
        <div ref={orbit} className="ld-round__orbit-wrap rv-v">
          <Sticker tone="night" pad="none" lift="lg" round="lg" className="ld-orbit">
            {/* a status only while the game is open to someone */}
            {live && <span className="ld-orbit__tag kb-tag">{t('ld.round.tag')}</span>}
            <OrbitDots
              width={640}
              height={330}
              coins={4}
              duration={20}
              tone="night"
              className="ld-orbit__svg"
              title={t('ld.round.svg')}
              stations={STATIONS.map((s, i) => ({ at: i / STATIONS.length, label: t(s.title), done: i <= read }))}
            />
            <span className="ld-orbit__core" aria-hidden="true">
              <GazeCoin paint="sun" mood="chomp" size={112} look={[2, 1]} reach={0.7} />
            </span>
          </Sticker>
        </div>
        <div ref={copy} className="ld-round__copy">
          <h2 className="ld-h2 rv-h" id="ld-round-h">
            {t('ld.round.h')}
          </h2>
          <ol ref={stops} className="ld-stops">
            {STATIONS.map((s, i) => (
              <li key={s.no} className={`ld-stop rv-i${i <= read ? ' is-read' : ''}`} style={v({ '--rv-n': i })}>
                <span className="ld-stop__no num" aria-hidden="true">
                  {s.no}
                </span>
                <span className="ld-stop__text">
                  <strong className="ld-stop__title">{t(s.title)}</strong>
                  <span>{t(s.body, stationVars())}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ── the Coinnibal NFT and why to get it ──────────────────────────────── */

/** The three NFT cards of the fan: which paint each wears and the slot it starts in. */
const EMBLEMS: { paint: CoinPaint; tilt: number }[] = [
  { paint: 'cyan', tilt: -8 },
  { paint: 'sun', tilt: -1.5 },
  { paint: 'up', tilt: 7 },
];
const SLOTS = ['left', 'front', 'right'] as const;

function Emblem({ paint, front, waking }: { paint: CoinPaint; front: boolean; waking: boolean }) {
  const t = useT();
  return (
    <div className={`ld-emblem${front ? ' is-front' : ''}`}>
      <div className="ld-emblem__panel">
        <Seigaiha tone="ink" rows={5} r={26} span={360} filled={false} className="ld-emblem__waves" />
        <span className="ld-emblem__no kb-tag num">No. ????</span>
        <span className="ld-emblem__coin">
          <CoinCharacter paint={paint} mood={!front ? 'sleepy' : waking ? 'open' : 'smug'} size={150} look={waking ? [3, -3] : [2, 0]} bob={front} />
        </span>
        <Stamp text={t('ld.nft.sealed')} tone="ink" size="sm" rotate={-12} className="ld-emblem__stamp" />
      </div>
      <span className="ld-emblem__rib">{t('ld.nft.rib')}</span>
    </div>
  );
}

/**
 * The fan of NFT cards shuffles itself like a hand of cards while it is on screen (every
 * 4.6 s, not while the visitor hovers it): the front card slides off to a side and tucks behind,
 * a side card comes forward and its sleepy coin wakes up and peeks out. The sticker button deals
 * the next card at once. Reduced motion: no automatic shuffle; the button still deals (no tween).
 */
function EmblemFan() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInViewSafe(ref, { amount: 0.4 });
  const [turn, setTurn] = useState(0);
  const [hold, setHold] = useState(false);
  const [waking, setWaking] = useState(false);
  // dealt from a deck on the first view (reveal.css); the auto-shuffle waits until the deal has landed
  const [dealt, setDealt] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useReveal(ref, {
    onIn: () => {
      timer.current = window.setTimeout(() => setDealt(true), 1200);
    },
    onSet: () => setDealt(true),
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  const ready = reduced || dealt;
  const t = useT();
  const deal = () => {
    setTurn((t) => t + 1);
    setWaking(true);
  };
  useEffect(() => {
    if (!waking) return;
    const t = setTimeout(() => setWaking(false), 1300);
    return () => clearTimeout(t);
  }, [waking, turn]);
  useEffect(() => {
    if (reduced || !ready || !inView || hold) return;
    const t = setInterval(deal, 4600);
    return () => clearInterval(t);
  }, [reduced, ready, inView, hold]);
  return (
    <div ref={ref} className="ld-nft__fan" data-dealt={ready || undefined} onPointerEnter={() => setHold(true)} onPointerLeave={() => setHold(false)}>
      {EMBLEMS.map((e, i) => {
        const slot = SLOTS[(i + turn) % 3];
        return (
          <div key={e.paint} className="ld-fan__card" data-slot={slot}>
            <Emblem paint={e.paint} front={slot === 'front'} waking={slot === 'front' && waking} />
          </div>
        );
      })}
      <button type="button" className="ld-fan__deal rv-b" style={v({ '--rv-at': 6 })} onClick={deal}>
        {t('ld.nft.shuffle')}
      </button>
    </div>
  );
}

/** The NFT: what it is and what holding one gives. The steps and the buttons show only for what is open. */
function Nft({ doors }: { doors: Doors }) {
  const t = useT();
  const testnet = isTestnetChain(useServerChain());
  const plate = usePlate(SEAL_GULP_MS);
  const copy = useReveal<HTMLDivElement>();
  const why = useRef<HTMLDivElement>(null);
  useReveal(why);
  useRevealEach(why, '.nf-row');
  return (
    <section ref={plate} className="ld-plate ld-nft" id="nft" aria-labelledby="ld-nft-h">
      <i className="ld-rule" aria-hidden="true" />
      <SealSeam />
      <div className="ld-nft__body">
        <div className="ld-wrap ld-nft__grid">
          <div ref={copy} className="ld-nft__copy">
            <h2 className="ld-h2 ld-nft__title rv-h" id="ld-nft-h">
              <T k={doors.mint ? 'ld.nft.h' : 'ld.nft.hInfo'} tags={{ em }} vars={{ supply: NFT_SUPPLY.toLocaleString('en-US') }} />
            </h2>
            <p className="ld-nft__text rv-b">{t('ld.nft.body')}</p>
            {doors.wl && doors.mint && doors.game && (
              <ol className="ld-flow rv-i" style={v({ '--rv-n': 2 })} aria-label={t('ld.nft.order')}>
                <li className="is-on">
                  <span>{t('site.nav.wl')}</span>
                </li>
                <li>
                  <span>{t('site.nav.mint')}</span>
                </li>
                <li>
                  <span>{t('site.nav.play')}</span>
                </li>
              </ol>
            )}
            {(doors.wl || doors.mint) && (
              <div className="ld-nft__ctas rv-i" style={v({ '--rv-n': 3 })}>
                {doors.wl && (
                  <SiteLinkButton href="/wl" variant="primary" icon="arrow">
                    {t('ld.cta.wl')}
                  </SiteLinkButton>
                )}
                {doors.mint && (
                  <SiteLinkButton href="/mint" variant={doors.wl ? 'teal' : 'primary'} icon={doors.wl ? undefined : 'arrow'}>
                    {t('ld.nft.see')}
                  </SiteLinkButton>
                )}
              </div>
            )}
          </div>
          <EmblemFan />
        </div>
        <div ref={why} className="ld-wrap ld-nft__why">
          <WhyNft testnet={testnet} level={3} />
        </div>
      </div>
    </section>
  );
}

/* ── the four rooms ───────────────────────────────────────────────────── */

/** Each room as a step up: a bigger ticket, a bigger coin on top. The $10 coin is the holders' (crowned). */
const STAIR: { paint: CoinPaint; mood: CoinMood; size: number }[] = [
  { paint: 'cyan', mood: 'smile', size: 58 },
  { paint: 'teal', mood: 'happy', size: 70 },
  { paint: 'coral', mood: 'smug', size: 84 },
  { paint: 'sun', mood: 'chomp', size: 100 },
];

function Arenas({ gameAccess }: { gameAccess: GameAccess }) {
  const t = useT();
  // no bite here: the dusk above already turns the page; the header coin still gulps as the plate prints
  const plate = usePlate(0);
  const head = useReveal<HTMLDivElement>();
  const stairs = useReveal<HTMLOListElement>();
  const fee = useReveal<HTMLDivElement>();
  const open = gameAccess === 'public' ? { tone: 'live' as const, text: t('ld.ar.open') } : gameAccess === 'holders' ? { tone: 'ok' as const, text: t('ld.ar.holders') } : { tone: 'idle' as const, text: t('ld.ar.after') };
  const feeBps = FACTS.fee.burnBps + FACTS.fee.vaultBps;
  const split = [
    { key: 'keep', bps: 10_000 - feeBps, label: t('ld.ar.keep', { pct: pct(10_000 - feeBps) }) },
    { key: 'burn', bps: FACTS.fee.burnBps, label: t('ld.ar.burn', { pct: pct(FACTS.fee.burnBps) }) },
    { key: 'team', bps: FACTS.fee.vaultBps, label: t('ld.ar.team', { pct: pct(FACTS.fee.vaultBps) }) },
  ];
  return (
    <section ref={plate} className="ld-plate ld-arenas" id="arenas" aria-labelledby="ld-arenas-h">
      <i className="ld-rule" aria-hidden="true" />
      <div className="ld-wrap">
        <div ref={head} className="ld-arenas__head">
          <h2 className="ld-h2 rv-h" id="ld-arenas-h">
            {t('ld.ar.h')}
          </h2>
          <div className="ld-arenas__aside rv-b">
            <StatusPill tone={open.tone}>{open.text}</StatusPill>
            <p>{t('ld.ar.body')}</p>
          </div>
        </div>
        <ol ref={stairs} className="ld-stairs">
          {DEFAULT_ARENAS.map((a, i) => {
            const meta = arenaMeta(a.id);
            const look = STAIR[i % STAIR.length];
            const price = formatUsdCents(a.usdCents).replace(/\.00$/, '');
            return (
              <li key={a.id} className={`ld-stair${a.holdersOnly ? ' is-holders' : ''}`} style={v({ '--step': i, '--ink-a': meta.ink, '--ink-b': meta.inkTo ?? meta.ink })}>
                <div className="ld-stair__coin" aria-hidden="true">
                  {i === 0 && <span className="kb-tag ld-stair__you">{t('ld.ar.you')}</span>}
                  {a.holdersOnly && (
                    <span className="ld-stair__crown">
                      <Icon name="crown" size={22} />
                    </span>
                  )}
                  <CoinCharacter paint={look.paint} mood={look.mood} size={look.size} feet ground bob={i === STAIR.length - 1} />
                </div>
                <div className="ld-ticket">
                  <h3 className="ld-ticket__name">
                    <span className="num ld-ticket__fee">{price}</span> <span className="ld-ticket__room">Room</span>
                  </h3>
                  {a.holdersOnly && (
                    <p className="ld-ticket__line">
                      <Icon name="crown" size={14} /> {t('ld.ar.holdersTag')}
                    </p>
                  )}
                  <span className="mono ld-ticket__stub">{t('ld.ar.stub')}</span>
                </div>
                <div className="ld-stair__step" aria-hidden="true" />
              </li>
            );
          })}
        </ol>
        {/* the fee: straight on the night, no card. One line says it, the bar shows where the profit goes */}
        <div ref={fee} className="ld-fee rv-v">
          <div className="ld-fee__copy">
            <h3 className="ld-fee__t">{t('ld.ar.feeT', { fee: pct(feeBps) })}</h3>
            <p className="ld-fee__n">{t('ld.ar.feeN')}</p>
          </div>
          <div className="ld-fee__split">
            <div className="ld-feebar" role="img" aria-label={split.map((p) => p.label).join(', ')}>
              {split.map((p) => (
                <span key={p.key} className={`ld-feebar__seg is-${p.key}`} style={{ flexGrow: p.bps }}>
                  {p.key === 'burn' && <Icon name="flame" size={14} />}
                </span>
              ))}
            </div>
            <ul className="ld-feebar__keys" aria-hidden="true">
              {split.map((p) => (
                <li key={p.key} className={`is-${p.key}`}>
                  <i />
                  {p.label}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── questions ────────────────────────────────────────────────────────── */

/** Bubbles rising through the pond: x and y (% of the water), size in px, delay in s. Every third is a little coin. */
const BUBBLES: [number, number, number, number][] = [
  [9, 34, 12, 0],
  [27, 20, 14, 5.2],
  [4, 52, 10, 8.8],
  [95, 36, 12, 1.4],
];

/**
 * The questions, on a moonlit pond: the cream coin is the moon over the horizon, its light lies on the water, which
 * deepens in three rows of scales down to a pebble shore (where the nap coin falls asleep). The questions float on it
 * in one straight column. The scene is decoration (aria-hidden); its loops stop off screen and under reduced motion.
 */
function Faq({ handle, doors }: { handle: string; doors: Doors }) {
  const t = useT();
  const plate = usePlate(BITE_GULP_MS);
  const side = useReveal<HTMLDivElement>();
  const list = useRef<HTMLDivElement>(null);
  // the scene's loops (the moon's bob, the bubbles, the boat) stop off screen; the heading's one-shot print-in is left
  // out of it, so it always runs to the end
  const [pond, awake] = useOffscreenPause<HTMLDivElement>();
  const paused = !awake || undefined;
  const tags = {
    x: (c: ReactNode) => (
      <a href={xProfile(handle)} target="_blank" rel="noreferrer">
        {c}
      </a>
    ),
    docs: (c: ReactNode) => <Link href="/docs">{c}</Link>,
    collab: (c: ReactNode) => <Link href="/collab">{c}</Link>,
    perks: (c: ReactNode) => <a href="#why-nft">{c}</a>,
  };
  // the most asked first: is it open, what it costs, the NFT. The team asked for the NFT's questions here (what it
  // gives, how many, is each one different); their answers add what the NFT section above does not say. "Is the game
  // open?" only while it is closed, the collab question only with its page; the last answer sends the visitor to the
  // guide for every rule
  const asked = [5, 6, 11, 9, 12, 10, 1, 2, 7, 8].filter((n) => (n !== 5 || !doors.game) && (n !== 7 || doors.collab));
  const items: { q: string; a: ReactNode }[] = asked.map((n) => ({
    q: t(`ld.faq.q${n}` as TKey, { chain: plainChainName(activeChain().name) }),
    a: renderRich(t(`ld.faq.a${n}` as TKey, { handle: `@${handle}`, sym: SYMBOL, chain: plainChainName(activeChain().name), supply: NFT_SUPPLY.toLocaleString('en-US') }), tags),
  }));
  // re-arm when a card is remounted (its key is the question, which carries the chain's name)
  useRevealEach(list, '.ld-qa', items.map((f) => f.q).join('\n'));
  return (
    <section ref={plate} className="ld-plate ld-faq has-bite" style={biteVars(BITES.faq)} id="faq" aria-labelledby="ld-faq-h">
      <i className="ld-rule" aria-hidden="true" />
      <BiteSeam at="faq" />
      <div ref={pond} className="ld-wrap ld-faq__grid">
        <div ref={side} className="ld-faq__side">
          <div>
            <h2 className="ld-h2 rv-h" id="ld-faq-h">
              {t('ld.faq.h')}
            </h2>
          </div>
          <span className="ld-faq__coin" aria-hidden="true" data-paused={paused}>
            <GazeCoin paint="cream" mood="open" size={120} look={[2, 3]} bob />
          </span>
        </div>
        <div className="ld-faq__water" aria-hidden="true" data-paused={paused}>
          <span className="ld-faq__glint">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <i key={i} style={v({ '--i': i })} />
            ))}
          </span>
          {BUBBLES.map(([x, y, s, d], i) => (
            <i key={i} className={`ld-faq__bubble${i % 3 === 2 ? ' is-coin' : ''}`} style={v({ '--x': `${x}%`, '--y': `${y}%`, '--s': `${s}px`, '--d': `${-d}s` })} />
          ))}
          <span className="ld-faq__boat">
            <svg className="ld-faq__boat-art" viewBox="0 0 120 72" focusable="false">
              <path className="is-lit" d="M44 6 L18 44 H44Z" />
              <path className="is-shade" d="M44 6 V44 H70Z" />
              <path className="is-ink" d="M44 6 L18 44 H70Z M44 9 V43" />
            </svg>
            <span className="ld-faq__boat-coin">
              <CoinCharacter paint="cyan" mood="happy" size={44} blink={false} />
            </span>
            <svg className="ld-faq__boat-art" viewBox="0 0 120 72" focusable="false">
              <path className="is-lit" d="M4 42 H116 L96 68 H24Z" />
              <path className="is-shade" d="M60 42 H116 L96 68 H60Z" />
              <path className="is-ink" d="M4 42 H116 L96 68 H24Z M60 44 L60 66" />
            </svg>
          </span>
          <span className="ld-faq__peek">
            <span className="ld-faq__peek-coin">
              <CoinCharacter paint="coral" mood="smug" size={64} look={[4, 1]} phase={1.1} />
            </span>
            <FoodBit kind="seed" paint="sun" size={16} glow className="ld-faq__seed" />
            <FoodBit kind="seed" paint="foam" size={12} className="ld-faq__seed" />
          </span>
          <span className="ld-faq__shore" />
        </div>
        <div ref={list} className="ld-faq__list">
          {items.map((f) => (
            <details key={f.q} className="ld-qa">
              <summary className="ld-qa__q">
                <span className="ld-qa__text">{f.q}</span>
                <span className="ld-qa__plus" aria-hidden="true" />
              </summary>
              <div className="ld-qa__a">{f.a}</div>
            </details>
          ))}
        </div>
      </div>
      <NapSeam />
    </section>
  );
}

/** `/`: the landing, from day into night. It links only to what the admin has opened (`useDoors`). */
export function Landing() {
  const { settings } = useSiteSettings();
  const doors = useDoors();
  const sound = useLandingSound();
  const t = useT();
  // only the part of the page on screen keeps its idle loops running
  const main = useRef<HTMLElement>(null);
  useIdleBudget(main);
  // a shared link to a part of the page (/#nft, /#why-nft, /#faq): the browser's own jump came before the sections
  // rendered, so it lands at the top; jump once they are there (the plates' scroll margin clears the header)
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    const raf = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior }));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <Kb theme="paper" className="st-root ld-root">
      <a className="st-skip" href="#main">
        {t('site.skip')}
      </a>
      <SiteHeader>
        <SeedRail />
      </SiteHeader>
      <main ref={main} id="main" className="ld-main" tabIndex={-1}>
        <Hero doors={doors} gameAccess={settings.gameAccess} handle={settings.xHandle} sound={sound} />
        <Feast />
        <Round live={doors.game && settings.gameAccess !== 'maintenance'} />
        <DuskSeam />
        <Kb theme="night" className="ld-night">
          <Arenas gameAccess={doors.loaded ? settings.gameAccess : 'admins'} />
          <Nft doors={doors} />
          <Faq handle={settings.xHandle.replace(/^@/, '')} doors={doors} />
        </Kb>
      </main>
      <SiteFooter />
    </Kb>
  );
}
