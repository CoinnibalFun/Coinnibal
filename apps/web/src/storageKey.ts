/**
 * The browser's storage keys (localStorage, sessionStorage): `coinnibal.<name>`.
 *
 * Before the rename (the project was called Elymum until November 2026) they were `elymum.<name>`. The first time a
 * key is used, a value this browser still keeps under the old key is moved to the new one (when the new one is
 * missing) and the old key is deleted, so nothing a player kept is lost: the session, the settings, the language, and
 * the shop's and the rooms' kept payments above all.
 */
const PREFIX = 'coinnibal.';
/** The keys' prefix before the rename: only read, to move a kept value to its new key. */
const OLD_PREFIX = 'elymum.';

/** `coinnibal.<name>` in `kind` storage, after moving a value kept under `elymum.<name>` there (see above). */
export function storageKey(name: string, kind: 'local' | 'session' = 'local'): string {
  const key = PREFIX + name;
  try {
    const store = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    if (store && store.getItem(key) === null) {
      const old = store.getItem(OLD_PREFIX + name);
      if (old !== null) {
        // the new key first: should it fail (a full storage), the old value stays where it is
        store.setItem(key, old);
        store.removeItem(OLD_PREFIX + name);
      }
    }
  } catch {
    /* no storage (a private window, a sandboxed frame): nothing to move */
  }
  return key;
}
