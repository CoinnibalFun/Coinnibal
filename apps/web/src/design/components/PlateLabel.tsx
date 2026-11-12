import type { HTMLAttributes, ReactNode } from 'react';

export interface PlateLabelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** The section's place in the page ("II" or 2): kept on the element as `data-plate`, not printed (plain copy, 2026-11). */
  numeral: string | number;
  /** The caption in Fraunces, e.g. "The Elymum NFT". */
  title: ReactNode;
  /** Right-hand mono note, e.g. "/mint". */
  aside?: ReactNode;
  /** Heading level for the title (default: not a heading, a caption). */
  level?: 2 | 3;
}

const ROMAN: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
function roman(n: number): string {
  let out = '';
  for (const [v, r] of ROMAN) while (n >= v) { out += r; n -= v; }
  return out;
}

/**
 * The caption between sections: "The Elymum NFT - - - - - /MINT". Ink rule on top, dashed
 * rule running to the aside.
 */
export function PlateLabel({ numeral, title, aside, level, className, ...rest }: PlateLabelProps) {
  const n = typeof numeral === 'number' ? roman(numeral) : numeral;
  const T = level ? (`h${level}` as const) : 'b';
  return (
    <div {...rest} data-plate={n} className={`kb-plate${className ? ` ${className}` : ''}`}>
      <T className="kb-plate__title">{title}</T>
      <span className="kb-plate__rule" aria-hidden="true" />
      {aside != null && <span className="kb-plate__aside">{aside}</span>}
    </div>
  );
}
