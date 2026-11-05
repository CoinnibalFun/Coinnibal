import {
  BURN_MODE_CALL,
  BURN_MODE_DEAD,
  createArenaCall,
  formatGasAmount,
  rescueCall,
  setBurnModeCall,
  setFeeRatesCall,
  setFeeWalletCall,
  setPaymentBurnBpsCall,
  setServerAuthorityCall,
  sweepArenaCall,
  updateArenaFrom,
} from '@elymum/sdk';
import {
  SWEEP_WARNING,
  arenaName,
  createArenaRefusal,
  feeRatesRefusal,
  fmtPct,
  fmtTok,
  parseAddressInput,
  parseBigIntInput,
  parseGasInput,
  parseIntInput,
  parseTokenInput,
  sweepArenaRefusal,
  updateArenaRefusal,
} from '@elymum/sdk/ops';
import { sameAddress } from '@elymum/sdk';
import { BPS, MAX_TOTAL_FEE_BPS, feeExample, GAS_SYMBOL } from '@elymum/shared';
import { useState } from 'react';
import type { Address } from 'viem';
import { DefaultArenas, SetTokenForm } from './DeployTab';
import type { Plan } from './plan';
import { Addr, Advanced, Btn, Card, FormError, Input, Row, useFormError, type ChainCtx } from './ui';

/**
 * `/admin → Game → the arena contract`: its status, the settler fix when it is not this server's
 * key (one click, the key comes from the server), and every manual control (token, arenas, the fee rates on
 * profit, the burn mode, the power-up payment split and the fee wallet, sweeps, rescue) under one collapsed
 * Advanced section, prefilled. The pause and the
 * per-arena open / close are on Start / stop above.
 */
export function ArenaTab({ ctx }: { ctx: ChainCtx }) {
  const arena = ctx.net.arenaAddress;
  const a = ctx.status?.arena ?? null;
  const cfg = a?.config ?? null;
  if (!arena) return <Card title="No arena yet" id="arena" tone="quiet" lede="Deploy ElymumArena first (Setup)." />;
  if (!a || !cfg)
    return (
      <Card
        title={a?.code === 'missing' || a?.code === 'mismatch' ? 'That is not our arena' : 'Reading the arena…'}
        id="arena"
        tone={a?.code === 'missing' || a?.code === 'mismatch' ? 'danger' : 'quiet'}
        lede={a?.code === 'missing' ? 'No code at the registered arena address.' : a?.code === 'mismatch' ? 'The code at the registered address is not the bundled ElymumArena.' : 'One moment: asking the chain.'}
      />
    );
  const open = (title: string, call: Plan['call'], extra: Partial<Plan> = {}) =>
    ctx.open({ title, contract: 'ElymumArena', call, ownerOf: arena, owner: cfg.admin, onDone: () => ctx.refresh(), ...extra });
  const d = cfg.decimals;
  const sym = a.token?.symbol ? ` ${a.token.symbol}` : '';
  const serverMismatch = !!ctx.net.serverKey && !sameAddress(ctx.net.serverKey, cfg.serverAuthority);

  return (
    <div className="ad-arena">
      <Card
        title="Arena status"
        id="arena-status"
        aside={cfg.paused ? <span className="ad-code mono is-bad">Paused</span> : <span className="ad-code mono is-ok">Taking joins</span>}
      >
        <div className="ad-stats ad-stats--4">
          <div>
            <span className="mono">Tickets</span>
            <strong className="num">{cfg.totals.sessions.toString()}</strong>
          </div>
          <div>
            <span className="mono">Staked</span>
            <strong className="num">{fmtTok(cfg.totals.staked, d)}</strong>
          </div>
          <div>
            <span className="mono">Paid out</span>
            <strong className="num">{fmtTok(cfg.totals.paidOut, d)}</strong>
          </div>
          <div>
            <span className="mono">Burned · to fee wallet</span>
            <strong className="num">
              {fmtTok(cfg.totals.feeBurned + cfg.totals.lootBurned + cfg.totals.paymentBurned, d)} <small>· {fmtTok(cfg.totals.feeToVault + (cfg.totals.payments - cfg.totals.paymentBurned), d)}</small>
            </strong>
          </div>
        </div>
        <dl className="ad-kv">
          <Row label="Contract">
            <Addr value={arena} net={ctx.net} /> <span className={`ad-code mono${a.code === 'ok' ? ' is-ok' : ' is-bad'}`}>{a.code === 'ok' ? 'code hash ok' : `code ${a.code}`}</span>
            <span className="ad-code mono is-ok">v3 · fee on profit</span>
          </Row>
          <Row label="Owner">
            <Addr value={cfg.admin} net={ctx.net} />
            {cfg.pendingAdmin && (
              <>
                {' '}
                · pending <Addr value={cfg.pendingAdmin} net={ctx.net} />
              </>
            )}
          </Row>
          <Row label="Server authority">
            <Addr value={cfg.serverAuthority} net={ctx.net} />
            {a.serverBalance !== null && <span className="ad-role num">{formatGasAmount(a.serverBalance, 4)} for gas</span>}
            {a.serverBalance === 0n && <span className="ad-bad"> no {GAS_SYMBOL} for gas: settlements cannot be sent</span>}
            {serverMismatch && <span className="ad-bad"> not this server's key ({ctx.net.serverKey})</span>}
          </Row>
          <Row label="Fee wallet">
            <Addr value={cfg.feeWallet} net={ctx.net} />
            {a.token && (
              <span className="ad-role num">
                holds {fmtTok(a.token.feeWalletBalance, d)}
                {sym}
              </span>
            )}
          </Row>
          <Row label="Fee on profit">
            <span className="num">
              {cfg.burnBps} + {cfg.vaultBps} bps
            </span>{' '}
            <span className="ad-role">
              {fmtPct(cfg.burnBps)} burned + {fmtPct(cfg.vaultBps)} to the fee wallet, of each ticket&apos;s profit only (no entry fee)
            </span>
          </Row>
          <Row label="Burn mode">
            {cfg.burnMode === BURN_MODE_CALL ? "the token's own burn() (falls back to 0x…dEaD)" : 'transfer to 0x…dEaD'}
            {a.burnSupport === true && cfg.burnMode !== BURN_MODE_CALL && <span className="ad-role"> · the token has burn(): mode 1 would shrink its supply</span>}
            {a.burnSupport === false && cfg.burnMode === BURN_MODE_CALL && <span className="ad-bad"> · the token has no working burn(): every burn falls back to 0x…dEaD</span>}
          </Row>
          <Row label="Power-up payments">
            {fmtPct(cfg.paymentBurnBps)} burned, {fmtPct(BPS - cfg.paymentBurnBps)} to the fee wallet
          </Row>
          <Row label="Paused">{cfg.paused ? <strong className="ad-bad">PAUSED: joins blocked</strong> : 'no'}</Row>
          <Row label="Token">{cfg.token ? <><Addr value={cfg.token} net={ctx.net} /> <span className="ad-role num">{d} decimals{sym}</span></> : <span className="ad-none">not set</span>}</Row>
        </dl>
        {a.arenas.length > 0 && (
          <div className="ad-tablewrap">
            <table className="ad-table">
              <caption className="mono">The four places</caption>
              <thead>
                <tr>
                  <th scope="col">Arena</th>
                  <th scope="col" className="is-num">Entry fee</th>
                  <th scope="col">State</th>
                  <th scope="col" className="is-num">Open tickets</th>
                  <th scope="col" className="is-num">Vault</th>
                  <th scope="col" className="is-num">Owed</th>
                </tr>
              </thead>
              <tbody>
                {a.arenas.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <span className="num ad-dim">#{x.id}</span> <strong>{arenaName(x.id)}</strong>
                    </td>
                    <td className="num is-num">
                      {fmtTok(x.entryFee, d)}
                      {sym}
                    </td>
                    <td>{x.enabled ? <span className="ad-code mono is-ok">enabled</span> : <span className="ad-code mono is-bad">disabled</span>}</td>
                    <td className="num is-num">
                      {x.openSessions} <span className="ad-dim">/ {x.maxSessions}</span>
                    </td>
                    <td className="num is-num">{fmtTok(x.vault, d)}</td>
                    <td className="num is-num">{fmtTok(x.owed, d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {serverMismatch && <SwitchCard ctx={ctx} open={open} serverMismatch={serverMismatch} />}
      <Advanced title="Advanced: arena contract controls" testId="arena-advanced" section>
        <div className="ad-mint__forms">
          <SetTokenForm ctx={ctx} />
          <FeeCard ctx={ctx} open={open} />
        </div>
        <DefaultArenas ctx={ctx} />
        {cfg.token && <ArenaEdit ctx={ctx} open={open} />}
        <h2 className="ad-zone mono">The red switches</h2>
        <div className="ad-mint__forms">
          {cfg.token && <SweepCard ctx={ctx} open={open} />}
          <RescueCard ctx={ctx} open={open} />
        </div>
      </Advanced>
    </div>
  );
}

type OpenFn = (title: string, call: Plan['call'], extra?: Partial<Plan>) => void;

function ArenaEdit({ ctx, open }: { ctx: ChainCtx; open: OpenFn }) {
  const a = ctx.status!.arena!;
  const cfg = a.config!;
  const arena = ctx.net.arenaAddress!;
  const [id, setId] = useState(String(a.arenas[0]?.id ?? 5));
  const [fee, setFee] = useState('');
  const [max, setMax] = useState('300');
  const [enabled, setEnabled] = useState(true);
  const [err, guard] = useFormError();
  const existing = a.arenas.filter((x) => x.exists).map((x) => x.id);
  const sym = a.token?.symbol ?? '';
  return (
    <Card title="Create or update an arena" id="arena-edit" lede="Updating writes every field; the entry fee changes only while no ticket is open.">
      <div className="ad-form ad-form--grid ad-form--3">
        <Input label="Arena id" value={id} onChange={setId} />
        <Input label="Entry fee (whole tokens)" suffix={sym.trim() || undefined} value={fee} onChange={setFee} placeholder="1000" />
        <Input label="Max open tickets" value={max} onChange={setMax} />
      </div>
      <label className="ad-check">
        <input type="checkbox" checked={enabled} onChange={() => setEnabled(!enabled)} />
        <span>
          Enabled <span className="ad-check__sub">Update only. A disabled arena takes no new tickets.</span>
        </span>
      </label>
      <div className="ad-actions">
        <Btn
          onClick={() =>
            guard(() => {
              const p = { id: parseIntInput('Arena id', id, 1, 65_535), entryFee: parseTokenInput('Entry fee', fee, cfg.decimals), maxSessions: parseIntInput('Max open tickets', max, 2, 2000) };
              const r = createArenaRefusal(cfg, p, existing);
              if (r) throw new Error(r);
              open(`Create arena #${p.id}`, createArenaCall(arena, p));
            })
          }
        >
          Preview create
        </Btn>
        <Btn
          onClick={() =>
            guard(() => {
              const n = parseIntInput('Arena id', id, 1, 65_535);
              const cur = a.arenas.find((x) => x.id === n);
              if (!cur) throw new Error(`arena #${n} does not exist`);
              const entryFee = fee.trim() ? parseTokenInput('Entry fee', fee, cfg.decimals) : cur.entryFee;
              const r = updateArenaRefusal(cur, entryFee);
              if (r) throw new Error(r);
              open(`Update arena #${n}`, updateArenaFrom(arena, cur, { entryFee, maxSessions: parseIntInput('Max open tickets', max, 2, 2000), enabled }));
            })
          }
        >
          Preview update
        </Btn>
      </div>
      <FormError error={err} />
    </Card>
  );
}

/**
 * The fee rules of the arena v3: the pair taken from a ticket's profit (burned + to the fee wallet, at most 25 %
 * together; new tickets only), the burn mode, the burned share of a power-up payment, and the fee wallet.
 */
function FeeCard({ ctx, open }: { ctx: ChainCtx; open: OpenFn }) {
  const a = ctx.status!.arena!;
  const cfg = a.config!;
  const arena = ctx.net.arenaAddress!;
  const [burn, setBurn] = useState(String(cfg.burnBps));
  const [vault, setVault] = useState(String(cfg.vaultBps));
  const [payBurn, setPayBurn] = useState(String(cfg.paymentBurnBps));
  const [wallet, setWallet] = useState<string>(cfg.feeWallet);
  const [err, guard] = useFormError();
  const rates = { burnBps: Math.floor(Number(burn)) || 0, vaultBps: Math.floor(Number(vault)) || 0 };
  const ex = feeExample(1000, 2000, rates);
  return (
    <Card
      title="Fees"
      id="arena-config"
      kicker={`Now ${cfg.burnBps} + ${cfg.vaultBps} bps of profit`}
      lede={`Taken from a ticket's profit only (payout above its entry fee); a loss or a break-even pays nothing and there is no entry fee. The burned share leaves the supply, the rest goes to the fee wallet. At most ${MAX_TOTAL_FEE_BPS} bps (25 %) together; new tickets only, open ones keep the rates they were bought with.`}
    >
      <div className="ad-form ad-form--grid">
        <Input label="Burned" suffix="bps" value={burn} onChange={setBurn} hint={`${fmtPct(rates.burnBps)} of the profit`} />
        <Input label="To the fee wallet" suffix="bps" value={vault} onChange={setVault} hint={`${fmtPct(rates.vaultBps)} of the profit`} />
      </div>
      <p className="ad-note num">
        Example: entry 1,000, payout 2,000: {ex.burned} burned, {ex.toVault} to the fee wallet, {ex.net} to the player.
      </p>
      <div className="ad-actions">
        <Btn
          onClick={() =>
            guard(() => {
              const r = {
                burnBps: parseIntInput('Burned (bps)', burn, 0, MAX_TOTAL_FEE_BPS),
                vaultBps: parseIntInput('To the fee wallet (bps)', vault, 0, MAX_TOTAL_FEE_BPS),
              };
              const bad = feeRatesRefusal(r);
              if (bad) throw new Error(bad);
              open('Set the fee rates on profit', setFeeRatesCall(arena, r));
            })
          }
        >
          Preview fee rates
        </Btn>
      </div>
      <div className="ad-inlineform">
        <Input
          label="Power-up payments burned"
          suffix="bps"
          value={payBurn}
          onChange={setPayBurn}
          hint={`${fmtPct(Math.floor(Number(payBurn)) || 0)} burned, the rest to the fee wallet`}
        />
        <Btn onClick={() => guard(() => open('Set the burned share of power-up payments', setPaymentBurnBpsCall(arena, parseIntInput('Payment burn (bps)', payBurn, 0, BPS))))}>
          Preview payment split
        </Btn>
      </div>
      <div className="ad-inlineform">
        <span className="ad-note">
          Burn mode: {cfg.burnMode === BURN_MODE_CALL ? "the token's burn()" : '0x…dEaD'}
          {a.burnSupport === null ? '' : a.burnSupport ? ' · the token has a working burn()' : ' · the token has no working burn()'}
        </span>
        <Btn
          testId="arena-burn-mode"
          onClick={() =>
            guard(() => {
              const next = cfg.burnMode === BURN_MODE_CALL ? BURN_MODE_DEAD : BURN_MODE_CALL;
              if (next === BURN_MODE_CALL && a.burnSupport === false) throw new Error("The game token has no working burn(): keep burn mode 0 (0x…dEaD).");
              open(next === BURN_MODE_CALL ? "Burn with the token's own burn()" : 'Burn to 0x…dEaD', setBurnModeCall(arena, next));
            })
          }
        >
          {cfg.burnMode === BURN_MODE_CALL ? 'Preview mode 0 (0x…dEaD)' : "Preview mode 1 (token's burn())"}
        </Btn>
      </div>
      <div className="ad-inlineform">
        <Input label="Fee wallet" value={wallet} onChange={setWallet} />
        <Btn onClick={() => guard(() => open('Set the fee wallet', setFeeWalletCall(arena, parseAddressInput('Fee wallet', wallet))))}>Preview fee wallet</Btn>
      </div>
      <FormError error={err} />
    </Card>
  );
}

function SwitchCard({ ctx, open, serverMismatch }: { ctx: ChainCtx; open: OpenFn; serverMismatch: boolean }) {
  const cfg = ctx.status!.arena!.config!;
  const arena = ctx.net.arenaAddress!;
  return (
    <Card title="The settler" id="arena-switches" tone="danger" lede="The settler is the key that pays out rounds. It must be this game server's key.">
      <div className="ad-dangerrow">
        <p>
          <strong>Server authority.</strong> {serverMismatch ? 'It is not this server’s key: rounds cannot settle.' : 'It is this server’s key. Nothing to do.'}
        </p>
        <Addr value={ctx.net.serverKey} net={ctx.net} />
        <Btn
          danger={serverMismatch}
          disabled={!serverMismatch || !ctx.net.serverKey}
          testId="arena-server-key"
          onClick={() => ctx.net.serverKey && open("Make this server's key the settler", setServerAuthorityCall(arena, ctx.net.serverKey as Address))}
        >
          Server authority = this server&apos;s key
        </Btn>
      </div>
    </Card>
  );
}

function SweepCard({ ctx, open }: { ctx: ChainCtx; open: OpenFn }) {
  const a = ctx.status!.arena!;
  const arena = ctx.net.arenaAddress!;
  const [id, setId] = useState('');
  const [err, guard] = useFormError();
  return (
    <Card title="Sweep a closed arena" id="arena-sweep" tone="danger" lede={SWEEP_WARNING}>
      <Input label="Arena id (disabled, no open tickets)" value={id} onChange={setId} />
      <Btn
        danger
        onClick={() =>
          guard(() => {
            const n = parseIntInput('Arena id', id, 1, 65_535);
            const cur = a.arenas.find((x) => x.id === n) ?? { id: n, exists: false, enabled: false, openSessions: 0 };
            const r = sweepArenaRefusal(cur);
            if (r) throw new Error(r);
            open(`Sweep arena #${n} to the fee wallet`, sweepArenaCall(arena, n), { confirmText: `SWEEP ${n}`, note: SWEEP_WARNING });
          })
        }
      >
        Preview sweep
      </Btn>
      <FormError error={err} />
    </Card>
  );
}

function RescueCard({ ctx, open }: { ctx: ChainCtx; open: OpenFn }) {
  const arena = ctx.net.arenaAddress!;
  const [token, setToken] = useState('');
  const [to, setTo] = useState<string>(ctx.me ?? '');
  const [amount, setAmount] = useState('');
  const [err, guard] = useFormError();
  return (
    <Card title="Rescue" id="arena-rescue" tone="danger" lede={`Recovers ${GAS_SYMBOL} (leave the token empty) or a foreign ERC-20 sent to the arena by mistake. Never the game token.`}>
      <div className="ad-form">
        <Input label={`Token (empty = ${GAS_SYMBOL})`} value={token} onChange={setToken} placeholder="0x… or empty" />
        <Input label="To" value={to} onChange={setTo} />
        <Input label={token.trim() ? 'Amount (base units)' : `Amount (${GAS_SYMBOL})`} value={amount} onChange={setAmount} />
      </div>
      <Btn
        onClick={() =>
          guard(() => {
            const t = token.trim() ? parseAddressInput('Token', token) : null;
            const cfg = ctx.status?.arena?.config;
            if (t && cfg?.token && sameAddress(t, cfg.token)) throw new Error('The game token can never be rescued.');
            const value = t ? parseBigIntInput('Amount', amount, 1n) : parseGasInput('Amount', amount);
            open('Rescue funds from the arena', rescueCall(arena, { token: t, to: parseAddressInput('To', to), amount: value }));
          })
        }
      >
        Preview rescue
      </Btn>
      <FormError error={err} />
    </Card>
  );
}
