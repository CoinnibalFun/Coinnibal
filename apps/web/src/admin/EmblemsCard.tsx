import type { NftCollectionAdminView } from '@elymum/shared';
import { useCallback, useEffect, useState } from 'react';
import { SERVER } from '../config';
import { Btn, Card, FormError, Input, NeedsSession, Row, type ChainCtx } from './ui';

const TIER_ORDER = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];
const short = (h: string) => (h.length > 22 ? `${h.slice(0, 12)}…${h.slice(-8)}` : h);

/** The step the reveal is at, in one line. */
export function revealLine(v: NftCollectionAdminView): string {
  const p = v.provenance;
  if (p.revealed) return `Revealed with block ${p.revealBlock} (offset ${p.offset}). Every emblem shows its art.`;
  if (p.revealBlock) return `Reveal scheduled at block ${p.revealBlock}${v.currentBlock ? ` (now ${v.currentBlock})` : ''}. Reveal once it is mined.`;
  if (v.mint && v.mint.phase !== 'closed' && !v.mint.soldOut) return 'Sealed. Close the mint (or sell out) before scheduling the reveal.';
  return 'Sealed. Schedule the reveal block when the mint is over.';
}

/**
 * The emblem collection (docs/NFT-DESIGN.md): the commitment to publish before the mint, the rarity counts
 * and the two reveal steps. Everything here is server-side; no transaction.
 */
export function EmblemsCard({ ctx }: { ctx: ChainCtx }) {
  const [view, setView] = useState<NftCollectionAdminView | null>(null);
  const [block, setBlock] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!ctx.api) return;
    try {
      setView(await ctx.api.nftCollection());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [ctx.api]);
  useEffect(() => {
    void load();
  }, [load]);
  const step = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const p = view?.provenance;
  return (
    <Card
      title="Emblems: provenance and reveal"
      id="mint-emblems"
      kicker="Sealed until the mint is over"
      lede="Every token shows the sealed emblem until the reveal. Publish the two hashes before the mint opens (and put them on chain with setContractURI); after the mint, fix a future block, then reveal with its hash."
    >
      {view && p && (
        <>
          <dl className="ad-kv">
            <Row label="Status">
              <span data-testid="emblems-status">{revealLine(view)}</span>
            </Row>
            <Row label="Seed hash">
              <code title={p.seedHash}>{short(p.seedHash)}</code>
            </Row>
            <Row label="Provenance">
              <code title={p.provenance}>{short(p.provenance)}</code>
            </Row>
            <Row label="Style">{view.style}</Row>
            <Row label="Tiers">
              <span className="num">
                {TIER_ORDER.map((t) => `${t} ${view.stats.tiers[t] ?? 0}`).join(' · ')} of {view.stats.size}
              </span>
              {view.stats.duplicates > 0 && <strong className="ad-bad"> {view.stats.duplicates} duplicates</strong>}
            </Row>
            {p.revealed && (
              <Row label="Seed">
                <code title={p.seed ?? ''}>{short(p.seed ?? '')}</code>
              </Row>
            )}
          </dl>
          {!p.revealed && !p.revealBlock && (
            <div className="ad-inlineform">
              <Input label="Reveal block (empty: 50 blocks from now)" value={block} onChange={setBlock} placeholder={view.currentBlock ?? ''} />
              <Btn disabled={busy || !ctx.api} onClick={() => void step(() => ctx.api!.nftScheduleReveal(block.trim() || undefined))} testId="emblems-schedule">
                Schedule the reveal (final)
              </Btn>
            </div>
          )}
          {!p.revealed && p.revealBlock && (
            <Btn primary disabled={busy || !ctx.api} onClick={() => void step(() => ctx.api!.nftReveal())} testId="emblems-reveal">
              Reveal
            </Btn>
          )}
          <p className="ad-note">
            Public: <a href={`${SERVER.http}/api/nft/provenance`}>/api/nft/provenance</a> · <a href={`${SERVER.http}/api/nft/rarity`}>/api/nft/rarity</a>
          </p>
        </>
      )}
      <NeedsSession api={ctx.api} />
      <FormError error={err} />
    </Card>
  );
}
