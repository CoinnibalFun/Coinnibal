import { testTokenRefusal, type StatusSnapshot } from '@coinnibal/sdk/ops';
import type { ContractsRegistry } from '@coinnibal/shared';
import { getAddress, isAddress, type Address } from 'viem';
import type { LocalDeploys } from './deploy';
import { faucetTokenToRegister, type SetupStep } from './setup';

/**
 * "Deploy the contracts" in one flow (pure, tested): every step the server's network still needs, in order, one wallet
 * signature each. Testnet: the TestToken (when none is registered), the arena, the NFT, registering them, setting the
 * game token, the rooms and the NFT perks, and the site pins. Mainnet: the arena, the NFT, registering them, the NFT
 * perks and the site pins; the game token comes later (it is launched on Pons), and the site pins are signed again then.
 */
export type FlowStepId = 'test-token' | 'arena' | 'nft' | 'register' | 'token' | 'setup' | 'pins';

export interface FlowStep {
  id: FlowStepId;
  label: string;
  /** One short line: what it does, or what was made. */
  detail: string;
  done: boolean;
  /** What the wallet is asked for: a transaction (`n` of them), a free message, or nothing. */
  ask: { kind: 'tx'; n: number } | { kind: 'message' } | { kind: 'none' };
}

export interface FlowInput {
  /** The server's chain id (null: no chain). */
  chainId: number | null;
  mainnet: boolean;
  /** The server's registered contracts. */
  registry: ContractsRegistry | null | undefined;
  /** What this browser deployed (kept until it is registered). */
  local: LocalDeploys;
  /** The chain read of the registered contracts. */
  status: StatusSnapshot | null;
  /** What Finish setup would still sign (`setupSteps`, without opening the mint). */
  setup: readonly SetupStep[];
  /** The site trusts the registered contracts (`PinReport.ok`). */
  pinsOk: boolean | null;
  /**
   * Arena and NFT addresses (registered or deployed here) whose code is not this build's (an older version) or is
   * gone (`checkDeployedCode`, lower case). The flow never uses them: it deploys a new one, which replaces the old
   * one in the server's registry.
   */
  stale?: readonly string[];
}

const addr = (v: string | null | undefined): Address | null => (v && isAddress(v, { strict: false }) ? getAddress(v) : null);

/** `v` as an address, unless it is one of `stale`'s. */
const usable = (stale: readonly string[] | undefined, v: string | null | undefined): Address | null => {
  const a = addr(v);
  return a && !stale?.includes(a.toLowerCase()) ? a : null;
};

/** The chain read of the arena, unless that arena is stale (an older version: nothing it holds counts). */
const liveArena = (i: Pick<FlowInput, 'status' | 'stale'>) => (i.status?.arena && usable(i.stale, i.status.arena.address) ? i.status.arena : null);

/** The arena, NFT and token of the flow: the registered ones, else the ones this browser deployed; never a stale one. */
export function flowContracts(i: Pick<FlowInput, 'registry' | 'local' | 'status' | 'stale'>): { arena: Address | null; nft: Address | null; token: Address | null } {
  const use = (v: string | null | undefined) => usable(i.stale, v);
  return {
    arena: use(i.registry?.arena?.address) ?? use(i.local.arena?.address),
    nft: use(i.registry?.nft?.address) ?? use(i.local.nft?.address),
    token: use(liveArena(i)?.config?.token) ?? use(i.registry?.token?.address) ?? use(i.status?.testToken?.address) ?? use(i.local.token?.address),
  };
}

/** The registered arena or NFT is stale: an older version the flow replaces. */
const replaces = (i: Pick<FlowInput, 'registry' | 'stale'>, kind: 'arena' | 'nft'): Address | null => {
  const a = addr(i.registry?.[kind]?.address);
  return a && !usable(i.stale, a) ? a : null;
};

/** The steps of this network, each done or not (pure, tested). */
export function deployFlowSteps(i: FlowInput): FlowStep[] {
  const c = flowContracts(i);
  const testnet = i.chainId !== null && !testTokenRefusal(i.chainId);
  const cfg = liveArena(i)?.config ?? null;
  const tokenSet = !!cfg?.token;
  // the faucet hands out the token registered with the server, not the arena's: on a testnet the game token is registered
  // too (never a stale arena's token)
  const faucetToken = faucetTokenToRegister({ testnet, status: liveArena(i) ? i.status : null, registry: i.registry });
  const registered = { arena: !!usable(i.stale, i.registry?.arena?.address), nft: !!usable(i.stale, i.registry?.nft?.address), token: (!!i.registry?.token || tokenSet) && !faucetToken };
  const old = { arena: replaces(i, 'arena'), nft: replaces(i, 'nft') };
  const fresh = (kind: 'arena' | 'nft', what: string) => (old[kind] ? `The registered one (${old[kind]}) is an older version: a new one replaces it.` : what);
  const steps: FlowStep[] = [];
  if (testnet) steps.push({ id: 'test-token', label: 'Deploy the test token', detail: c.token ?? 'The token the test rooms take (TEST). Testnet only.', done: !!c.token, ask: { kind: 'tx', n: 1 } });
  steps.push(
    { id: 'arena', label: 'Deploy the arena', detail: c.arena ?? fresh('arena', 'It holds the ticket money and settles the rounds.'), done: !!c.arena, ask: { kind: 'tx', n: 1 } },
    { id: 'nft', label: 'Deploy the NFT', detail: c.nft ?? fresh('nft', 'The Coinnibal NFT, 3,333 pieces.'), done: !!c.nft, ask: { kind: 'tx', n: 1 } },
    {
      id: 'register',
      label: 'Register them with the server',
      detail: faucetToken ? 'The faucet hands out the token the server knows: the game token joins them. No signature.' : 'The server checks each one. No signature.',
      done: registered.arena && registered.nft && (!testnet || registered.token),
      ask: { kind: 'none' },
    },
  );
  if (testnet) steps.push({ id: 'token', label: 'Set the game token', detail: tokenSet ? cfg!.token! : 'The test token becomes the arena’s token (once, for good).', done: tokenSet, ask: { kind: 'tx', n: 1 } });
  // before the token is set the rooms are not known yet: the line stays open (testnet) until it is
  // (the setup calls of a stale arena do not count: they were read from the old one)
  const setup = cfg ? i.setup : [];
  const setupOpen = setup.length > 0 || (testnet && !tokenSet) || !cfg;
  steps.push({
    id: 'setup',
    label: i.mainnet ? 'Set the NFT perks' : 'Create the rooms and the NFT perks',
    detail: setupOpen ? (setup.length > 0 ? setup.map((s) => s.label).join(' · ') : i.mainnet ? 'The holder fee and the holders-only room.' : 'The four arenas, the holder fee, the holders-only room.') : 'All in place.',
    done: !setupOpen,
    ask: { kind: 'tx', n: Math.max(1, setup.length) },
  });
  steps.push({ id: 'pins', label: 'Sign the site pins', detail: 'One free message: the site may use these contracts. No transaction.', done: i.pinsOk === true, ask: { kind: 'message' } });
  return steps;
}

/** The first step still to do (null: all done). */
export const nextFlowStep = (steps: readonly FlowStep[]): FlowStep | null => steps.find((s) => !s.done) ?? null;

/** How many wallet prompts are left (transactions and messages). */
export function flowAsksLeft(steps: readonly FlowStep[]): number {
  return steps.filter((s) => !s.done).reduce((n, s) => n + (s.ask.kind === 'tx' ? s.ask.n : s.ask.kind === 'message' ? 1 : 0), 0);
}
