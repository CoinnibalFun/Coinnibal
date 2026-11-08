import { describe, expect, it } from 'vitest';
import {
  PlayerFlag,
  X_CODE_RE,
  decodeSnapshot,
  eatenLine,
  encodeSnapshot,
  isXHandle,
  parseXPostId,
  readSnapshot,
  xLinkIntentUrl,
  xMention,
  xPostTime,
  xSyndicationToken,
  type SnapshotData,
} from '../src';

describe('Link X helpers', () => {
  it('handles: 1-15 of A-Z a-z 0-9 _, nothing else', () => {
    for (const ok of ['a', 'Penny_Lane', '_', 'abcdefghijklmno']) expect(isXHandle(ok)).toBe(true);
    for (const bad of ['', '@penny', 'abcdefghijklmnop', 'pen ny', 'pen-ny', 'pénny', 'penny​', 'a.b', null, 5]) expect(isXHandle(bad)).toBe(false);
    expect(xMention('penny')).toBe('@penny');
    expect(xMention('@penny')).toBeNull();
  });

  it('post links: x.com / twitter.com status URLs or a bare id; the id only', () => {
    const id = '1854012345678901234';
    for (const ok of [id, `https://x.com/penny/status/${id}`, `https://twitter.com/penny/status/${id}?s=20&t=abc`, `x.com/penny/status/${id}`, `https://mobile.twitter.com/penny/status/${id}/`, `https://x.com/i/web/status/${id}`, `https://x.com/penny/status/${id}/photo/1`])
      expect(parseXPostId(ok)).toBe(id);
    for (const bad of ['', 'nope', `https://x.com.evil.com/a/status/${id}`, `https://evil.com/x.com/a/status/${id}`, `https://x.com/penny`, `https://x.com/penny/status/abc`, `ftp://x.com/a/status/${id}`, `https://x.com/a/status/${id}/likes`, '0123', 'a'.repeat(400), undefined])
      expect(parseXPostId(bad)).toBeNull();
  });

  it('the syndication token and the snowflake time', () => {
    expect(xSyndicationToken('20')).toBe(((20 / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''));
    const ms = Date.UTC(2026, 10, 8, 12, 0, 0);
    expect(xPostTime(String((BigInt(ms - 1288834974657) << 22n) | 5n))).toBe(ms);
    expect(xPostTime('20')).toBeNull();
  });

  it('the proof post and its code', () => {
    expect(X_CODE_RE.test('ELYMUM-7F3K9Q')).toBe(true);
    expect(X_CODE_RE.test('ELYMUM-7F3K9O')).toBe(false);
    expect(xLinkIntentUrl('ELYMUM-7F3K9Q')).toBe('https://x.com/intent/post?text=Linking%20my%20X%20to%20Elymum%3A%20ELYMUM-7F3K9Q%20elymum.io');
  });

  it('eaten lines name linked people by @handle, never bots, never an invalid handle', () => {
    expect(eatenLine([{ name: 'Penny', xHandle: 'penny_x' }, { name: 'Zed', bot: true, xHandle: 'zed' }, { name: '@Ed', xHandle: 'bad handle' }], 2)).toBe('@penny_x, Zed (BOT), Ed +2');
  });

  it('snapshots carry the handle (v14) for people only; both decoders agree', () => {
    const s: SnapshotData = {
      tick: 1,
      view: { x: 0, y: 0, h: 10 },
      players: [
        { id: 1, skin: 1, flags: 0, name: 'Penny', xHandle: 'penny_x', country: 'JP' },
        { id: 2, skin: 1, flags: PlayerFlag.Bot, name: 'Bot', isBot: true, xHandle: 'nope' },
        { id: 3, skin: 1, flags: PlayerFlag.XHandle, name: 'Ed', xHandle: 'not valid!' },
      ],
      upserts: [],
      removals: [],
    };
    const buf = encodeSnapshot(s);
    const d = decodeSnapshot(buf);
    expect(d.players.map((p) => p.xHandle)).toEqual(['penny_x', undefined, undefined]);
    expect(d.players[0].country).toBe('JP');
    expect(d.players.map((p) => (p.flags & PlayerFlag.XHandle) !== 0)).toEqual([true, false, false]);
    const seen: [number, string][] = [];
    readSnapshot(buf, {
      snapshotBegin() {},
      snapshotPlayer: (id, _skin, _flags, bytes, _at, _len, _avatarAt, _country, xAt, xLen) => {
        if (xAt >= 0) seen.push([id, new TextDecoder().decode(bytes.subarray(xAt, xAt + xLen))]);
      },
      snapshotUpsert() {},
      snapshotRemoval() {},
    });
    expect(seen).toEqual([[1, 'penny_x']]);
  });
});
