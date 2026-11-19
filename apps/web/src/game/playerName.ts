import { defaultName, sanitizeName } from '@coinnibal/shared';
import { storageKey } from '../storageKey';

/**
 * localStorage key: this browser's own random tag, the seed of a guest's default name. It is drawn for the name only
 * (not the integrity fingerprint's id) and never leaves the browser: the name carries four hex digits of its hash.
 */
export const NAME_TAG_KEY = storageKey('nameTag.v1');

/** Storage can be blocked (private mode, sandboxed frames): then the tag is kept for this page only. */
let tagHere: string | null = null;

function drawTag(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** This browser's tag, drawn on first use. */
function browserTag(): string {
  try {
    let tag = localStorage.getItem(NAME_TAG_KEY);
    if (!tag || !/^[0-9a-f]{16}$/.test(tag)) {
      tag = drawTag();
      localStorage.setItem(NAME_TAG_KEY, tag);
    }
    return tag;
  } catch {
    return (tagHere ??= drawTag());
  }
}

/**
 * The name a join sends: the one the player chose, cleaned the way the server cleans it (`sanitizeName`); none (or
 * none usable) is "Coinie" and a tag of the signed-in wallet, else of this browser (`defaultName`), so players who
 * never set a name are told apart. The server falls back the same way; the saved name is left as it is.
 */
export function joinName(chosen: string, wallet: string | null): string {
  return sanitizeName(chosen, defaultName(wallet ?? browserTag()));
}
