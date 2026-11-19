import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRAWL_TICK_MS, steppedMotion, useDashCrawl } from '../src/design/motifs/stepped';
import { useOffscreenPausedBlock } from '../src/design/motifs/useOffscreenPause';

/** A touch phone (`(hover: none)`) or not, with or without reduced motion, for this test only. */
function media(touch: boolean, reduced = false) {
  const real = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: q.includes('hover: none') ? touch : q.includes('reduced-motion') ? reduced : false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = real;
  };
}

function Lights({ on }: { on: boolean }) {
  const ref = useRef<SVGPathElement>(null);
  useDashCrawl(ref, on, 250, 24_000);
  return (
    <svg>
      <path ref={ref} data-testid="lights" style={{ strokeDashoffset: 0 }} />
    </svg>
  );
}

describe('stepped motion on touch phones (the arch lights, the dusk lights, the orbit)', () => {
  let restore = () => {};
  afterEach(() => {
    restore();
    vi.useRealTimers();
  });

  it('a touch phone crawls the dashes from script, four steps a second, with the CSS animation off', () => {
    restore = media(true);
    expect(steppedMotion()).toBe(true);
    vi.useFakeTimers();
    const { getByTestId } = render(<Lights on />);
    const path = getByTestId('lights');
    expect(path.style.animation).toContain('none');
    act(() => vi.advanceTimersByTime(4 * CRAWL_TICK_MS));
    // the CSS lap (-250 in 24 s) in 96 ticks: four ticks are -10.42
    expect(Number(path.style.strokeDashoffset)).toBeCloseTo(-10.42, 1);
  });

  it('stops while off screen, and never runs on a desktop or under reduced motion', () => {
    restore = media(true);
    vi.useFakeTimers();
    const off = render(<Lights on={false} />);
    act(() => vi.advanceTimersByTime(2000));
    expect(off.getByTestId('lights').style.animation).toBe('');
    off.unmount();
    restore();

    for (const [touch, reduced] of [
      [false, false],
      [true, true],
    ] as const) {
      restore = media(touch, reduced);
      expect(steppedMotion()).toBe(false);
      const r = render(<Lights on />);
      act(() => vi.advanceTimersByTime(2000));
      expect(r.getByTestId('lights').style.animation).toBe('');
      expect(Number(r.getByTestId('lights').style.strokeDashoffset)).toBe(0);
      r.unmount();
      restore();
    }
    restore = () => {};
  });
});

describe('a landing section pauses its loops off screen without re-rendering', () => {
  it('sets data-paused on the element itself and pauses the SMIL timelines under it', () => {
    let fire: (visible: boolean) => void = () => {};
    const real = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(cb: IntersectionObserverCallback) {
        fire = (visible) => cb([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    let renders = 0;
    function Section() {
      renders++;
      const ref = useRef<HTMLElement>(null);
      useOffscreenPausedBlock(ref);
      return (
        <section ref={ref} data-testid="section">
          <svg data-testid="orbit" />
        </section>
      );
    }
    try {
      const { getByTestId } = render(<Section />);
      const section = getByTestId('section');
      const svg = getByTestId('orbit') as unknown as SVGSVGElement & { pauseAnimations: () => void; unpauseAnimations: () => void };
      svg.pauseAnimations = vi.fn();
      svg.unpauseAnimations = vi.fn();
      const before = renders;
      act(() => fire(true));
      expect(section.hasAttribute('data-paused')).toBe(false);
      act(() => fire(false));
      expect(section.getAttribute('data-paused')).toBe('');
      expect(svg.pauseAnimations).toHaveBeenCalledTimes(1);
      act(() => fire(true));
      expect(section.hasAttribute('data-paused')).toBe(false);
      expect(svg.unpauseAnimations).toHaveBeenCalledTimes(1);
      expect(renders).toBe(before);
    } finally {
      globalThis.IntersectionObserver = real;
    }
  });
});
