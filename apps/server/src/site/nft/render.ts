/** One entry point for both emblem styles (the collection picks one; `?style=` previews the other). */
import { pixelSvg } from './pixel';
import type { Genome } from './traits';
import { vectorSvg } from './vector';

export const ART_STYLES = ['vector', 'pixel'] as const;
export type ArtStyle = (typeof ART_STYLES)[number];

/** The default style (docs/NFT-DESIGN.md, "Style comparison"). */
export const DEFAULT_ART_STYLE: ArtStyle = 'vector';

export function parseArtStyle(v: string | null | undefined): ArtStyle | null {
  return (ART_STYLES as readonly string[]).includes(v ?? '') ? (v as ArtStyle) : null;
}

/** The emblem of a genome as a 512 × 512 SVG; `id` labels the frame. */
export function renderEmblem(g: Genome, id: number | null, style: ArtStyle): string {
  return style === 'pixel' ? pixelSvg(g, id) : vectorSvg(g, id);
}
