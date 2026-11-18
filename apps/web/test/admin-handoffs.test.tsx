/**
 * The admin side of the server work: secret exports behind a fresh, purpose-bound signature (X-Coinnibal-Proof), short
 * revocable admin sessions, the server key's gas runway, "Re-price at next bell", USD-priced power-ups and the
 * finer integrity flag kinds.
 */
import { SHOP_DEFAULTS, type GasRunway, type IntegrityFlag, type ShopSettings } from '@coinnibal/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepriceAtBell, repriceText } from '../src/admin/ArenaPricesCard';
import { BackupCard, RunwayRow, SessionsCard, gasRunwayView } from '../src/admin/NetworkTab';
import { secretErrorText, withSecretProof } from '../src/admin/secrets';
import { ShopCard, shopPatch, usdTextToCents } from '../src/admin/ShopCard';
import { SUBTYPE_LABEL, flagKindText } from '../src/admin/site/IntegrityTab';
import type { ChainCtx } from '../src/admin/ui';
import { Kb } from '../src/design';
import { SiteApiError, adminApi, encodeProof, type AdminApi, type RepriceEntry, type ShopAdminView } from '../src/site/api';
import { useSession } from '../src/site/session';

const ADMIN = '0x1111111111111111111111111111111111111111';
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const decode = (proof: string) => JSON.parse(atob(proof.replace(/-/g, '+').replace(/_/g, '/'))) as { message: string; signature: string };
const challenge = (purpose: string, n = 1) => ({ message: `Coinnibal admin: export the server secrets\n\nPurpose: ${purpose}\nNonce: ${String(n).padStart(32, '0')}`, nonce: String(n), expiresAt: Date.now() + 600_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSession.setState({ session: null, error: null, signing: false });
});

function fakeApi(over: Partial<Record<keyof AdminApi, unknown>> = {}): AdminApi {
  let n = 0;
  return {
    me: vi.fn(async () => ({ address: ADMIN, admin: true })),
    secretProof: vi.fn(async (purpose: string) => challenge(purpose, ++n)),
    backup: vi.fn(async () => {}),
    backupCommand: vi.fn((proof: string) => `curl backup --proof ${proof}`),
    installCommand: vi.fn((proof: string) => `install --proof ${proof}`),
    revokeSessions: vi.fn(async (w: string) => ({ revoked: w })),
    ...over,
  } as unknown as AdminApi;
}
const ctxOf = (api: AdminApi | null) => ({ api }) as unknown as ChainCtx;

describe('secret exports: sign the purpose-bound text, then send X-Coinnibal-Proof', () => {
  it('encodes the proof as base64url JSON of {message, signature} (unicode safe)', () => {
    const p = encodeProof('Purpose: backup\nServer: é', '0xabc');
    expect(p).not.toMatch(/[+/=]/);
    const bin = atob(p.replace(/-/g, '+').replace(/_/g, '/'));
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))).toEqual({ message: 'Purpose: backup\nServer: é', signature: '0xabc' });
  });

  it('asks for the text, signs it, runs with the proof; a proof_required answer asks for one fresh signature', async () => {
    const api = fakeApi();
    const sign = vi.fn(async (m: string) => `0xsig:${m.slice(-4)}`);
    let calls = 0;
    const out = await withSecretProof(api, 'backup', sign, async (proof) => {
      calls++;
      if (calls === 1) throw new SiteApiError(401, 'proof_required', 'The signature request expired: ask for a new one.');
      return decode(proof);
    });
    expect(api.secretProof).toHaveBeenCalledTimes(2);
    expect(api.secretProof).toHaveBeenCalledWith('backup');
    expect(sign).toHaveBeenCalledTimes(2);
    expect(out.message).toContain('Purpose: backup');
    expect(out.signature).toBe('0xsig:0002');
    // a second refusal is not retried forever
    await expect(withSecretProof(api, 'backup', sign, async () => Promise.reject(new SiteApiError(401, 'proof_required', 'no')))).rejects.toThrow('no');
    expect(api.secretProof).toHaveBeenCalledTimes(4);
  });

  it('Download backup: one signature of purpose backup, the download carries its proof', async () => {
    const api = fakeApi();
    const sign = vi.fn(async () => '0xfeed');
    render(
      <Kb>
        <BackupCard ctx={ctxOf(api)} sign={sign} />
      </Kb>,
    );
    fireEvent.click(screen.getByTestId('backup-download'));
    await settle();
    expect(api.secretProof).toHaveBeenCalledWith('backup');
    const proof = ((api.backup as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[])[0] as string;
    expect(decode(proof)).toMatchObject({ signature: '0xfeed' });
    expect(decode(proof).message).toContain('Purpose: backup');
    expect(screen.getByTestId('backup-note').textContent).toMatch(/Backup downloaded/);
  });

  it('Copy new-server command: a migration proof in the command; the migration command a backup one', async () => {
    const api = fakeApi();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(
      <Kb>
        <BackupCard ctx={ctxOf(api)} sign={async () => '0xbeef'} />
      </Kb>,
    );
    fireEvent.click(screen.getByTestId('backup-install'));
    await settle();
    expect(api.secretProof).toHaveBeenLastCalledWith('migration');
    expect((writeText.mock.calls[0] as unknown[])[0]).toMatch(/^install --proof /);
    fireEvent.click(screen.getByTestId('backup-copy'));
    await settle();
    expect(api.secretProof).toHaveBeenLastCalledWith('backup');
    expect((writeText.mock.calls[1] as unknown[])[0]).toMatch(/^curl backup --proof /);
    expect(screen.getByTestId('backup-note').textContent).toMatch(/within 10 minutes/);
  });

  it('an ended admin session says to sign in again; a cancelled signature downloads nothing', async () => {
    const api = fakeApi({ secretProof: vi.fn(async () => Promise.reject(new SiteApiError(401, 'admin_session_expired', 'Your admin session ended.'))) });
    render(
      <Kb>
        <BackupCard ctx={ctxOf(api)} sign={async () => '0x'} />
      </Kb>,
    );
    fireEvent.click(screen.getByTestId('backup-download'));
    await settle();
    expect(screen.getByTestId('backup-note').textContent).toMatch(/Sign in again/);
    expect(api.backup).not.toHaveBeenCalled();
    expect(secretErrorText(Object.assign(new Error('User rejected the request.'), { code: 4001 }), 'the download')).toMatch(/Signature cancelled/);
    expect(secretErrorText(new SiteApiError(403, 'disabled', 'Secret exports are off on the mainnet.'), 'the download')).toBe('Secret exports are off on the mainnet.');
  });

  it('any admin_session_expired answer drops the stored session and asks for a fresh sign-in', async () => {
    useSession.setState({ session: { address: ADMIN, token: 'old', admin: true }, error: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'admin_session_expired', message: 'Your admin session ended (they last a short time). Sign in again.' }), { status: 401 })),
    );
    await expect(adminApi('old').network()).rejects.toMatchObject({ code: 'admin_session_expired' });
    expect(useSession.getState().session).toBeNull();
    expect(useSession.getState().error).toMatch(/Sign in again/);
  });
});

describe('admin sessions: sign out everywhere', () => {
  beforeEach(() => useSession.setState({ session: { address: ADMIN, token: 't', admin: true }, error: null }));

  it('asks first, then revokes this wallet’s sessions and signs out here', async () => {
    const api = fakeApi();
    render(
      <Kb>
        <SessionsCard ctx={ctxOf(api)} />
      </Kb>,
    );
    fireEvent.click(screen.getByTestId('revoke-me'));
    expect(screen.getByTestId('revoke-confirm').textContent).toMatch(/this one included/);
    expect(api.revokeSessions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('revoke-yes'));
    await settle();
    expect(api.revokeSessions).toHaveBeenCalledWith(ADMIN);
    expect(useSession.getState().session).toBeNull();
    expect(screen.getByTestId('revoke-note').textContent).toMatch(/Sign in again/);
  });

  it('End every admin session sends "admins"', async () => {
    const api = fakeApi();
    render(
      <Kb>
        <SessionsCard ctx={ctxOf(api)} />
      </Kb>,
    );
    fireEvent.click(screen.getByTestId('revoke-admins'));
    fireEvent.click(screen.getByTestId('revoke-yes'));
    await settle();
    expect(api.revokeSessions).toHaveBeenCalledWith('admins');
  });
});

describe('the server key’s gas runway', () => {
  const gas = (o: Partial<GasRunway> = {}): GasRunway => ({
    level: 'ok',
    balanceWei: '50000000000000000',
    spendWeiPerDay: '1000000000000000',
    days: 50,
    floorWei: '2000000000000000',
    warnDays: 7,
    criticalDays: 2,
    sampledHours: 24,
    ...o,
  });

  it('ok, warning, critical and measuring, each with its colour', () => {
    expect(gasRunwayView(gas())).toMatchObject({ tone: 'ok', label: 'ok · 50 days' });
    expect(gasRunwayView(gas({ level: 'warn', days: 5.25 }))).toMatchObject({ tone: 'warn', label: 'low · 5.3 days' });
    expect(gasRunwayView(gas({ level: 'critical', days: 1.2 }))).toMatchObject({ tone: 'bad', label: 'critical · 1.2 days' });
    expect(gasRunwayView(gas({ level: 'critical', days: null, spendWeiPerDay: null })).label).toMatch(/under the .* floor/);
    expect(gasRunwayView(gas({ level: 'unknown', days: null, spendWeiPerDay: null, sampledHours: 0.4 }))).toMatchObject({ tone: 'unknown', label: 'measuring' });
    expect(gasRunwayView(gas()).detail).toMatch(/Warning under 7 days, alert under 2 days/);
  });

  it('renders the runway pill with its level', () => {
    render(
      <Kb>
        <dl>
          <RunwayRow gas={gas({ level: 'critical', days: 1.2 })} />
        </dl>
      </Kb>,
    );
    const pill = screen.getByTestId('gas-runway');
    expect(pill.className).toContain('is-bad');
    expect(pill.dataset.level).toBe('critical');
  });
});

describe('Re-price at next bell', () => {
  const entry = (o: Partial<RepriceEntry>): RepriceEntry => ({ arenaId: 1, phase: 'waiting', by: ADMIN, at: 1, entryFeeAtStart: 1, bellAt: null, readyAt: null, ...o });

  it('says where each arena is', () => {
    expect(repriceText(undefined).label).toBe('open');
    expect(repriceText(entry({ phase: 'waiting' })).tone).toBe('warn');
    expect(repriceText(entry({ phase: 'draining', open: { onChain: 2, journal: 1, live: 0 } })).label).toBe('closed · 3 tickets still open');
    expect(repriceText(entry({ phase: 'ready' }))).toEqual({ tone: 'ok', label: 'ready: sign the new entry fee now' });
  });

  it('schedules one arena, all the changed ones, and cancels', async () => {
    let entries: RepriceEntry[] = [];
    const api = {
      reprice: vi.fn(async () => entries),
      scheduleReprice: vi.fn(async (ids: number[]) => (entries = [...entries, ...ids.map((arenaId) => entry({ arenaId }))])),
      cancelReprice: vi.fn(async (ids: number[]) => (entries = entries.filter((e) => !ids.includes(e.arenaId)))),
    } as unknown as AdminApi;
    render(
      <Kb>
        <RepriceAtBell api={api} arenaIds={[1, 2, 3]} pending={[2, 3]} />
      </Kb>,
    );
    await settle();
    fireEvent.click(screen.getByTestId('reprice-go-1'));
    await settle();
    expect(api.scheduleReprice).toHaveBeenCalledWith([1]);
    expect(screen.getByTestId('reprice-state-1').textContent).toMatch(/last minute/);
    fireEvent.click(screen.getByTestId('reprice-all'));
    await settle();
    expect(api.scheduleReprice).toHaveBeenLastCalledWith([2, 3]);
    fireEvent.click(screen.getByTestId('reprice-cancel-2'));
    await settle();
    expect(api.cancelReprice).toHaveBeenCalledWith([2]);
    expect(screen.getByTestId('reprice-state-2').textContent).toBe('open');
  });
});

describe('power-ups priced in US dollars', () => {
  const settings = (o: Partial<ShopSettings> = {}): ShopSettings => structuredClone({ ...SHOP_DEFAULTS, ...o });

  it('the patch carries priceIn and the changed dollar prices only', () => {
    const a = settings();
    const b = settings({ priceIn: 'token', usdCents: { ...a.usdCents, leap: 150 } });
    expect(shopPatch(a, b)).toEqual({ priceIn: 'token', usdCents: { leap: 150 } });
    expect(usdTextToCents('0.6')).toBe(60);
    expect(usdTextToCents('$1.20')).toBe(120);
    expect(usdTextToCents('0')).toBeNull();
    expect(usdTextToCents('1.234')).toBeNull();
  });

  it('edits a dollar price and saves it', async () => {
    const view: ShopAdminView = { settings: settings(), defaults: settings(), payTo: null, burnBps: 5000, purchases: [], purchaseCount: 0 };
    const saveShop = vi.fn(async (patch: Partial<ShopSettings>) => ({ ...view, settings: { ...view.settings, ...patch, usdCents: { ...view.settings.usdCents, ...patch.usdCents } } }));
    const api = { shop: vi.fn(async () => view), saveShop } as unknown as AdminApi;
    render(
      <Kb>
        <ShopCard ctx={ctxOf(api)} />
      </Kb>,
    );
    await settle();
    const leap = screen.getByLabelText('Leap price in USD') as HTMLInputElement;
    expect(leap.value).toBe('0.90');
    fireEvent.change(leap, { target: { value: '1.5' } });
    fireEvent.click(screen.getByTestId('shop-save'));
    await settle();
    expect(saveShop).toHaveBeenCalledWith({ usdCents: { leap: 150 } });
    // an amount that is not dollars blocks the save
    fireEvent.change(leap, { target: { value: 'abc' } });
    expect((screen.getByTestId('shop-save') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('integrity: the finer flag kinds', () => {
  it('names the subtype next to the kind', () => {
    expect(flagKindText({ kind: 'pair_transfer', subtype: 'non_aggression' } as IntegrityFlag)).toBe('Pair transfer · Non-aggression pact');
    expect(flagKindText({ kind: 'shared_device', subtype: 'emblem_shared' } as IntegrityFlag)).toBe('Shared IP or browser · Emblem shared');
    expect(flagKindText({ kind: 'eject_feed' } as IntegrityFlag)).toBe('Eject feeding');
    expect(Object.keys(SUBTYPE_LABEL).sort()).toEqual(['emblem_shared', 'fresh_feeders', 'non_aggression', 'shared_funding']);
  });
});
