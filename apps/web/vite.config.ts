import react from '@vitejs/plugin-react';
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { build, defineConfig, type Plugin } from 'vite';

const gameServer = process.env.GAME_SERVER ?? 'http://127.0.0.1:8787';

// index.html uses %VITE_PUBLIC_URL% for its absolute canonical / Open Graph URLs (they must be
// absolute: crawlers need them, and Vite would try to bundle a relative og:image). Default: the
// server's PUBLIC_URL, else the live public domain. Set VITE_PUBLIC_URL (or PUBLIC_URL) at build time:
// moving the site to another domain (coinnibal.fun) is only this variable (docs/OPERATIONS.md).
const LIVE_URL = 'https://coinnibal.fun';
process.env.VITE_PUBLIC_URL = (process.env.VITE_PUBLIC_URL || process.env.PUBLIC_URL || LIVE_URL).replace(/\/+$/, '');
// the project's X handle (no `@`) for index.html's twitter:site and the pages before the server's settings load
process.env.VITE_X_HANDLE = (process.env.VITE_X_HANDLE || 'coinnibalfun').replace(/^@/, '').trim();

/**
 * robots.txt and sitemap.xml are static files (public/) written for the live domain; the build rewrites their absolute
 * URLs to `VITE_PUBLIC_URL`, so they follow the domain like index.html does.
 * The sitemap lists only the pages that are always open (`/`, `/docs`): a static file cannot follow the admin's
 * settings, which open and close the mint, the game, the WL and the collab pages.
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

/** The text files the build precompresses (the game server sends `x.br` or `x.gz` in their place: http.ts). */
export const PRECOMPRESS = new Set(['.js', '.css', '.svg', '.html', '.webmanifest']);

/**
 * Build only: writes a brotli (quality 11) and a gzip (level 9) copy next to every text file of `dist/` (`x.js.br`,
 * `x.js.gz`), when it is smaller than the file. The game server (apps/server/src/http.ts `serveStatic`) sends the
 * best one the browser takes; Caddy leaves a response that already has a Content-Encoding alone. Brotli 11 is about
 * 12 % smaller than what Caddy compresses on the fly (zstd at its default level, about gzip 6): about 30 KB less on a
 * first visit. Runs after every other plugin has written its files (`order: 'post'`).
 */
function precompress(): Plugin {
  let outDir = '';
  const br = promisify(brotliCompress);
  const gz = promisify(gzip);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : PRECOMPRESS.has(extname(f)) ? [p] : [];
    });
  return {
    name: 'precompress',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir.startsWith('/') ? c.build.outDir : join(c.root, c.build.outDir);
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
        await Promise.all(
          walk(outDir).map(async (file) => {
            const raw = await readFile(file);
            const [b, g] = await Promise.all([
              br(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
              gz(raw, { level: 9 }),
            ]);
            if (b.length < raw.length) await writeFile(file + '.br', b);
            if (g.length < raw.length) await writeFile(file + '.gz', g);
          }),
        );
      },
    },
  };
}

/** What `site-preloads` reads of a chunk in the bundle. */
interface BundleChunk {
  type: 'chunk';
  fileName: string;
  facadeModuleId: string | null;
  imports: string[];
  viteMetadata?: { importedCss: Set<string> };
}

/**
 * Build only: index.html starts the site's code in its first request round. Every visitor page goes through
 * `src/site/mount.tsx`, which main.tsx imports dynamically, so its chunk, the chunks it imports and their CSS were found
 * only after the entry had downloaded and run (a second round of requests). Adds `<link rel="modulepreload">` for those
 * chunks and `<link rel="preload" as="style" crossorigin>` for their CSS (crossorigin: Vite's loader adds the
 * stylesheet in CORS mode, and only a preload in the same mode is used), appended to `<head>`, each marked
 * `data-site-preload`: the prerendered landing (whose HTML paints before any script) leaves them out, and Vite's own
 * modulepreloads too (`landingHtml`), because there they would take bandwidth from the page's own HTML and CSS.
 */
function sitePreloads(): Plugin {
  let base = '/';
  return {
    name: 'site-preloads',
    apply: 'build',
    configResolved(c) {
      base = c.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const chunks = Object.values(ctx.bundle ?? {}).filter((c) => c.type === 'chunk') as unknown as BundleChunk[];
        const site = chunks.find((c) => c.facadeModuleId?.replace(/\\/g, '/').endsWith('/src/site/mount.tsx'));
        if (!site) throw new Error('site-preloads: no chunk for src/site/mount.tsx in the build');
        const byName = new Map(chunks.map((c) => [c.fileName, c]));
        const js = new Set<string>();
        const css = new Set<string>();
        const walk = (c: BundleChunk) => {
          if (js.has(c.fileName)) return;
          js.add(c.fileName);
          for (const f of c.viteMetadata?.importedCss ?? []) css.add(f);
          for (const i of c.imports) {
            const d = byName.get(i);
            if (d) walk(d);
          }
        };
        walk(site);
        // what index.html already loads (the entry, its own imports and CSS) needs no second tag
        const fresh = (f: string) => !html.includes(`"${base}${f}"`);
        return [
          ...[...js].filter(fresh).map((f) => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: base + f, 'data-site-preload': true }, injectTo: 'head' as const })),
          ...[...css].filter(fresh).map((f) => ({ tag: 'link', attrs: { rel: 'preload', as: 'style', crossorigin: true, href: base + f, 'data-site-preload': true }, injectTo: 'head' as const })),
        ];
      },
    },
  };
}

/** What `prerender-landing` reads of the build manifest (`build.manifest`): a module's chunk, its CSS and its imports. */
type Manifest = Record<string, { file: string; css?: string[]; imports?: string[] }>;

/**
 * The stylesheets a dynamically imported module needs (`src/site/mount.tsx`: today mount, Shell, WhyNft, Closed), in
 * the order Vite's loader adds them to the page: the CSS of a chunk's static imports (depth first) before its own, so
 * the cascade is the same as on a page the browser renders itself.
 */
export function moduleCss(manifest: Manifest, key: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (k: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    const m = manifest[k];
    if (!m) throw new Error(`prerender-landing: ${k} is not in the build manifest`);
    for (const i of m.imports ?? []) visit(i);
    for (const c of m.css ?? []) if (!out.includes(c)) out.push(c);
  };
  visit(key);
  return out;
}

/**
 * `landing.html` from the built `index.html`: `<html data-theme="light">` (what `mount()` sets: without it a dark-mode
 * phone gets the dark tokens outside `.kb` until the script runs), the prerendered markup in `#root` in place of the
 * `.boot` loader, a `<link rel="stylesheet">` for each of the landing's CSS chunks (the page paints styled from its
 * HTML; Vite's loader finds them there and does not add them again), `bodyEnd` before `</body>` (the inked-edge
 * filters), and no preload of scripts: neither the `data-site-preload` tags (`site-preloads`) nor Vite's own
 * `modulepreload` of the entry's imports. On a page that paints from its HTML they take bandwidth from its HTML and
 * CSS (B12 of the speed plan): without Vite's three, phone FCP 1008 -> 948 ms on the replica, hydration ~0.36 s later.
 */
export function landingHtml(index: string, markup: string, css: string[], base = '/', bodyEnd = ''): string {
  const open = '<div id="root">';
  const at = index.indexOf(open);
  const end = index.lastIndexOf('</body>');
  const loader = at < 0 || end < at ? '' : index.slice(at, end).trimEnd();
  if (!loader.endsWith('</div>') || !loader.includes('class="boot"')) throw new Error('prerender-landing: index.html has no <div id="root"> with the .boot loader');
  let html = index.slice(0, at) + open + markup + '</div>' + index.slice(at + loader.length);
  html = html.replace(/[ \t]*<link\b[^>]*\b(?:data-site-preload\b|rel="modulepreload")[^>]*>\r?\n?/g, '');
  if (!html.includes('<html lang="en">')) throw new Error('prerender-landing: index.html has no <html lang="en">');
  html = html.replace('<html lang="en">', '<html lang="en" data-theme="light">');
  const links = css
    .map((f) => base + f)
    .filter((href) => !html.includes(`href="${href}"`))
    .map((href) => `    <link rel="stylesheet" crossorigin href="${href}">\n`)
    .join('');
  if (!html.includes('</head>') || !html.includes('</body>')) throw new Error('prerender-landing: index.html has no </head> or </body>');
  return html.replace('</head>', `${links}  </head>`).replace('</body>', `${bodyEnd ? `    ${bodyEnd}\n` : ''}  </body>`);
}

/**
 * Build only (S1 of the speed plan): `/` is prerendered. After the client build, bundles `src/site/landing/prerender.tsx`
 * with `vite build --ssr` (everything bundled, so it runs from a cache directory), runs it in this Node process (no
 * DOM) and writes:
 * - `dist/landing.html`: index.html with the landing's markup (`landingHtml`); the browser hydrates it (`mount()`).
 *   Its first paint is the whole first viewport, from the HTML, before any script.
 * - `dist/landing.json`: the settings the markup assumed (`gameAccess`, `mintOpen`, `wlOpen`, `collabOpen`, `xHandle`:
 *   the closed defaults, the build's X handle). The game server sends `landing.html` for `/` only while its live
 *   settings equal these (apps/server/src/http.ts), else `index.html` (the page renders in the browser, as before).
 * The manifest (`build.manifest`) is read for the CSS chunks and then removed (nothing serves it). Runs before
 * `precompress`, which writes the `.br` / `.gz` copies of `landing.html` too.
 */
function prerenderLanding(): Plugin {
  let root = '';
  let outDir = '';
  let mode = 'production';
  let base = '/';
  let ssr = false;
  return {
    name: 'prerender-landing',
    apply: 'build',
    configResolved(c) {
      root = c.root;
      outDir = resolve(c.root, c.build.outDir);
      mode = c.mode;
      base = c.base;
      ssr = !!c.build.ssr;
    },
    closeBundle: {
      sequential: true,
      async handler() {
        if (ssr) return;
        const tmp = join(root, 'node_modules', '.cache', 'prerender-landing');
        try {
          await build({
            configFile: false,
            root,
            mode,
            base,
            logLevel: 'warn',
            publicDir: false,
            plugins: [react()],
            ssr: { noExternal: true },
            build: {
              ssr: 'src/site/landing/prerender.tsx',
              outDir: tmp,
              emptyOutDir: true,
              target: 'node22',
              minify: false,
              rollupOptions: { output: { entryFileNames: 'prerender.mjs' } },
            },
          });
          const entry = (await import(pathToFileURL(join(tmp, 'prerender.mjs')).href)) as typeof import('./src/site/landing/prerender');
          const { html: markup, settings, bodyEnd } = entry.renderLanding();
          const manifest = JSON.parse(readFileSync(join(outDir, '.vite', 'manifest.json'), 'utf8')) as Manifest;
          const index = readFileSync(join(outDir, 'index.html'), 'utf8');
          writeFileSync(join(outDir, 'landing.html'), landingHtml(index, markup, moduleCss(manifest, 'src/site/mount.tsx'), base, bodyEnd));
          writeFileSync(join(outDir, 'landing.json'), JSON.stringify(settings) + '\n');
        } finally {
          rmSync(tmp, { recursive: true, force: true });
          rmSync(join(outDir, '.vite'), { recursive: true, force: true });
        }
      },
    },
  };
}

// A web build on a separate static host (here: Vercel) must reach the game server directly: proxied API calls would
// all come from the host's addresses (the server's per-IP limits could not tell players apart). Fail the build loudly
// instead of shipping a site whose API calls 404. (The repository's vercel.json builds no web app any more: it only
// redirects the old elymum.io to coinnibal.fun, and the VPS serves the site.)
if (process.env.VERCEL === '1' && !process.env.VITE_SERVER_URL && !process.env.VITE_WS_URL) {
  throw new Error('VITE_SERVER_URL is not set: set it to the game server (e.g. https://game.coinnibal.fun) in the Vercel project settings');
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
  plugins: [react(), publicUrlFiles(), sitePreloads(), prerenderLanding(), precompress()],
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
    // read by `prerender-landing` (the landing's CSS chunks), then removed from dist
    manifest: true,
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
