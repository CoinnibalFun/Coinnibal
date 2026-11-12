/**
 * The brand: Coinnibal (a coin + a cannibal: coins that eat coins), its token $NIBAL. Everything a player reads uses
 * these names; the code, the packages (`@elymum/*`), the contracts, the storage keys and the env vars keep the old
 * internal name "elymum" on purpose (renaming them would break deploys and saved data).
 *
 * The domain and the X handle are configuration, not code: the site's origin is `PUBLIC_URL` (server) and
 * `VITE_PUBLIC_URL` (web build), the X handle is the admin setting (Admin, Settings) with `X_HANDLE` /
 * `VITE_X_HANDLE` as the default. The defaults below are the live ones until coinnibal.io and @coinnibal are
 * live (docs/OPERATIONS.md, "Moving to coinnibal.io").
 */

/** The product name. */
export const BRAND_NAME = 'Coinnibal';

/** The one short brand line (simple English, a little playful). */
export const BRAND_TAGLINE = 'Eat or be eaten.';

/** The site's host when nothing is configured (the live domain until coinnibal.io is). */
export const SITE_HOST_DEFAULT = 'elymum.io';

/** `https://<SITE_HOST_DEFAULT>`. */
export const SITE_URL_DEFAULT = `https://${SITE_HOST_DEFAULT}`;

/**
 * The NFT collection's name in the server's contract metadata (`contractURI`, what marketplaces show). The on-chain
 * `name()` / `symbol()` are set by the contract's constructor ("Coinnibal" / "NIBAL" for new deployments; a deployed
 * collection keeps the ones it was deployed with).
 */
export const NFT_NAME = BRAND_NAME;

/**
 * The host of a site URL (`https://coinnibal.io/` → `coinnibal.io`), else `fallback` (an unset, empty or bad value).
 */
export function siteHostOf(url: string | null | undefined, fallback: string = SITE_HOST_DEFAULT): string {
  if (!url) return fallback;
  try {
    return new URL(url).host || fallback;
  } catch {
    return fallback;
  }
}
