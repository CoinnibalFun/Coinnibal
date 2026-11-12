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
