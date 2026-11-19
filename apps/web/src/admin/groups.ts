import { formatGasAmount } from '@coinnibal/sdk';
import { testTokenRefusal, type StatusSnapshot } from '@coinnibal/sdk/ops';
import { GAS_SYMBOL } from '@coinnibal/shared';
import type { ContractsRegistry, GameAccess, SiteCounts, SiteSettings } from '@coinnibal/shared';
import type { BuildPins, Pins } from '../wallet/pinned';
import type { AdminNetwork } from './net';
import { registeredPinReport } from './pins';
import { faucetTokenToRegister, setupSteps } from './setup';

/**
 * The admin panel's drawers, few and grouped (the owner runs everything from here): Network,
 * Setup (deploy), Mint, Game, Community (WL, Tasks, Collabs), Safety (integrity), Feedback (players' messages),
 * Settings.
 */
export type AdminGroup = 'network' | 'setup' | 'mint' | 'game' | 'community' | 'safety' | 'feedback' | 'settings';
export const ADMIN_GROUPS: readonly AdminGroup[] = ['network', 'setup', 'mint', 'game', 'community', 'safety', 'feedback', 'settings'];

/** The chain drawers (status for everyone, writes for the contract owner). */
export const CHAIN_GROUPS: readonly AdminGroup[] = ['network', 'setup', 'mint', 'game'];

export type CommunityTab = 'wl' | 'tasks' | 'collabs';
export const COMMUNITY_TABS: readonly CommunityTab[] = ['wl', 'tasks', 'collabs'];

export const GROUP_LABEL: Record<AdminGroup, string> = {
  network: 'Network',
  setup: 'Setup',
  mint: 'Mint',
  game: 'Game',
  community: 'Community',
  safety: 'Safety',
  feedback: 'Feedback',
  settings: 'Settings',
};

/**
 * The start screen and its big actions, outside the drawers (`/admin` opens on `home`): a short status, then Deploy
 * the contracts, Open or close the game, Mint, Feedback (the `feedback` drawer) and Settings (the drawer). Every
 * drawer stays one click away under the start screen's Advanced section.
 */
export type AdminView = 'home' | 'deploy' | 'open' | 'minting';
export const ADMIN_VIEWS: readonly AdminView[] = ['home', 'deploy', 'open', 'minting'];

/** A page of `/admin`: the start screen, one of its actions, or a drawer. */
export type AdminPage = AdminView | AdminGroup;

export const VIEW_LABEL: Record<AdminView, string> = {
  home: 'Start',
  deploy: 'Deploy the contracts',
  open: 'Open or close the game',
  minting: 'Mint',
};

/** A page's name, as the rail or the start screen shows it. */
export const pageLabel = (p: AdminPage): string => ((ADMIN_VIEWS as readonly string[]).includes(p) ? VIEW_LABEL[p as AdminView] : GROUP_LABEL[p as AdminGroup]);

export const isAdminView = (p: string): p is AdminView => (ADMIN_VIEWS as readonly string[]).includes(p);

/** Where an old drawer id (and the launch checklist's links) now lives. */
const LEGACY: Record<string, { group: AdminGroup; sub?: CommunityTab }> = {
  launch: { group: 'network' },
  arena: { group: 'game' },
  play: { group: 'game' },
  wl: { group: 'community', sub: 'wl' },
  tasks: { group: 'community', sub: 'tasks' },
  collabs: { group: 'community', sub: 'collabs' },
  integrity: { group: 'safety' },
};

/** `#community/tasks`, `#game`, `#deploy`, old `#arena`… → the page (and the Community sub-tab). Unknown → the start screen. */
export function parseAdminHash(hash: string): { group: AdminPage; sub: CommunityTab } {
  const [head, tail] = hash.replace(/^#/, '').split('/');
  const legacy = LEGACY[head];
  if (legacy) return { group: legacy.group, sub: legacy.sub ?? 'wl' };
  const group: AdminPage = (ADMIN_GROUPS as readonly string[]).includes(head) ? (head as AdminGroup) : isAdminView(head) ? head : 'home';
  const sub = (COMMUNITY_TABS as readonly string[]).includes(tail) ? (tail as CommunityTab) : 'wl';
  return { group, sub };
}

export function adminHash(group: AdminPage, sub: CommunityTab = 'wl'): string {
  if (group === 'home') return '';
  return group === 'community' && sub !== 'wl' ? `#community/${sub}` : `#${group}`;
}

/** A drawer's opening lines: what is true now, and the one next step. */
export interface GroupSummary {
  now: string;
  next: string | null;
}

export interface SummaryInput {
  net: AdminNetwork;
  status: StatusSnapshot | null;
  /** The server's registered contracts (the game token among them). */
  registry?: ContractsRegistry | null;
  settings?: SiteSettings | null;
  gameAccessEnv?: GameAccess | null;
  counts?: SiteCounts | null;
  bots?: { bots: number; humans: number; rooms: number } | null;
  /** The site build's contract pins (default: this build's). */
  pins?: BuildPins;
  /** Players' messages not read yet (null: not known, no admin session). */
  feedbackUnread?: number | null;
  /** The owner's verified signed pins of this chain. */
  signed?: Pins | null;
}

const ACCESS: Record<GameAccess, string> = { admins: 'admins only', holders: 'NFT holders', public: 'everyone', maintenance: 'maintenance (admins only)' };

/**
 * "Status now / next step" for each drawer (pure, tested). The next step is always something only
 * the owner can do (deploy, Finish setup, open the mint, fund the server key): never "register" or
 * "paste an address" the panel can fill in by itself (the one address typed by hand is the real game token on the
 * mainnet, typed twice).
 */
export function groupSummary(group: AdminGroup, i: SummaryInput): GroupSummary {
  const { net, status } = i;
  const a = status?.arena ?? null;
  const cfg = a?.config ?? null;
  const nft = status?.nft?.state ?? null;
  const chain = net.info ? `${net.mainnet ? 'MAINNET' : 'Testnet'} · ${net.info.name} (${net.info.id})` : 'No chain';
  switch (group) {
    case 'network': {
      if (!net.chain) return { now: 'The game server is not answering.', next: 'It retries every 5 s. If it stays down: on the server, run coinnibal-status (deploy/vps/README.md).' };
      if (!net.info) return { now: 'The server has no chain: its RPC did not answer, serves another chain or is not set, or SERVER_PRIVATE_KEY is empty or invalid.', next: 'Check coinnibal-compose logs app on the VPS (its "chain:" lines say which), then fix COINNIBAL_RPC_URLS or SERVER_PRIVATE_KEY in /opt/elymum/.env (EVM_RPC_URL(S) when the server runs outside Docker) and run coinnibal-compose up -d app.' };
      const bal = a?.serverBalance ?? null;
      const now = `${chain}${status ? ` · block ${status.block.toString()}` : ''}${bal !== null ? ` · server key ${formatGasAmount(bal, 4)}` : ''}`;
      if (bal === 0n) return { now, next: `Fund the server key with ${GAS_SYMBOL}: it pays the gas of every settlement.` };
      if (!net.mainnet) return { now, next: 'Mainnet launch: follow the checklist below, step by step.' };
      return { now, next: null };
    }
    case 'setup': {
      const parts = [`Arena ${net.arenaAddress ? (a?.code === 'ok' ? 'ok' : (a?.code ?? '…')) : 'missing'}`, `NFT ${net.nftAddress ? (status?.nft?.code === 'ok' ? 'ok' : (status?.nft?.code ?? '…')) : 'missing'}`];
      if (cfg) parts.push(`token ${cfg.token ? 'set' : 'not set'}`, `holder perks ${cfg.holderNft ? `on (${cfg.holderBurnBps} + ${cfg.holderVaultBps} bps)` : 'off'}`);
      // the faucet hands out the token registered with the server (testnet), not the arena's
      const faucetToken = faucetTokenToRegister({ testnet: !!net.info && !net.mainnet, status, registry: i.registry });
      if (cfg?.token && net.info && !net.mainnet && i.registry) parts.push(`faucet ${faucetToken ? 'not ready' : 'ok'}`);
      const pins = registeredPinReport(net, status, i.pins, i.signed ?? null);
      if (pins.ok !== null) parts.push(`site pins ${pins.ok ? 'ok' : 'to sign'}`);
      const now = parts.join(' · ');
      if (!net.arenaAddress) return { now, next: 'Deploy CoinnibalArena from the owner wallet (below).' };
      if (!net.nftAddress) return { now, next: 'Deploy CoinnibalNFT from the owner wallet (below).' };
      if (!cfg) return { now, next: null };
      // right after the deploy (and after setToken): the site signs nothing with contracts it was not built with
      if (pins.ok === false) return { now, next: 'Sign the site pins: Setup → Site pins (one free signature from the owner wallet).' };
      const steps = setupSteps({ status }, { openMint: !net.mainnet });
      if (!cfg.token && !steps.some((s) => s.id === 'token')) {
        const known = i.registry?.token?.address ?? status?.testToken?.address ?? null;
        if (known) return { now, next: 'Confirm the game token (one click, then your wallet).' };
        if (net.info && !testTokenRefusal(net.info.id)) return { now, next: 'Deploy a TestToken (below), then Finish setup.' };
        return { now, next: 'Once the token is launched on Pons: enter it in Setup → Set the game token, by hand and typed twice (the server cannot know it before the arena uses it).' };
      }
      // Finish setup registers the game token for the faucet too (no signature)
      const left = steps.length + (faucetToken ? 1 : 0);
      if (left > 0) return { now, next: `Finish setup: ${left} step${left === 1 ? '' : 's'} left, one button.` };
      return { now, next: null };
    }
    case 'mint': {
      if (!net.nftAddress) return { now: 'No NFT registered yet.', next: 'Deploy CoinnibalNFT in Setup.' };
      if (!nft) return { now: 'Reading the NFT…', next: null };
      const now = `Phase ${nft.phaseName} · ${nft.totalSupply} / ${nft.maxSupply} minted`;
      if (nft.phaseName === 'closed') return { now, next: net.mainnet ? 'Build and publish the allowlist, then open the allowlist mint.' : 'Open the mint (testnet: Public).' };
      if (nft.phaseName === 'allowlist') return { now, next: 'Go Public when the allowlist has had its turn.' };
      return { now, next: nft.soldOut ? null : 'Watch the supply; withdraw the proceeds to the treasury.' };
    }
    case 'game': {
      const access = i.gameAccessEnv ?? i.settings?.gameAccess ?? null;
      const parts = [access ? `Open to ${ACCESS[access]}${i.gameAccessEnv ? ' (COINNIBAL_GAME_ACCESS / GAME_ACCESS env)' : ''}` : 'Access unknown (sign in)'];
      if (cfg) parts.push(cfg.paused ? 'arena PAUSED' : 'arena taking joins');
      if (i.bots) parts.push(`${i.bots.humans} people · ${i.bots.bots} bots in ${i.bots.rooms} rooms`);
      const now = parts.join(' · ');
      if (cfg?.paused) return { now, next: 'Unpause the arena when it is safe to take joins again.' };
      if (access === 'admins') return { now, next: net.mainnet ? 'Open the game to holders when the mint is live and the token is set.' : 'When you decide: open the testnet game (Game → Who may play).' };
      return { now, next: null };
    }
    case 'community': {
      const c = i.counts;
      if (!c) return { now: 'Sign in as the admin to see the queue.', next: null };
      const now = `WL ${c.wl.approved} approved · ${c.wl.pending} waiting · collabs ${c.collab.pending ?? 0} waiting`;
      if (c.wl.pending > 0) return { now, next: `Review the ${c.wl.pending} waiting WL entries.` };
      if ((c.collab.pending ?? 0) > 0) return { now, next: 'Answer the waiting collab applications.' };
      return { now, next: null };
    }
    case 'safety':
      return { now: 'Flags, bans and held settlements.', next: 'Scan after busy rounds; held payouts wait for a person.' };
    case 'feedback': {
      const n = i.feedbackUnread;
      if (n === null || n === undefined) return { now: 'Sign in as the admin to read the messages.', next: null };
      return { now: n === 0 ? 'No unread messages.' : `${n} unread message${n === 1 ? '' : 's'}.`, next: n > 0 ? 'Read them below, newest first.' : null };
    }
    case 'settings': {
      const st = i.settings;
      if (!st) return { now: 'Sign in as the admin to see the switches.', next: null };
      return { now: `WL ${st.wlOpen ? 'open' : 'closed'} · collabs ${st.collabOpen ? 'open' : 'closed'} · @${st.xHandle}`, next: null };
    }
  }
}
