import { arenaPriceSyncCalls, sameAddress } from '@elymum/sdk';
import { arenaName, fmtTok } from '@elymum/sdk/ops';
import {
  ARENA_PRICING_LIMITS,
  arenaPriceDiff,
  formatUsd,
  formatUsdCents,
  parseUsdPrice,
  type ArenaPriceRow,
  type ArenaPricingSettings,
  type ArenaUsdTier,
} from '@elymum/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Hash } from 'viem';
import { sendWithWallet, txErrorText } from '../wallet/tx';
import { SiteApiError, type AdminApi, type ArenaPricesAdminView, type RepriceEntry } from '../site/api';
import { sendPlan, type Plan } from './plan';
import { Btn, Card, FormError, Input, Mark, saveErrorText, type ChainCtx } from './ui';

/** The fields that changed (a partial PUT). */
export function arenaPricingPatch(saved: ArenaPricingSettings, draft: ArenaPricingSettings): Partial<ArenaPricingSettings> {
  const out: Partial<ArenaPricingSettings> = {};
  if (draft.source !== saved.source) out.source = draft.source;
  if ((draft.manualUsdPerToken ?? '') !== (saved.manualUsdPerToken ?? '')) out.manualUsdPerToken = draft.manualUsdPerToken?.trim() || null;
  if (draft.sigFigs !== saved.sigFigs) out.sigFigs = draft.sigFigs;
  if (JSON.stringify(draft.tiers) !== JSON.stringify(saved.tiers)) out.tiers = draft.tiers;
  return out;
}

/** `"3"` / `"2.50"` → cents; null when it is not a dollar amount. */
const centsOf = (text: string): number | null => {
  const m = /^\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(text);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
};
const dollarsOf = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

type Run = { at: number; done: number; total: number; error: string | null; busy: boolean; hashes: Hash[] };

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + ' UTC';

/** Where an arena is on its way to a re-price, in words, with its tone (pure, tested). */
export function repriceText(e: RepriceEntry | undefined): { tone: 'ok' | 'warn' | 'bad' | 'unknown'; label: string } {
  if (!e) return { tone: 'unknown', label: 'open' };
  switch (e.phase) {
    case 'waiting':
      return { tone: 'warn', label: "closes at this round's last minute" };
    case 'closing':
      return { tone: 'warn', label: e.bellAt ? `joins closed · bell at ${hhmm(e.bellAt)}` : 'joins closed until the bell' };
    case 'draining': {
      const o = e.open;
      const left = o ? o.onChain + o.journal + o.live : null;
      return { tone: 'bad', label: left === null ? 'closed · refunding unseated tickets' : `closed · ${left} ticket${left === 1 ? '' : 's'} still open` };
    }
    case 'ready':
      return { tone: 'ok', label: 'ready: sign the new entry fee now' };
  }
}

/**
 * "Re-price at next bell": the contract changes an entry fee only while none of the arena's tickets is open. This
 * closes the arena's joins at the round's last minute, lets the round play out to its bell, refunds unseated tickets
 * and says "ready"; the owner then signs the sync above, and the arena opens again by itself once the chain shows the
 * new entry fee (or on Cancel).
 */
export function RepriceAtBell({ api, arenaIds, pending }: { api: AdminApi; arenaIds: number[]; pending: number[] }) {
  const [entries, setEntries] = useState<RepriceEntry[] | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing'>('loading');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api.reprice().then(
      (e) => {
        setEntries(e);
        setState('ok');
      },
      (e) => {
        if (e instanceof SiteApiError && (e.status === 404 || e.status === 405)) setState('missing');
        else setErr((e as Error).message);
      },
    );
  }, [api]);
  useEffect(load, [load]);
  // an arena on its way moves by itself: re-read while one is
  useEffect(() => {
    if (!entries?.length) return;
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [entries, load]);
  if (state === 'missing') return null;
  const of = (id: number) => entries?.find((e) => e.arenaId === id);
  const act = async (ids: number[], cancel: boolean) => {
    if (busy || ids.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      setEntries(cancel ? await api.cancelReprice(ids) : await api.scheduleReprice(ids));
    } catch (e) {
      setErr(saveErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const due = pending.filter((id) => !of(id));
  return (
    <section className="ad-reprice" aria-labelledby="ad-reprice-h" data-testid="reprice">
      <h3 className="ad-h3" id="ad-reprice-h">
        Re-price at next bell
      </h3>
      <p className="ad-note">
        An arena with open tickets cannot change its entry fee. This closes its joins at the round&apos;s last minute, lets the round finish at the bell, refunds tickets that were never
        seated, and turns ready: then sign the sync above. It opens again by itself once the new entry fee is on chain.
      </p>
      <ul className="ad-reprice__list">
        {arenaIds.map((id) => {
          const e = of(id);
          const v = repriceText(e);
          return (
            <li key={id} className="ad-reprice__row" data-arena={id}>
              <span>
                <span className="num ad-dim">#{id}</span> <strong>{arenaName(id)}</strong>
              </span>
              <span className={`ad-code mono is-${v.tone}`} data-testid={`reprice-state-${id}`}>
                {v.label}
              </span>
              {e ? (
                <Btn testId={`reprice-cancel-${id}`} disabled={busy} onClick={() => void act([id], true)}>
                  Cancel
                </Btn>
              ) : (
                <Btn testId={`reprice-go-${id}`} disabled={busy || entries === null} onClick={() => void act([id], false)}>
                  Re-price at next bell
                </Btn>
              )}
            </li>
          );
        })}
      </ul>
      {due.length > 1 && (
        <div className="ad-actions">
          <Btn sun testId="reprice-all" disabled={busy || entries === null} onClick={() => void act(due, false)}>
            {`Re-price the ${due.length} changed arenas at next bell`}
          </Btn>
        </div>
      )}
      <FormError error={err} />
    </section>
  );
}

/**
 * Game → Arena prices (USD): the tiers ($1 / $3 / $5 / $10, the $10 one holders-only), where the token's USD price
 * comes from (the manual price the admin types; a Pons / DEX TWAP is not wired yet), the rounding, and "Sync arena
 * prices to USD": every tier's token entry at that price against the chain (old → new, in tokens and USD), then the
 * `updateArena` / `setArenaHoldersOnly` calls for the OWNER's wallet to sign, one prompt each. The server stores the
 * settings only; it never holds the owner key. Open tickets keep the entry fee they were bought with.
 */
export function ArenaPricesCard({ ctx }: { ctx: ChainCtx }) {
  const [view, setView] = useState<ArenaPricesAdminView | null>(null);
  const [draft, setDraft] = useState<ArenaPricingSettings | null>(null);
  const [usdText, setUsdText] = useState<Record<number, string>>({});
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const inFlight = useRef(false);
  const adopt = (v: ArenaPricesAdminView) => {
    setView(v);
    setDraft(structuredClone(v.settings));
    setUsdText(Object.fromEntries(v.settings.tiers.map((t) => [t.arenaId, dollarsOf(t.usdCents)])));
  };
  const load = useCallback(() => {
    if (!ctx.api) return;
    ctx.api.arenaPrices().then(
      (v) => {
        adopt(v);
        setState('ok');
      },
      (e) => {
        if (e instanceof SiteApiError && e.status === 404) setState('missing');
        else {
          setState('error');
          setErr((e as Error).message);
        }
      },
    );
  }, [ctx.api]);
  useEffect(load, [load]);

  if (!ctx.api) return <Card title="Arena prices (USD)" id="arena-prices" tone="quiet" lede="Sign in as the admin (top right) to see and change the arena prices." />;
  if (state === 'missing') return <Card title="Arena prices (USD)" id="arena-prices" tone="quiet" lede="This server has no arena prices yet (/api/admin/arena-prices). Update the game server." />;
  if (!view || !draft) return <Card title="Arena prices (USD)" id="arena-prices" tone="quiet" lede={state === 'error' ? `Cannot load the arena prices: ${err}` : 'Loading the arena prices…'} />;

  const patch = arenaPricingPatch(view.settings, draft);
  const dirty = Object.keys(patch).length > 0;
  const badTier = draft.tiers.find((t) => centsOf(usdText[t.arenaId] ?? '') === null);
  let draftPriceOk = true;
  if (draft.manualUsdPerToken?.trim()) {
    try {
      parseUsdPrice(draft.manualUsdPerToken);
    } catch {
      draftPriceOk = false;
    }
  }
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      adopt(await ctx.api!.saveArenaPrices(patch));
      setMsg('Saved. The lobby shows the dollar prices; sign the sync below to change the entry fees on chain.');
    } catch (e) {
      setErr(saveErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const setTier = (id: number, change: Partial<ArenaUsdTier>) => setDraft({ ...draft, tiers: draft.tiers.map((t) => (t.arenaId === id ? { ...t, ...change } : t)) });

  // the sync: the SAVED settings (what the lobby shows) against the chain
  const a = ctx.status?.arena ?? null;
  const cfg = a?.config ?? null;
  const arena = ctx.net.arenaAddress;
  const decimals = cfg?.decimals ?? 18;
  const sym = a?.token?.symbol ? ` ${a.token.symbol}` : '';
  const saved = view.settings;
  const price = view.price.ok ? parseUsdPrice(view.price.usdPerToken) : null;
  const rows: ArenaPriceRow[] =
    cfg?.token && a ? arenaPriceDiff({ tiers: saved.tiers, price, decimals, sigFigs: saved.sigFigs, arenas: a.arenas, holderNft: !!cfg.holderNft }) : [];
  const calls = arena ? arenaPriceSyncCalls(arena, rows) : [];
  const ownerOk = !!ctx.me && !!cfg && sameAddress(cfg.admin, ctx.me);
  const blocked = dirty
    ? 'Save the settings first: the sync uses the saved prices.'
    : !price
      ? 'Set the token price first.'
      : !cfg?.token
        ? 'The arena has no game token yet (Setup → Finish setup).'
        : !ctx.me
          ? 'Connect the owner wallet.'
          : !ownerOk
            ? 'The connected wallet is not the arena owner.'
            : null;

  const sign = async () => {
    const chain = ctx.net.chain;
    if (inFlight.current || calls.length === 0 || blocked || !chain) return;
    inFlight.current = true;
    const r: Run = { at: 0, done: 0, total: calls.length, error: null, busy: true, hashes: [] };
    setRun({ ...r });
    for (let i = 0; i < calls.length; i++) {
      r.at = i;
      setRun({ ...r });
      const plan: Plan = { title: calls[i].label, contract: 'ElymumArena', call: calls[i].call, ownerOf: arena!, owner: cfg!.admin };
      const res = await sendWithWallet((wallet, from) => sendPlan(plan, wallet, from), { chain, publicClient: ctx.client });
      if (!res.ok) {
        r.error = `${calls[i].label}: ${txErrorText(res.error)}`;
        break;
      }
      r.done++;
      r.hashes.push(res.hash);
      setRun({ ...r });
    }
    r.busy = false;
    setRun({ ...r });
    inFlight.current = false;
    await ctx.refresh();
  };

  const at = view.price.ok && view.price.at ? new Date(view.price.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null;
  const tok = (raw: bigint | null) => (raw === null ? '—' : `${fmtTok(raw, decimals)}${sym}`);
  const usd = (v: number | null) => (v === null ? '' : ` · ${formatUsd(v)}`);
  return (
    <Card
      title="Arena prices (USD)"
      id="arena-prices"
      kicker={view.price.ok ? `${view.price.usdPerToken} USD per token` : 'No token price'}
      lede="Tickets are priced in US dollars; the chain keeps entry fees in token units. Set the token's USD price, save, then sign the sync with the owner wallet: it re-prices each arena in tokens. Open tickets keep the entry fee they were bought with, and the contract changes an entry fee only while none of that arena's tickets is open."
    >
      <div className="ad-switchrow" role="group" aria-label="Price source">
        <span className="ad-switchrow__label mono">Price source</span>
        <div className="ad-switchrow__segs">
          <button type="button" className="ad-seg is-on" aria-pressed="true" disabled>
            Manual
          </button>
          <button type="button" className="ad-seg" aria-pressed="false" disabled title="A future on-chain Pons / DEX TWAP: not wired yet">
            Pons TWAP (not wired yet)
          </button>
        </div>
      </div>
      <div className="ad-form ad-form--grid">
        <Input
          label="Token price (USD per whole token)"
          value={draft.manualUsdPerToken ?? ''}
          onChange={(v) => setDraft({ ...draft, manualUsdPerToken: v })}
          placeholder="0.00081"
          suffix="USD"
          hint={!draftPriceOk ? 'A plain decimal above 0, at most 18 decimals.' : at ? `Set ${at}` : 'Not set yet: nothing to sync.'}
        />
        <label className="ad-field">
          <span className="ad-field__label mono">Round entries to (significant figures)</span>
          <input
            className="ad-input ad-input--num num"
            type="number"
            min={ARENA_PRICING_LIMITS.sigFigsMin}
            max={ARENA_PRICING_LIMITS.sigFigsMax}
            value={draft.sigFigs}
            aria-label="Significant figures"
            onChange={(e) => setDraft({ ...draft, sigFigs: Math.max(ARENA_PRICING_LIMITS.sigFigsMin, Math.min(ARENA_PRICING_LIMITS.sigFigsMax, Math.floor(Number(e.target.value) || 1))) })}
          />
        </label>
      </div>
      <div className="ad-tablewrap">
        <table className="ad-table" data-testid="arena-tiers">
          <caption className="mono">Tiers</caption>
          <thead>
            <tr>
              <th scope="col">Arena</th>
              <th scope="col" className="is-num">
                Ticket (USD)
              </th>
              <th scope="col">Emblem holders only</th>
            </tr>
          </thead>
          <tbody>
            {draft.tiers.map((t) => (
              <tr key={t.arenaId} data-arena={t.arenaId}>
                <td>
                  <span className="num ad-dim">#{t.arenaId}</span> <strong>{arenaName(t.arenaId)}</strong>
                </td>
                <td className="is-num">
                  <input
                    className="ad-input ad-input--num num"
                    value={usdText[t.arenaId] ?? ''}
                    aria-label={`Arena #${t.arenaId} price in USD`}
                    onChange={(e) => {
                      setUsdText({ ...usdText, [t.arenaId]: e.target.value });
                      const c = centsOf(e.target.value);
                      if (c !== null && c > 0) setTier(t.arenaId, { usdCents: c });
                    }}
                  />
                </td>
                <td>
                  <label className="ad-switch ad-switch--inline">
                    <input type="checkbox" role="switch" checked={t.holdersOnly} onChange={() => setTier(t.arenaId, { holdersOnly: !t.holdersOnly })} aria-label={`Arena #${t.arenaId} holders only`} />
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ad-actions">
        <Btn sun disabled={!dirty || busy || !draftPriceOk || !!badTier} onClick={() => void save()} testId="arena-prices-save">
          {busy ? 'Saving…' : 'Save arena prices'}
        </Btn>
        {dirty && <Btn onClick={() => adopt(view)}>Undo</Btn>}
        {msg && !dirty && <span className="ad-note">{msg}</span>}
      </div>
      <FormError error={err} />

      <h3 className="ad-h3">Sync arena prices to USD</h3>
      {rows.length > 0 && (
        <div className="ad-tablewrap">
          <table className="ad-table" data-testid="arena-price-sync">
            <thead>
              <tr>
                <th scope="col">Arena</th>
                <th scope="col" className="is-num">
                  Ticket
                </th>
                <th scope="col" className="is-num">
                  Entry now
                </th>
                <th scope="col" className="is-num">
                  New entry
                </th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.arenaId} data-arena={r.arenaId}>
                  <td>
                    <span className="num ad-dim">#{r.arenaId}</span> <strong>{arenaName(r.arenaId)}</strong>
                  </td>
                  <td className="num is-num">{formatUsdCents(r.usdCents)}</td>
                  <td className="num is-num">
                    {tok(r.oldEntry)}
                    <span className="ad-dim">{usd(r.oldUsd)}</span>
                  </td>
                  <td className="num is-num">
                    {tok(r.newEntry)}
                    <span className="ad-dim">{usd(r.newUsd)}</span>
                  </td>
                  <td>
                    {r.error ? (
                      <span className="ad-bad">{r.error}</span>
                    ) : r.blocked ? (
                      <span className="ad-bad">{r.blocked}</span>
                    ) : !r.entryChange && r.holdersOnlyChange === null ? (
                      <span className="ad-code mono is-ok">in sync</span>
                    ) : (
                      <span className="ad-code mono">
                        {[r.entryChange ? 'updateArena' : null, r.holdersOnlyChange !== null ? `holders only: ${r.holdersOnlyChange ? 'on' : 'off'}` : null].filter(Boolean).join(' + ')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {run && (
        <ol className="ad-checks" data-testid="arena-price-sync-steps">
          {calls.length === 0 && run.done > 0 && (
            <li className="ad-check-line is-ok">
              <Mark state="ok" />
              <span className="ad-check-line__label">{run.done} change(s) signed: the arenas are at their USD prices.</span>
            </li>
          )}
          {calls.map((c, i) => (
            <li key={`${c.label}-${i}`} className={`ad-check-line is-${run.busy && run.at === i ? 'unknown' : 'todo'}`}>
              <Mark state={run.busy && run.at === i ? 'active' : 'todo'} />
              <span className="ad-check-line__label">{c.label}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="ad-actions">
        <Btn primary icon="wallet" testId="arena-price-sync-go" disabled={!!blocked || calls.length === 0 || !!run?.busy} onClick={() => void sign()}>
          {run?.busy ? `Signing ${run.at + 1} of ${run.total}…` : calls.length === 0 ? 'Nothing to sign' : `Sign ${calls.length} change${calls.length === 1 ? '' : 's'} with the owner wallet`}
        </Btn>
        {blocked && <span className="ad-note">{blocked}</span>}
      </div>
      <FormError error={run?.error ?? null} />
      {typeof ctx.api.reprice === 'function' && <RepriceAtBell api={ctx.api} arenaIds={draft.tiers.map((t) => t.arenaId)} pending={rows.filter((r) => r.entryChange && !r.error).map((r) => r.arenaId)} />}
    </Card>
  );
}
