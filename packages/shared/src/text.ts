import { MAX_CHAT_LENGTH, MAX_NAME_LENGTH } from './constants';

// Control chars, zero-width / bidi overrides and other invisible troublemakers.
// eslint-disable-next-line no-control-regex
// controls, zero-width / bidi marks, plus the blank "letters" that render as nothing (Hangul fillers,
// the combining grapheme joiner, the Mongolian vowel separator, the Arabic letter mark, the braille blank)
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F͏؜ᅟᅠ᠎⠀ㅤﾠ​-‏‪-‮⁠-⁯﻿]/g;

/** Take at most `max` user-perceived characters (code points). */
function takeCodePoints(s: string, max: number): string {
  return Array.from(s).slice(0, max).join('');
}

/** Look-alikes folded before the reserved-name check (digits and symbols that read as letters). */
const LOOKALIKE: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '|': 'l', '!': 'i' };
/** Words no player name may be (the system speaker of the chat, staff roles). */
const RESERVED_WORDS = new Set(['admin', 'admins', 'administrator', 'moderator', 'mod', 'mods', 'support', 'official', 'system', 'staff', 'helpdesk']);

/**
 * Names that impersonate the game or its staff: anything spelling "Coinnibal" or its name before the rename, "Elymum" (also
 * "C0innibal", "COINNIBAL Support", "c.o.i.n.n.i.b.a.l", "E1ymum"), and names made of a staff word ("Admin", "Support", "Official Mod"). Case, accents, full-width
 * letters, separators and digit look-alikes are folded first.
 */
export function isReservedName(name: string): boolean {
  const folded = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[0-9@$|!]/g, (c) => LOOKALIKE[c] ?? c);
  const letters = folded.replace(/[^\p{L}]/gu, '');
  if (letters.includes('elymum') || letters.includes('coinnibal')) return true;
  const words = folded.split(/[^\p{L}]+/u).filter(Boolean);
  return words.length > 0 && words.length <= 3 && words.some((w) => RESERVED_WORDS.has(w));
}

/** What a player who set no name is called, before the tag `defaultName` adds. */
const DEFAULT_NAME = 'Coinie';

/**
 * The name of a player who set none (or none usable): "Coinie-" and four hex digits drawn from `seed` (FNV-1a over it,
 * any case), e.g. "Coinie-3f2a". The seed is the signed-in wallet, else the browser's own tag (a guest) or, on the
 * server, the connection: players who never picked a name are told apart (one bare "Coinie" for everyone made the kill
 * feed read "you had you for lunch"). The same seed always gives the same name, on the client and on the server. The
 * tag is hex, so the name is never reserved (`isReservedName`) and fits `MAX_NAME_LENGTH`.
 */
export function defaultName(seed: string): string {
  let h = 0x811c9dc5;
  const s = seed.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${DEFAULT_NAME}-${((h >>> 16) ^ (h & 0xffff)).toString(16).padStart(4, '0')}`;
}

/**
 * Cleans a player name; returns `fallback` when nothing usable remains or the name is reserved (`isReservedName`).
 * A player's name falls back to their own `defaultName`, never to one word every such player would share.
 */
export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = takeCodePoints(raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim(), MAX_NAME_LENGTH).trim();
  return cleaned.length > 0 && !isReservedName(cleaned) ? cleaned : fallback;
}

/** Cleans a chat line; returns '' when nothing is left. */
export function sanitizeChat(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return takeCodePoints(raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim(), MAX_CHAT_LENGTH).trim();
}

/** UTF-8 byte length (profile names are limited to 16 bytes). */
export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(s: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const len = utf8Length(ch);
    if (bytes + len > maxBytes) break;
    out += ch;
    bytes += len;
  }
  return out;
}

/** Shortens an EVM address: 0x12Ab…9fE0 (`head` counts the `0x`). */
export const shortAddress = (addr: string, head = 6, tail = 4): string =>
  addr.length <= head + tail + 1 ? addr : `${addr.slice(0, head)}…${addr.slice(-tail)}`;

/** English ordinal: 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st (the place on a final board, a share card). */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}
