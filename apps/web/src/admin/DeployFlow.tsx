import { deployArenaParams, deployNftParams, deployTestTokenParams, sameAddress, setTokenCall } from '@coinnibal/sdk';
import { checkDeployedCode, fetchStatus, setTokenRefusal, type StatusSnapshot } from '@coinnibal/sdk/ops';
import type { ContractKind, ContractsRegistry } from '@coinnibal/shared';
import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { Icon } from '../design';
import { site } from '../site/api';
import { PINS, signedPinsFor } from '../wallet/pinned';
import { sendWithWallet, txErrorText, type TxPhase } from '../wallet/tx';
import { arenaDeployArgs, defaultNftForm, loadLocalDeploys, nftDeployArgs, saveLocalDeploy, type LocalDeploys } from './deploy';
import { deployFlowSteps, flowAsksLeft, flowContracts, nextFlowStep, type FlowStep } from './flow';
import { chainBlockers } from './net';
import { pinReport, pinsSigned } from './pins';
import { sendPlan, type Plan } from './plan';
import { faucetTokenToRegister, setupSteps } from './setup';
import { signSitePins } from './sign-pins';
import { Addr, Btn, Card, FormError, type ChainCtx } from './ui';

/** Everything the flow decides on, read fresh from the server and the chain before each step. */
interface FlowRead {
  steps: FlowStep[];
  registry: ContractsRegistry | null;
  local: LocalDeploys;
  status: StatusSnapshot | null;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Why the flow cannot start (null: it can). Pure, tested. */
export function flowRefusal(i: { me: Address | null; owner: Address | null; signedIn: boolean; blockers: readonly string[] }): string | null {
  if (i.blockers.length) return i.blockers[0];
  if (!i.owner) return 'This site build has no valid owner wallet (VITE_OWNER_WALLET).';
  if (!i.me) return `Connect the owner wallet (${short(i.owner)}) at the top right.`;
  if (!sameAddress(i.me, i.owner)) return `Deploy from the owner wallet ${short(i.owner)}. The connected wallet is ${short(i.me)}.`;
  if (!i.signedIn) return 'Sign in at the top right (one free signature), then start.';
  return null;
}

const PHASE: Record<TxPhase, string> = { switching: 'Switching the wallet to the right network…', signing: 'Confirm in your wallet…', confirming: 'Waiting for the network…' };

/**
 * "Deploy the contracts": one button runs every step this network still needs, in order (`deployFlowSteps`), one
 * wallet signature per step, and shows where it is. Each step re-reads the server and the chain first, so the flow
 * can stop anywhere (a refusal, a closed tab) and pick up where it left off. It reuses the deploy wizard's pieces
 * (constructor arguments with no address to type, the local deploy memory, the server registration, Finish setup's
 * steps); the wizard itself stays under Setup → Advanced.
 */
export function DeployFlow({ ctx, onDone }: { ctx: ChainCtx; onDone?: () => void }) {
  const chainId = ctx.net.info?.id ?? null;
  const [read, setRead] = useState<FlowRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inFlight = useRef(false);
  // the panel re-renders while the flow runs (each registration re-reads the server): use its latest callbacks
  const latest = useRef(ctx);
  latest.current = ctx;
  const cur = () => latest.current;

  /** Re-reads the server's registry, this browser's deploys, the chain and the signed pins: the steps left. */
  const load = async (fresh: boolean): Promise<FlowRead> => {
    const registry = await site.contracts().catch(() => ctx.registry ?? null);
    const local = loadLocalDeploys(chainId);
    const c = flowContracts({ registry, local, status: null });
    const testToken = !ctx.net.mainnet ? c.token : null;
    const status = ctx.client
      ? await fetchStatus(ctx.client, { arena: c.arena, nft: c.nft, testToken, account: ctx.me, chainOverrides: ctx.net.info ? { rpcUrl: ctx.net.info.rpcUrl, explorerUrl: ctx.net.info.explorerUrl } : undefined }).catch(() => null)
      : null;
    const signed = chainId ? await signedPinsFor(chainId, { fresh }).catch(() => null) : null;
    const cfg = status?.arena?.config ?? null;
    const pins = pinReport({ chainId, arena: registry?.arena?.address, nft: registry?.nft?.address, token: cfg?.token ?? null }, PINS, signed);
    const setup = status?.arena && cfg ? setupSteps({ status }, { openMint: false }) : [];
    const steps = deployFlowSteps({ chainId, mainnet: ctx.net.mainnet, registry, local, status, setup, pinsOk: pinsSigned(pins) });
    return { steps, registry, local, status };
  };

  useEffect(() => {
    let live = true;
    void load(false).then((r) => live && setRead(r));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, ctx.client, ctx.net.arenaAddress, ctx.net.nftAddress, ctx.me, ctx.signed]);

  const blockers = chainBlockers(ctx.net, ctx.status?.chain.id);
  const refusal = flowRefusal({ me: ctx.me, owner: PINS.owner, signedIn: !!ctx.api, blockers });

  /** Sends one plan from the connected wallet and waits for its receipt. */
  const send = async (plan: Plan) => {
    const chain = ctx.net.chain;
    if (!chain) throw new Error('The game server reports no chain.');
    const res = await sendWithWallet((wallet, from) => sendPlan(plan, wallet, from), { chain, publicClient: ctx.client, onPhase: (p) => setPhase(PHASE[p]) });
    setPhase(null);
    if (!res.ok) throw new Error(`${plan.title}: ${txErrorText(res.error)}`);
    return res;
  };

  /**
   * Registers what this browser deployed and the server does not know yet (the code is checked first), then, on a
   * testnet, the arena's game token when the server does not know it (the faucet hands out the registered token; the
   * server checks it is the owner's TestToken or the arena's token).
   */
  const registerLeft = async (r: FlowRead) => {
    const api = ctx.api!;
    for (const kind of ['token', 'arena', 'nft'] as ContractKind[]) {
      const d = r.local[kind];
      if (!d || r.registry?.[kind]) continue;
      if (kind === 'token' && r.status?.arena?.config?.token) continue;
      if (ctx.client) {
        const code = await checkDeployedCode(ctx.client, d.address, kind);
        if (code !== 'ok') throw new Error(`The ${kind} at ${d.address} is ${code === 'missing' ? 'not on this chain' : 'not the bundled contract'}.`);
      }
      await api.registerContract({ kind, address: d.address, txHash: d.txHash });
    }
    const gameToken = faucetTokenToRegister({ testnet: !!ctx.net.info && !ctx.net.mainnet, status: r.status, registry: r.registry });
    if (gameToken) await api.registerContract({ kind: 'token', address: gameToken, txHash: sameAddress(r.local.token?.address, gameToken) ? (r.local.token?.txHash ?? null) : null });
    await cur().reloadNet();
  };

  /** Deploys one contract, remembers it in this browser, then registers it with the server. */
  const deploy = async (kind: ContractKind, plan: Plan) => {
    const res = await send(plan);
    const address = res.receipt.contractAddress;
    if (!address || !chainId) throw new Error(`${plan.title}: the receipt names no new contract.`);
    const local = saveLocalDeploy(chainId, kind, { address, txHash: res.hash });
    await registerLeft({ steps: [], registry: await site.contracts().catch(() => null), local, status: null });
  };

  const runStep = async (step: FlowStep, r: FlowRead) => {
    const me = ctx.me!;
    const c = flowContracts(r);
    switch (step.id) {
      case 'test-token':
        return deploy('token', { title: 'Deploy the test token', contract: 'TestToken', deploy: { name: 'TestToken', params: deployTestTokenParams({ owner: me }) } });
      case 'arena':
        return deploy('arena', { title: 'Deploy the arena', contract: 'CoinnibalArena', deploy: { name: 'CoinnibalArena', params: deployArenaParams(arenaDeployArgs(me, ctx.net.serverKey)) } });
      case 'nft': {
        const quote = await ctx.api!.mintPrice().catch(() => null);
        if (!quote?.priceWei) throw new Error('The server could not price the NFT mint right now (its ETH/USD feed did not answer). Try again in a minute.');
        const args = nftDeployArgs(defaultNftForm(location.origin, quote.priceWei, me), me);
        return deploy('nft', { title: 'Deploy the NFT', contract: 'CoinnibalNFT', deploy: { name: 'CoinnibalNFT', params: deployNftParams(args) } });
      }
      case 'register':
        return registerLeft(r);
      case 'token': {
        const cfg = r.status?.arena?.config;
        if (!c.arena || !cfg || !c.token) throw new Error('The arena or the test token is not readable yet. Try again in a moment.');
        const code = ctx.client ? await ctx.client.getCode({ address: c.token }) : '0x1';
        const why = setTokenRefusal(cfg, c.token, !!code && code !== '0x');
        if (why) throw new Error(`Set the game token: ${why}.`);
        await send({ title: 'Set the game token', contract: 'CoinnibalArena', call: setTokenCall(c.arena, c.token) });
        return;
      }
      case 'setup': {
        const next = r.status?.arena?.config ? setupSteps({ status: r.status }, { openMint: false })[0] : null;
        if (!next) throw new Error('The arena is not readable yet. Try again in a moment.');
        setAt(`setup:${next.label}`);
        await send({ title: next.label, contract: 'Setup', call: next.call });
        return;
      }
      case 'pins': {
        setPhase('Sign the message in your wallet (free)…');
        const cfg = r.status?.arena?.config ?? null;
        await signSitePins({ api: ctx.api, me, chainId, targets: { arena: (r.registry?.arena?.address as Address) ?? null, nft: (r.registry?.nft?.address as Address) ?? null, token: (cfg?.token as Address | null) ?? null } });
        setPhase(null);
        cur().pinsChanged?.();
        return;
      }
    }
  };

  const start = async () => {
    if (inFlight.current || refusal) return;
    inFlight.current = true;
    setBusy(true);
    setErr(null);
    try {
      // at most one pass per step and per setup call: a step that does not finish stops the flow with its reason
      for (let guard = 0; guard < 24; guard++) {
        const r = await load(true);
        setRead(r);
        const step = nextFlowStep(r.steps);
        if (!step) {
          await cur().refresh();
          await cur().reloadNet();
          void cur().api?.mintRefresh?.().catch(() => {});
          onDone?.();
          break;
        }
        setAt(step.id);
        await runStep(step, r);
        await cur().refresh();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPhase(null);
      setAt(null);
      setBusy(false);
      inFlight.current = false;
      setRead(await load(true).catch(() => read));
    }
  };

  const steps = read?.steps ?? [];
  const left = steps.filter((s) => !s.done);
  const done = read !== null && left.length === 0;
  const asks = flowAsksLeft(steps);
  const current = at?.split(':')[0] ?? null;
  const c = read ? flowContracts(read) : null;

  return (
    <div className="ad-flow" data-testid="deploy-flow">
      <Card
        title={done ? 'Done. The contracts are live.' : 'Deploy the contracts'}
        id="deploy-flow"
        tone={done ? 'done' : undefined}
        kicker={read === null ? 'Reading…' : done ? 'All steps done' : `${left.length} step${left.length === 1 ? '' : 's'} left · ${asks} wallet prompt${asks === 1 ? '' : 's'}`}
        lede={
          done
            ? ctx.net.mainnet
              ? 'Deployed from your wallet, registered with the server and signed for the site. The game token comes later: once it is launched, set it (Setup → Set the game token), then sign the site pins again here.'
              : 'Deployed from your wallet, registered with the server, the rooms are set and the site pins are signed. Next: open the game when you are ready.'
            : 'One button. Your wallet asks once per step; you only confirm. Every contract is deployed from your wallet and owned by it.'
        }
      >
        <ol className="ad-steps ad-flow__steps" data-testid="deploy-flow-steps">
          {steps.map((s, i) => {
            const state = s.done ? 'done' : busy && current === s.id ? 'active' : 'todo';
            return (
              <li key={s.id} className={`ad-step is-${state}`} data-step={s.id} data-state={state} aria-current={state === 'active' ? 'step' : undefined}>
                <span className="ad-step__n num" aria-hidden="true">
                  {s.done ? <Icon name="check" size={16} /> : i + 1}
                </span>
                <span className="ad-step__text">
                  <strong className="ad-step__label">{s.label}</strong>
                  <span className={`ad-step__detail${/^0x[0-9a-fA-F]{40}$/.test(s.detail) ? ' is-hex' : ''}`}>{state === 'active' && phase ? phase : s.detail}</span>
                </span>
              </li>
            );
          })}
        </ol>
        {!done && (
          <div className="ad-actions">
            <Btn sun icon="arrow" testId="deploy-flow-go" disabled={busy || !!refusal || read === null} onClick={() => void start()}>
              {busy ? 'Working…' : steps.some((s) => s.done) ? 'Continue' : 'Deploy the contracts'}
            </Btn>
          </div>
        )}
        {!done && refusal && (
          <p className="ad-note" data-testid="deploy-flow-refusal">
            {refusal}
          </p>
        )}
        <FormError error={err} />
        {done && c && (
          <ul className="ad-registered" data-testid="deploy-flow-done">
            {c.arena && (
              <li>
                <span className="ad-registered__name">Arena</span>
                <Addr value={c.arena} net={ctx.net} />
              </li>
            )}
            {c.nft && (
              <li>
                <span className="ad-registered__name">NFT</span>
                <Addr value={c.nft} net={ctx.net} />
              </li>
            )}
            {read?.status?.arena?.config?.token && (
              <li>
                <span className="ad-registered__name">Token</span>
                <Addr value={read.status.arena.config.token} net={ctx.net} />
              </li>
            )}
          </ul>
        )}
      </Card>
    </div>
  );
}
