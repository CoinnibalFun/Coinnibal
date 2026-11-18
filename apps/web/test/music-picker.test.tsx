import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetLoader, assetUrls, type AssetUrls } from '../src/audio/assets';
import { Mixer, prefsFromSettings } from '../src/audio/mixer';
import { CROSSFADE, Music, TRACKS } from '../src/audio/music';
import { BUILTIN_TRACKS, musicChoice } from '../src/audio/tracks';
import { FakeGain, FakeSource, fakeCtor, fakeFile, flush } from './fake-audio';

const settings = (patch: Record<string, unknown> = {}) => ({ sound: true, volume: 0.6, ...patch });
const settle = async () => {
  for (let i = 0; i < 6; i++) await flush();
};

describe('the soundtrack files', () => {
  it('every pickable track ships as Ogg Opus and AAC, a 60-120 s loop with a pad', () => {
    const urls = assetUrls();
    for (const id of BUILTIN_TRACKS.filter((t) => t !== 'classic')) {
      expect(Object.keys(urls[`music/${id}`] ?? {}).sort(), id).toEqual(['m4a', 'ogg']);
      const t = TRACKS[id];
      expect(t.loop, id).toBeGreaterThanOrEqual(60);
      expect(t.loop, id).toBeLessThanOrEqual(120);
      expect(t.pad, id).toBeGreaterThan(0.1);
    }
  });
});

describe('music: picking a soundtrack', () => {
  const urls: AssetUrls = Object.fromEntries(['lobby', 'game', 'tension', 'chill', 'arcade', 'chiptune', 'lofi'].map((n) => [`music/${n}`, { ogg: `${n}.ogg` }]));

  function make(patch: Record<string, unknown> = {}) {
    const { ctx, create } = fakeCtor();
    const mixer = new Mixer(create);
    const fetcher = vi.fn(async (url: string) => fakeFile(`${url}:61`));
    const timers: (() => void)[] = [];
    const music = new Music(mixer, {
      loader: new AssetLoader(urls, ['ogg'], fetcher),
      setTimer: (fn) => timers.push(fn),
    });
    mixer.apply(prefsFromSettings(settings(patch)));
    const loops = () => ctx.sources().filter((s): s is FakeSource => s.loop);
    const tag = (s: FakeSource) => (s.buffer as { tag: string }).tag;
    const fetched = () => fetcher.mock.calls.map((c) => c[0]);
    return { ctx, mixer, music, fetched, loops, tag, timers };
  }

  it('fetches only the picked track (nothing before the gesture)', async () => {
    const { mixer, music, fetched, loops, tag } = make();
    music.setChoice('chiptune');
    expect(fetched()).toEqual([]);
    mixer.unlock();
    await settle();
    expect(fetched()).toEqual(['chiptune.ogg']);
    const [src] = loops();
    expect(tag(src)).toBe('chiptune.ogg:61');
    expect(src.loopStart).toBe(TRACKS.chiptune.pad);
    expect(src.loopEnd).toBeCloseTo(TRACKS.chiptune.pad + TRACKS.chiptune.loop, 6);
  });

  it('cross-fades from the default to the new pick', async () => {
    const { ctx, mixer, music, fetched, loops, tag } = make();
    mixer.unlock();
    await settle();
    ctx.currentTime = 10;
    music.setChoice('lofi');
    await settle();
    const [old, next] = loops();
    expect(tag(old)).toBe('lobby.ogg:61');
    expect(tag(next)).toBe('lofi.ogg:61');
    expect((old.outputs[0] as FakeGain).gain.events.at(-1)).toEqual(['linear', 0, 10 + CROSSFADE]);
    expect((next.outputs[0] as FakeGain).gain.events.at(-1)![2]).toBeCloseTo(10.05 + CROSSFADE, 6);
    expect((next.outputs[0] as FakeGain).outputs).toContain(mixer.busNode('music'));
    expect(fetched()).toEqual(['lobby.ogg', 'lofi.ogg']);
  });

  it('a picked track plays through lobby and room alike; no tension layer over it', async () => {
    const { mixer, music, fetched, loops } = make();
    music.setChoice('arcade');
    mixer.unlock();
    await settle();
    music.setMood('game');
    music.setTension(true);
    await settle();
    expect(loops().length).toBe(1);
    expect(music.layers()).toEqual([{ name: 'arcade', ending: false }]);
    expect(fetched()).toEqual(['arcade.ogg']);
    // back to the default: the classic room loop and its tension layer
    music.setChoice('classic');
    await settle();
    expect(music.layers().filter((l) => !l.ending).map((l) => l.name)).toEqual(['game', 'tension']);
  });

  it('no music (the switch off) stops the pick; on again fades it back in', async () => {
    const { mixer, music, loops } = make();
    music.setChoice('chill');
    mixer.unlock();
    await settle();
    mixer.apply(prefsFromSettings(settings({ musicOn: false })));
    expect(music.playing).toBe(false);
    expect(loops()[0].stoppedAt).not.toBeNull();
    mixer.apply(prefsFromSettings(settings()));
    await settle();
    expect(music.playing).toBe(true);
    expect(music.layers().filter((l) => !l.ending)).toEqual([{ name: 'chill', ending: false }]);
  });
});

describe('the music setting persists', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('defaults to the classic soundtrack and round-trips a pick', async () => {
    const first = await import('../src/store');
    expect(first.useUi.getState().settings.musicTrack).toBe('classic');
    first.updateSettings({ musicTrack: 'lofi' });
    vi.resetModules();
    const second = await import('../src/store');
    expect(second.useUi.getState().settings.musicTrack).toBe('lofi');
  });

  it('an unknown saved track falls back to the default; old saves gain the field', async () => {
    localStorage.setItem('coinnibal.settings.v1', JSON.stringify({ musicTrack: 'polka', volume: 0.3 }));
    const { useUi } = await import('../src/store');
    expect(useUi.getState().settings.musicTrack).toBe('classic');
    expect(musicChoice(undefined)).toBe('classic');
    // the removed "your own music" reads as the default
    expect(musicChoice('custom')).toBe('classic');
  });
});

describe('the music picker (settings)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mount() {
    const store = await import('../src/store');
    const { MusicPicker } = await import('../src/ui/profile/MusicPicker');
    render(<MusicPicker />);
    return store;
  }

  it('lists the tracks and no music as one radio group (no own-file option)', async () => {
    await mount();
    const group = screen.getByRole('radiogroup', { name: 'Music' });
    const names = [...group.querySelectorAll('[role="radio"] .gs-track__name')].map((n) => n.textContent);
    expect(names).toEqual(['Classic', 'Chill', 'Arcade', 'Chiptune', 'Lo-fi', 'No music']);
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByRole('radio', { name: /Classic/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('picking a track saves it; no music turns the switch off; a track turns it back on', async () => {
    const { useUi } = await mount();
    fireEvent.click(screen.getByRole('radio', { name: /Chill/ }));
    expect(useUi.getState().settings.musicTrack).toBe('chill');
    expect(screen.getByRole('radio', { name: /Chill/ }).getAttribute('aria-checked')).toBe('true');
    expect(JSON.parse(localStorage.getItem('coinnibal.settings.v1')!).musicTrack).toBe('chill');
    fireEvent.click(screen.getByRole('radio', { name: /No music/ }));
    expect(useUi.getState().settings.musicOn).toBe(false);
    expect(useUi.getState().settings.musicTrack).toBe('chill');
    expect(screen.getByRole('radio', { name: /No music/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: /Arcade/ }));
    expect(useUi.getState().settings).toMatchObject({ musicOn: true, musicTrack: 'arcade' });
  });

  it('arrow keys move the pick', async () => {
    const { useUi } = await mount();
    const group = screen.getByRole('radiogroup');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(useUi.getState().settings.musicTrack).toBe('chill');
    expect(document.activeElement?.getAttribute('data-track')).toBe('chill');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(useUi.getState().settings.musicTrack).toBe('classic');
    // wraps from the first ticket to the last: no music
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(useUi.getState().settings).toMatchObject({ musicTrack: 'classic', musicOn: false });
  });

  it('a saved "your own music" from an earlier visit reads as the default soundtrack', async () => {
    localStorage.setItem('coinnibal.settings.v1', JSON.stringify({ musicTrack: 'custom' }));
    const { useUi } = await mount();
    expect(useUi.getState().settings.musicTrack).toBe('classic');
    expect(screen.getByRole('radio', { name: /Classic/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('the file an earlier visit kept in this browser is deleted', async () => {
    const deleteDatabase = vi.fn(() => ({}) as IDBOpenDBRequest);
    vi.stubGlobal('indexedDB', { deleteDatabase });
    const { forgetSavedMusic } = await import('../src/audio/custom');
    forgetSavedMusic();
    // the database was named before the rename (Elymum), so the old name is the one deleted
    expect(deleteDatabase).toHaveBeenCalledWith('elymum.music');
    vi.unstubAllGlobals();
  });
});
