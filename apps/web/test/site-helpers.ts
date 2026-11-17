import { vi } from 'vitest';

export interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

type Handler = (call: Call) => unknown | Response | Promise<unknown | Response>;

/**
 * A fetch stand-in for the site API: `routes` maps "METHOD /path" (query string ignored, or kept
 * when the key has one) to a JSON body, a Response or a handler. Unmatched calls answer 404.
 */
export function mockFetch(routes: Record<string, unknown | Handler>): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method, path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization ?? null };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}${url.search}`] ?? routes[`${method} ${url.pathname}`];
    if (route === undefined) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    const out = typeof route === 'function' ? await (route as Handler)(call) : route;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = orig) };
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Every stand-in IntersectionObserver made in this test file (kept across tests: the landing's reveal engine makes its
 * observers once per module), with what each one observes, so a test can fire an entry by hand (`intersect`).
 */
const observers: { cb: IntersectionObserverCallback; opts?: IntersectionObserverInit; els: Set<Element>; io: IntersectionObserver }[] = [];

/** Which of the reveal engine's observers (site/landing/reveal.ts) an entry goes to. */
export type RevealObserver = 'line' | 'dwell' | 'passed';
const isWhich = (which: RevealObserver, opts?: IntersectionObserverInit) =>
  which === 'line' ? opts?.rootMargin === '0px 0px -10% 0px' : which === 'passed' ? !!opts?.rootMargin?.startsWith('100000px') : opts === undefined;

/**
 * Fires one entry per element, in ONE callback, on the reveal engine's `which` observer (only to observers that still
 * observe the element). `rect` is the entry's boundingClientRect (the `passed` observer reads its bottom).
 */
export function intersect(els: Element | Element[], which: RevealObserver, isIntersecting: boolean, rect: Partial<DOMRectReadOnly> = { top: 100, bottom: 200 }): void {
  const list = Array.isArray(els) ? els : [els];
  for (const o of observers) {
    if (!isWhich(which, o.opts)) continue;
    const entries = list.filter((el) => o.els.has(el)).map((target) => ({ target, isIntersecting, boundingClientRect: rect, intersectionRatio: isIntersecting ? 1 : 0 }) as unknown as IntersectionObserverEntry);
    if (entries.length) o.cb(entries, o.io);
  }
}

/** jsdom has no IntersectionObserver or 2D canvas: quiet stand-ins (nothing is on screen until a test says so). */
export function installDomStubs(): void {
  class IO {
    private rec: (typeof observers)[number];
    constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
      this.rec = { cb, opts, els: new Set(), io: this as unknown as IntersectionObserver };
      observers.push(this.rec);
    }
    observe(el: Element) {
      this.rec.els.add(el);
      this.rec.cb([{ isIntersecting: false, target: el } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve(el: Element) {
      this.rec.els.delete(el);
    }
    disconnect() {
      this.rec.els.clear();
    }
    takeRecords() {
      return [];
    }
  }
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = IO;
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  Element.prototype.scrollIntoView = () => {};
}

export const SETTINGS = { wlOpen: true, collabOpen: true, mintOpen: true, gameAccess: 'admins' as const, xHandle: 'coinnibalfun', launchPostUrl: null };
