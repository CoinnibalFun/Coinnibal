// Illustrative NFT emblems for the promo's collection beat: drawn with the collection's own generator and
// renderer (apps/server/src/site/nft), from a film-only seed, so they show the style and the rarity tiers
// without being any real token's art. Writes SVGs to media/promo/cache/nft/<n>.svg and index.json.
//   npx tsx media/promo/render/nft-cards.ts   (from apps/server, so the workspace imports resolve)
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drawGenome, stream } from '../../../apps/server/src/site/nft/generate';
import { renderEmblem } from '../../../apps/server/src/site/nft/render';

const OUT = resolve(import.meta.dirname, '../cache/nft');
mkdirSync(OUT, { recursive: true });
const tiers = ['Common', 'Rare', 'Epic', 'Common', 'Legendary', 'Rare', 'Common', 'Epic', 'Rare', 'Common', 'Legendary', 'Rare'] as const;
const r = stream('coinnibal-promo-film-illustration', 'film');
const index = tiers.map((tier, i) => {
  const g = drawGenome(r, tier);
  writeFileSync(resolve(OUT, `${i}.svg`), renderEmblem(g, null, 'vector'));
  return { file: `${i}.svg`, tier };
});
writeFileSync(resolve(OUT, 'index.json'), JSON.stringify(index));
console.log(`wrote ${index.length} emblems to ${OUT}`);
