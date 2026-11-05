#!/usr/bin/env node
// `pnpm check`: everything CI checks, locally, one suite at a time (the suites start hardhat nodes and
// worker threads; running them in parallel only makes them flaky). Stops at the first failure.
//
//   pnpm check            the full run (contracts included)
//   pnpm check --fast     skips the contracts build + Solidity tests and the web build
import { spawnSync } from 'node:child_process';

const fast = process.argv.includes('--fast');
const ROOT = new URL('..', import.meta.url).pathname;

/** The CI English-only guard: no Turkish-specific letter in any tracked text file but the translations. */
function englishOnly() {
  const letters = [0xe7, 0x11f, 0x131, 0xf6, 0x15f, 0xfc, 0xc7, 0x11e, 0x130, 0xd6, 0x15e, 0xdc].map((c) => `\\x{${c.toString(16)}}`).join('');
  const r = spawnSync('git', ['grep', '-InP', `[${letters}]`, '--', '.', ':!*.webp', ':!*.png', ':!*.jpg', ':!apps/web/src/i18n/locales/*'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C.UTF-8' },
  });
  if (r.status === 0) {
    process.stdout.write(r.stdout);
    return 'Turkish text found outside apps/web/src/i18n/locales';
  }
  return r.status === 1 ? null : `git grep failed (exit ${r.status}): ${r.stderr}`;
}

const steps = [
  ['English-only guard', englishOnly],
  ['dead exports', ['node', 'scripts/check-exports.mjs']],
  ['typecheck (every package)', ['pnpm', '-r', 'typecheck']],
  ...(fast ? [] : [['contracts: build + artifacts in sync', ['pnpm', '-F', '@elymum/contracts', 'build']]]),
  ...(fast ? [] : [['contracts: artifacts committed', ['git', 'diff', '--exit-code', 'packages/contracts/src/artifacts.ts']]]),
  ...(fast ? [] : [['contracts: unit, fuzz and invariant tests', ['pnpm', '-F', '@elymum/contracts', 'test']]]),
  ['shared tests', ['pnpm', '-F', '@elymum/shared', 'test']],
  ['art tests', ['pnpm', '-F', '@elymum/art', 'test']],
  ['sdk tests', ['pnpm', '-F', '@elymum/sdk', 'test']],
  ['server tests', ['pnpm', '-F', '@elymum/server', 'test']],
  ['server tests with room workers', ['pnpm', '-F', '@elymum/server', 'test:workers']],
  ['web tests', ['pnpm', '-F', '@elymum/web', 'test']],
  ...(fast ? [] : [['web build', ['pnpm', '-F', '@elymum/web', 'build']]]),
];

const started = Date.now();
for (const [name, step] of steps) {
  const t0 = Date.now();
  console.log(`\n▶ ${name}`);
  let failure = null;
  if (typeof step === 'function') failure = step();
  else {
    const r = spawnSync(step[0], step.slice(1), { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) failure = `${step.join(' ')} exited ${r.status ?? r.signal}`;
  }
  if (failure) {
    console.error(`\n✗ ${name}: ${failure}`);
    process.exit(1);
  }
  console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
console.log(`\nAll checks passed in ${((Date.now() - started) / 60_000).toFixed(1)} min.`);
