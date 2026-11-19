import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The player guide (/docs) must not download the wallet layer (viem, the wallet store, the lobby) or the game engine:
 * that was about 150 KB on every visit to the guide. These modules are what the guide imports from those areas, so
 * they must stay light: type-only imports of viem are fine, and from the sdk only constants and math.
 * (The production build is checked too: the /docs run requests no viem, wallet store, lobby or devFakeLoader chunk.)
 */
const LIGHT = [
  'src/ui/tokenText.ts',
  'src/wallet/ticket.ts',
  // lane GUIDE's power-up key caps, once they exist
  'src/ui/game/boostGlyphs.ts',
];
const SDK_ALLOWED = new Set(['ledgerDecimals', 'REFUND_DELAY_SECS', 'fromLedger']);
const HEAVY = [/^viem$/, /(^|\/)wallet\/(store|chain)(\.tsx?)?$/, /(^|\/)ui\/lobby\//, /(^|\/)lobby\//, /(^|\/)game\//];

interface Imp {
  from: string;
  /** Names imported at runtime (type-only specifiers left out); `*` for a namespace or side-effect import. */
  names: string[];
}

function runtimeImports(src: string): Imp[] {
  const out: Imp[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*(?:from\s*)?['"]([^'"]+)['"]/gm;
  for (const m of src.matchAll(re)) {
    if (m[2]) continue; // `import type` / `export type`
    const clause = m[3].trim();
    const names: string[] = [];
    if (!clause || /\*/.test(clause)) names.push('*');
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const p = part.trim();
        if (p && !p.startsWith('type ')) names.push(p.split(/\s+as\s+/)[0].trim());
      }
    }
    const def = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
    if (def && def !== '*' && !def.startsWith('*')) names.push('default');
    if (names.length) out.push({ from: m[4], names });
  }
  return out;
}

describe('the modules the player guide imports stay light (no wallet layer, no engine)', () => {
  for (const file of LIGHT) {
    const path = join(__dirname, '..', file);
    it.skipIf(!existsSync(path))(`${file} imports nothing heavy at runtime`, () => {
      const imps = runtimeImports(readFileSync(path, 'utf8'));
      expect(imps.length).toBeGreaterThan(0);
      for (const imp of imps) {
        for (const heavy of HEAVY) expect(heavy.test(imp.from), `${file}: runtime import of ${imp.from}`).toBe(false);
        if (imp.from === '@coinnibal/sdk') for (const n of imp.names) expect(SDK_ALLOWED.has(n), `${file}: ${n} from the sdk`).toBe(true);
      }
    });
  }

  it('the parser sees type-only imports as such', () => {
    expect(runtimeImports("import type { Address } from 'viem';\nimport { type Hex } from 'viem';")).toEqual([]);
    expect(runtimeImports("import { REFUND_DELAY_SECS, fromLedger, type Erc20Call } from '@coinnibal/sdk';")).toEqual([{ from: '@coinnibal/sdk', names: ['REFUND_DELAY_SECS', 'fromLedger'] }]);
    expect(runtimeImports("import { parseUnits } from 'viem';\nimport './x.css';")).toEqual([
      { from: 'viem', names: ['parseUnits'] },
      { from: './x.css', names: ['*'] },
    ]);
  });

  it('the guide takes its token text from the light module, and /docs does not import the lobby stylesheet', () => {
    const docs = readFileSync(join(__dirname, '../src/ui/docs/DocsPage.tsx'), 'utf8');
    expect(docs).toMatch(/from '\.\.\/tokenText'/);
    expect(docs).not.toMatch(/lobby\/useLobby/);
    expect(readFileSync(join(__dirname, '../src/site/DocsRoute.tsx'), 'utf8')).not.toMatch(/lobby\.css/);
  });
});
