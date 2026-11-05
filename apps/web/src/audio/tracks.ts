/**
 * The soundtracks a player can pick (settings → Music). Kept apart from music.ts so the store can
 * validate a saved choice without pulling in the asset loader.
 *
 * - `classic`: the game's own soundtrack (lobby and room moods plus the last-minute tension layer);
 * - `chill`, `arcade`, `chiptune`, `lofi`: one loop each, the same in the lobby and the room
 *   (rendered by scripts/audio/music_tracks.py at the same loudness as the default).
 * "No music" is the music switch (`musicOn: false`), not a track. A saved choice that is no longer
 * offered (the removed "your own music", `custom`) reads as the default.
 */

export const BUILTIN_TRACKS = ['classic', 'chill', 'arcade', 'chiptune', 'lofi'] as const;
export type TrackId = (typeof BUILTIN_TRACKS)[number];
export type MusicChoice = TrackId;

export const DEFAULT_TRACK: TrackId = 'classic';

export function isMusicChoice(v: unknown): v is MusicChoice {
  return typeof v === 'string' && (BUILTIN_TRACKS as readonly string[]).includes(v);
}

/** A saved value, or the default when it is missing or no longer known. */
export function musicChoice(v: unknown): MusicChoice {
  return isMusicChoice(v) ? v : DEFAULT_TRACK;
}
