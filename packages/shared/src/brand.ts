/**
 * The brand: Coinnibal (a coin + a cannibal: coins that eat coins), its token $NIBAL. Everything a player reads uses
 * these names, and so do the code, the packages (`@coinnibal/*`), the contracts, the storage keys and the env vars. The
 * project was called Elymum until November 2026; the few names kept from then (the live server's installed names, the
 * fallbacks that still read an old name) say why where they are.
 *
 * The domain and the X handle are configuration, not code: the site's origin is `PUBLIC_URL` (server) and
 * `VITE_PUBLIC_URL` (web build), the X handle is the admin setting (Admin, Settings) with `X_HANDLE` /
 * `VITE_X_HANDLE` as the default. The defaults below are the live ones (coinnibal.fun, @coinnibalfun; see
 * docs/OPERATIONS.md, "The name: Coinnibal (formerly Elymum)").
 */

/** The Coinnibal NFT collection's size (the team's decision; the contract's `maxSupply` is set to it at deploy). */
export const NFT_SUPPLY = 3333;

/** The product name. */
export const BRAND_NAME = 'Coinnibal';

/** The one short brand line (simple English, a little playful). */
export const BRAND_TAGLINE = 'Eat or be eaten.';

/** The site's host when nothing is configured (the live domain). */
export const SITE_HOST_DEFAULT = 'coinnibal.fun';

/** `https://<SITE_HOST_DEFAULT>`. */
export const SITE_URL_DEFAULT = `https://${SITE_HOST_DEFAULT}`;

/**
 * The brand's own site origins: coinnibal.fun (the site) and elymum.io, the domain of before the rename: the live
 * config still answers there (it redirects every path to coinnibal.fun, vercel.json), and the NFT's on-chain base URI
 * and links already posted on X point at it, so it stays on this list. A server whose `CORS_ORIGIN` is a list always
 * accepts these too, and a sign-in from one of them names that site, so both work whatever the server's `.env` says.
 */
export const BRAND_SITE_ORIGINS: readonly string[] = ['https://coinnibal.fun', 'https://www.coinnibal.fun', 'https://elymum.io'];

/** A `CORS_ORIGIN` value with the brand's site origins added (`*` and an unset value stay as they are). */
export function withBrandOrigins(corsOrigin: string | undefined): string {
  if (corsOrigin === undefined || corsOrigin.trim() === '' || corsOrigin.trim() === '*') return corsOrigin?.trim() || '*';
  const list = corsOrigin.split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
  for (const o of BRAND_SITE_ORIGINS) if (!list.includes(o)) list.push(o);
  return list.join(',');
}

/**
 * The NFT collection's name in the server's contract metadata (`contractURI`, what marketplaces show). The on-chain
 * `name()` / `symbol()` are set by the contract's constructor ("Coinnibal" / "NIBAL" for new deployments; a deployed
 * collection keeps the ones it was deployed with).
 */
export const NFT_NAME = BRAND_NAME;

/**
 * The host of a site URL (`https://coinnibal.fun/` → `coinnibal.fun`), else `fallback` (an unset, empty or bad value).
 */
export function siteHostOf(url: string | null | undefined, fallback: string = SITE_HOST_DEFAULT): string {
  if (!url) return fallback;
  try {
    return new URL(url).host || fallback;
  } catch {
    return fallback;
  }
}
