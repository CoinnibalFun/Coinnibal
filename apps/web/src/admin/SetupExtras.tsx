import {
  DEFAULT_HOLDERS_ONLY_ARENA_IDS,
  SUGGESTED_HOLDER_BURN_BPS,
  SUGGESTED_HOLDER_VAULT_BPS,
  sameAddress,
  setArenaHoldersOnlyCall,
  setFaucetCall,
  setHolderNftCall,
  setHolderPerksCall,
} from '@coinnibal/sdk';
import { MAX_TOTAL_FEE_BPS } from '@coinnibal/shared';
import { arenaName, fmtTok, holderPerksRefusal, holderPerksWarnings, holdersOnlyRefusal, parseAddressInput, parseIntInput, setFaucetRefusal, testTokenRefusal } from '@coinnibal/sdk/ops';
import { useState } from 'react';
import type { Address } from 'viem';
import { Addr, Advanced, Btn, Card, FormError, Input, Row, useFormError, type ChainCtx } from './ui';

/**
 * Setup → the emblem's perks on the arena: `setHolderPerks(nft, holderBurnBps, holderVaultBps)` (holders' tickets
 * get this pair on their profit when it totals less than the normal one, and holders may enter holders-only arenas)
 * and `setArenaHoldersOnly(id, on)` per arena. The NFT is the registered CoinnibalNFT (shown, not typed); another
 * address is an override under Advanced. The owner's pair (2026-11): holders pay 10 % of their profit instead of
 * 20 %, 8 % burned + 2 % to the fee wallet (`DEFAULT_HOLDER_FEE_RATES`).
 */
export function HolderPerksCard({ ctx }: { ctx: ChainCtx }) {
  const arena = ctx.net.arenaAddress;
  const a = ctx.status?.arena ?? null;
  const cfg = a?.config ?? null;
  const registered = ctx.net.nftAddress;
  const [override, setOverride] = useState('');
  const [burn, setBurn] = useState(String(cfg?.holderNft ? cfg.holderBurnBps : SUGGESTED_HOLDER_BURN_BPS));
  const [vault, setVault] = useState(String(cfg?.holderNft ? cfg.holderVaultBps : SUGGESTED_HOLDER_VAULT_BPS));
  const [err, guard, setErr] = useFormError();
  if (!arena || !cfg) return null;
  const holdersOnlyIds = a!.arenas.filter((x) => x.holdersOnly).map((x) => x.id);

  const preview = async (off: boolean) => {
    setErr(null);
    let addr: Address | null = null;
    let rates = { burnBps: cfg.holderBurnBps, vaultBps: cfg.holderVaultBps };
    try {
      if (!off && !override.trim() && !registered) throw new Error('No CoinnibalNFT is registered with the server yet: deploy it in Setup (or enter one under Advanced).');
      addr = off ? null : override.trim() ? parseAddressInput('Holder NFT', override) : registered;
      if (!off) rates = { burnBps: parseIntInput('Holder burn', burn, 0, MAX_TOTAL_FEE_BPS), vaultBps: parseIntInput('Holder fee wallet', vault, 0, MAX_TOTAL_FEE_BPS) };
    } catch (e) {
      setErr((e as Error).message);
      return;
    }
    let hasCode = true;
    if (addr && ctx.client) hasCode = !!(await ctx.client.getCode({ address: addr }).catch(() => undefined));
    const why = holderPerksRefusal(addr, hasCode, rates);
    if (why) return setErr(`Not sent: ${why}.`);
    const warn = holderPerksWarnings({ nft: addr, holder: rates, normal: { burnBps: cfg.burnBps, vaultBps: cfg.vaultBps }, holdersOnlyIds });
    guard(() =>
      ctx.open({
        title: off ? 'Turn the holder perks off' : `Holder perks: ${rates.burnBps} + ${rates.vaultBps} bps of profit for emblem holders`,
        contract: 'CoinnibalArena',
        call: setHolderPerksCall(arena, addr, rates),
        ownerOf: arena,
        owner: cfg.admin,
        note: warn.length ? `Heads up: ${warn.join('; ')}.` : undefined,
        onDone: () => ctx.refresh(),
      }),
    );
  };

  return (
    <Card
      title="Holder perks"
      id="holder-perks"
      kicker={cfg.holderNft ? `On · ${cfg.holderBurnBps} + ${cfg.holderVaultBps} bps` : 'Off'}
      lede={`Emblem holders' tickets get their own fee pair on profit (burned + to the fee wallet; used when it totals less than the normal pair, fixed into each ticket at join) and holders may enter holders-only arenas. Normal pair: ${cfg.burnBps} + ${cfg.vaultBps} bps.`}
    >
      <dl className="ad-kv">
        <Row label="Holder NFT">{cfg.holderNft ? <Addr value={cfg.holderNft} net={ctx.net} /> : <span className="ad-none">none (perks off)</span>}</Row>
      </dl>
      <dl className="ad-kv">
        <Row label="Uses">
          {registered ? (
            <>
              <Addr value={registered} net={ctx.net} /> <span className="ad-role">the registered CoinnibalNFT</span>
            </>
          ) : (
            <span className="ad-none">no CoinnibalNFT registered yet</span>
          )}
        </Row>
      </dl>
      <div className="ad-form2">
        <Input label="Holder burn" value={burn} onChange={setBurn} suffix="bps" hint="800 = 8 % of the profit, burned." />
        <Input label="Holder fee wallet" value={vault} onChange={setVault} suffix="bps" hint="200 = 2 % of the profit to the fee wallet." />
      </div>
      <Advanced title="Advanced: a different holder NFT" testId="holder-perks-advanced">
        <Input label="Holder NFT (override)" value={override} onChange={setOverride} placeholder={registered ?? '0x…'} hint="Leave empty to use the registered CoinnibalNFT." />
      </Advanced>
      <div className="ad-actions">
        <Btn sun testId="holder-perks" onClick={() => void preview(false)}>
          Preview holder perks
        </Btn>
        {cfg.holderNft && (
          <Btn onClick={() => void preview(true)} testId="holder-perks-off">
            Turn off
          </Btn>
        )}
      </div>
      <FormError error={err} />
    </Card>
  );
}

/** Setup → which arenas admit emblem holders only (default: #4, the $10 Room). */
export function HoldersOnlyCard({ ctx }: { ctx: ChainCtx }) {
  const arena = ctx.net.arenaAddress;
  const a = ctx.status?.arena ?? null;
  const cfg = a?.config ?? null;
  const [err, setErr] = useState<string | null>(null);
  if (!arena || !cfg || !a || a.arenas.length === 0) return null;
  const d = cfg.decimals;
  return (
    <Card title="Holders-only arenas" id="holders-only" lede="A holders-only arena admits emblem holders only. Open tickets are not affected. The $10 Room (#4) is the holders' room.">
      <div className="ad-tablewrap">
        <table className="ad-table">
          <thead>
            <tr>
              <th scope="col">Arena</th>
              <th scope="col" className="is-num">Entry fee</th>
              <th scope="col">Who may join</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {a.arenas.map((x) => {
              const suggested = !x.holdersOnly && DEFAULT_HOLDERS_ONLY_ARENA_IDS.includes(x.id);
              return (
                <tr key={x.id} data-arena={x.id}>
                  <td>
                    <span className="num ad-dim">#{x.id}</span> <strong>{arenaName(x.id)}</strong>
                  </td>
                  <td className="num is-num">{fmtTok(x.entryFee, d)}</td>
                  <td>{x.holdersOnly ? <span className="ad-code mono is-ok">holders only</span> : <span className="ad-code mono">everyone</span>}</td>
                  <td>
                    <Btn
                      sun={suggested}
                      testId={`holders-only-${x.id}`}
                      onClick={() => {
                        const why = holdersOnlyRefusal(x, !x.holdersOnly, cfg);
                        if (why) return setErr(`Not sent: ${why}.`);
                        setErr(null);
                        ctx.open({
                          title: `${x.holdersOnly ? 'Open' : 'Reserve'} arena #${x.id} ${arenaName(x.id)} ${x.holdersOnly ? 'to everyone' : 'for holders'}`,
                          contract: 'CoinnibalArena',
                          call: setArenaHoldersOnlyCall(arena, x.id, !x.holdersOnly),
                          ownerOf: arena,
                          owner: cfg.admin,
                          onDone: () => ctx.refresh(),
                        });
                      }}
                    >
                      {x.holdersOnly ? 'Open to all' : 'Holders only'}
                    </Btn>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <FormError error={err} />
    </Card>
  );
}

/** Setup → the TestToken (testnet only): the emblem as the holder NFT (2x faucet) and the faucet amounts and cooldown. */
export function TestTokenAdminCard({ ctx }: { ctx: ChainCtx }) {
  const tt = ctx.status?.testToken ?? null;
  const f = tt?.faucet ?? null;
  const decimals = 18;
  const unit = 10n ** BigInt(decimals);
  const [amount, setAmount] = useState(f ? (f.amount / unit).toString() : '1000000');
  const [holder, setHolder] = useState(f ? (f.holderAmount / unit).toString() : '2000000');
  const [minutes, setMinutes] = useState(f ? String(Math.round(f.cooldownSecs / 60)) : '60');
  const [err, guard, setErr] = useFormError();
  if (!ctx.net.info || testTokenRefusal(ctx.net.info.id)) return null;
  if (!tt) return null;
  const token = tt.address;
  const owner = f?.owner ?? null;
  const server = ctx.net.serverKey;
  const nft = ctx.net.nftAddress;
  const open = (title: string, call: Parameters<ChainCtx['open']>[0]['call']) =>
    ctx.open({ title, contract: 'TestToken', call, ownerOf: token, owner, onDone: () => ctx.refresh() });

  return (
    <Card title="TestToken faucet" id="test-token-admin" kicker="Testnet only" lede="The faucet players use on /faucet. It gives test tokens only, never ETH: players get gas from the network's official faucet. Only the TestToken owner mints; the game server never does.">
      <dl className="ad-kv">
        <Row label="Token">
          <Addr value={token} net={ctx.net} /> <span className={`ad-code mono${tt.code === 'ok' ? ' is-ok' : ' is-bad'}`}>{tt.code === 'ok' ? 'TestToken' : `code ${tt.code}`}</span>
        </Row>
        {f && (
          <>
            <Row label="Faucet">
              <span className="num">
                {fmtTok(f.amount, decimals)} · holders {fmtTok(f.holderAmount, decimals)} · every {Math.round(f.cooldownSecs / 60)} min
              </span>
            </Row>
            <Row label="Holder NFT">{f.holderNft ? <Addr value={f.holderNft} net={ctx.net} /> : <span className="ad-none">none (no 2x)</span>}</Row>
          </>
        )}
        <Row label="Server key">
          <Addr value={server} net={ctx.net} /> <span className="ad-role">from the game server</span>
        </Row>
        <Row label="Emblem">
          <Addr value={nft} net={ctx.net} /> <span className="ad-role">the registered CoinnibalNFT</span>
        </Row>
      </dl>
      <div className="ad-actions">
        <Btn
          disabled={!nft || (!!f?.holderNft && sameAddress(f.holderNft, nft))}
          testId="tt-holder-nft"
          onClick={() => nft && open('Emblem holders get the holder faucet amount', setHolderNftCall(token, nft))}
        >
          Use the emblem for the 2x
        </Btn>
      </div>
      <div className="ad-form2 ad-form3">
        <Input label="Per claim" value={amount} onChange={setAmount} suffix="tokens" />
        <Input label="Holders" value={holder} onChange={setHolder} suffix="tokens" />
        <Input label="Cooldown" value={minutes} onChange={setMinutes} suffix="min" />
      </div>
      <div className="ad-actions">
        <Btn
          testId="tt-faucet"
          onClick={() =>
            guard(() => {
              const p = {
                amount: BigInt(parseIntInput('Per claim', amount, 1, 1_000_000_000)) * unit,
                holderAmount: BigInt(parseIntInput('Holders', holder, 1, 1_000_000_000)) * unit,
                cooldownSecs: parseIntInput('Cooldown', minutes, 0, 60 * 24 * 7) * 60,
              };
              const why = setFaucetRefusal(p);
              if (why) throw new Error(`Not sent: ${why}.`);
              open(`Faucet: ${amount} per claim, holders ${holder}, every ${minutes} min`, setFaucetCall(token, p));
            })
          }
        >
          Preview faucet settings
        </Btn>
      </div>
      <FormError error={err} />
      {!owner && (
        <p className="ad-note" onClick={() => setErr(null)}>
          Reading the token owner…
        </p>
      )}
    </Card>
  );
}
