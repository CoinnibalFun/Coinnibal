import { BITTEN_COIN, MARK_C } from '../../design/motifs/brandShapes';

/**
 * The seal between the rooms and the NFT plate: a rubber-stamp impression of the Coinnibal coin mark (the wordmark's
 * bitten O with its C) pressed in sun ink over the NFT plate's top line, as the mint is sealed. It echoes the SEALED
 * stamps on the NFT cards. Pure decoration (aria-hidden, pointer-events none); the rest state is the pressed seal and
 * reveal.css stamps it when the section turns `data-seam="in"`, so it needs no hook.
 */
export function SealSeam() {
  return (
    <div className="ld-seal" aria-hidden="true">
      <svg className="ld-seal__stamp" viewBox="-50 -50 100 100" focusable="false">
        <circle className="ld-seal__disc" r={46} />
        <circle className="ld-seal__ring" r={38} />
        <g transform="scale(0.6)">
          <path className="ld-seal__coin" d={BITTEN_COIN} />
          <path className="ld-seal__c" d={MARK_C} />
        </g>
      </svg>
      <span className="ld-seal__bloom" />
    </div>
  );
}
