export interface EmoteDef {
  id: number;
  key: string;
  /** The emoji drawn on the bar and over the coin (the platform's own emoji font). */
  emoji: string;
  /** Plain-text fallback (chat feed, screen readers). */
  text: string;
  label: string;
}

/**
 * Quick emotes: plain emoji, the ones people actually throw at the coin they just ate (laughing,
 * shades, the crown, fuming, cursing, crying, the clown). Ids never change meaning on the wire; the
 * old sticker ids (0..15) still render, as emoji, for anything that sends them. The bar shows
 * `EMOTE_BAR` in key order (keys 1-8).
 */
export const EMOTES: readonly EmoteDef[] = [
  { id: 0, key: 'gm', emoji: '👋', text: 'GM', label: 'Wave' },
  { id: 1, key: 'wagmi', emoji: '🙌', text: 'WAGMI', label: 'WAGMI' },
  { id: 2, key: 'rocket', emoji: '🚀', text: 'To the moon', label: 'To the moon' },
  { id: 3, key: 'diamond', emoji: '💎', text: 'Diamond hands', label: 'Diamond hands' },
  { id: 4, key: 'cry', emoji: '😭', text: 'Crying', label: 'Crying' },
  { id: 5, key: 'yum', emoji: '😋', text: 'Yum', label: 'Yum' },
  { id: 6, key: 'salute', emoji: '🫡', text: 'Salute', label: 'Salute' },
  { id: 7, key: 'love', emoji: '❤️', text: 'Love', label: 'Love' },
  { id: 8, key: 'cursing', emoji: '🤬', text: '#@$!', label: 'Cursing' },
  { id: 9, key: 'fuming', emoji: '😡', text: 'Fuming', label: 'Fuming' },
  { id: 10, key: 'cool', emoji: '😎', text: 'Too cool', label: 'Too cool' },
  { id: 11, key: 'lol', emoji: '😂', text: 'LOL', label: 'LOL' },
  { id: 12, key: 'rofl', emoji: '🤣', text: 'ROFL', label: 'ROFL' },
  { id: 13, key: 'dead', emoji: '💀', text: 'Dead', label: 'Dead' },
  { id: 14, key: 'eyeroll', emoji: '🙄', text: 'Eye roll', label: 'Eye roll' },
  { id: 15, key: 'loser', emoji: '🤡', text: 'Clown', label: 'Clown' },
  { id: 16, key: 'king', emoji: '👑', text: 'King', label: 'King' },
];

/** The bar, in key order (keys 1-8). */
export const EMOTE_BAR: readonly number[] = [11, 12, 10, 16, 9, 8, 4, 15];

/** The emote id key `slot` (0..7, keys 1-8) fires; null when there is none. */
export function emoteForSlot(slot: number): number | null {
  return EMOTE_BAR[slot] ?? null;
}

/** The emoji of emote `id` (falls back to the first). */
export function emoteEmoji(id: number): string {
  return (EMOTES[id] ?? EMOTES[0]).emoji;
}

export const EMOTE_DURATION_MS = 2600;
