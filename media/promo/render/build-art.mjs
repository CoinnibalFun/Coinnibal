#!/usr/bin/env node
// Bundles packages/art (coin characters) into cache/art.js as the global `CoinnibalArt`.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(PROMO, '../..');
mkdirSync(resolve(PROMO, 'cache'), { recursive: true });
// esbuild: the art package's own, else the workspace's (pnpm store)
import { existsSync, readdirSync } from 'node:fs';
let bin = resolve(ROOT, 'packages/art/node_modules/.bin/esbuild');
if (!existsSync(bin)) {
  const store = resolve(ROOT, 'node_modules/.pnpm');
  const v = readdirSync(store).filter((d) => /^esbuild@\d/.test(d)).sort().pop();
  bin = resolve(store, v, 'node_modules/esbuild/bin/esbuild');
}
const r = spawnSync(
  bin,
  [resolve(PROMO, 'scenes/art-entry.ts'), '--bundle', '--format=iife', '--global-name=CoinnibalArt', '--target=chrome120', `--outfile=${resolve(PROMO, 'cache/art.js')}`],
  { stdio: 'inherit', cwd: resolve(ROOT, 'packages/art') },
);
process.exit(r.status ?? 1);
