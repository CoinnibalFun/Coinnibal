/**
 * The keys a client's address is counted under. One provider customer usually holds a whole IPv6 /64 (often a /56 or
 * a /48), so a limit keyed on the exact IPv6 address does not hold: an attacker takes a new address for every
 * request. IPv4 addresses (and IPv4-mapped IPv6 ones) stay exact: neighbours behind a carrier NAT are not lumped into
 * their /24 for a rate limit.
 */

const V4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i;

/** The eight groups of an IPv6 address (or of a `…::/NN` network key), lower case, without leading zeros. */
function v6Groups(ip: string): string[] {
  const [head, tail = ''] = ip.toLowerCase().replace(/\/\d+$/, '').split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.map((g) => g.replace(/^0+(?=.)/, ''));
}

/**
 * The network an address belongs to for the per-subnet connection limit: IPv4 /24, IPv6 /64 (an IPv4-mapped
 * IPv6 address counts as IPv4).
 */
export function subnetOf(ip: string): string {
  const v4 = V4.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (!ip.includes(':')) return ip;
  return `${v6Groups(ip).slice(0, 4).join(':')}::/64`;
}

/** The key of a per-client rate limit: an IPv4 address as it is, an IPv6 address as its /64. */
export function rateKey(ip: string): string {
  const v4 = V4.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.${v4[4]}`;
  return ip.includes(':') ? subnetOf(ip) : ip;
}

/** The IPv6 /48 of an address (or of its /64 key): at most one customer's site. Null for IPv4. */
export function wideNetOf(ip: string): string | null {
  if (V4.test(ip) || !ip.includes(':')) return null;
  return `${v6Groups(ip).slice(0, 3).join(':')}::/48`;
}
