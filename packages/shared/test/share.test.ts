import { describe, expect, it } from 'vitest';
import { CUSTOM_LIMITS, PRACTICE_ROOM, SHARE_ID_RE, ordinal, practiceRoomConfig, shareIntentUrl, validateCustomConfig } from '../src';

describe('share on X and practice rooms (shared rules)', () => {
  it('builds the X web intent with the text and the card link, encoded', () => {
    const u = new URL(shareIntentUrl('I just ate Ann & Bo on Elymum!', 'https://elymum.io/share/AbCdE12345'));
    expect(u.origin + u.pathname).toBe('https://x.com/intent/post');
    expect(u.searchParams.get('text')).toBe('I just ate Ann & Bo on Elymum!');
    expect(u.searchParams.get('url')).toBe('https://elymum.io/share/AbCdE12345');
    expect(SHARE_ID_RE.test('AbCdE12345')).toBe(true);
    expect(SHARE_ID_RE.test('AbCdE1234')).toBe(false);
    expect(SHARE_ID_RE.test('AbCdE1234/')).toBe(false);
  });

  it('writes English ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  });

  it('a practice room is a valid free custom room with bots', () => {
    const c = practiceRoomConfig();
    expect(validateCustomConfig(c)).toEqual({ ok: true, config: c });
    expect(c).toMatchObject({ kind: 'free', arenaId: null, bots: PRACTICE_ROOM.bots, maxPlayers: PRACTICE_ROOM.maxPlayers, durationMin: PRACTICE_ROOM.durationMin, mapSize: 'auto' });
    expect(c.bots).toBeLessThanOrEqual(CUSTOM_LIMITS.botsMax);
  });
});
