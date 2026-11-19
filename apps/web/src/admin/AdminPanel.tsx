import { sameAddress } from '@coinnibal/sdk';
import { checkDeployedCode } from '@coinnibal/sdk/ops';
import { useEffect, useMemo, useState } from 'react';
import type { Address, PublicClient } from 'viem';
import { Button } from '../design';
import type { AdminApi } from '../site/api';
import { publicClientFor } from '../wallet/network';
import { signedPinsFor, type SignedPins } from '../wallet/pinned';
import { useWallet } from '../wallet/store';
import type { ContractsRegistry, GameAccess, SiteSettings } from '@coinnibal/shared';
import { site } from '../site/api';
import { GameTab } from './GameTab';
import { groupSummary, isAdminView, type AdminGroup, type AdminView } from './groups';
import { LaunchTab, type ChecklistTab } from './LaunchTab';
import { DeployFlow } from './DeployFlow';
import { MintSwitch, MintTab } from './MintTab';
import { GameSwitchCard, StartScreen } from './Start';
import { NetworkTab } from './NetworkTab';
import { SetupTab } from './SetupTab';
import { SummaryBar } from './SummaryBar';
import { chainBlockers, walletChainNote, type AdminNetwork } from './net';
import { readOwner, type Plan } from './plan';
import { TxPreview, type SignedEntry } from './TxPreview';
import { Addr, type ChainCtx } from './ui';
import { useAdminStatus } from './useAdminStatus';
import './admin.css';

export type ChainTab = Extract<AdminGroup, 'network' | 'setup' | 'mint' | 'game'> | AdminView;

/** The runtime code hash check as a tiny verdict tag. */
function CodeTag({ code }: { code: string | null }) {
  if (!code) return null;
  const ok = code === 'ok';
  return (
    <span className={`ad-code mono${ok ? ' is-ok' : ' is-bad'}`} title={ok ? 'The runtime code hash matches the bundled contract' : `Code check: ${code}`}>
      {ok ? 'code hash ok' : `code ${code}`}
    </span>
  );
}

/**
 * The chain drawers of `/admin` (Launch, Deploy, Mint, Arena): the contracts' status for
 * everyone, and every owner operation, signed by the connected browser wallet. Every write
 * opens the transaction preview first; the contracts check every signer themselves.
 */
export function AdminPanel({
  net,
  api,
  tab,
  go,
  reloadNet,
  onRole,
  token = null,
}: {
  net: AdminNetwork;
  api: AdminApi | null;
  tab: ChainTab;
  /** Opens a page (a drawer, a start screen action, or an old drawer id: the checklist's links). */
  go: (t: ChecklistTab | 'wl' | string) => void;
  reloadNet: () => Promise<void>;
  /** Reports whether the connected wallet owns the registered contracts (the top bar's OWNER badge). */
  onRole?: (r: { arena: boolean | null; nft: boolean | null }) => void;
  /** The admin session token (the start screen's feedback count). */
  token?: string | null;
}) {
  const me = useWallet((s) => (s.status === 'connected' ? s.address : null));
  const provider = useWallet((s) => s.current?.provider ?? null);
  const walletChainId = useWallet((s) => s.chainId);
  const client = useMemo<PublicClient | null>(() => (net.chain ? publicClientFor(net.chain, provider) : null), [net.chain, provider]);
  // the registered contracts (the TestToken is kind `token`: its faucet and minters are read too)
  const [registry, setRegistry] = useState<ContractsRegistry | null>(null);
  useEffect(() => {
    let live = true;
    site.contracts().then(
      (r) => live && setRegistry(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [net]);
  const testToken = !net.mainnet ? ((registry?.token?.address as Address | undefined) ?? null) : null;
  const { status, error, loading, refresh } = useAdminStatus(client, net, me, testToken);
  // the server's game switches, for the drawer's opening lines
  const [access, setAccess] = useState<{ settings: SiteSettings; env: GameAccess | null } | null>(null);
  // bumped by a card that saved a setting (who may play), so the summary line is not stale
  const [settingsRev, setSettingsRev] = useState(0);
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.settings().then(
      (r) => live && setAccess({ settings: r.settings, env: r.gameAccessEnv ?? null }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, tab, settingsRev]);
  // the owner's signed site pins of this chain (verified against the owner wallet this build knows)
  const [signed, setSigned] = useState<SignedPins | null>(null);
  const [pinsRev, setPinsRev] = useState(0);
  useEffect(() => {
    const id = net.info?.id;
    if (!id) return;
    let live = true;
    signedPinsFor(id, { fresh: pinsRev > 0 }).then(
      (p) => live && setSigned(p),
      () => live && setSigned(null),
    );
    return () => {
      live = false;
    };
  }, [net.info?.id, pinsRev]);
  const view = isAdminView(tab);
  const summary = view ? null : groupSummary(tab as AdminGroup, { net, status, registry, settings: access?.settings ?? null, gameAccessEnv: access?.env ?? null, signed });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [log, setLog] = useState<SignedEntry[]>([]);
  const [codes, setCodes] = useState<{ arena: string | null; nft: string | null }>({ arena: null, nft: null });
  const [nftOwner, setNftOwner] = useState<Address | null>(null);
  const blockers = chainBlockers(net, status?.chain.id);
  const note = walletChainNote(net, walletChainId);

  // the runtime code hash check of the registered contracts (the server checked it when they were registered)
  useEffect(() => {
    if (!client) return;
    let live = true;
    void Promise.all([
      net.arenaAddress ? checkDeployedCode(client, net.arenaAddress, 'arena').catch(() => null) : null,
      net.nftAddress ? checkDeployedCode(client, net.nftAddress, 'nft').catch(() => null) : null,
    ]).then(([arena, nft]) => live && setCodes({ arena, nft }));
    if (net.nftAddress) readOwner(client, net.nftAddress).then((o) => live && setNftOwner(o), () => {});
    return () => {
      live = false;
    };
  }, [client, net.arenaAddress, net.nftAddress, status]);

  const arenaAdmin = status?.arena?.config?.admin ?? null;
  const arenaRole = !me || !net.arenaAddress || !arenaAdmin ? null : sameAddress(arenaAdmin, me);
  const nftRole = !me || !net.nftAddress || !nftOwner ? null : sameAddress(nftOwner, me);
  useEffect(() => onRole?.({ arena: arenaRole, nft: nftRole }), [onRole, arenaRole, nftRole]);

  const ctx: ChainCtx = {
    net,
    status,
    refresh,
    reloadNet,
    me,
    walletChainId,
    client,
    api,
    open: setPlan,
    registry,
    settingsChanged: () => setSettingsRev((n) => n + 1),
    signed,
    pinsChanged: () => setPinsRev((n) => n + 1),
  };

  return (
    <div className={`ad-chain${view ? ' ad-chain--view' : ''}`} aria-busy={loading}>
      {summary && <SummaryBar summary={summary} />}
      {net.mainnet && tab !== 'home' && (
        <div className="ad-mainnet" role="alert" data-testid="mainnet-banner">
          <strong>MAINNET.</strong> Every transaction signed here is final and moves real funds.
        </div>
      )}
      {blockers.length > 0 && tab !== 'home' && tab !== 'open' && (
        <div className="ad-blocked" role="alert">
          <strong>SIGNING BLOCKED.</strong>
          {blockers.map((b) => (
            <p key={b}>{b}</p>
          ))}
        </div>
      )}
      {note && !view && <p className="ad-warn">{note}</p>}
      {error && !net.fake && (
        <p className="ad-err" role="alert">
          {error}
        </p>
      )}
      {!view && (
        <section className="ad-chainbar" aria-label="Registered contracts">
          <dl className="ad-chainbar__list">
            <div>
              <dt className="mono">Chain</dt>
              <dd className="ad-chainbar__chain">{net.info ? `${net.info.name} (${net.info.id})` : 'none'}</dd>
            </div>
            <div>
              <dt className="mono">CoinnibalArena</dt>
              <dd>
                <Addr value={net.arenaAddress} net={net} /> <CodeTag code={codes.arena} />
              </dd>
            </div>
            <div>
              <dt className="mono">CoinnibalNFT</dt>
              <dd>
                <Addr value={net.nftAddress} net={net} /> <CodeTag code={codes.nft} />
              </dd>
            </div>
            <div>
              <dt className="mono">Server key</dt>
              <dd>
                <Addr value={net.serverKey} net={net} />
              </dd>
            </div>
          </dl>
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()} className="ad-chainbar__refresh">
            {loading ? 'Reading…' : 'Re-read the chain'}
          </Button>
        </section>
      )}

      {tab === 'home' && <StartScreen ctx={ctx} go={go} token={token} access={access} />}
      {tab === 'deploy' && <DeployFlow ctx={ctx} />}
      {tab === 'open' && <GameSwitchCard ctx={ctx} />}
      {tab === 'minting' && <MintSwitch ctx={ctx} />}

      {tab === 'network' && (
        <>
          <NetworkTab ctx={ctx} registry={registry} />
          <LaunchTab ctx={ctx} go={go} />
        </>
      )}
      {tab === 'setup' && <SetupTab ctx={ctx} />}
      {tab === 'mint' && <MintTab ctx={ctx} />}
      {tab === 'game' && <GameTab ctx={ctx} />}

      {log.length > 0 && (
        <section className="ad-card ad-logcard" aria-labelledby="ad-log-h">
          <header className="ad-card__head">
            <h2 className="ad-card__title" id="ad-log-h">
              Signed in this session
            </h2>
          </header>
          <ol className="ad-log">
            {log.map((e) => (
              <li key={e.hash}>
                <span className="ad-log__time num">{new Date(e.at).toLocaleTimeString('en-US', { hour12: false })}</span>
                <span className="ad-log__label">{e.label}</span>
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noreferrer" className="ad-log__hash">
                    <code>{e.hash}</code>
                  </a>
                ) : (
                  <code className="ad-log__hash">{e.hash}</code>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {plan && (
        <TxPreview
          plan={plan}
          net={net}
          me={me}
          client={client}
          blockers={blockers}
          onClose={() => setPlan(null)}
          onSigned={(entry) => {
            setLog((l) => [entry, ...l]);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
