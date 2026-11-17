// The landing's reveal engine (site/landing/reveal.ts): one trigger line, a dwell, a "jumped past" observer, focus and
// print fallbacks, and the SeedRail gulp. jsdom applies no CSS: these tests read the attributes the CSS keys on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BITE_GULP_MS, gulp, watch } from '../src/site/landing/reveal';
import { installDomStubs, intersect } from './site-helpers';

const made: Element[] = [];
function target(id = 'x', rect: Partial<DOMRect> = { top: 900, bottom: 1300 }): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  el.innerHTML = '<button type="button">inside</button>';
  el.getBoundingClientRect = () => ({ left: 0, right: 100, width: 100, height: 400, x: 0, y: 0, top: 0, bottom: 0, toJSON() {}, ...rect }) as DOMRect;
  document.body.append(el);
  made.push(el);
  return el;
}

beforeEach(() => installDomStubs());
afterEach(() => {
  vi.useRealTimers();
  for (const el of made.splice(0)) el.remove();
});

describe('reveal engine', () => {
  it('without an IntersectionObserver every target is finished at once and never plays', () => {
    const io = globalThis.IntersectionObserver;
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    try {
      const onIn = vi.fn();
      const onSet = vi.fn();
      const el = target();
      watch(el, { onIn, onSet });
      expect(el.getAttribute('data-reveal')).toBe('set');
      expect(onSet).toHaveBeenCalledTimes(1);
      expect(onIn).not.toHaveBeenCalled();
    } finally {
      globalThis.IntersectionObserver = io;
    }
  });

  it('waits, plays once when its top crosses the line, and never hides again', () => {
    const onIn = vi.fn();
    const el = target();
    watch(el, { attr: 'data-seam', onIn });
    expect(el.getAttribute('data-seam')).toBe('wait');
    intersect(el, 'line', true);
    expect(el.getAttribute('data-seam')).toBe('in');
    expect(onIn).toHaveBeenCalledTimes(1);
    // unobserved: later entries change nothing
    intersect(el, 'line', false);
    intersect(el, 'line', true);
    intersect(el, 'passed', true, { top: -500, bottom: -100 });
    expect(el.getAttribute('data-seam')).toBe('in');
    expect(onIn).toHaveBeenCalledTimes(1);
  });

  it('staggers list items that cross together, capped at five beats', () => {
    const items = Array.from({ length: 8 }, (_, i) => target(`i${i}`));
    for (const el of items) watch(el, { batch: true });
    intersect(items, 'line', true);
    expect(items.map((el) => (el as HTMLElement).style.getPropertyValue('--rv-n'))).toEqual(['0', '1', '2', '3', '4', '5', '5', '5']);
    expect(items.every((el) => el.getAttribute('data-reveal') === 'in')).toBe(true);
    // a stage (no batch) gets no stagger of its own
    const stage = target('stage');
    watch(stage);
    intersect(stage, 'line', true);
    expect(stage.style.getPropertyValue('--rv-n')).toBe('');
  });

  it('plays a target that stays on screen for 300 ms short of the line; leaving earlier cancels it', () => {
    vi.useFakeTimers();
    const el = target();
    watch(el);
    intersect(el, 'dwell', true);
    vi.advanceTimersByTime(299);
    expect(el.getAttribute('data-reveal')).toBe('wait');
    vi.advanceTimersByTime(1);
    expect(el.getAttribute('data-reveal')).toBe('in');

    const other = target('other');
    watch(other);
    intersect(other, 'dwell', true);
    vi.advanceTimersByTime(200);
    intersect(other, 'dwell', false);
    vi.advanceTimersByTime(500);
    expect(other.getAttribute('data-reveal')).toBe('wait');
  });

  it('finishes a target that was jumped past without playing it', () => {
    const onIn = vi.fn();
    const onSet = vi.fn();
    const below = target('below');
    watch(below, { onIn });
    // a target still below or on screen is left alone
    intersect(below, 'passed', true, { top: 300, bottom: 700 });
    expect(below.getAttribute('data-reveal')).toBe('wait');
    const above = target('above');
    watch(above, { onIn, onSet });
    intersect(above, 'passed', true, { top: -900, bottom: -40 });
    expect(above.getAttribute('data-reveal')).toBe('set');
    expect(onSet).toHaveBeenCalledTimes(1);
    expect(onIn).not.toHaveBeenCalled();
  });

  it('is finished at mount when the page already scrolled past it (an anchor, back navigation)', () => {
    const el = target('gone', { top: -2000, bottom: -1200 });
    watch(el);
    expect(el.getAttribute('data-reveal')).toBe('set');
  });

  it('finishes at once when focus moves inside a waiting target', () => {
    const el = target();
    watch(el);
    el.querySelector('button')!.focus();
    expect(el.getAttribute('data-reveal')).toBe('set');
  });

  it('finishes every waiting target before printing', () => {
    const a = target('a');
    const b = target('b');
    watch(a);
    watch(b, { attr: 'data-seam' });
    window.dispatchEvent(new Event('beforeprint'));
    expect(a.getAttribute('data-reveal')).toBe('set');
    expect(b.getAttribute('data-seam')).toBe('set');
  });

  it('does not re-arm a played target; its cleanup only clears a target still waiting', () => {
    const el = target();
    watch(el);
    intersect(el, 'line', true);
    const off = watch(el);
    expect(el.getAttribute('data-reveal')).toBe('in');
    off();
    expect(el.getAttribute('data-reveal')).toBe('in');
    const waiting = target('waiting');
    const stop = watch(waiting);
    expect(waiting.getAttribute('data-reveal')).toBe('wait');
    stop();
    // no attribute is the finished page
    expect(waiting.hasAttribute('data-reveal')).toBe(false);
    intersect(waiting, 'line', true);
    expect(waiting.hasAttribute('data-reveal')).toBe(false);
  });

  it('gulps the header coin when a bite takes its first chomp', () => {
    vi.useFakeTimers();
    const heard = vi.fn();
    window.addEventListener('ld:gulp', heard);
    try {
      gulp(BITE_GULP_MS);
      vi.advanceTimersByTime(BITE_GULP_MS - 1);
      expect(heard).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('ld:gulp', heard);
    }
  });
});
