import { formatGasAmount } from '@coinnibal/sdk';
import { checkDeployedCode, type CodeCheck, type StatusSnapshot } from '@coinnibal/sdk/ops';
import { CONTRACT_KINDS, type ContractKind, type ContractsRegistry, type GameServerLoad, type GameThreadLoad, type GasRunway, type NetworkInfo, GAS_SYMBOL, networkOf } from '@coinnibal/shared';
import { useEffect, useState } from 'react';
import { parseEther, type Address } from 'viem';
import { gasFaucetUrl } from '../site/faucet/logic';
import { signOut } from '../site/session';
import { secretErrorText, walletProofSigner, withSecretProof, type ProofSigner } from './secrets';
import { NetPill } from './NetPill';
import type { AdminNetwork } from './net';
import { Addr, Btn, Card, Input, Mark, NeedsSession, Row, type ChainCtx } from './ui';

/** Below this the server key gets a "fund it" hint (a settlement costs a little gas). */
export const LOW_SERVER_GAS = 10n ** 16n; // 0.01 of the gas token

/**
 * The server key's balance to show: this page's own chain read first (it follows a funding at once),
 * else the server's figure (the server re-reads its balance only now and then). Pure, tested.
 */
export function serverKeyBalance(info: { serverBalanceWei: string | null; low: boolean } | null, keyWei: bigint | null): { wei: bigint | null; low: boolean } {
  const wei = keyWei ?? (info?.serverBalanceWei != null ? BigInt(info.serverBalanceWei) : null);
  return { wei, low: wei !== null ? wei < LOW_SERVER_GAS : !!info?.low };
}

/**
 * The server key's gas runway in words, with its tone (pure, tested): `critical` under the floor or under 2 days at the
 * trailing spend (the server alerts and /api/health answers 503), `warn` under 7 days, `unknown` while there is less
 * than an hour of samples.
 */
export function gasRunwayView(gas: GasRunway): { tone: 'ok' | 'warn' | 'bad' | 'unknown'; label: string; detail: string } {
  const spend = gas.spendWeiPerDay !== null ? `${formatGasAmount(BigInt(gas.spendWeiPerDay), 5)} a day` : null;
  const days = gas.days === null ? null : gas.days >= 100 ? '100+ days' : gas.days >= 10 ? `${Math.round(gas.days)} days` : `${gas.days.toFixed(1)} days`;
  const floor = formatGasAmount(BigInt(gas.floorWei), 4);
  const over = `measured over ${gas.sampledHours.toFixed(gas.sampledHours < 10 ? 1 : 0)} h`;
  const label =
    gas.level === 'critical'
      ? `critical · ${days ?? `under the ${floor} floor`}`
      : gas.level === 'warn'
        ? `low · ${days ?? 'soon'}`
        : gas.level === 'ok'
          ? days
            ? `ok · ${days}`
            : 'ok · nothing spent lately'
          : 'measuring';
  const detail =
    gas.level === 'unknown'
      ? `Less than an hour of balance readings: only the ${floor} floor is checked so far.`
      : `${spend ? `Spends ${spend} (${over}). ` : `Nothing spent (${over}). `}Warning under ${gas.warnDays} days, alert under ${gas.criticalDays} days or ${floor}.`;
  return { tone: gas.level === 'critical' ? 'bad' : gas.level === 'warn' ? 'warn' : gas.level === 'ok' ? 'ok' : 'unknown', label, detail };
}

export interface MainnetStep {
  id: string;
  label: string;
  detail: string;
  /** null: cannot be checked from here (or not on mainnet yet). */
  ok: boolean | null;
  /** The drawer that does it. */
  where: 'Server' | 'Setup' | 'Mint' | 'Game' | 'Community';
}

/**
 * The mainnet launch, in order, with the exact steps (pure, tested). On a testnet every step is
 * still to do (they are checked once the server follows the mainnet RPC).
 */
export function mainnetChecklist(net: AdminNetwork, status: StatusSnapshot | null): MainnetStep[] {
  const on = net.mainnet;
  const a = status?.arena ?? null;
  const cfg = a?.config ?? null;
  const nft = status?.nft?.state ?? null;
  const when = (v: boolean | null | undefined): boolean | null => (on ? (v ?? null) : false);
  return [
    // /opt/elymum: the live server's install directory, kept from before the rename (deploy/vps/lib.sh)
    { id: 'rpc', label: 'Point the server at the mainnet (COINNIBAL_CHAIN_ID and COINNIBAL_RPC_URLS)', detail: '/opt/elymum/.env on the VPS → COINNIBAL_CHAIN_ID=4663 and COINNIBAL_RPC_URLS=<Alchemy URL>,https://rpc.mainnet.chain.robinhood.com, then coinnibal-compose up -d app. The server follows that chain; testnet records stay on file.', ok: on, where: 'Server' },
    { id: 'access', label: 'Set Game access explicitly', detail: 'The site settings carry over from testnet (where the game is public): pick Admins or Holders in Game before anything else opens.', ok: null, where: 'Game' },
    { id: 'fund', label: `Fund the server key with ${GAS_SYMBOL}`, detail: 'It sends every settlement; a little gas lasts a long time.', ok: when(a?.serverBalance != null ? a.serverBalance >= LOW_SERVER_GAS : null), where: 'Server' },
    { id: 'arena', label: 'Deploy CoinnibalArena from the owner wallet', detail: 'Setup → the deploy wizard. No address to type; it registers with the server by itself (code hash, owner and settler checked).', ok: when(!!net.arenaAddress && a?.code === 'ok'), where: 'Setup' },
    { id: 'nft', label: 'Deploy CoinnibalNFT from the owner wallet', detail: 'Setup → the deploy wizard, right after the arena. Treasury = you, base URI = this site.', ok: when(!!net.nftAddress && status?.nft?.code === 'ok'), where: 'Setup' },
    { id: 'token', label: 'Confirm the game token on the arena', detail: 'Once, and only the real token (TOKEN_ADDRESS on the server): Setup shows it, you confirm once.', ok: when(cfg ? !!cfg.token : null), where: 'Setup' },
    { id: 'arenas', label: 'Finish setup: the arenas, the holder perks and the holders-only $10 Room', detail: 'Setup → Finish setup, one button: your wallet confirms each step.', ok: when(cfg ? (a?.arenas.length ?? 0) >= 4 && !!cfg.holderNft : null), where: 'Setup' },
    { id: 'allowlist', label: 'Build the mainnet allowlist and publish its root', detail: 'Import the testnet holders into the WL first (Mint), then build and publish.', ok: when(nft ? nft.root !== `0x${'0'.repeat(64)}` : null), where: 'Mint' },
    { id: 'mint', label: 'Open the mint (Allowlist, then Public)', detail: 'Mint → the phase switch.', ok: when(nft ? nft.phaseName !== 'closed' : null), where: 'Mint' },
    { id: 'game', label: 'Open the game', detail: 'Game → who may play: holders, then everyone when you are ready.', ok: null, where: 'Game' },
  ];
}

interface RpcHealth {
  ok: boolean;
  block: bigint | null;
  ms: number | null;
  error: string | null;
}

/** `/admin → Network`: the chain, the RPC, the server key, the contracts and the mainnet launch steps. */
export function NetworkTab({ ctx, registry }: { ctx: ChainCtx; registry: ContractsRegistry | null }) {
  const { net, client, status } = ctx;
  const [rpc, setRpc] = useState<RpcHealth | null>(null);
  const [keyWei, setKeyWei] = useState<bigint | null>(null);
  const [codes, setCodes] = useState<Partial<Record<ContractKind, CodeCheck | null>>>({});
  // the server's own view (`GET /api/admin/network`): its RPC, its key, its code checks
  const [info, setInfo] = useState<NetworkInfo | null>(null);
  const [fundText, setFundText] = useState('1');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!ctx.api?.network) return;
    let live = true;
    ctx.api.network().then(
      (n) => live && setInfo(n),
      () => {},
    );
    void reload;
    return () => {
      live = false;
    };
  }, [ctx.api, status, reload]);

  // RPC health: one timed block read
  useEffect(() => {
    if (!client) {
      setRpc(null);
      return;
    }
    let live = true;
    const t0 = performance.now();
    client.getBlockNumber().then(
      (block) => live && setRpc({ ok: true, block, ms: Math.round(performance.now() - t0), error: null }),
      (e: Error) => live && setRpc({ ok: false, block: null, ms: null, error: e.message?.split('\n')[0] ?? 'unreachable' }),
    );
    if (net.serverKey) client.getBalance({ address: net.serverKey }).then((b) => live && setKeyWei(b), () => {});
    return () => {
      live = false;
    };
  }, [client, net.serverKey, status]);

  // the code hash of every registered contract
  useEffect(() => {
    if (!client || !registry) return;
    let live = true;
    for (const kind of CONTRACT_KINDS) {
      const r = registry[kind];
      if (!r) continue;
      checkDeployedCode(client, r.address as Address, kind).then(
        (c) => live && setCodes((x) => ({ ...x, [kind]: c })),
        () => live && setCodes((x) => ({ ...x, [kind]: null })),
      );
    }
    return () => {
      live = false;
    };
  }, [client, registry]);

  const steps = mainnetChecklist(net, status);
  const { wei: serverWei, low } = serverKeyBalance(info, keyWei);
  const health: RpcHealth | null = info ? { ok: info.rpcOk, block: info.block !== null ? BigInt(info.block) : null, ms: info.rpcLatencyMs, error: info.rpcOk ? null : 'the server cannot reach its RPC' } : rpc;
  const codeOf = (kind: ContractKind) => {
    const c = info?.contracts.find((x) => x.kind === kind);
    return c ? c.code : codes[kind];
  };
  const NAMES: Record<ContractKind, string> = { arena: 'CoinnibalArena', nft: 'CoinnibalNFT', token: 'Game token / TestToken' };

  return (
    <div className="ad-network">
      <Card title="The chain" id="net-chain" aside={<NetPill net={net} />}>
        <dl className="ad-kv">
          <Row label="Chain">{net.info ? <span className="num">{`${net.info.name} (${net.info.id})`}</span> : <span className="ad-bad">none: EVM_RPC_URL is unset</span>}</Row>
          <Row label="RPC">
            {net.info?.rpcUrl ? <code className="ad-addr__v">{net.info.rpcUrl}</code> : <span className="ad-none">the wallet&apos;s own</span>}{' '}
            {health &&
              (health.ok ? (
                <span className="ad-code mono is-ok" data-testid="rpc-health">
                  ok · block {health.block?.toString()} · {health.ms} ms
                </span>
              ) : (
                <span className="ad-code mono is-bad" data-testid="rpc-health">
                  down · {health.error}
                </span>
              ))}
          </Row>
          <Row label="Explorer">{net.info?.explorerUrl ? <a href={net.info.explorerUrl} target="_blank" rel="noreferrer">{net.info.explorerUrl}</a> : <span className="ad-none">none</span>}</Row>
        </dl>
      </Card>

      <Card title="Server key" id="net-key" lede={`The game server's own key: it settles every round on the arena, so it pays the gas in ${GAS_SYMBOL}.`}>
        <dl className="ad-kv">
          <Row label="Address">
            <Addr value={net.serverKey} net={net} />
          </Row>
          <Row label="Balance">
            {serverWei === null ? <span className="ad-none">…</span> : <span className={`num${low ? ' ad-bad' : ''}`}>{formatGasAmount(serverWei, 4)}</span>}
          </Row>
          {info?.gas && <RunwayRow gas={info.gas} />}
        </dl>
        <FundServerKey
          ctx={ctx}
          text={fundText}
          setText={setFundText}
          onFunded={() => {
            setReload((n) => n + 1);
            void ctx.refresh();
          }}
        />
        {(low || info?.gas?.level === 'critical' || info?.gas?.level === 'warn') && (
          <p className={info?.gas?.level === 'critical' ? 'ad-err' : 'ad-warn'} data-testid="fund-hint">
            <strong>Fund it.</strong> Send {GAS_SYMBOL} to the address above (a little lasts a long time); without gas, settlements cannot be sent.
            {!net.mainnet && gasFaucetUrl(ctx.net.chain?.faucetUrl) && (
              <>
                {' '}
                On testnet:{' '}
                <a href={gasFaucetUrl(ctx.net.chain?.faucetUrl)!} target="_blank" rel="noreferrer">
                  the {GAS_SYMBOL} faucet
                </a>
                .
              </>
            )}
          </p>
        )}
      </Card>

      <Card title="Contracts on this chain" id="net-contracts" lede="What the server has registered, each checked against the bundled code hash. Every chain keeps its own records.">
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th scope="col">Contract</th>
                <th scope="col">Address</th>
                <th scope="col">Chain</th>
                <th scope="col">Code</th>
              </tr>
            </thead>
            <tbody>
              {CONTRACT_KINDS.map((kind) => {
                const r = registry?.[kind] ?? null;
                const c = codeOf(kind);
                const other = r && net.info && r.chainId !== net.info.id;
                return (
                  <tr key={kind} data-kind={kind}>
                    <td>
                      <strong>{NAMES[kind]}</strong>
                    </td>
                    <td>{r ? <Addr value={r.address} net={net} /> : <span className="ad-none">not registered</span>}</td>
                    <td className="num">{r ? <span className={other ? 'ad-bad' : undefined}>{r.chainId}</span> : '—'}</td>
                    <td>{r ? c === undefined ? <span className="ad-none">…</span> : <span className={`ad-code mono${c === 'ok' ? ' is-ok' : ' is-bad'}`}>{c === 'ok' ? 'code hash ok' : `code ${c ?? 'unreadable'}`}</span> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {info && info.otherChains.length > 0 && (
          <p className="ad-note" data-testid="other-chains">
            Records kept for other networks: {info.otherChains.map((id) => `${networkOf(id)?.name ?? 'a retired chain'} (${id})`).join(', ')}. They come back if CHAIN_ID points at that network again.
          </p>
        )}
      </Card>

      {info?.load && <LoadCard load={info.load} />}

      <Card
        title="Mainnet launch"
        id="net-mainnet"
        kicker={net.mainnet ? 'On mainnet' : 'Do these in order'}
        lede={net.mainnet ? 'The server follows mainnet. Each line turns green as it is done.' : 'The exact steps for launch day. Nothing here runs from testnet: the lines are checked once the server is on mainnet.'}
      >
        <ol className="ad-checks ad-mainnet-steps" data-testid="mainnet-checklist">
          {steps.map((s, i) => {
            const state = s.ok === true ? 'ok' : s.ok === false ? 'todo' : 'unknown';
            return (
              <li key={s.id} className={`ad-check-line is-${state}`} data-item={s.id}>
                <Mark state={state} />
                <span className="ad-check-line__label">
                  <span className="num ad-dim">{i + 1}.</span> {s.label}
                </span>
                <span className="ad-check-line__detail">
                  {s.detail} <span className="mono ad-dim">· {s.where}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </Card>

      <BackupCard ctx={ctx} />
      <SessionsCard ctx={ctx} />
    </div>
  );
}

/** The gas runway line of the server key: how long its balance lasts at the trailing spend, coloured by level. */
export function RunwayRow({ gas }: { gas: GasRunway }) {
  const v = gasRunwayView(gas);
  return (
    <Row label="Runway">
      <span className={`ad-code mono is-${v.tone}`} data-testid="gas-runway" data-level={gas.level}>
        {v.label}
      </span>
      <span className="ad-note ad-runway__detail">{v.detail}</span>
    </Row>
  );
}

/**
 * "Admin sessions": admin sessions last 2 hours and are never extended; "Sign out everywhere" ends every session of
 * this wallet (other browsers, a copied migration command), "End every admin session" those of every admin wallet.
 */
export function SessionsCard({ ctx }: { ctx: ChainCtx }) {
  const api = ctx.api;
  const [busy, setBusy] = useState<'me' | 'admins' | null>(null);
  const [confirm, setConfirm] = useState<'me' | 'admins' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const revoke = async (who: 'me' | 'admins') => {
    if (!api) return;
    setBusy(who);
    setNote(null);
    try {
      const me = await api.me();
      await api.revokeSessions(who === 'admins' ? 'admins' : me.address);
      setConfirm(null);
      // this session was one of them: sign in again for the next admin step
      signOut();
      setNote({ ok: true, text: who === 'admins' ? 'Every admin session ended, this one too. Sign in again at the top right.' : 'Every session of this wallet ended, this one too. Sign in again at the top right.' });
    } catch (e) {
      setNote({ ok: false, text: secretErrorText(e, 'the sign-out') });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Admin sessions" id="net-sessions" lede="An admin sign-in lasts 2 hours and is never extended. If a session token may have leaked (a shared screen, a copied command), end it here: the server refuses it at once, also after a restart.">
      <div className="ad-fund ad-sessions">
        {confirm === null ? (
          <>
            <Btn danger icon="lock" testId="revoke-me" disabled={!api || busy !== null} onClick={() => setConfirm('me')}>
              Sign out everywhere
            </Btn>
            <Btn testId="revoke-admins" disabled={!api || busy !== null} onClick={() => setConfirm('admins')}>
              End every admin session
            </Btn>
          </>
        ) : (
          <>
            <span className="ad-note" data-testid="revoke-confirm">
              {confirm === 'me' ? 'End every session of this wallet, in every browser, this one included?' : 'End the sessions of every admin wallet, this one included?'}
            </span>
            <Btn danger testId="revoke-yes" disabled={busy !== null} onClick={() => void revoke(confirm)}>
              {busy ? 'Ending…' : 'Yes, end them'}
            </Btn>
            <Btn disabled={busy !== null} onClick={() => setConfirm(null)}>
              Cancel
            </Btn>
          </>
        )}
      </div>
      <NeedsSession api={api} />
      {note && (
        <p className={note.ok ? 'ad-note' : 'ad-bad'} role={note.ok ? 'status' : 'alert'} data-testid="revoke-note">
          {note.text}
        </p>
      )}
    </Card>
  );
}

/** A thread is busy past this share of its time, or its tick nears the 33 ms frame (pure, tested). */
export function threadHot(t: GameThreadLoad): boolean {
  return !t.up || t.elu >= 0.75 || t.tickP95Ms >= 25 || t.lagP99Ms >= 20;
}

/**
 * "Game server load": the main thread (sockets, HTTP, chain, journal) and each room worker
 * (`GAME_WORKERS`): rooms, players, tick time against the 33 ms frame, event-loop use and lag.
 */
export function LoadCard({ load }: { load: GameServerLoad }) {
  const rows = [load.main, ...load.threads];
  const lede =
    load.mode === 'workers'
      ? `${load.workers} room worker${load.workers === 1 ? '' : 's'} on ${load.cpus} cores. Rooms are placed on the least-loaded worker; a worker that stops is restarted and its tickets are settled from the journal.`
      : `One thread runs every room (GAME_WORKERS=0) on a ${load.cpus}-core machine.`;
  return (
    <Card title="Game server load" id="net-load" lede={lede} kicker={`${load.conns} connections · ${(load.sentBytesPerSec / 1e6).toFixed(2)} MB/s out · ${load.rssMb} MB`}>
      <div className="ad-tablewrap">
        <table className="ad-table" data-testid="load-threads">
          <thead>
            <tr>
              <th scope="col">Thread</th>
              <th scope="col" className="is-num">Rooms</th>
              <th scope="col" className="is-num">Players</th>
              <th scope="col" className="is-num">Bots</th>
              <th scope="col" className="is-num">Tick mean / p95 / max</th>
              <th scope="col" className="is-num">Busy</th>
              <th scope="col" className="is-num">Lag p99</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={String(t.id)} data-thread={String(t.id)} className={threadHot(t) ? 'ad-bad' : undefined}>
                <td>
                  <strong>{t.id === 'main' ? 'main' : `worker ${t.id}`}</strong>
                  {!t.up && <span className="ad-bad"> · down</span>}
                  {t.restarts > 0 && <span className="ad-dim num"> · {t.restarts} restart{t.restarts === 1 ? '' : 's'}</span>}
                </td>
                <td className="num is-num">{t.id === 'main' && load.mode === 'workers' ? '—' : t.rooms}</td>
                <td className="num is-num">{t.humans}</td>
                <td className="num is-num">{t.bots}</td>
                <td className="num is-num">
                  {t.tickMeanMs.toFixed(1)} / {t.tickP95Ms.toFixed(1)} / {t.tickMaxMs.toFixed(1)} ms
                </td>
                <td className="num is-num">{Math.round(t.elu * 100)} %</td>
                <td className="num is-num">{t.lagP99Ms.toFixed(1)} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ad-note">A tick has 33 ms. Red: a thread busy 75 % of the time or more, a p95 tick of 25 ms or more, or a lag of 20 ms or more.</p>
    </Card>
  );
}

/**
 * "Backup & move": downloads a gzip tar of the server's DATA_DIR, or copies the `curl` command that does the same from
 * another machine (the new server), or the whole new-server command. Each one hands out the server key, so each asks
 * the admin wallet for a fresh, purpose-bound signature first (`X-Coinnibal-Proof`): one download within 10 minutes.
 */
export function BackupCard({ ctx, sign = walletProofSigner() }: { ctx: ChainCtx; sign?: ProofSigner }) {
  const api = ctx.api;
  const [busy, setBusy] = useState<'download' | 'copy' | 'install' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (what: 'download' | 'copy' | 'install') => {
    if (!api || busy) return;
    setBusy(what);
    setNote(null);
    try {
      if (what === 'download') {
        await withSecretProof(api, 'backup', sign, (proof) => api.backup(proof));
        setNote({ ok: true, text: 'Backup downloaded. Keep it somewhere private.' });
      } else {
        const command = await withSecretProof(api, what === 'copy' ? 'backup' : 'migration', sign, async (proof) => (what === 'copy' ? api.backupCommand(proof) : api.installCommand(proof)));
        try {
          await navigator.clipboard.writeText(command);
        } catch {
          setNote({ ok: false, text: 'The browser refused the clipboard. Use Download backup instead.' });
          return;
        }
        setNote({
          ok: true,
          text:
            what === 'copy'
              ? 'Command copied. Paste it on the new server within 10 minutes: the signature opens one download, and your session ends within 2 hours.'
              : 'New-server command copied. Paste it into the new server (SSH, logged in as ubuntu) within 10 minutes. It copies the settings and the data once.',
        });
      }
    } catch (e) {
      setNote({ ok: false, text: secretErrorText(e, what === 'download' ? 'the download' : 'the copy') });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Backup & move" id="net-backup" lede="Everything the server keeps (journal, contracts registry, server key, profiles, pictures, site data) as one .tar.gz file: for moving the server to a new host, or a copy to keep.">
      <p className="ad-warn" data-testid="backup-warning">
        <strong>The file contains the server key and secrets.</strong> Anyone holding it can sign settlements as the server. Never share it or upload it anywhere public. Each button asks
        your admin wallet for one free signature first (no transaction); a copied command works once, within 10 minutes: paste it only into your own server&apos;s terminal.
      </p>
      <div className="ad-fund">
        <Btn sun icon="lock" testId="backup-download" disabled={!api || busy !== null} onClick={() => void run('download')}>
          {busy === 'download' ? 'Check your wallet…' : 'Download backup'}
        </Btn>
        <Btn testId="backup-copy" disabled={!api || busy !== null} onClick={() => void run('copy')}>
          {busy === 'copy' ? 'Check your wallet…' : 'Copy migration command'}
        </Btn>
        <Btn testId="backup-install" disabled={!api || busy !== null} onClick={() => void run('install')}>
          {busy === 'install' ? 'Check your wallet…' : 'Copy new-server command'}
        </Btn>
      </div>
      <NeedsSession api={api} />
      {note && (
        <p className={note.ok ? 'ad-note' : 'ad-bad'} role={note.ok ? 'status' : 'alert'} data-testid="backup-note">
          {note.text}
        </p>
      )}
    </Card>
  );
}

/**
 * "Send gas to the server key": a plain transfer of the chain's gas token from the connected wallet, shown in the
 * transaction preview first like every other write (it pays the settlement gas).
 */
function FundServerKey({ ctx, text, setText, onFunded }: { ctx: ChainCtx; text: string; setText: (v: string) => void; onFunded: () => void }) {
  const to = ctx.net.serverKey as Address | null;
  let value: bigint | null = null;
  try {
    value = /^\d+(\.\d{1,18})?$/.test(text.trim()) ? parseEther(text.trim()) : null;
  } catch {
    value = null;
  }
  const bad = value === null || value <= 0n;
  const send = () => {
    if (!to || bad || value === null) return;
    ctx.open({
      title: 'Fund the server key',
      contract: 'Server key',
      transfer: { to, value },
      note: `Sends ${text.trim()} ${GAS_SYMBOL} from your wallet to the game server's key. It pays settlement gas.`,
      onDone: onFunded,
    });
  };
  return (
    <div className="ad-fund" data-testid="fund-server-key">
      <Input label={`Send ${GAS_SYMBOL} from your wallet`} value={text} onChange={setText} suffix={GAS_SYMBOL} hint={bad ? 'Type an amount, e.g. 1 or 0.5.' : undefined} />
      <Btn sun icon="wallet" testId="fund-send" disabled={!to || bad || !ctx.me} onClick={send}>
        Send to server key
      </Btn>
      {!ctx.me && <span className="ad-note">Connect your wallet first.</span>}
      {!to && <span className="ad-note">The server has not published its key yet.</span>}
    </div>
  );
}
