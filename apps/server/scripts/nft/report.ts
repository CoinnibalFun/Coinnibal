/**
 * The collection distribution report (docs/NFT-DESIGN.md): generates the whole collection and proves the tier
 * shares, the trait odds, zero broken exclusion rules and zero duplicate DNA.
 *
 *   pnpm -F @elymum/server nft:report [--size 3333] [--seed <s>] [--seeds 3] [--json]
 *
 * `--seed` reports one seed (e.g. the committed one, after the reveal); otherwise `--seeds` random seeds are
 * generated and each is checked. Exits 1 when any check fails.
 */
import { randomBytes } from 'node:crypto';
import { NFT_SUPPLY } from '@elymum/shared';
import { drawGenome, generateCollection, provenanceHash, rarityStats, stream, tierQuotas } from '../../src/site/nft/generate';
import { LAYERS, TIERS, TIER_SHARE, brokenRule, type Tier } from '../../src/site/nft/traits';

const arg = (name: string, def: string | null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const size = Number(arg('size', String(NFT_SUPPLY)));
const fixed = arg('seed', null);
const seeds = fixed ? [fixed] : Array.from({ length: Number(arg('seeds', '3')) }, () => `0x${randomBytes(32).toString('hex')}`);
const json = process.argv.includes('--json');

type Rolled = Exclude<Tier, 'Mythic'>;
const ROLLED = TIERS.filter((t) => t !== 'Mythic') as Rolled[];
/**
 * The odds the generator means: the per-tier share of each value with the exclusion rules applied but without
 * the no-duplicates reroll, by simulation (200,000 draws per tier). The collection is checked against these,
 * so the report shows how much the uniqueness constraint bends the odds (it must stay small).
 */
const SIM = 200_000;
const expected = new Map<string, number>();
for (const tier of ROLLED) {
  const r = stream('report-simulation', tier);
  for (let i = 0; i < SIM; i++) {
    const g = drawGenome(r, tier);
    for (const [label, key] of LAYERS) expected.set(`${tier}|${label}|${g[key]}`, (expected.get(`${tier}|${label}|${g[key]}`) ?? 0) + 1 / SIM);
  }
}

let failed = false;
const results = [];
for (const seed of seeds) {
  const t0 = performance.now();
  const genomes = generateCollection(seed, size);
  const ms = Math.round(performance.now() - t0);
  const st = rarityStats(genomes);
  const q = tierQuotas(size);
  const broken = genomes.filter((g) => brokenRule(g)).length;
  const tierOk = TIERS.every((t) => st.tiers[t] === q[t]);
  // every value's count inside its tier against the intended odds: within 4 sigma (plus 2) of the binomial
  const drift: string[] = [];
  let worst = 0;
  for (const tier of ROLLED) {
    const inTier = genomes.filter((g) => g.tier === tier);
    for (const [label, key] of LAYERS) {
      for (const [k, p] of expected) {
        const [t, l, v] = k.split('|');
        if (t !== tier || l !== label) continue;
        const n = inTier.filter((g) => g[key] === v).length;
        const sd = Math.sqrt(inTier.length * p * (1 - p));
        const z = sd > 0 ? Math.abs(n - inTier.length * p) / sd : 0;
        worst = Math.max(worst, z);
        if (Math.abs(n - inTier.length * p) > 4 * sd + 2) drift.push(`${tier} ${label}=${v}: ${n} vs ${(inTier.length * p).toFixed(0)} expected`);
      }
    }
  }
  const ok = tierOk && st.duplicates === 0 && broken === 0 && drift.length === 0;
  failed ||= !ok;
  results.push({ seed, size, ms, provenance: provenanceHash(genomes), tiers: st.tiers, quotas: q, duplicates: st.duplicates, brokenRules: broken, worstZ: Math.round(worst * 100) / 100, drift, layers: st.layers, ok });
}

if (json) console.log(JSON.stringify(results, null, 2));
else {
  for (const r of results) {
    console.log(`\nseed ${r.seed}  (${r.size} tokens, generated in ${r.ms} ms)`);
    console.log(`provenance ${r.provenance}`);
    console.log('tier        count   share    target');
    for (const t of TIERS) console.log(`${t.padEnd(10)} ${String(r.tiers[t]).padStart(6)}  ${((r.tiers[t] / size) * 100).toFixed(2).padStart(6)} %  ${(TIER_SHARE[t] * 100).toFixed(2).padStart(6)} %`);
    console.log(`duplicate DNA: ${r.duplicates}   broken exclusion rules: ${r.brokenRules}   worst |z| vs intended odds: ${r.worstZ}   drift beyond 4 sigma: ${r.drift.length ? r.drift.join('; ') : 'none'}`);
    for (const [label, counts] of Object.entries(r.layers)) {
      console.log(`\n${label}`);
      for (const [v, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${v.padEnd(14)} ${String(n).padStart(6)}  ${((n / size) * 100).toFixed(2).padStart(6)} %`);
    }
    console.log(`\n${r.ok ? 'OK' : 'FAILED'}`);
  }
}
process.exit(failed ? 1 : 0);
