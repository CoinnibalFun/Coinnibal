import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULES, type DeathStats, type RoomInfo, type RoundInfo, type RoundStanding, type ServerMessage } from '@coinnibal/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The engine without a canvas renderer or a real socket: the test drives the server side.
vi.mock('../src/render/renderer', async (orig) => ({
  ...((await orig()) as object),
  Renderer: class {
    levels = [{ dpr: 1, low: false }];
    autoLow = false;
    resize() {}
    setLevel() {}
    draw() {}
    drawMinimap() {}
    lookFor() {
      return {};
    }
  },
}));
const net = vi.hoisted(() => ({ handlers: null as null | { onMessage(m: unknown): void } }));
vi.mock('../src/game/net', () => ({
  Net: class {
    rtt = 0;
    constructor(_url: string, handlers: { onMessage(m: unknown): void }) {
      net.handlers = handlers;
    }
    connect() {}
    close() {}
    get open() {
      return true;
    }
    send() {}
    sendBinary() {}
  },
}));

const { GameEngine, freshResult, RESULT_SHARE_FRESH_MS } = await import('../src/game/engine');
const { useUi } = await import('../src/store');
const { Kb } = await import('../src/design');
const { SERVER } = await import('../src/config');
const { setReducedMotion } = await import('../src/test/media');
const { RoundOverSheet, RoomOverSheet } = await import('../src/ui/game');
const { DeathSheet } = await import('../src/ui/game/DeathSheet');
const { SHARE_COIN, gameShareText, killShareText, resultShareText, shareUrl } = await import('../src/ui/game/ShareOnX');
const { translate } = await import('../src/i18n');
const { fileSlug, resetCardBlobs } = await import('../src/ui/game/SharePanel');
const { chainStatus } = await import('./evm-helpers');

HTMLCanvasElement.prototype.getContext = (() => null) as never;
const initial = useUi.getState();
const M = 1_000_000;
const N = 5_800_000;
const R: RoundInfo = { n: N, endsAt: (N + 1) * RULES.roundMs, joinsCloseAt: (N + 1) * RULES.roundMs - RULES.roundJoinCloseMs };
const ARENA: RoomInfo = { id: 'arena-1-1', mode: 'arena', name: '$1 Room', width: 6400, height: 6400, players: 3, bots: 0, maxPlayers: 50, arenaId: 1, entryFee: 1000 * M, round: R };
const POND: RoomInfo = { id: 'practice-1', mode: 'practice', name: 'Pro Pond #1', width: 6000, height: 6000, players: 1, bots: 0, maxPlayers: 50 };
const STANDINGS: RoundStanding[] = [
  { rank: 1, name: 'Daphne', value: 3000 * M, mass: 1800, kills: 6, you: true },
  { rank: 2, name: 'Penny', value: 900 * M, mass: 600, kills: 1 },
];
const STATS: DeathStats = { aliveMs: 94_000, finalMass: 1800, maxMass: 2000, foodEaten: 88, cellsEaten: 9, playersEaten: 2, bestRank: 1, finalRank: 1, finalOf: 2 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let fetchMock: ReturnType<typeof vi.fn>;
let clicks: { href: string; download: string }[];
beforeEach(() => {
  setReducedMotion(true);
  resetCardBlobs();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob([PNG], { type: 'image/png' }) }));
  vi.stubGlobal('fetch', fetchMock);
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:card-${++n}`);
  URL.revokeObjectURL = vi.fn();
  clicks = [];
  // a download is a click on a blob link with `download` (jsdom does not navigate)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.download });
  });
  useUi.setState({ chain: chainStatus({ fees: null }), rooms: [ARENA, POND] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  act(() => useUi.setState(initial, true));
});

const card = (over: Partial<NonNullable<ReturnType<typeof useUi.getState>['share']>> = {}) => ({ kind: 'round' as const, id: 'AbCdE12345', at: Date.now(), ...over });
const kill = (id: string, victim: string, over = {}) => ({ kind: 'kill' as const, id, victim, at: Date.now(), ...over });
const fetched = () => fetchMock.mock.calls.map((c) => String(c[0]));

function roundSheet(share: ReturnType<typeof card> | null, moments: ReturnType<typeof kill>[] = []) {
  useUi.setState({
    screen: 'roundover',
    room: ARENA,
    ticket: { entryFee: 1000 * M, arenaId: 1, session: 'S1' },
    roundResult: { kind: 'round', round: N, payout: 3000 * M, stats: STATS, standings: STANDINGS },
    lastSettlement: null,
    share,
    moments,
  });
  return render(
    <Kb>
      <RoundOverSheet />
    </Kb>,
  );
}

describe('the end-of-game share panel', () => {
  it('previews the result card, downloads it as a file, and switches to the standings picture', async () => {
    roundSheet(card({ standings: true }));
    const panel = screen.getByTestId('share-panel');
    expect(panel.textContent).toContain('Share your game');
    const img = (await screen.findByTestId('share-preview')) as HTMLImageElement;
    expect(img.src).toMatch(/^blob:card-/);
    expect(fetched()).toEqual([`${SERVER.http}/share/AbCdE12345.png`]);
    fireEvent.click(screen.getByTestId('share-download'));
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0].download).toBe('coinnibal-1-room-result.png');
    expect(clicks[0].href).toMatch(/^blob:/);
    // the picture was fetched once: the download reuses the preview's bytes
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('share-pick-standings'));
    expect(screen.getByTestId('share-pick-standings').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(fetched()).toContain(`${SERVER.http}/share/AbCdE12345/standings.png`));
    fireEvent.click(screen.getByTestId('share-download'));
    await waitFor(() => expect(clicks).toHaveLength(2));
    expect(clicks[1].download).toBe('coinnibal-1-room-standings.png');
  });

  it('"Share on X" opens the intent with the result line and the card link; no standings tab without the picture', () => {
    roundSheet(card());
    const x = screen.getByTestId('share-x') as HTMLAnchorElement;
    const url = new URL(x.href);
    expect(url.origin + url.pathname).toBe('https://x.com/intent/post');
    expect(url.searchParams.get('text')).toBe(`${resultShareText(translate, { rank: 1, n: 2, room: '$1 Room' })} ${SHARE_COIN}`);
    expect(url.searchParams.get('text')).toMatch(/in \$1 Room on Coinnibal/);
    expect(url.searchParams.get('url')).toBe(shareUrl('AbCdE12345'));
    expect(x.closest('[data-testid="share-panel"]')).toBeTruthy();
    expect(screen.queryByTestId('share-pick-standings')).toBeNull();
  });

  it('uses the system share sheet with the picture file where the browser can share files', async () => {
    const share = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, share, canShare: (d: { files?: File[] }) => Array.isArray(d.files) && d.files.length > 0 });
    roundSheet(card());
    fireEvent.click(screen.getByTestId('share-native'));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const arg = (share.mock.calls[0] as unknown as [{ files: File[]; text: string }])[0];
    expect(arg.files).toHaveLength(1);
    expect(arg.files[0].name).toBe('coinnibal-1-room-result.png');
    expect(arg.files[0].type).toBe('image/png');
    expect(arg.text).toContain(resultShareText(translate, { rank: 1, n: 2, room: '$1 Room' }));
    expect(arg.text).toContain(shareUrl('AbCdE12345'));
    // a closed share sheet is no error
    share.mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'AbortError' }));
    fireEvent.click(screen.getByTestId('share-native'));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers no Share button where the browser cannot share files', () => {
    vi.stubGlobal('navigator', { ...navigator, share: undefined, canShare: undefined });
    roundSheet(card());
    expect(screen.queryByTestId('share-native')).toBeNull();
    expect(screen.getByTestId('share-download')).toBeTruthy();
  });

  it('with the card still on its way: no picture yet, the post links the site', () => {
    roundSheet(null);
    expect(screen.queryByTestId('share-download')).toBeNull();
    expect(new URL((screen.getByTestId('share-x') as HTMLAnchorElement).href).searchParams.get('url')).toBe(`${window.location.origin}/play`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('"Your moments": the kills of the game, newest first, each downloadable and postable (BOT, TEST and @handles kept)', async () => {
    roundSheet(card(), [kill('KiLLaaaaaa', 'Penny'), kill('KiLLbbbbbb', 'Botty', { victimIsBot: true, test: true }), kill('KiLLcccccc', 'Rocky', { victimX: 'rocky_x' })]);
    const moments = screen.getByTestId('share-moments');
    expect(moments.querySelector('summary')!.textContent).toBe('Your moments: 3 kills');
    const rows = screen.getAllByTestId('share-moment');
    expect(rows.map((r) => r.querySelector('bdi')!.textContent)).toEqual(['You ate @rocky_x!', 'You ate Botty (BOT)!', 'You ate Penny!']);
    expect(rows[1].querySelector('.g-test-tag')?.textContent).toBe('TEST');
    const x = rows[1].querySelector('[data-testid="moment-x"]') as HTMLAnchorElement;
    const posted = new URL(x.href).searchParams.get('text')!;
    expect(posted).toBe(`${killShareText(translate, { id: 'KiLLbbbbbb', victim: 'Botty', victimIsBot: true, test: true })} ${SHARE_COIN}`);
    expect(posted).toContain('Botty (BOT)');
    expect(posted).toContain('Coinnibal');
    expect(posted).toContain('(TEST: testnet test room, no real money)');
    expect(new URL(x.href).searchParams.get('url')).toBe(shareUrl('KiLLbbbbbb'));
    fireEvent.click(rows[0].querySelector('[data-testid="moment-download"]')!);
    await waitFor(() => expect(clicks.some((c) => c.download === 'coinnibal-1-room-ate-rocky-x.png')).toBe(true));
    expect(fetched()).toContain(`${SERVER.http}/share/KiLLcccccc.png`);
  });

  it("the death sheet shares the death's own card (the game I had), and a result card never stands in for it", async () => {
    const stats = { aliveMs: 61_000, finalMass: 0, maxMass: 2345.6, foodEaten: 40, cellsEaten: 0, playersEaten: 2, bestRank: 1 };
    useUi.setState({ screen: 'dead', room: POND, death: { stats, killer: 'Nakamoto', killerSkin: 2 }, share: card({ kind: 'room', id: 'DeAdD12345', dead: true }), moments: [kill('KiLLaaaaaa', 'Penny')] });
    render(
      <Kb>
        <DeathSheet />
      </Kb>,
    );
    await screen.findByTestId('share-preview');
    expect(fetched()).toEqual([`${SERVER.http}/share/DeAdD12345.png`]);
    const url = new URL((screen.getByTestId('share-x') as HTMLAnchorElement).href);
    expect(url.searchParams.get('text')).toBe(`${gameShareText(translate, { mass: 2345.6, eaten: 2, room: 'Pro Pond #1' })} ${SHARE_COIN}`);
    expect(url.searchParams.get('text')).toMatch(/2,345/);
    expect(url.searchParams.get('text')).toMatch(/\b2 coins\b/);
    expect(url.searchParams.get('text')).toContain('Pro Pond #1 on Coinnibal');
    expect(url.searchParams.get('url')).toBe(shareUrl('DeAdD12345'));
    expect(screen.getByTestId('share-moments').textContent).toContain('Your moments: 1 kill');
    fireEvent.click(screen.getByTestId('share-download'));
    await waitFor(() => expect(clicks[0]?.download).toBe('coinnibal-pro-pond-1-game.png'));
  });

  it("a custom room's end: using the panel stops the sheet from leaving by itself", async () => {
    useUi.setState({
      screen: 'roomover',
      roomResult: { message: 'Time is up.', players: 2, standings: STANDINGS, stats: STATS, room: { ...POND, id: 'priv-PONDS', mode: 'private', name: 'Friday Pond' } },
      share: card({ kind: 'room', standings: true }),
    });
    render(
      <Kb>
        <RoomOverSheet />
      </Kb>,
    );
    expect(document.querySelector('.g-roomover__auto')).toBeTruthy();
    fireEvent.click(screen.getByTestId('share-download'));
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0].download).toBe('coinnibal-friday-pond-result.png');
    expect(document.querySelector('.g-roomover__auto')).toBeNull();
  });

  it('file names: lower-case ASCII words joined by dashes', () => {
    expect(fileSlug('$1 Room')).toBe('1-room');
    expect(fileSlug('Crème Brûlée #3')).toBe('creme-brulee-3');
    expect(fileSlug('海')).toBe('game');
  });
});

describe('engine: the cards of a game', () => {
  let engine: InstanceType<typeof GameEngine>;
  const recv = (m: Partial<ServerMessage> & { t: string }) => net.handlers!.onMessage(m);
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    localStorage.setItem('coinnibal.brief', '1');
    useUi.setState({ ...initial, rooms: [ARENA], screen: 'lobby' }, true);
    engine = new GameEngine(document.createElement('canvas'));
    recv({ t: 'welcome', v: 1, serverTime: Date.now(), serverNow: Date.now(), rooms: [ARENA], chain: initial.chain as never, online: 1 });
  });
  afterEach(() => engine.destroy());

  it('keeps every kill card of the game for the end panel, the result card that comes just before the bell, and starts afresh on a join', () => {
    recv({ t: 'joined', room: ARENA, playerId: 7, name: 'Daphne', skin: 0 });
    recv({ t: 'share', kind: 'kill', id: 'KiLLaaaaaa', victim: 'Penny' });
    recv({ t: 'share', kind: 'kill', id: 'KiLLbbbbbb', victim: 'Botty', victimIsBot: true, test: true });
    expect(useUi.getState().moments.map((m) => m.id)).toEqual(['KiLLaaaaaa', 'KiLLbbbbbb']);
    expect(useUi.getState().moments[1]).toMatchObject({ victimIsBot: true, test: true });
    // the server sends the card, then the result
    recv({ t: 'share', kind: 'round', id: 'AbCdE12345', standings: true });
    recv({ t: 'roundOver', round: N, payout: 0, stats: STATS, standings: STANDINGS });
    expect(useUi.getState().share).toMatchObject({ kind: 'round', id: 'AbCdE12345', standings: true });
    expect(useUi.getState().moments).toHaveLength(2);
    recv({ t: 'joined', room: ARENA, playerId: 8, name: 'Daphne', skin: 0 });
    expect(useUi.getState().share).toBeNull();
    expect(useUi.getState().moments).toEqual([]);
  });

  it('an old card, a kill card or a death card never stands in for a result', () => {
    const now = 1_000_000;
    expect(freshResult({ kind: 'round', id: 'A', at: now }, now + 10)).not.toBeNull();
    expect(freshResult({ kind: 'round', id: 'A', at: now }, now + RESULT_SHARE_FRESH_MS)).toBeNull();
    expect(freshResult({ kind: 'kill', id: 'A', at: now }, now)).toBeNull();
    expect(freshResult({ kind: 'room', id: 'A', at: now, dead: true }, now)).toBeNull();
  });
});

describe('the in-game styles', () => {
  const css = readFileSync(join(__dirname, '../src/ui/game/game.css'), 'utf8');
  const rule = (sel: string) => new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`).exec(css)?.[0] ?? '';

  it('the kill notice is a small chip that takes no clicks', () => {
    const chip = rule('.g-killshare');
    expect(chip).toMatch(/pointer-events: none/);
    expect(Number(/font-size: (\d+)px/.exec(chip)?.[1])).toBeLessThanOrEqual(14);
    expect(chip).toMatch(/max-width: min\(70vw, 300px\)/);
  });

  it('the chat line types dark ink on its white field (the night HUD makes --ink cream), with a dark caret and a readable placeholder', () => {
    const input = rule('.g-chat__input');
    expect(input).toMatch(/background: #fff;/);
    expect(input).toMatch(/\n  color: var\(--ink-fixed/);
    expect(input).toMatch(/-webkit-text-fill-color: var\(--ink-fixed/);
    expect(input).toMatch(/caret-color: var\(--ink-fixed/);
    expect(input).not.toMatch(/color: var\(--ink\)/);
    expect(rule('.g-chat__input::placeholder')).toMatch(/color: #6b655a/);
    expect(rule('.g-stream__form .g-chat__send')).toMatch(/color: var\(--ink-fixed\)/);
  });
});
