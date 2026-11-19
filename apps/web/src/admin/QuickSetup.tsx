import { sameAddress } from '@coinnibal/sdk';
import { useRef, useState } from 'react';
import type { Address, Hash } from 'viem';
import { sendWithWallet, txErrorText } from '../wallet/tx';
import { sendPlan, type Plan } from './plan';
import { faucetTokenToRegister, setupSteps, type SetupStep } from './setup';
import { signSitePins } from './sign-pins';
import { Addr, Btn, Card, FormError, Mark, Row, type ChainCtx } from './ui';

export { setupSteps, type SetupStep };

/** A line of Finish setup: a transaction (`call`), or the game token registered with the server (no signature). */
type Line = SetupStep | { id: 'faucet-token'; label: string; token: Address };
type Run = { list: Line[]; at: number; done: string[]; hashes: Hash[]; error: string | null; busy: boolean };

/**
 * "Finish setup": every missing owner step in one go. The wallet asks once per step (they are
 * separate transactions); nothing else to click in between. On a testnet whose server does not know the arena's game
 * token yet, the panel registers it first, with no signature: the faucet hands out the registered token. Stops at the
 * first refusal and can be resumed (finished steps are read back from the chain and skipped).
 */
export function QuickSetup({ ctx }: { ctx: ChainCtx }) {
  const openMint = !ctx.net.mainnet;
  const steps = setupSteps(ctx, { openMint });
  const faucetToken = faucetTokenToRegister({ testnet: !!ctx.net.info && !ctx.net.mainnet, status: ctx.status, registry: ctx.registry });
  const lines: Line[] = [...(faucetToken ? [{ id: 'faucet-token' as const, label: 'The faucet hands out the game token (the server registers it, no signature)', token: faucetToken }] : []), ...steps];
  const [run, setRun] = useState<Run | null>(null);
  const inFlight = useRef(false);
  const ownerOk = !!ctx.me && !!ctx.status?.arena?.config && sameAddress(ctx.status.arena.config.admin, ctx.me);
  const blocked = !ctx.me
    ? 'Connect the owner wallet first.'
    : !ctx.status?.arena
      ? 'The arena is not known to the server yet.'
      : !ownerOk
        ? 'The connected wallet is not the arena owner.'
        : faucetToken && !ctx.api
          ? 'Sign in at the top right (one free signature): the server registers the game token for the faucet.'
          : null;

  const go = async () => {
    const chain = ctx.net.chain;
    if (inFlight.current || lines.length === 0 || blocked || !chain) return;
    inFlight.current = true;
    const list = lines;
    const r: Run = { list, at: 0, done: [], hashes: [], error: null, busy: true };
    setRun({ ...r });
    const stop = async (error: string) => {
      r.error = error;
      r.busy = false;
      setRun({ ...r });
      inFlight.current = false;
      await ctx.refresh();
    };
    for (let i = 0; i < list.length; i++) {
      r.at = i;
      setRun({ ...r });
      const line = list[i];
      if (!('call' in line)) {
        // no wallet prompt: the server checks the token (the owner's TestToken, or the arena's token) and keeps it
        try {
          await ctx.api!.registerContract({ kind: 'token', address: line.token, txHash: null });
        } catch (e) {
          return stop(`${line.label}: ${(e as Error).message}`);
        }
        r.done.push(line.id);
        setRun({ ...r });
        continue;
      }
      const plan: Plan = { title: line.label, contract: 'Setup', call: line.call };
      const res = await sendWithWallet((wallet, from) => sendPlan(plan, wallet, from), { chain, publicClient: ctx.client });
      if (!res.ok) return stop(`${line.label}: ${txErrorText(res.error)}`);
      r.done.push(line.id);
      r.hashes.push(res.hash);
      setRun({ ...r });
    }
    // the game token just joined the arena: the site pins name it, so the owner signs them again (free, no transaction)
    if (list.some((x) => x.id === 'token') && ctx.net.info) {
      const cfg = ctx.status?.arena?.config ?? null;
      try {
        await signSitePins({ api: ctx.api, me: ctx.me, chainId: ctx.net.info.id, targets: { arena: ctx.net.arenaAddress, nft: ctx.net.nftAddress, token: (cfg?.token ?? ctx.status?.testToken?.address ?? null) as Address | null } });
        ctx.pinsChanged?.();
      } catch (e) {
        r.error = `Site pins: ${(e as Error).message} Sign them in Site pins, below.`;
      }
    }
    r.busy = false;
    r.at = list.length;
    setRun({ ...r });
    inFlight.current = false;
    // the public mint page reads a cached NFT state on the server: have it re-read the phase now
    void ctx.api?.mintRefresh?.().catch(() => {});
    await ctx.refresh();
    await ctx.reloadNet();
  };

  // the addresses the steps use, all known already (shown, never typed)
  const cfg = ctx.status?.arena?.config ?? null;
  const token = cfg?.token ?? ctx.status?.testToken?.address ?? null;
  const nft = ctx.status?.nft?.address ?? ctx.net.nftAddress;
  const serverKey = cfg?.serverAuthority ?? ctx.net.serverKey;
  const shown = run && (run.busy || run.error) ? run.list : lines;
  return (
    <Card
      title="Finish setup"
      id="quick-setup"
      kicker={lines.length === 0 ? 'All set' : `${lines.length} step${lines.length === 1 ? '' : 's'} left`}
      lede={
        lines.length === 0
          ? 'The token, the arenas, the holder perks' + (openMint ? ', the faucet and the open testnet mint' : '') + ' are all in place on this chain.'
          : 'Everything still missing on this chain, in one go. Your wallet asks once per step; you only confirm.' +
            (faucetToken ? ' The faucet waits for the game token: the server registers it first (no signature).' : '') +
            (steps.some((s) => s.id === 'token') ? ' After the token, it asks you to sign the site pins again (free).' : '') +
            (steps.some((s) => s.id === 'mint') ? ' On this testnet the last step opens the NFT mint on chain to every wallet.' : '')
      }
    >
      {lines.length > 0 && (
        <dl className="ad-kv" data-testid="quick-setup-uses">
          {token && (
            <Row label="Game token">
              <Addr value={token} net={ctx.net} /> <span className="ad-role">{cfg?.token ? 'set' : 'registered with the server'}</span>
            </Row>
          )}
          {nft && (
            <Row label="NFT">
              <Addr value={nft} net={ctx.net} /> <span className="ad-role">the registered CoinnibalNFT</span>
            </Row>
          )}
          {serverKey && ctx.status?.testToken && (
            <Row label="Server key">
              <Addr value={serverKey} net={ctx.net} /> <span className="ad-role">from the game server</span>
            </Row>
          )}
        </dl>
      )}
      {lines.length > 0 && (
        <ol className="ad-checks" data-testid="quick-setup-steps">
          {shown.map((s, i) => {
            const state = run?.done.includes(s.id) ? 'ok' : run?.busy && run.at === i ? 'active' : 'todo';
            return (
              <li key={s.id} className={`ad-check-line is-${state === 'active' ? 'unknown' : state}`}>
                <Mark state={state} />
                <span className="ad-check-line__label">{s.label}</span>
              </li>
            );
          })}
        </ol>
      )}
      <div className="ad-actions">
        <Btn sun icon="check" testId="quick-setup-go" disabled={!!blocked || lines.length === 0 || !!run?.busy} onClick={() => void go()}>
          {run?.busy ? `Step ${run.at + 1} of ${run.list.length}…` : run?.error ? 'Continue setup' : 'Finish setup'}
        </Btn>
      </div>
      {blocked && lines.length > 0 && <p className="ad-note">{blocked}</p>}
      <FormError error={run?.error ?? null} />
    </Card>
  );
}
