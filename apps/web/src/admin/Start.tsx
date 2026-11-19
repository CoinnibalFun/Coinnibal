import type { StatusSnapshot } from '@coinnibal/sdk/ops';
import type { ContractsRegistry, GameAccess } from '@coinnibal/shared';
import { useEffect, useState } from 'react';
import { Icon } from '../design';
import { SiteApiError, request } from '../site/api';
import type { Pins } from '../wallet/pinned';
import { loadLocalDeploys } from './deploy';
import { deployFlowSteps } from './flow';
import type { AdminNetwork } from './net';
import { pinsSigned, registeredPinReport } from './pins';
import { setupSteps } from './setup';
import { SwitchRow } from './GameTab';
import { Card, FormError, type ChainCtx } from './ui';

export type StartTone = 'ok' | 'todo' | 'off' | 'unknown';

export interface StartRow {
  id: 'network' | 'contracts' | 'game' | 'mint' | 'feedback' | 'community';
  label: string;
  value: string;
  tone: StartTone;
}

export interface StartInput {
  net: AdminNetwork;
  status: StatusSnapshot | null;
  registry: ContractsRegistry | null | undefined;
  signed: Pins | null;
  /** The effective game access (null: not signed in). */
  access: GameAccess | null;
  /** The server's GAME_ACCESS override, if any. */
  accessEnv: GameAccess | null;
  /** Feedback waiting (null: not signed in; undefined: this server has no feedback route). */
  feedback: number | null | undefined;
  /** The WL and collab forms (null: not signed in or not read yet). */
  community?: StartCommunity | null;
  /** Deploy steps left (`deployFlowSteps`). */
  deployLeft: number;
  /** Nothing is deployed yet. */
  fresh: boolean;
}

/** The WL and collab forms for the start screen: open or not, and the applications waiting for a decision. */
export interface StartCommunity {
  wlOpen: boolean;
  collabOpen: boolean;
  wlWaiting: number;
  collabWaiting: number;
}

const GAME_NOW: Record<GameAccess, { value: string; tone: StartTone }> = {
  admins: { value: 'Closed. Only admins play.', tone: 'off' },
  holders: { value: 'Open to NFT holders.', tone: 'ok' },
  public: { value: 'Open to everyone.', tone: 'ok' },
  maintenance: { value: 'Down for maintenance.', tone: 'todo' },
};

/** The start screen's six status lines (pure, tested). */
export function startRows(i: StartInput): StartRow[] {
  const { net } = i;
  const network: StartRow = !net.chain
    ? { id: 'network', label: 'Network', value: 'The game server is not answering.', tone: 'todo' }
    : !net.info
      ? { id: 'network', label: 'Network', value: 'The server has no chain yet.', tone: 'todo' }
      : { id: 'network', label: 'Network', value: `${net.info.name} (${net.info.id})${net.mainnet ? ' · mainnet' : ''}`, tone: 'ok' };
  const contracts: StartRow = !net.info
    ? { id: 'contracts', label: 'Contracts', value: 'Waiting for the network.', tone: 'unknown' }
    : i.fresh
      ? { id: 'contracts', label: 'Contracts', value: 'Not deployed yet.', tone: 'todo' }
      : i.deployLeft > 0
        ? { id: 'contracts', label: 'Contracts', value: `${i.deployLeft} deploy step${i.deployLeft === 1 ? '' : 's'} left.`, tone: 'todo' }
        : { id: 'contracts', label: 'Contracts', value: 'Live and signed for the site.', tone: 'ok' };
  const g = i.access ? GAME_NOW[i.access] : null;
  const game: StartRow = g ? { id: 'game', label: 'Game', value: `${g.value}${i.accessEnv ? ' (fixed on the server)' : ''}`, tone: g.tone } : { id: 'game', label: 'Game', value: 'Sign in to see.', tone: 'unknown' };
  const nft = i.status?.nft?.state ?? null;
  const mint: StartRow = !net.nftAddress
    ? { id: 'mint', label: 'Mint', value: 'No NFT yet.', tone: 'off' }
    : !nft
      ? { id: 'mint', label: 'Mint', value: 'Reading the NFT…', tone: 'unknown' }
      : {
          id: 'mint',
          label: 'Mint',
          value: `${nft.phaseName === 'closed' ? 'Closed' : nft.phaseName === 'allowlist' ? 'Allowlist open' : 'Open to everyone'} · ${nft.totalSupply.toLocaleString('en-US')} / ${nft.maxSupply.toLocaleString('en-US')} minted.`,
          tone: nft.phaseName === 'closed' ? 'off' : 'ok',
        };
  const feedback: StartRow =
    i.feedback === undefined
      ? { id: 'feedback', label: 'Feedback', value: 'Not on this server yet.', tone: 'off' }
      : i.feedback === null
        ? { id: 'feedback', label: 'Feedback', value: 'Sign in to see.', tone: 'unknown' }
        : i.feedback === 0
          ? { id: 'feedback', label: 'Feedback', value: 'Nothing new.', tone: 'ok' }
          : { id: 'feedback', label: 'Feedback', value: `${i.feedback} new.`, tone: 'todo' };
  const c = i.community;
  const community: StartRow = !c
    ? { id: 'community', label: 'WL & collabs', value: 'Sign in to see.', tone: 'unknown' }
    : {
        id: 'community',
        label: 'WL & collabs',
        value: `WL ${c.wlOpen ? 'open' : 'closed'} · ${c.wlWaiting} waiting. Collabs ${c.collabOpen ? 'open' : 'closed'} · ${c.collabWaiting} waiting.`,
        tone: c.wlWaiting + c.collabWaiting > 0 ? 'todo' : c.wlOpen || c.collabOpen ? 'ok' : 'off',
      };
  return [network, contracts, game, mint, feedback, community];
}

export interface StartAction {
  /** The page it opens (`feedback` is lane FEED's drawer). */
  go: 'deploy' | 'open' | 'minting' | 'feedback' | 'community' | 'settings';
  title: string;
  hint: string;
  /** The next thing to do. */
  next: boolean;
}

/** The big actions, in order, with the one that comes next marked (pure, tested). */
export function startActions(i: StartInput): StartAction[] {
  const rows = new Map(startRows(i).map((r) => [r.id, r]));
  const deployNext = !!i.net.info && (i.fresh || i.deployLeft > 0);
  return [
    { go: 'deploy', title: 'Deploy the contracts', hint: deployNext ? (i.fresh ? 'Start here. One flow, from your wallet.' : `${i.deployLeft} step${i.deployLeft === 1 ? '' : 's'} left.`) : i.net.info ? 'Done.' : 'Waiting for the network.', next: deployNext },
    { go: 'open', title: 'Open or close the game', hint: rows.get('game')!.value, next: false },
    { go: 'minting', title: 'Mint', hint: rows.get('mint')!.value, next: false },
    { go: 'feedback', title: 'Feedback', hint: rows.get('feedback')!.value, next: (i.feedback ?? 0) > 0 && !deployNext },
    { go: 'community', title: 'WL and collab applications', hint: rows.get('community')!.value, next: !deployNext && !((i.feedback ?? 0) > 0) && !!i.community && i.community.wlWaiting + i.community.collabWaiting > 0 },
    { go: 'settings', title: 'Settings', hint: 'What visitors see: the mint page, WL and collab forms, the X handle.', next: false },
  ];
}

/** `GET /api/admin/feedback`'s unread count (lane FEED's drawer): undefined when this server has no such route. */
/** The WL and collab forms and their waiting applications (`/api/admin/counts`, `/api/admin/settings`); null on any error. */
async function communityNow(token: string): Promise<StartCommunity | null> {
  try {
    const [counts, settings] = await Promise.all([
      request<{ wl: { pending: number }; collab: { pending: number; submitted: number } }>('/api/admin/counts', { token }),
      request<{ settings: { wlOpen: boolean; collabOpen: boolean } }>('/api/admin/settings', { token }),
    ]);
    return { wlOpen: settings.settings.wlOpen === true, collabOpen: settings.settings.collabOpen === true, wlWaiting: counts.wl.pending ?? 0, collabWaiting: (counts.collab.pending ?? 0) + (counts.collab.submitted ?? 0) };
  } catch {
    return null;
  }
}

async function feedbackWaiting(token: string): Promise<number | null | undefined> {
  try {
    const r = await request<{ unread?: unknown }>('/api/admin/feedback', { token });
    return typeof r.unread === 'number' ? r.unread : null;
  } catch (err) {
    return err instanceof SiteApiError && (err.status === 404 || err.code === 'not_found') ? undefined : null;
  }
}

const TONE_WORD: Record<StartTone, string> = { ok: 'ok', todo: 'to do', off: 'off', unknown: 'unknown' };

/**
 * `/admin`'s first screen: six status lines and six big actions in order. Everything else (the drawers, their cards
 * and the long explanations) sits under Advanced, below it (AdminHome).
 */
export function StartScreen({ ctx, go, token, access }: { ctx: ChainCtx; go: (page: string) => void; token: string | null; access: { settings: { gameAccess: GameAccess }; env: GameAccess | null } | null }) {
  const [feedback, setFeedback] = useState<number | null | undefined>(null);
  const [community, setCommunity] = useState<StartCommunity | null>(null);
  useEffect(() => {
    if (!token) {
      setCommunity(null);
      return setFeedback(null);
    }
    let live = true;
    void feedbackWaiting(token).then((n) => live && setFeedback(n));
    void communityNow(token).then((c) => live && setCommunity(c));
    return () => {
      live = false;
    };
  }, [token]);
  const chainId = ctx.net.info?.id ?? null;
  const local = loadLocalDeploys(chainId);
  const cfg = ctx.status?.arena?.config ?? null;
  const pins = registeredPinReport(ctx.net, ctx.status, undefined, ctx.signed ?? null);
  const steps = deployFlowSteps({
    chainId,
    mainnet: ctx.net.mainnet,
    registry: ctx.registry ?? (ctx.net.arenaAddress || ctx.net.nftAddress ? { arena: ctx.net.arenaAddress ? ({ address: ctx.net.arenaAddress } as never) : null, nft: ctx.net.nftAddress ? ({ address: ctx.net.nftAddress } as never) : null, token: null } : null),
    local,
    status: ctx.status,
    setup: ctx.status?.arena && cfg ? setupSteps({ status: ctx.status }, { openMint: false }) : [],
    pinsOk: pinsSigned(pins),
    // a registered arena or NFT of an older version counts as not deployed: the deploy flow replaces it
    stale: [ctx.status?.arena, ctx.status?.nft].flatMap((x) => (x && x.code !== 'ok' ? [x.address.toLowerCase()] : [])),
  });
  const input: StartInput = {
    net: ctx.net,
    status: ctx.status,
    registry: ctx.registry,
    signed: ctx.signed ?? null,
    access: access ? (access.env ?? access.settings.gameAccess) : null,
    accessEnv: access?.env ?? null,
    feedback: token ? feedback : null,
    community: token ? community : null,
    deployLeft: steps.filter((s) => !s.done).length,
    fresh: !ctx.net.arenaAddress && !ctx.net.nftAddress && !local.arena && !local.nft,
  };
  const rows = startRows(input);
  const actions = startActions(input);
  return (
    <div className="ad-start" data-testid="admin-start">
      <section className="ad-card ad-start__status" aria-labelledby="ad-start-status-h">
        <h2 className="ad-card__title" id="ad-start-status-h">
          Now
        </h2>
        <dl className="ad-start__rows" data-testid="start-status">
          {rows.map((r) => (
            <div key={r.id} className={`ad-start__row is-${r.tone}`} data-row={r.id} data-tone={r.tone}>
              <dt className="mono">{r.label}</dt>
              <dd>
                <span className="ad-start__dot" aria-hidden="true" />
                <span className="kb-sr">{TONE_WORD[r.tone]}: </span>
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <ol className="ad-start__actions" data-testid="start-actions" aria-label="What to do">
        {actions.map((a, i) => (
          <li key={a.go}>
            <button type="button" className={`ad-start__action${a.next ? ' is-next' : ''}`} data-go={a.go} onClick={() => go(a.go)}>
              <span className="ad-start__n num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="ad-start__text">
                <strong className="ad-start__title">{a.title}</strong>
                <span className="ad-start__hint">{a.hint}</span>
              </span>
              {a.next && <span className="ad-start__next mono">Next</span>}
              <Icon name="arrow" size={20} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

const ACCESS_CHOICES: { id: GameAccess; label: string; note: string }[] = [
  { id: 'public', label: 'Open to everyone', note: 'Every visitor can play. Practice needs no wallet.' },
  { id: 'holders', label: 'Only NFT holders', note: 'Wallets that hold a Coinnibal NFT (and admins) can play.' },
  { id: 'admins', label: 'Closed', note: 'Only admin wallets can play. Visitors read that the game is not open yet.' },
];

/** The start screen's "Open or close the game": who may play, saved on the server at once (no transaction). */
export function GameSwitchCard({ ctx }: { ctx: ChainCtx }) {
  const [access, setAccess] = useState<GameAccess | null>(null);
  const [env, setEnv] = useState<GameAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!ctx.api) return;
    let live = true;
    ctx.api.settings().then(
      (r) => {
        if (!live) return;
        setAccess(r.settings.gameAccess);
        setEnv(r.gameAccessEnv ?? null);
      },
      (e: Error) => live && setErr(e.message),
    );
    return () => {
      live = false;
    };
  }, [ctx.api]);
  const now = env ?? access;
  const pick = async (m: GameAccess) => {
    if (!ctx.api) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await ctx.api.saveSettings({ gameAccess: m });
      setAccess(r.settings.gameAccess);
      setEnv(r.gameAccessEnv ?? null);
      ctx.settingsChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!ctx.api) return <Card title="Who may play" id="game-switch" tone="quiet" lede="Sign in at the top right first (one free signature)." />;
  return (
    <Card title="Who may play" id="game-switch" kicker={now ? `Now: ${GAME_NOW[now].value}` : 'Reading…'} lede="It changes at once. No transaction.">
      <SwitchRow label="The game" options={ACCESS_CHOICES} value={now === 'maintenance' ? null : now} busy={busy || !!env} onPick={(m) => void pick(m)} testId="game-switch" />
      <p className="ad-note">{ACCESS_CHOICES.find((c) => c.id === now)?.note ?? (now === 'maintenance' ? 'Maintenance: only admins play. Pick one above to end it.' : '')}</p>
      {env && <p className="ad-note">The server fixes this (GAME_ACCESS={env}): the switch cannot change it.</p>}
      <FormError error={err} />
    </Card>
  );
}
