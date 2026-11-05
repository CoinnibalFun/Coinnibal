/**
 * "Your own music" was removed. Earlier visits may have kept the player's file in this browser's
 * IndexedDB (`elymum.music`): delete that database once at start so the copy does not linger.
 * Guarded: in a private window or with storage blocked there is nothing to do.
 */
export function forgetSavedMusic(): void {
  try {
    if (typeof indexedDB === 'undefined') return;
    const req = indexedDB.deleteDatabase('elymum.music');
    req.onerror = () => {};
    req.onblocked = () => {};
  } catch {
    /* storage blocked */
  }
}
