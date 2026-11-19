import { defineConfig } from 'tsup';

export default defineConfig({
  // the room worker (GAME_WORKERS) is its own bundle next to index.js: dist/room-worker.js
  entry: { index: 'src/index.ts', 'room-worker': 'src/rooms/remote/worker-main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // workspace packages ship TypeScript sources → bundle them; npm deps (viem, ws) stay external
  noExternal: [/^@coinnibal\//],
  splitting: false,
  // a CommonJS dependency bundled through a workspace package would need `require`, `__filename` and
  // `__dirname`, which an ESM bundle does not have: define them so such a dependency never crashes the process
  banner: {
    js: [
      "import { createRequire as __coinnibalCreateRequire } from 'node:module';",
      "import { fileURLToPath as __coinnibalFileURLToPath } from 'node:url';",
      "import { dirname as __coinnibalDirname } from 'node:path';",
      'const require = __coinnibalCreateRequire(import.meta.url);',
      'const __filename = __coinnibalFileURLToPath(import.meta.url);',
      'const __dirname = __coinnibalDirname(__filename);',
    ].join('\n'),
  },
});
