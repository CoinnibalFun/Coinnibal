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
  // the power-up glyphs (type imports only)
  'src/ui/game/boostGlyphs.ts',
];
const SDK_ALLOWED = new Set(['ledgerDecimals', 'REFUND_DELAY_SECS', 'fromLedger']);
const HEAVY = [/^viem$/, /(^|\/)wallet\/(store|chain)(\.tsx?)?$/, /(^|\/)ui\/lobby\//, /(^|\/)lobby\//, /(^|\/)game\//];

interface Imp {
  from: string;
  /** Names imported at runtime (type-only specifiers left out); `*` for a namespace or side-effect import. */
  names: string[];
}

/**
 * `import ... from 'x'`, `import 'x'` and the re-exports `export ... from 'x'`. A declaration (`export const`,
 * `export function`) is not an import, even when a string follows it.
 */
const IMPORT_RE = /^\s*(?:import\s+(type\s+)?(?:([^'";]*?)\s*\bfrom\s*)?|export\s+(type\s+)?([^'";]*?)\s*\bfrom\s*)['"]([^'"]+)['"]/gm;

function runtimeImports(src: string): Imp[] {
  const out: Imp[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    if (m[1] || m[3]) continue; // `import type` / `export type`
    const clause = (m[2] ?? m[4] ?? '').trim();
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
    if (names.length) out.push({ from: m[5], names });
  }
  return out;
}

describe('the modules the player guide imports stay light (no wallet layer, no engine)', () => {
  for (const file of LIGHT) {
    const path = join(__dirname, '..', file);
    it.skipIf(!existsSync(path))(`${file} imports nothing heavy at runtime`, () => {
      const src = readFileSync(path, 'utf8');
      // the scan reads a real module (a module with only type imports has no runtime import to check)
      expect(src).toMatch(/^import\s/m);
      const imps = runtimeImports(src);
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
    // declarations are not imports, re-exports are
    expect(runtimeImports("export const P = {\n  a: 'viem',\n};\nexport function f(x: Pick<T, 'a'>) {}")).toEqual([]);
    expect(runtimeImports("export { a as b } from './y';\nexport type { C } from 'viem';")).toEqual([{ from: './y', names: ['a'] }]);
  });

  it('the guide takes its token text from the light module, and /docs does not import the lobby stylesheet', () => {
    const docs = readFileSync(join(__dirname, '../src/ui/docs/DocsPage.tsx'), 'utf8');
    expect(docs).toMatch(/from '\.\.\/tokenText'/);
    expect(docs).not.toMatch(/lobby\/useLobby/);
    expect(readFileSync(join(__dirname, '../src/site/DocsRoute.tsx'), 'utf8')).not.toMatch(/lobby\.css/);
  });
});

describe('the design system has no import-time side effects (the build tree-shakes it per page: vite.config.ts)', () => {
  it('every module under src/design is declarations only: no top-level call, no side-effect import but a style sheet', async () => {
    const ts = await import('typescript');
    const { readdirSync, statSync } = await import('node:fs');
    const root = join(__dirname, '../src/design');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(30);
    const found: string[] = [];
    for (const file of files) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      for (const st of sf.statements) {
        if (ts.isImportDeclaration(st)) {
          const from = (st.moduleSpecifier as import('typescript').StringLiteral).text;
          if (!st.importClause && !from.endsWith('.css')) found.push(`${file}: import '${from}'`);
          continue;
        }
        const declaration =
          ts.isExportDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isVariableStatement(st) || ts.isModuleDeclaration(st);
        if (!declaration) found.push(`${file}: ${st.getText().slice(0, 60)}`);
      }
    }
    expect(found).toEqual([]);
    const { isPureDesignModule } = await import('../vite.config');
    expect(isPureDesignModule('/w/apps/web/src/design/components/Modal.tsx')).toBe(true);
    expect(isPureDesignModule('C:\\w\\apps\\web\\src\\design\\motifs\\RingScene.tsx')).toBe(true);
    expect(isPureDesignModule('/w/apps/web/src/design/storybook.css')).toBe(false);
    expect(isPureDesignModule('/w/apps/web/src/design/fonts/core.css?inline')).toBe(false);
    expect(isPureDesignModule('/w/apps/web/src/site/Shell.tsx')).toBe(false);
  });
});
