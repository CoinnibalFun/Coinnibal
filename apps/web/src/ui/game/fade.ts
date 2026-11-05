import { useEffect, useState } from 'react';

/** The feed and the chat fade to semi-transparent after this long without a new line (ms). */
export const FEED_FADE_MS = 6000;

/**
 * True once `FEED_FADE_MS` passed since `activity` last changed (a new kill or chat line) while nothing holds the
 * area awake (`held`: the pointer over it, focus inside it, the chat line open). A new line or `held` wakes it at
 * once; it fades again `FEED_FADE_MS` after the last of them.
 */
export function useIdleFade(activity: unknown, held: boolean, ms = FEED_FADE_MS): boolean {
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    setFaded(false);
    if (held) return;
    const id = setTimeout(() => setFaded(true), ms);
    return () => clearTimeout(id);
  }, [activity, held, ms]);
  return faded && !held;
}
