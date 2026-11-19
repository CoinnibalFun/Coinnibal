import { EntityKind, PlayerFlag, encodeSnapshot, isCountryCode } from '@coinnibal/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientWorld } from '../src/game/state';
import { DRAWN_FLAGS, FLAG_H, FLAG_W, FlagCache, flagArt, paintFlag } from '../src/render/flags';
import { adoptProfileCountry, mergeSettings, useUi, type Settings } from '../src/store';
import { CountrySelect, filterCountries, foldName } from '../src/ui/CountrySelect';
import { Flag, countryName } from '../src/ui/Flag';

const initial = useUi.getState();
afterEach(() => {
  act(() => useUi.setState(initial, true));
});

/** A 2D context that counts what it was asked to draw. */
function countingContext() {
  const calls: Record<string, number> = {};
  const hit = (k: string) => () => void (calls[k] = (calls[k] ?? 0) + 1);
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fillRect: hit('fillRect'),
    arc: hit('arc'),
    beginPath: hit('beginPath'),
    moveTo: hit('moveTo'),
    lineTo: hit('lineTo'),
    closePath: hit('closePath'),
    fill: hit('fill'),
    stroke: hit('stroke'),
    roundRect: hit('roundRect'),
    clip: hit('clip'),
    save: hit('save'),
    restore: hit('restore'),
    translate: hit('translate'),
    scale: hit('scale'),
    fillText: hit('fillText'),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('the flag table', () => {
  it('covers the common countries with allowlisted codes and well-formed shapes', () => {
    expect(DRAWN_FLAGS.length).toBeGreaterThanOrEqual(60);
    for (const c of ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'IT', 'ES', 'BR', 'MX', 'JP', 'KR', 'CN', 'IN', 'TR', 'RU', 'UA', 'PL', 'NL', 'SE']) expect(flagArt(c)).not.toBeNull();
    const arity: Record<string, number> = { r: 6, c: 5, s: 5, a: 7, l: 7 };
    for (const code of DRAWN_FLAGS) {
      expect(isCountryCode(code), code).toBe(true);
      const art = flagArt(code)!;
      expect(art.length, code).toBeGreaterThan(0);
      for (const op of art) {
        const kind = op[0] as string;
        expect(['h', 'v', 'r', 'c', 's', 'a', 'p', 'l', 'o'], `${code} ${kind}`).toContain(kind);
        if (kind in arity) expect(op.length, `${code} ${kind}`).toBe(arity[kind]);
        if (kind === 'h' || kind === 'v') expect(op.length).toBeGreaterThan(2);
        if (kind === 'p') expect((op.length - 2) % 2).toBe(0);
        if (kind === 'o') expect((op.length - 3) % 2).toBe(0);
        for (const v of op.slice(1)) {
          if (typeof v === 'string') expect(v, code).toMatch(/^#[0-9A-Fa-f]{6}$/);
          else expect(Number.isFinite(v), code).toBe(true);
        }
      }
    }
    // codes without art get a badge
    expect(flagArt('TV')).toBeNull();
  });

  it('paints every shape to canvas', () => {
    const { ctx, calls } = countingContext();
    for (const code of DRAWN_FLAGS) paintFlag(ctx, flagArt(code)!);
    expect(calls.fillRect).toBeGreaterThan(100);
    expect(calls.fill).toBeGreaterThan(50);
    expect(calls.stroke).toBeGreaterThan(5);
    expect(FLAG_W / FLAG_H).toBe(1.5);
  });

  it('caches one bitmap per code and pixel height', () => {
    // jsdom has no canvas: a counting context stands in
    const proto = HTMLCanvasElement.prototype as unknown as { getContext: unknown };
    const orig = proto.getContext;
    const { ctx, calls } = countingContext();
    proto.getContext = () => ctx;
    try {
      cacheChecks();
    } finally {
      proto.getContext = orig;
    }
    // drawn once per bitmap: the flag (or badge) and its ink edge
    expect(calls.stroke).toBeGreaterThanOrEqual(4);
    expect(calls.fillText).toBe(1);
  });

  function cacheChecks() {
    const cache = new FlagCache();
    const a = cache.get('DE', 12.2);
    expect(cache.get('DE', 11.8)).toBe(a);
    expect(a.h).toBe(12);
    expect(a.w).toBe(18);
    expect(cache.get('DE', 20)).not.toBe(a);
    // tiny sizes stay legible: at least 6 px
    expect(cache.get('FR', 2).h).toBe(6);
    // a code without art still draws (the code badge)
    expect(cache.get('TV', 14).w).toBe(21);
    expect(cache.size).toBe(4);
    cache.clear();
    expect(cache.size).toBe(0);
  }
});

describe('<Flag>', () => {
  it('draws a known flag as an SVG sticker named for the country, a badge for the rest, nothing for junk', () => {
    const { container, rerender } = render(<Flag code="DE" size={16} />);
    const de = screen.getByRole('img', { name: countryName('DE') });
    expect(de.querySelector('svg')).not.toBeNull();
    expect(de.getAttribute('style')).toContain('--flag-h: 16px');
    rerender(<Flag code="TV" />);
    expect(container.querySelector('.kb-flag.is-code')?.textContent).toBe('TV');
    rerender(<Flag code="XX" />);
    expect(container.querySelector('.kb-flag')).toBeNull();
    rerender(<Flag code={null} />);
    expect(container.querySelector('.kb-flag')).toBeNull();
    // decorative where the row says the country in words
    rerender(<Flag code="BR" label={false} />);
    expect(container.querySelector('.kb-flag')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('the picker opens a listbox like the language picker: "none" and every country, flag rows, the current one checked', () => {
    let picked = 'unset';
    render(<CountrySelect label="You play for" value="FR" noneLabel="No flag" onChange={(c) => (picked = c)} />);
    const tag = screen.getByTestId('country-pick');
    expect(tag.getAttribute('aria-label')).toBe(`You play for: ${countryName('FR')}`);
    expect(tag.getAttribute('aria-haspopup')).toBe('listbox');
    expect(tag.querySelector('.kb-flag')).not.toBeNull();
    fireEvent.click(tag);
    expect(tag.getAttribute('aria-expanded')).toBe('true');
    const opts = screen.getAllByRole('option');
    expect(opts.length).toBe(250);
    expect(opts[0].textContent).toBe('No flag');
    expect(opts.filter((o) => o.querySelector('.kb-flag')).length).toBe(250);
    const on = opts.filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(on.map((o) => o.dataset.code)).toEqual(['FR']);
    // opening starts on the current country
    expect(opts.find((o) => o.className.includes('is-active'))?.dataset.code).toBe('FR');
    // the search box has the keyboard on wide screens (type to filter)
    expect(document.activeElement).toBe(screen.getByTestId('country-search'));
    fireEvent.click(opts.find((o) => o.dataset.code === 'JP')!);
    expect(picked).toBe('JP');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(tag);
    fireEvent.click(tag);
    fireEvent.click(screen.getAllByRole('option')[0]);
    expect(picked).toBe('');
  });

  it('typing filters the list (accents and case do not matter); arrows and Enter pick; Escape closes', () => {
    let picked = 'unset';
    render(<CountrySelect label="You play for" value="" noneLabel="No flag" onChange={(c) => (picked = c)} />);
    const tag = screen.getByTestId('country-pick');
    tag.focus();
    fireEvent.keyDown(tag, { key: 'ArrowDown' });
    const search = screen.getByTestId('country-search') as HTMLInputElement;
    // nothing picked: "none" is checked
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.change(search, { target: { value: 'turk' } });
    const opts = screen.getAllByRole('option');
    expect(opts[0].dataset.code).toBe('TR');
    expect(opts.length).toBeLessThan(5);
    expect(opts.some((o) => o.textContent === 'No flag')).toBe(false);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(picked).toBe('TR');
    expect(document.activeElement).toBe(tag);
    // arrows walk the filtered rows
    fireEvent.click(tag);
    fireEvent.change(screen.getByTestId('country-search'), { target: { value: 'united' } });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    const active = screen.getAllByRole('option')[1];
    expect(active.className).toContain('is-active');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(picked).toBe(active.dataset.code);
    // no match: an empty list and a plain line; Escape closes without a pick
    picked = 'unset';
    fireEvent.click(tag);
    fireEvent.change(screen.getByTestId('country-search'), { target: { value: 'zzzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toBe('No country found');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(picked).toBe('unset');
  });

  it('search matches names from the start first, then inside, plus the two-letter code', () => {
    const rows = [
      { code: 'GB', name: 'United Kingdom' },
      { code: 'US', name: 'United States' },
      { code: 'TZ', name: 'Tanzania' },
      { code: 'TR', name: 'T\u00fcrkiye' },
    ];
    expect(foldName('  T\u00fcrkiye ')).toBe('turkiye');
    expect(filterCountries(rows, '').map((r) => r.code)).toEqual(['GB', 'US', 'TZ', 'TR']);
    expect(filterCountries(rows, 'T\u00dcR').map((r) => r.code)).toEqual(['TR']);
    expect(filterCountries(rows, 'states').map((r) => r.code)).toEqual(['US']);
    expect(filterCountries(rows, 'us').map((r) => r.code)).toEqual(['US']);
    expect(filterCountries(rows, 'ted').map((r) => r.code)).toEqual(['GB', 'US']);
    expect(filterCountries(rows, 't').map((r) => r.code)).toEqual(['TZ', 'TR', 'GB', 'US']);
  });
});

describe('the country setting', () => {
  const defaults = { ...initial.settings, country: 'GB', countryAuto: true } as Settings;

  it('settings saved before countries existed take the guess; a saved pick stays; junk is cleared', () => {
    expect(mergeSettings(defaults, { name: 'x' })).toMatchObject({ name: 'x', country: 'GB', countryAuto: true });
    expect(mergeSettings(defaults, { country: 'BR', countryAuto: false })).toMatchObject({ country: 'BR', countryAuto: false });
    expect(mergeSettings(defaults, { country: '', countryAuto: false })).toMatchObject({ country: '', countryAuto: false });
    expect(mergeSettings(defaults, { country: 'XX', countryAuto: false })).toMatchObject({ country: '', countryAuto: false });
  });

  it("a signed-in profile's saved country replaces the guess, never a pick", () => {
    act(() => useUi.setState({ settings: { ...useUi.getState().settings, country: 'GB', countryAuto: true } }));
    adoptProfileCountry({ country: undefined });
    expect(useUi.getState().settings).toMatchObject({ country: 'GB', countryAuto: true });
    adoptProfileCountry({ country: 'JP' });
    expect(useUi.getState().settings).toMatchObject({ country: 'JP', countryAuto: false });
    adoptProfileCountry({ country: 'DE' });
    expect(useUi.getState().settings.country).toBe('JP');
    act(() => useUi.setState({ settings: { ...useUi.getState().settings, country: 'GB', countryAuto: true } }));
    adoptProfileCountry({ country: null });
    expect(useUi.getState().settings).toMatchObject({ country: '', countryAuto: false });
  });
});

describe('the client world', () => {
  it('keeps the country a snapshot carries, and drops it when it goes', () => {
    const world = new ClientWorld();
    const snap = (country?: string) =>
      encodeSnapshot({
        tick: 1,
        view: { x: 0, y: 0, h: 1000 },
        players: [{ id: 3, skin: 1, flags: PlayerFlag.Bot, isBot: true, name: 'bot', ...(country ? { country } : {}) }],
        upserts: [{ id: 9, kind: EntityKind.Cell, x: 1, y: 2, r: 30, playerId: 3, flags: 0 }],
        removals: [],
      });
    world.applyBinary(snap('CA'), 0);
    expect(world.players.get(3)?.country).toBe('CA');
    world.applyBinary(snap(), 10);
    expect(world.players.get(3)?.country).toBeUndefined();
  });
});
