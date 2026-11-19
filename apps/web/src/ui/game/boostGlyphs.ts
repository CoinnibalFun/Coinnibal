import type { BoostKind } from '@coinnibal/shared';

/**
 * Bought power-up glyphs in the icon set's hand (24 grid, round 2.2 px strokes): the in-game buttons (`BoostBar`), the
 * shop and the player guide draw the same picture. A module of its own, with no runtime import, so the guide on `/docs`
 * pulls no game code for it.
 */
export const BOOST_PATH: Record<BoostKind, string> = {
  magnet: 'M6.5 4.5v8a5.5 5.5 0 0 0 11 0v-8h-3.6v8a1.9 1.9 0 0 1-3.8 0v-8zM6.5 8.2h3.6M13.9 8.2h3.6',
  // a hop: the arc off the ground line, an arrowhead where it lands
  leap: 'M3 20.5h6M5 17.5C6.8 10.2 13 6.6 19.2 8.6M15.4 5 19.2 8.6l-4.3 2.6',
  speed: 'M13.5 2.8L5.8 13.2h5.4l-1.4 8 7.9-10.6h-5.5z',
  // an eye with a slash through it
  invis: 'M2.8 12s3.4-6.2 9.2-6.2 9.2 6.2 9.2 6.2-3.4 6.2-9.2 6.2S2.8 12 2.8 12zM12 9.4a2.6 2.6 0 1 1 0 5.2a2.6 2.6 0 1 1 0-5.2zM4.2 19.8 19.8 4.2',
};
