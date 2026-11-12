import { ELYSIUM, SHADE } from '@elymum/shared';
import { useId, type CSSProperties, type ReactElement } from 'react';
import { BITTEN_COIN, MARK_C, WORD_COIN_SCALE, WORD_H, WORD_LETTERS, WORD_W, type BrandLetter } from './brandShapes';

const BRUSH = 24;
const EDGE = 6;
const SHADOW = 5;

export type WordmarkPaint = 'cyan' | 'sun' | 'cream' | 'foam';

export interface WordmarkProps {
  /** Rendered height in px; width follows (about 5.2 × height). Default 96. */
  height?: number;
  /** Letter paint (default cyan). */
  paint?: WordmarkPaint;
  /** Accessible name (default "Coinnibal"). */
  title?: string;
  /** Letters hop one after another on hover (and once on mount). Ignored with `diecut`. */
  playful?: boolean;
  /**
   * Cut out like a sticker: a cream border with its own ink edge and shadow
   * around the whole word. Use it when the wordmark sits straight on the night
   * page or on a photo, where the ink outline alone would disappear.
   */
  diecut?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * The coin "O" of the wordmark: the bitten coin (gold, or cyan on a gold word) with the letters' outline weight and
 * hard shadow, in a letter's 80 x 112 cell.
 */
function WordCoin({ paint, clip }: { paint: WordmarkPaint; clip: string }): ReactElement {
  const ink = ELYSIUM.abyss;
  const coin = paint === 'sun' ? 'cyan' : 'sun';
  const k = WORD_COIN_SCALE;
  const edge = (EDGE / k) * 1.2;
  return (
    <g transform={`translate(40 56) scale(${k})`}>
      <clipPath id={clip}>
        <path d={BITTEN_COIN} />
      </clipPath>
      <path d={BITTEN_COIN} fill={ink} stroke={ink} strokeWidth={EDGE / k} transform={`translate(${SHADOW / k} ${SHADOW / k})`} />
      <path d={BITTEN_COIN} fill={SHADE[coin]} />
      <circle cx={-5} cy={-7} r={44} fill={ELYSIUM[coin]} clipPath={`url(#${clip})`} />
      <circle r={30} fill="none" stroke={SHADE[coin]} strokeWidth={4} />
      <path d="M-36 -10 A37 37 0 0 1 -18 -32" stroke="#FFFFFF" strokeWidth={6} opacity={0.85} />
      <path d={BITTEN_COIN} stroke={ink} strokeWidth={edge} />
    </g>
  );
}

/** The skeleton of a letter for the die-cut halo (the coin "O" is a fat dot there). */
const haloPath = (l: BrandLetter): string => l.d ?? 'M40 56 h0.1';

/**
 * The hand-built COINNIBAL wordmark: chunky cyan brush letters, ink stroke, hard offset shadow, and a gold coin with a
 * bite taken out of it for the "O" (coins that eat coins).
 */
export function Wordmark({ height = 96, paint = 'cyan', title = 'Coinnibal', playful = true, diecut = false, className, style }: WordmarkProps): ReactElement {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const lit = ELYSIUM[paint];
  const shade = SHADE[paint];
  const ink = ELYSIUM.abyss;
  const pad = diecut ? 13 : 0;
  const vbW = WORD_W + pad * 2;
  const vbH = WORD_H + pad * 2;
  const hop = playful && !diecut;
  const place = (l: BrandLetter, children: ReactElement) => (
    <g transform={`translate(${l.x} ${l.dy}) rotate(${l.rot} 40 56)`}>{children}</g>
  );
  const HALO = BRUSH + EDGE + 26;
  // the coin "O" gets a fat dot of halo: its radius matches the coin's
  const haloWidth = (l: BrandLetter, extra: number) => (l.d ? HALO + extra : 46 * WORD_COIN_SCALE * 2 + 26 + extra);
  return (
    <svg
      className={`kb-wordmark${hop ? ' kb-wordmark--playful' : ''}${className ? ` ${className}` : ''}`}
      viewBox={`${-6 - pad} ${-4 - pad} ${vbW} ${vbH}`}
      height={height}
      width={(height * vbW) / vbH}
      role="img"
      aria-label={title}
      style={style}
      focusable="false"
    >
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {diecut && (
          <g>
            {WORD_LETTERS.map((l, i) => (
              <g key={`s${i}`}>{place(l, <path d={haloPath(l)} stroke={ink} strokeWidth={haloWidth(l, 6)} transform="translate(6 6)" />)}</g>
            ))}
            {WORD_LETTERS.map((l, i) => (
              <g key={`o${i}`}>{place(l, <path d={haloPath(l)} stroke={ink} strokeWidth={haloWidth(l, 6)} />)}</g>
            ))}
            {WORD_LETTERS.map((l, i) => (
              <g key={`c${i}`}>{place(l, <path d={haloPath(l)} stroke={ELYSIUM.cream} strokeWidth={haloWidth(l, 0)} />)}</g>
            ))}
          </g>
        )}
        {WORD_LETTERS.map((l, i) => (
          <g key={i} transform={`translate(${l.x} ${l.dy})`}>
            <g className="kb-wordmark__letter" style={{ transformOrigin: '40px 56px', animationDelay: `${i * 60}ms` } as CSSProperties}>
              <g transform={`rotate(${l.rot} 40 56)`}>
                {l.d ? (
                  <>
                    <path d={l.d} stroke={ink} strokeWidth={BRUSH + EDGE} transform={`translate(${SHADOW} ${SHADOW})`} />
                    <path d={l.d} stroke={ink} strokeWidth={BRUSH + EDGE} />
                    <path d={l.d} stroke={shade} strokeWidth={BRUSH} />
                    <path d={l.d} stroke={lit} strokeWidth={BRUSH - 5} transform="translate(-1.6 -1.8)" />
                    {l.shine && <path d={l.shine} stroke={ELYSIUM.mist} strokeWidth={4.5} transform="translate(5 0)" />}
                  </>
                ) : (
                  <WordCoin paint={paint} clip={`kb-wm-${uid}-${i}`} />
                )}
              </g>
            </g>
          </g>
        ))}
      </g>
    </svg>
  );
}

export interface CoinMarkProps {
  /** Rendered size in px (default 48). */
  size?: number;
  /** Coin paint (default cyan). */
  paint?: 'cyan' | 'sun' | 'teal';
  /** Accessible name; omit when a visible "Coinnibal" sits next to it. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * The compact mark: a coin with a bite taken out of its upper right edge and a fat cream C pressed into it, ink
 * outline and one hard shade. Used for the favicon, the nav and small brand spots.
 */
export function CoinMark({ size = 48, paint = 'cyan', title, className, style }: CoinMarkProps): ReactElement {
  const ink = ELYSIUM.abyss;
  const clip = `kb-coinmark-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  return (
    <svg
      className={`kb-coinmark${className ? ` ${className}` : ''}`}
      viewBox="-56 -56 116 116"
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      style={style}
    >
      <clipPath id={clip}>
        <path d={BITTEN_COIN} />
      </clipPath>
      <path d={BITTEN_COIN} fill={ink} transform="translate(4 4)" />
      <path d={BITTEN_COIN} fill={SHADE[paint]} />
      <circle cx={-5} cy={-7} r={45} fill={ELYSIUM[paint]} clipPath={`url(#${clip})`} />
      <circle r={36} fill="none" stroke={SHADE[paint]} strokeWidth={3} clipPath={`url(#${clip})`} />
      <path d="M-36 -10 A37 37 0 0 1 -18 -32" stroke="#FFFFFF" strokeWidth={5} fill="none" strokeLinecap="round" opacity={0.85} />
      <path d={BITTEN_COIN} fill="none" stroke={ink} strokeWidth={5} strokeLinejoin="round" />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" transform="translate(-4 4)">
        <path d={MARK_C} stroke={ink} strokeWidth={22} transform="translate(3 3)" />
        <path d={MARK_C} stroke={ink} strokeWidth={22} />
        <path d={MARK_C} stroke={ELYSIUM.cream} strokeWidth={14} />
      </g>
    </svg>
  );
}

export interface ChompMarkProps {
  /** Rendered size in px (default 48). */
  size?: number;
  /** Accessible name; omit when the link around it already names the brand. */
  title?: string;
  className?: string;
}

/** The C of the chomp mark: a thick ring open to the right, its two ends the jaws (drawn with a round pen). */
const CHOMP_C = 'M19.3 -23 A30 30 0 1 0 19.3 23';
/** Two fangs on each jaw, pointing at the coin between them. */
const CHOMP_TEETH = 'M12 -9 L15.5 0 L19.5 -9.5Z M21.5 -10 L24.5 -2 L28 -10.5Z M12 9 L15.5 0 L19.5 9.5Z M21.5 10 L24.5 2 L28 10.5Z';

/**
 * The phone logo, standing alone where the word does not fit: the C of Coinnibal is a mouth. Its two ends are fanged
 * jaws closing on a small gold coin that stares back, terrified; a hungry eye under a hungry brow watches its dinner
 * and crumbs fly off the bite. It reads as a C at a glance and tells the whole game (coins that eat coins) on a
 * closer look. The eye blinks now and then and the crumbs bob (none of it with reduced motion); hovering or pressing
 * it makes the coin squirm.
 */
export function ChompMark({ size = 48, title, className }: ChompMarkProps): ReactElement {
  const ink = ELYSIUM.abyss;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const lit = `kb-chomp-lit-${uid}`;
  const inside = `kb-chomp-in-${uid}`;
  return (
    <svg
      className={`kb-chomp${className ? ` ${className}` : ''}`}
      viewBox="-52 -54 114 112"
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <clipPath id={lit}>
        <circle cx={-8} cy={-10} r={42} />
      </clipPath>
      <clipPath id={inside}>
        <circle r={22} />
      </clipPath>
      {/* inside the mouth: dark, with a pink tongue */}
      <circle r={22} fill={ink} />
      <ellipse cx={2} cy={14} rx={14} ry={7} fill={ELYSIUM.blush} clipPath={`url(#${inside})`} />
      {/* dinner: a small gold coin caught between the jaws, wide-eyed */}
      <g className="kb-chomp__prey">
        <circle cx={35} cy={0} r={12.5} fill={ELYSIUM.sun} stroke={ink} strokeWidth={4} />
        <circle cx={35} cy={0} r={7.5} fill="none" stroke={SHADE.sun} strokeWidth={2.5} />
        <circle cx={37.5} cy={-2.5} r={2.8} fill="#FFFFFF" stroke={ink} strokeWidth={1.6} />
        <circle cx={43.5} cy={-2.5} r={2.8} fill="#FFFFFF" stroke={ink} strokeWidth={1.6} />
        <ellipse cx={40.5} cy={5} rx={1.8} ry={2.4} fill={ink} />
      </g>
      {/* the crumbs of the bite */}
      <g className="kb-chomp__crumbs" fill={ELYSIUM.sun} stroke={ink} strokeWidth={2.5}>
        <circle className="kb-chomp__crumb" cx={53} cy={-15} r={4} />
        <circle className="kb-chomp__crumb" cx={46} cy={-26} r={2.8} />
        <circle className="kb-chomp__crumb" cx={54} cy={13} r={3} />
      </g>
      {/* the C: ink shadow, outline, shade, lit face, shine */}
      <g className="kb-chomp__body" fill="none" strokeLinecap="round">
        <path d={CHOMP_C} stroke={ink} strokeWidth={33} transform="translate(4 4)" />
        <path d={CHOMP_C} stroke={ink} strokeWidth={33} />
        <path d={CHOMP_C} stroke={SHADE.cyan} strokeWidth={24} />
        <path d={CHOMP_C} stroke={ELYSIUM.cyan} strokeWidth={24} clipPath={`url(#${lit})`} />
        <path d="M-35 12 A36 36 0 0 1 -30 -18" stroke="#FFFFFF" strokeWidth={4.5} opacity={0.85} />
      </g>
      {/* the jaws' fangs, sunk into the coin */}
      <path className="kb-chomp__teeth" d={CHOMP_TEETH} fill="#FFFFFF" stroke={ink} strokeWidth={2.2} strokeLinejoin="round" />
      {/* the hungry eye on top of the C, looking down at dinner, under a hungry brow */}
      <g className="kb-chomp__eyes">
        <circle cx={-10} cy={-28} r={10.5} fill="#FFFFFF" stroke={ink} strokeWidth={4} />
        <circle cx={-6} cy={-25.5} r={5} fill={ink} />
        <circle cx={-4.5} cy={-27.2} r={1.5} fill="#FFFFFF" />
      </g>
      <path d="M-24 -44 L1 -37" fill="none" stroke={ink} strokeWidth={5} strokeLinecap="round" />
    </svg>
  );
}
