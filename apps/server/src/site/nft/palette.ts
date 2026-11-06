/**
 * The emblem palette: the Ring Storybook paints (`@elymum/shared`) plus a few curated material and tier
 * colours. Every colour an emblem uses comes from here (both styles), so a picture never invents a hue.
 */
import { ELYSIUM as E, SHADE as S } from '@elymum/shared';
import type { Material, Tier } from './traits';

export const INK = E.abyss;
export const CREAM = E.cream;
export const WHITE = '#FFFFFF';
export const BLUSH = E.blush;
export const P = {
  ...E,
  violet: '#9B7BD8',
  violetS: '#7458B0',
  violetL: '#C9B6F0',
  silver: '#D5DEE2',
  silverS: '#9FB0B8',
  rose: '#F0B1A0',
  roseS: '#D58776',
  jade: '#5FB58A',
  jadeS: '#3E8A5C',
  jadeL: '#A8DFC0',
  pearl: '#F4EFE6',
  pearlS: '#D9CFC3',
  obsidian: '#1E2E36',
  obsidianS: '#0B161B',
  obsidianL: '#36505C',
  crystal: '#C5ECF6',
  crystalS: '#8CCFE3',
  pink: '#F7B2D9',
  lilac: '#B9A6F2',
  lemon: '#F7E3A1',
  mintL: '#B9F2D0',
  copper: '#D9714F',
  copperS: '#B4553A',
  crust: '#5A2A1E',
  crustS: '#3A1912',
  moon: '#E9E6DA',
  moonS: '#C9C3B0',
  patina: '#7FB59A',
  tan: '#C9955A',
  tanS: '#A3713D',
} as const;
export const SHADES = S;

/** The holographic foil: five pastel bands, repeated. */
export const HOLO = [P.pink, P.lilac, P.foam, P.mintL, P.lemon] as const;

export type MaterialKind = 'paint' | 'metal' | 'stone' | 'pearl' | 'glass' | 'crystal' | 'holo' | 'molten' | 'void' | 'moon' | 'ancient';

export interface MaterialSpec {
  kind: MaterialKind;
  fill: string;
  shade: string;
  /** Secondary detail colour (veins, facets, reeding). */
  detail: string;
  /** Face line colour (cream on dark materials, so the mouth still reads). */
  face: string;
  /** Glow-eye colour. */
  glow: string;
  dark: boolean;
}

const m = (kind: MaterialKind, fill: string, shade: string, detail: string, dark = false, glow: string = E.sun): MaterialSpec => ({
  kind,
  fill,
  shade,
  detail,
  face: dark ? CREAM : INK,
  glow,
  dark,
});

export const MATERIAL_SPECS: Record<Material, MaterialSpec> = {
  Cyan: m('paint', E.cyan, S.cyan, S.cyan),
  Teal: m('paint', E.teal, S.teal, S.teal),
  Foam: m('paint', E.foam, S.foam, S.foam),
  Mint: m('paint', E.up, S.up, S.up),
  Cream: m('paint', E.cream, S.cream, S.cream),
  Copper: m('paint', P.copper, P.copperS, P.copperS),
  Silver: m('metal', P.silver, P.silverS, P.silverS),
  Gold: m('metal', E.sun, S.sun, S.sun),
  'Rose Gold': m('metal', P.rose, P.roseS, P.roseS),
  Jade: m('stone', P.jade, P.jadeS, P.jadeL),
  Pearl: m('pearl', P.pearl, P.pearlS, P.pink),
  Obsidian: m('glass', P.obsidian, P.obsidianS, P.obsidianL, true, E.spray),
  Crystal: m('crystal', P.crystal, P.crystalS, WHITE, false, E.cyan),
  Holographic: m('holo', P.lilac, P.violetS, WHITE, false, E.sun),
  'Molten Sun': m('molten', P.crust, P.crustS, E.sun, true, E.sun),
  Void: m('void', E.deep, P.obsidianS, E.spray, true, E.spray),
  Moonstone: m('moon', P.moon, P.moonS, P.moonS, false, E.foam),
  Prismatic: m('holo', P.pink, P.violetS, WHITE, false, E.cyan),
  'Ancient Gold': m('ancient', E.sun, S.sun, P.patina, false, E.sun),
};

/** Frame colours per tier: [band, band shade]. */
export const TIER_FRAME: Record<Tier, readonly [string, string]> = {
  Common: [E.cream, S.cream],
  Rare: [E.cyan, S.cyan],
  Epic: [P.violet, P.violetS],
  Legendary: [E.sun, S.sun],
  Mythic: [INK, INK],
};
