export type EmoteSet = 'hype' | 'trash';

export interface EmoteDef {
  id: number;
  key: string;
  text: string;
  label: string;
  /** The sticker page it sits on: "Hype" (ids 0..7) or "Trash talk" (ids 8..15). */
  set: EmoteSet;
}

/**
 * Quick emotes, drawn by the web as die-cut stickers (`text` is the plain-text fallback, no emoji).
 * Two pages of eight, keys 1-8 fire the page on show: "Hype" (ids 0..7, the first set) and
 * "Trash talk" (ids 8..15, appended in protocol v11; the old ids never change). PG-13: no obscene
 * gestures, no slurs.
 */
export const EMOTES: readonly EmoteDef[] = [
  { id: 0, key: 'gm', text: 'GM', label: 'GM', set: 'hype' },
  { id: 1, key: 'wagmi', text: 'WAGMI', label: 'WAGMI', set: 'hype' },
  { id: 2, key: 'rocket', text: 'To the moon', label: 'To the moon', set: 'hype' },
  { id: 3, key: 'diamond', text: 'Diamond hands', label: 'Diamond hands', set: 'hype' },
  { id: 4, key: 'cry', text: 'Rekt', label: 'Rekt', set: 'hype' },
  { id: 5, key: 'yum', text: 'Yum', label: 'Yum', set: 'hype' },
  { id: 6, key: 'salute', text: 'Salute', label: 'Salute', set: 'hype' },
  { id: 7, key: 'love', text: 'Love', label: 'Love', set: 'hype' },
  { id: 8, key: 'cursing', text: '#@$!', label: 'Cursing', set: 'trash' },
  { id: 9, key: 'fuming', text: 'Fuming', label: 'Fuming', set: 'trash' },
  { id: 10, key: 'cool', text: 'Too cool', label: 'Too cool', set: 'trash' },
  { id: 11, key: 'lol', text: 'LOL', label: 'LOL', set: 'trash' },
  { id: 12, key: 'rofl', text: 'ROFL', label: 'ROFL', set: 'trash' },
  { id: 13, key: 'dead', text: 'Dead', label: 'Dead', set: 'trash' },
  { id: 14, key: 'eyeroll', text: 'Eye roll', label: 'Eye roll', set: 'trash' },
  { id: 15, key: 'loser', text: 'Take the L', label: 'Take the L', set: 'trash' },
];

/** The sticker pages in bar order. */
export const EMOTE_SETS: readonly EmoteSet[] = ['hype', 'trash'];

/** Stickers on a page, in key order (keys 1-8). */
export function emotesOf(set: EmoteSet): readonly EmoteDef[] {
  return EMOTES.filter((e) => e.set === set);
}

/** The emote id key `slot` (0..7, keys 1-8) fires on page `set`; null when there is none. */
export function emoteForSlot(set: EmoteSet, slot: number): number | null {
  return emotesOf(set)[slot]?.id ?? null;
}

export const EMOTE_DURATION_MS = 2600;
