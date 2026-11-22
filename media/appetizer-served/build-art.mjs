#!/usr/bin/env node
// Bundles packages/art into cache/art.js as the global `CoinnibalArt` (drawAppetizerCard, drawRisoCoin, lookForHandle)
// and copies the card's own Fraunces cut (the wght file the server draws the share image with) to cache/fonts/.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
mkdirSync(resolve(HERE, 'cache/fonts'), { recursive: true });
copyFileSync(
  resolve(ROOT, 'apps/web/node_modules/@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2'),
  resolve(HERE, 'cache/fonts/fraunces-wght.woff2'),
);
// esbuild: the art package's own, else the workspace's (pnpm store)
let bin = resolve(ROOT, 'packages/art/node_modules/.bin/esbuild');
if (!existsSync(bin)) {
  const store = resolve(ROOT, 'node_modules/.pnpm');
  const v = readdirSync(store).filter((d) => /^esbuild@\d/.test(d)).sort().pop();
  bin = resolve(store, v, 'node_modules/esbuild/bin/esbuild');
}
const r = spawnSync(
  bin,
  [resolve(HERE, 'scenes/art-entry.ts'), '--bundle', '--format=iife', '--global-name=CoinnibalArt', '--target=chrome120', `--outfile=${resolve(HERE, 'cache/art.js')}`],
  { stdio: 'inherit', cwd: resolve(ROOT, 'packages/art') },
);
process.exit(r.status ?? 1);
