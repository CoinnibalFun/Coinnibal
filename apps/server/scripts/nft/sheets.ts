/**
 * Contact sheets of the emblem collection, for picking a style and checking the art (docs/NFT-DESIGN.md):
 *
 *   pnpm -F @coinnibal/server nft:sheets [--seed <s>] [--size 3333] [--out <dir>]
 *
 * Writes compare.png (the same 12 tokens in both styles), vector-tiers.png and pixel-tiers.png (five of
 * each tier), vector-traits.png and pixel-traits.png (every trait value), rarity-table.png and
 * unrevealed.png into the out directory (default: out/nft2 at the repository root, which git ignores).
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NFT_SUPPLY } from '@coinnibal/shared';
import { GlobalFonts, createCanvas, loadImage, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { generateCollection, rarityStats, tierQuotas } from '../../src/site/nft/generate';
import { pixelSvg } from '../../src/site/nft/pixel';
import { unrevealedSvg } from '../../src/site/nft/unrevealed';
import { vectorSvg } from '../../src/site/nft/vector';
import { LAYERS, MYTHICS, TIERS, valueTier, type Genome, type Tier } from '../../src/site/nft/traits';

const require = createRequire(import.meta.url);
GlobalFonts.registerFromPath(require.resolve('@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2'), 'Fraunces');
GlobalFonts.registerFromPath(require.resolve('@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2'), 'DM Sans');

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const seed = arg('seed', 'elymum-preview-seed');
const size = Number(arg('size', String(NFT_SUPPLY)));
const out = resolve(arg('out', resolve(import.meta.dirname, '../../../../out/nft2')));
mkdirSync(out, { recursive: true });

const INK = '#04181C';
const PAPER = '#F1EFE8';
const TIER_INK: Record<Tier, string> = { Common: '#6B655A', Rare: '#1E6F8C', Epic: '#7458B0', Legendary: '#8A5F0E', Mythic: '#04181C' };

const collection = generateCollection(seed, size);
const styles = { vector: vectorSvg, pixel: pixelSvg } as const;

async function tile(ctx: SKRSContext2D, svg: string, x: number, y: number, s: number): Promise<void> {
  const img = await loadImage(Buffer.from(svg));
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, x, y, s, s);
}

function sheet(w: number, h: number): { c: Canvas; ctx: SKRSContext2D } {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  return { c, ctx };
}

function title(ctx: SKRSContext2D, text: string, sub: string, x = 40, y = 64): void {
  ctx.fillStyle = INK;
  ctx.font = '600 40px Fraunces';
  ctx.fillText(text, x, y);
  ctx.font = '400 20px "DM Sans"';
  ctx.fillStyle = '#6B655A';
  ctx.fillText(sub, x, y + 32);
}

const save = (c: Canvas, name: string) => {
  writeFileSync(join(out, name), c.toBuffer('image/png'));
  console.log(`wrote ${join(out, name)}`);
};

/** Ids (art index + 1, i.e. a zero reveal offset) of the first tokens of each tier. */
function sample(tier: Tier, n: number, skip = 0): { id: number; g: Genome }[] {
  const out: { id: number; g: Genome }[] = [];
  collection.forEach((g, i) => {
    if (g.tier === tier && out.length < n + skip) out.push({ id: i + 1, g });
  });
  return out.slice(skip);
}

/* compare: the same 12 tokens in both styles ---------------------------------------------------------- */

async function compare(): Promise<void> {
  const picks = [...sample('Common', 4), ...sample('Rare', 3), ...sample('Epic', 2), ...sample('Legendary', 2), ...sample('Mythic', 1)];
  const S = 280;
  const gap = 12;
  const pairW = S * 2 + gap;
  const cols = 3;
  const W = 40 * 2 + cols * pairW + (cols - 1) * 40;
  const rowH = S + 64;
  const { c, ctx } = sheet(W, 150 + Math.ceil(picks.length / cols) * rowH + 20);
  title(ctx, 'Same token, two styles', `Left: vector (house style). Right: pixel art (64 x 64 grid). Collection seed "${seed}", ${size} tokens.`);
  for (const [i, { id, g }] of picks.entries()) {
    const x = 40 + (i % cols) * (pairW + 40);
    const y = 130 + Math.floor(i / cols) * rowH;
    await tile(ctx, vectorSvg(g, id), x, y, S);
    await tile(ctx, pixelSvg(g, id), x + S + gap, y, S);
    ctx.fillStyle = TIER_INK[g.tier];
    ctx.font = '700 17px "DM Sans"';
    ctx.fillText(`#${id}  ${g.tier.toUpperCase()}`, x, y + S + 26);
    ctx.fillStyle = INK;
    ctx.font = '400 15px "DM Sans"';
    ctx.fillText([g.name, g.material, g.background, g.eyes, g.mouth, g.headwear, g.accessory, g.effect].filter((v) => v && v !== 'None').join(' / '), x, y + S + 48);
  }
  save(c, 'compare.png');
}

/* tiers: five of each tier per style ------------------------------------------------------------------ */

async function tiers(style: keyof typeof styles): Promise<void> {
  const S = 220;
  const per = 5;
  const W = 260 + per * (S + 16) + 24;
  const { c, ctx } = sheet(W, 130 + TIERS.length * (S + 30) + 10);
  title(ctx, `Tiers, ${style} style`, `Five tokens of each tier (seed "${seed}"). Odds are exact quotas of ${size}.`);
  const q = tierQuotas(size);
  for (const [r, tier] of TIERS.entries()) {
    const y = 130 + r * (S + 30);
    ctx.fillStyle = TIER_INK[tier];
    ctx.font = '600 30px Fraunces';
    ctx.fillText(tier, 40, y + 60);
    ctx.font = '400 17px "DM Sans"';
    ctx.fillStyle = INK;
    ctx.fillText(`${q[tier]} of ${size}`, 40, y + 90);
    ctx.fillText(`${((q[tier] / size) * 100).toFixed(1)} %`, 40, y + 114);
    const picks = tier === 'Mythic' ? MYTHICS.slice(0, per).map((g, i) => ({ id: collection.findIndex((x) => x.name === g.name) + 1 || i + 1, g })) : sample(tier, per, 4);
    for (const [i, { id, g }] of picks.entries()) await tile(ctx, styles[style](g, id), 260 + i * (S + 16), y, S);
  }
  save(c, `${style}-tiers.png`);
}

/* traits: every value of every layer --------------------------------------------------------------------- */

async function traits(style: keyof typeof styles): Promise<void> {
  const base: Genome = { tier: 'Common', background: 'Seigaiha', material: 'Cyan', eyes: 'Round', mouth: 'Smile', headwear: 'None', accessory: 'None', effect: 'None' };
  const rows: { label: string; items: { name: string; g: Genome }[] }[] = [];
  const extra: Record<string, string[]> = {
    background: ['Eclipse', 'Abyss', 'Prism', 'Origin'],
    material: ['Molten Sun', 'Void', 'Moonstone', 'Prismatic', 'Ancient Gold'],
    effect: ['Corona', 'Embers', 'Starfall', 'Prism Halo'],
  };
  for (const [label, key, table] of LAYERS) {
    const values = [...Object.keys(table), ...(extra[key] ?? [])].filter((v) => v !== 'None');
    rows.push({ label, items: values.map((v) => ({ name: v, g: { ...base, tier: key === 'background' || key === 'material' || key === 'effect' ? tierOfValue(key, v) : 'Common', [key]: v } as Genome })) });
  }
  const S = 150;
  const cols = 8;
  const lines = rows.reduce((n, r) => n + Math.ceil(r.items.length / cols), 0);
  const W = 200 + cols * (S + 12) + 20;
  const { c, ctx } = sheet(W, 130 + lines * (S + 34) + rows.length * 10);
  title(ctx, `Every trait, ${style} style`, 'Each value on a plain Common coin (signature layers carry their own tier frame).');
  let y = 130;
  for (const row of rows) {
    ctx.fillStyle = INK;
    ctx.font = '600 24px Fraunces';
    ctx.fillText(row.label, 30, y + 40);
    for (const [i, it] of row.items.entries()) {
      const x = 200 + (i % cols) * (S + 12);
      const yy = y + Math.floor(i / cols) * (S + 34);
      await tile(ctx, styles[style](it.g, null), x, yy, S);
      ctx.font = '400 14px "DM Sans"';
      ctx.fillStyle = INK;
      ctx.fillText(it.name, x, yy + S + 18);
    }
    y += Math.ceil(row.items.length / cols) * (S + 34) + 10;
  }
  save(c, `${style}-traits.png`);
}

function tierOfValue(key: string, v: string): Tier {
  const table = LAYERS.find((l) => l[1] === key)![2] as Record<string, readonly [number, number, number, number]>;
  return table[v] ? valueTier(table[v]) : 'Mythic';
}

/* rarity table -------------------------------------------------------------------------------------------- */

function rarityTable(): void {
  const st = rarityStats(collection);
  const colW = 380;
  const cols = 4;
  const lineH = 24;
  const blocks = [
    { label: 'Tier', entries: TIERS.map((t) => [t, st.tiers[t]] as [string, number]) },
    ...LAYERS.map(([label]) => ({ label, entries: Object.entries(st.layers[label]).sort((a, b) => b[1] - a[1]) })),
  ];
  // pack blocks into columns
  const colsY = Array(cols).fill(150);
  const placed: { x: number; y: number; b: (typeof blocks)[number] }[] = [];
  for (const b of blocks) {
    const ci = colsY.indexOf(Math.min(...colsY));
    placed.push({ x: 40 + ci * colW, y: colsY[ci], b });
    colsY[ci] += 50 + b.entries.length * lineH + 24;
  }
  const { c, ctx } = sheet(40 * 2 + cols * colW, Math.max(...colsY) + 70);
  title(ctx, 'Rarity table', `The full collection: ${size} tokens from seed "${seed}". Duplicate DNA: ${st.duplicates}. Tiers are exact quotas.`);
  for (const { x, y, b } of placed) {
    ctx.fillStyle = INK;
    ctx.font = '600 24px Fraunces';
    ctx.fillText(b.label, x, y + 24);
    for (const [i, [name, n]] of b.entries.entries()) {
      const yy = y + 54 + i * lineH;
      const tier = b.label === 'Tier' ? (name as Tier) : tierOfValue(LAYERS.find((l) => l[0] === b.label)![1], name);
      ctx.fillStyle = TIER_INK[tier];
      ctx.fillRect(x, yy - 12, 6, 14);
      ctx.fillStyle = INK;
      ctx.font = '400 16px "DM Sans"';
      ctx.fillText(name, x + 14, yy);
      ctx.textAlign = 'right';
      ctx.fillText(String(n), x + 250, yy);
      ctx.fillStyle = '#6B655A';
      ctx.fillText(`${((n / size) * 100).toFixed(2)} %`, x + 340, yy);
      ctx.textAlign = 'left';
    }
  }
  ctx.font = '400 15px "DM Sans"';
  ctx.fillStyle = '#6B655A';
  ctx.fillText('Bar colour: the tier a value first appears at (Common grey, Rare blue, Epic violet, Legendary amber, Mythic ink).', 40, Math.max(...colsY) + 40);
  save(c, 'rarity-table.png');
}

async function unrevealed(): Promise<void> {
  const S = 360;
  const { c, ctx } = sheet(40 * 3 + S * 2, S + 170);
  title(ctx, 'Before the reveal', 'Every minted token shows the sealed emblem until the collection seed is revealed.');
  await tile(ctx, unrevealedSvg(42, 'vector'), 40, 130, S);
  await tile(ctx, unrevealedSvg(42, 'pixel'), 80 + S, 130, S);
  save(c, 'unrevealed.png');
}

await compare();
await tiers('vector');
await tiers('pixel');
await traits('vector');
await traits('pixel');
rarityTable();
await unrevealed();
