import { GAS_SYMBOL } from '@coinnibal/shared';
import type { SiteCounts, SiteSettings } from '@coinnibal/shared';
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CoinCharacter, CoinMark, StatusPill, Tabs, TabPanel, tabId, type TabItem } from '../../design';
import { adminApi } from '../../site/api';
import { AdminPanel, type ChainTab } from '../AdminPanel';
import { ADMIN_GROUPS, CHAIN_GROUPS, GROUP_LABEL, adminHash, groupSummary, isAdminView, parseAdminHash, type AdminGroup, type AdminPage, type AdminView, type CommunityTab } from '../groups';
import type { AdminNetwork } from '../net';
import { SummaryBar } from '../SummaryBar';
import { AdminSessionBar, SignInCard, useAdminSession, type OwnerRole } from './AdminSession';
import { AppetizersTab } from './AppetizersTab';
import { AvatarsTab } from './AvatarsTab';
import { CollabsTab } from './CollabsTab';
import { FeedbackTab, useFeedbackUnread } from './FeedbackTab';
import { IntegrityTab } from './IntegrityTab';
import { SettingsTab } from './SettingsTab';
import { TasksTab } from './TasksTab';
import { WlTab } from './WlTab';
import './admin-site.css';

const TABS: TabItem<AdminGroup>[] = ADMIN_GROUPS.map((id) => ({ id, label: GROUP_LABEL[id] }));
const IDS = TABS.map((t) => t.id);
const COMMUNITY_ITEMS: TabItem<CommunityTab>[] = [
  { id: 'wl', label: 'WL' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'collabs', label: 'Collabs' },
];

/** The start screen's pages: a title and one short line. */
const VIEW_BENCH: Record<AdminView, { title: string; lede: string }> = {
  home: { title: 'Start', lede: 'Where things stand, and the few things you do here.' },
  deploy: { title: 'Deploy the contracts', lede: 'From your own wallet, in one go. You confirm each step in your wallet.' },
  open: { title: 'Open or close the game', lede: 'Who may play. It changes at once, with no transaction.' },
  minting: { title: 'Mint', lede: 'Open or close the NFT mint. Your wallet confirms the switch.' },
};

/** Each drawer's heading: a title and one honest line under it. */
const BENCH: Record<AdminGroup, { title: string; lede: string }> = {
  network: { title: 'Network', lede: 'The chain the server follows, its RPC, the server key, the contracts, and the way to mainnet.' },
  setup: { title: 'Setup', lede: 'Every contract leaves from your wallet, and your wallet becomes its owner. Then the NFT perks and the TestToken.' },
  mint: { title: 'Mint', lede: 'Start and stop the mint, the allowlist, the price and the small print of the Coinnibal NFT.' },
  game: { title: 'Game', lede: 'Who may play, the arena switches, the bots and the rooms right now.' },
  community: { title: 'Community', lede: 'The WL, the chores applicants do, and the communities asking for spots.' },
  safety: { title: 'Safety', lede: 'Farming, feeding and collusion (evidence for a person to weigh, never a verdict), and the pictures players wear.' },
  feedback: { title: 'Feedback', lede: 'What players tell you from the game page: problems, ideas, questions.' },
  appetizers: { title: 'Appetizers', lede: 'The early cards visitors claim on the landing page: the handle, the wallet, the post on X.' },
  settings: { title: 'Settings', lede: 'What visitors can see: the game (the same switch as in Game), the mint page, WL and collab applications, Appetizer cards. And the X handle.' },
};

import { NetPill } from '../NetPill';

export { NetPill };

/**
 * `/admin`: the operator's workshop. A top bar (network, wallet, owner and admin badges), a rail
 * of drawers on the left and the open drawer on the right. The chain drawers (Network, Setup,
 * Mint, Game; status for everyone, writes for the contract owner) sit above the site drawers
 * (Community, Safety, Settings). The site drawers (and the server steps of the chain drawers:
 * registering contracts, the allowlist, the mint price (MINT_USD_CENTS)) need an admin session
 * (SIWE with a wallet in ADMIN_WALLETS); every call sends it as a Bearer token.
 */
export function AdminHome({ net, reloadNet }: { net: AdminNetwork; reloadNet: () => Promise<void> }) {
  const [page, setPage] = useState<AdminPage>(() => parseAdminHash(location.hash).group);
  const [sub, setSub] = useState<CommunityTab>(() => parseAdminHash(location.hash).sub);
  const [role, setRole] = useState<OwnerRole>({ arena: null, nft: null });
  const state = useAdminSession();
  const api = useMemo(() => (state.kind === 'admin' ? adminApi(state.session.token) : null), [state]);
  // players' messages waiting: the Feedback drawer's badge
  const [unread, setUnread] = useFeedbackUnread(api);
  const tabs = useMemo(() => TABS.map((it) => (it.id === 'feedback' && unread ? { ...it, badge: unread } : it)), [unread]);
  const token = state.kind === 'admin' ? state.session.token : null;
  // the Appetizers drawer's summary line: its own totals, as the drawer reads them
  const [appetizerTotals, setAppetizerTotals] = useState<{ total: number; posted: number } | null>(null);

  useEffect(() => {
    const on = () => {
      const h = parseAdminHash(location.hash);
      setPage(h.group);
      setSub(h.sub);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  /** Opens a page; old drawer ids (the launch checklist's links: arena, wl…) land in their group. */
  const go = (t: string, s?: CommunityTab) => {
    const h = (ADMIN_GROUPS as readonly string[]).includes(t) ? { group: t as AdminGroup, sub: s ?? sub } : parseAdminHash(`#${t}`);
    setPage(h.group);
    setSub(h.sub);
    history.replaceState(null, '', adminHash(h.group, h.sub) || location.pathname);
    window.scrollTo?.({ top: 0 });
  };
  const view = isAdminView(page);
  const tab: AdminGroup = view ? 'network' : (page as AdminGroup);
  // the site drawers' opening lines read the server's counts and settings
  const [siteInfo, setSiteInfo] = useState<{ counts: SiteCounts | null; settings: SiteSettings | null }>({ counts: null, settings: null });
  // bumped by a drawer that saved something (an approval, the settings): the summary is re-read
  const [siteRev, setSiteRev] = useState(0);
  const onSiteChange = useCallback(() => setSiteRev((n) => n + 1), []);
  useEffect(() => {
    if (!api || view || CHAIN_GROUPS.includes(tab)) return;
    let live = true;
    void Promise.all([api.counts().catch(() => null), api.settings().then((r) => r.settings).catch(() => null)]).then(([counts, settings]) => live && setSiteInfo({ counts, settings }));
    return () => {
      live = false;
    };
  }, [api, tab, view, siteRev]);
  // the rail is vertical on wide screens: Up / Down move too
  const onRailKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = IDS.indexOf(tab);
    const next = IDS[(i + (e.key === 'ArrowDown' ? 1 : -1) + IDS.length) % IDS.length];
    go(next);
    document.getElementById(tabId('ad', next))?.focus();
  };

  let panel: ReactNode;
  if (view) panel = <AdminPanel net={net} api={api} tab={page as AdminView} go={(t) => go(t)} reloadNet={reloadNet} onRole={setRole} token={token} />;
  else if (CHAIN_GROUPS.includes(tab)) panel = <AdminPanel net={net} api={api} tab={tab as ChainTab} go={(t) => go(t)} reloadNet={reloadNet} onRole={setRole} />;
  else if (!api)
    panel = (
      <section className="ad-gate" role="status">
        <CoinCharacter paint="cream" mood="sleepy" size={96} feet />
        <div>
          <h2 className="ad-gate__title">{state.kind === 'checking' ? 'Checking the session…' : 'This drawer is locked.'}</h2>
          <p>The WL, collab, task, integrity, feedback, appetizer and site settings drawers open for the admin wallet. Sign in at the top right: one free signature, no transaction.</p>
        </div>
      </section>
    );
  else if (tab === 'community')
    panel = (
      <>
        <SummaryBar summary={groupSummary('community', { net, status: null, counts: siteInfo.counts })} />
        <Tabs items={COMMUNITY_ITEMS} value={sub} onChange={(s) => go('community', s)} label="Community" idBase="ad-com" className="ad-subtabs" />
        <TabPanel idBase="ad-com" id={sub} className="ad-subpanel">
          {sub === 'wl' ? <WlTab api={api} onSiteChange={onSiteChange} /> : sub === 'tasks' ? <TasksTab api={api} /> : <CollabsTab api={api} onSiteChange={onSiteChange} />}
        </TabPanel>
      </>
    );
  else if (tab === 'feedback')
    panel = (
      <>
        <SummaryBar summary={groupSummary('feedback', { net, status: null, feedbackUnread: unread })} />
        <FeedbackTab api={api} onUnread={setUnread} />
      </>
    );
  else if (tab === 'appetizers')
    panel = (
      <>
        <SummaryBar summary={groupSummary('appetizers', { net, status: null, appetizers: appetizerTotals })} />
        <AppetizersTab api={api} onTotals={setAppetizerTotals} />
      </>
    );
  else if (tab === 'safety')
    panel = (
      <>
        <SummaryBar summary={groupSummary('safety', { net, status: null })} />
        <IntegrityTab api={api} />
        <AvatarsTab api={api} />
      </>
    );
  else
    panel = (
      <>
        <SummaryBar summary={groupSummary('settings', { net, status: null, settings: siteInfo.settings })} />
        <SettingsTab api={api} onSiteChange={onSiteChange} />
      </>
    );

  const top = (
    <>
      {net.mainnet && (
        <div className="ad-mainstrip mono" role="note">
          Mainnet · every signature here moves real {GAS_SYMBOL}
        </div>
      )}
      <header className="ad-top">
        <a className="ad-brand" href="/" aria-label="Coinnibal: back to the site">
          <CoinMark size={40} />
          <span className="ad-brand__text">
            <span className="ad-brand__name">Coinnibal</span>
            <span className="ad-brand__sub mono">Workshop</span>
          </span>
        </a>
        <div className="ad-top__net">
          <NetPill net={net} />
          {net.info && <span className="ad-top__chain">{net.info.name}</span>}
        </div>
        <AdminSessionBar state={state} role={role} />
      </header>
    </>
  );

  if (view) {
    const bench = VIEW_BENCH[page as AdminView];
    return (
      <div className={`ad-shell${net.mainnet ? ' is-mainnet' : ''}`}>
        {top}
        <div className="ad-body ad-body--simple">
          <main className="ad-main">
            {page !== 'home' && (
              <button type="button" className="ad-back" onClick={() => go('home')} data-testid="admin-back">
                ← Start
              </button>
            )}
            <header className="ad-bench ad-bench--simple">
              <h1 className="ad-bench__title">{bench.title}</h1>
              <p className="ad-bench__lede">{bench.lede}</p>
            </header>
            <div className="ad-panel" id="ad-view">
              {page === 'home' && !api && <SignInCard state={state} />}
              {panel}
              {page === 'home' && <AdvancedDrawers go={go} />}
              {page !== 'home' && (
                <p className="ad-note ad-view__more">
                  More controls: <button type="button" className="ad-golink" onClick={() => go(page === 'deploy' ? 'setup' : page === 'open' ? 'game' : 'mint')}>{GROUP_LABEL[page === 'deploy' ? 'setup' : page === 'open' ? 'game' : 'mint']} (Advanced) →</button>
                </p>
              )}
            </div>
          </main>
        </div>
      </div>
    );
  }

  const bench = BENCH[tab];
  const no = String(IDS.indexOf(tab) + 1).padStart(2, '0');
  return (
    <div className={`ad-shell${net.mainnet ? ' is-mainnet' : ''}`}>
      {top}
      <div className="ad-body">
        <nav className="ad-rail" aria-label="Admin drawers">
          <button type="button" className="ad-rail__start" onClick={() => go('home')} data-testid="admin-start-link">
            ← Start
          </button>
          <span className="ad-rail__group mono">Advanced</span>
          <Tabs items={tabs} value={tab} onChange={go} label="Admin sections" idBase="ad" className="ad-tabs" onKeyDown={onRailKey} />
          <a className="ad-rail__site" href="/">
            Back to the site
          </a>
        </nav>
        <main className="ad-main">
          <header className="ad-bench">
            <span className="kicker ad-bench__no">
              Drawer {no} · {CHAIN_GROUPS.includes(tab) ? 'on chain' : 'the site'}
            </span>
            <h1 className="ad-bench__title">{bench.title}</h1>
            <p className="ad-bench__lede">{bench.lede}</p>
          </header>
          <TabPanel idBase="ad" id={tab} className="ad-panel">
            {panel}
          </TabPanel>
        </main>
      </div>
    </div>
  );
}

/** The start screen's Advanced section: every drawer (nothing removed), collapsed. */
function AdvancedDrawers({ go }: { go: (t: string) => void }) {
  return (
    <details className="ad-more ad-advanced ad-advanced--section ad-start__advanced" data-testid="start-advanced">
      <summary>Advanced: every drawer, card and setting</summary>
      <div className="ad-advanced__body">
        <ul className="ad-start__drawers">
          {ADMIN_GROUPS.map((g) => (
            <li key={g}>
              <button type="button" className="ad-start__drawer" data-drawer={g} onClick={() => go(g)}>
                <strong>{BENCH[g]?.title ?? GROUP_LABEL[g]}</strong>
                <span>{BENCH[g]?.lede ?? ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
