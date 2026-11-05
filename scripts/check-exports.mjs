#!/usr/bin/env node
// Dead-export check: every name a source file exports must be used somewhere: in its own file, another
// source file, a test or a script. An export whose name appears nowhere but in its own declaration is dead
// code (exported "for later" or left behind by a removal).
//
//   node scripts/check-exports.mjs            lists dead exports, exits 1 when there are any
//
// A plain-text scan, on purpose (no compiler, no dependencies): a name counts as used when it appears as a
// whole word a second time anywhere in the tracked .ts / .tsx / .mjs files. That is generous (a same-named
// local elsewhere counts as a use), so what it reports is reliably dead. Generated and tool-called files are
// skipped.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.includes('/dist/') && !f.endsWith('.d.ts'));

/** Files whose exports are consumed by a tool, a runtime or a build (not by an import in this repo). */
const SKIP = [
  /^packages\/contracts\/src\/artifacts\.ts$/, // generated
  /\/vite\.config\.ts$/,
  /\/vitest\.config\.ts$/,
  /\/hardhat\.config\.ts$/,
  /^apps\/web\/scripts\//,
  /^apps\/server\/scripts\//,
  /^scripts\//,
  /^media\//,
  /^brand\//,
  /\.test\.tsx?$/,
  /\/test\//,
];
/**
 * Names kept on purpose although nothing in the repository uses them: the SDK's public call builders and reads for
 * operators' own scripts (ownership hand-over, owner mint, metadata), documented in packages/sdk.
 */
const KEEP = new Set(['default', 'transferOwnershipCall', 'acceptOwnershipCall', 'mintCall', 'waitForSuccess', 'getTokenURI', 'setContractURICall']);

const text = new Map(files.map((f) => [f, readFileSync(ROOT + f, 'utf8')]));
const EXPORT = /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|class|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm;

const dead = [];
for (const [file, src] of text) {
  if (SKIP.some((r) => r.test(file))) continue;
  for (const m of src.matchAll(EXPORT)) {
    const name = m[1];
    if (KEEP.has(name)) continue;
    const word = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
    let seen = 0;
    for (const body of text.values()) {
      seen += (body.match(word) ?? []).length;
      if (seen > 1) break;
    }
    if (seen <= 1) dead.push(`${file}: ${name}`);
  }
}

if (dead.length) {
  console.log(`${dead.length} export(s) nothing else uses:\n  ${dead.join('\n  ')}`);
  process.exit(1);
}
console.log('No dead exports');
