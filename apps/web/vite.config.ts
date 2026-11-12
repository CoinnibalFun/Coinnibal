import react from '@vitejs/plugin-react';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const gameServer = process.env.GAME_SERVER ?? 'http://127.0.0.1:8787';

// index.html uses %VITE_PUBLIC_URL% for its absolute canonical / Open Graph URLs (they must be
// absolute: crawlers need them, and Vite would try to bundle a relative og:image). Default: the
// server's PUBLIC_URL, else the live public domain. Set VITE_PUBLIC_URL (or PUBLIC_URL) at build time:
// moving the site to another domain (coinnibal.io) is only this variable (docs/OPERATIONS.md).
const LIVE_URL = 'https://elymum.io';
process.env.VITE_PUBLIC_URL = (process.env.VITE_PUBLIC_URL || process.env.PUBLIC_URL || LIVE_URL).replace(/\/+$/, '');
// the project's X handle (no `@`) for index.html's twitter:site and the pages before the server's settings load
process.env.VITE_X_HANDLE = (process.env.VITE_X_HANDLE || 'elymumio').replace(/^@/, '').trim();

/**
 * robots.txt and sitemap.xml are static files (public/) written for the live domain; the build rewrites their absolute
 * URLs to `VITE_PUBLIC_URL`, so they follow the domain like index.html does.
 */
function publicUrlFiles(): Plugin {
  let outDir = '';
  return {
    name: 'public-url-files',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir.startsWith('/') ? c.build.outDir : join(c.root, c.build.outDir);
    },
    closeBundle() {
      const url = process.env.VITE_PUBLIC_URL!;
      if (url === LIVE_URL) return;
      for (const f of ['robots.txt', 'sitemap.xml']) {
        const p = join(outDir, f);
        if (existsSync(p)) writeFileSync(p, readFileSync(p, 'utf8').replaceAll(LIVE_URL, url));
      }
    },
  };
}

// On Vercel (a static host) the browser must reach the game server directly: vercel.json proxies only the NFT
// metadata and the share cards, and proxied API calls would all come from Vercel's addresses (the server's per-IP
// limits could not tell players apart). Fail the build loudly instead of shipping a site whose API calls 404.
if (process.env.VERCEL === '1' && !process.env.VITE_SERVER_URL && !process.env.VITE_WS_URL) {
  throw new Error('VITE_SERVER_URL is not set: set it to the game server (e.g. https://game.elymum.io) in the Vercel project settings');
}

/**
 * Dev / preview proxy to the game server. `/api` keeps the browser's Host header
 * (no `changeOrigin`): the server names the request host in the SIWE sign-in
 * message, and the client only signs a message for the page it is on
 * (`localhost:5173`), not for the proxy target (`127.0.0.1:8787`).
 * The WebSocket carries no host-bound data, so it keeps the target's host.
 */
export function gameServerProxy(target: string) {
  return {
    '/api': { target, changeOrigin: false },
    // "Share on X" cards (`/share/<id>` and its image) are served by the game server
    '/share': { target, changeOrigin: false },
    '/ws': { target: target.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
  };
}

/**
 * The package directories of viem and the crypto / ABI packages it depends on, the exact versions it uses (real
 * paths: pnpm keeps each version in its own directory). Only these make the cacheable `viem` chunk: another copy of
 * the same packages (WalletConnect brings its own `ox` and `@noble/*` versions) stays with whoever imports it, so
 * the lazily loaded WalletConnect chunk never grows the chunk every page loads.
 */
function viemPackageDirs(): string[] {
  const dirs = new Set<string>();
  const walk = (dir: string) => {
    if (dirs.has(dir)) return;
    dirs.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!/^(viem|ox|abitype|@noble\/|@scure\/|isows)/.test(dep)) continue;
      // pnpm: a package's dependencies are its siblings in the same node_modules directory
      const at = join(dir, dep.startsWith('@') ? '../..' : '..', dep);
      if (existsSync(join(at, 'package.json'))) walk(realpathSync(at));
    }
  };
  try {
    walk(realpathSync(join(dirname(fileURLToPath(import.meta.url)), 'node_modules', 'viem')));
  } catch {
    /* no viem here (should not happen): the chunk rule below then matches nothing special */
  }
  return [...dirs].map((d) => `${d}/`);
}
const VIEM_DIRS = viemPackageDirs();

export default defineConfig({
  plugins: [react(), publicUrlFiles()],
  server: {
    port: 5173,
    host: true,
    proxy: gameServerProxy(gameServer),
  },
  preview: {
    port: 4173,
    proxy: gameServerProxy(gameServer),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      // The workspace SDK's modules have no import-time side effects (ABIs, constants, functions):
      // marked so, a page that only needs its constants (the landing quotes fee and refund numbers)
      // does not pull in its viem-based clients. The SDK's package.json has no `sideEffects` field.
      treeshake: {
        moduleSideEffects: (id: string) => !/[\\/]packages[\\/](sdk|contracts)[\\/]/.test(id),
      },
      output: {
        // long-term cacheable vendor chunks
        manualChunks(id: string) {
          // Vite's dynamic-import preload helper: its own tiny chunk. Left alone, the bundler can
          // place it inside the viem chunk, and then the entry (which needs the helper for every
          // page's `import()`) downloads all of viem before any page starts.
          if (id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) return 'preload';
          if (!id.includes('node_modules')) return undefined;
          // package roots only (`node_modules/<pkg>/`): viem and its crypto / ABI dependencies in one cacheable chunk
          // WalletConnect (only in a build with a project id): its own chunk, loaded when a player picks it
          if (/[\\/]@walletconnect[\\/]/.test(id)) return 'walletconnect';
          if (/node_modules[\\/](viem|ox|abitype|@noble|@scure|isows)[\\/]/.test(id)) return VIEM_DIRS.some((d) => id.startsWith(d)) ? 'viem' : undefined;
          if (/node_modules[\\/](react|react-dom|scheduler|zustand)[\\/]/.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
});
