/** HYPE amounts (wei) as text: the room fee in the creator sheet and the admin card. */

/** HYPE with as few decimals as it needs (0.05, 0.025). */
export function hypeDecimals(wei: bigint): number {
  for (let d = 2; d <= 6; d++) if (wei % 10n ** BigInt(18 - d) === 0n) return d;
  return 6;
}

export function hypeText(wei: bigint): string {
  const d = hypeDecimals(wei);
  const s = (wei / 10n ** BigInt(18 - d)).toString().padStart(d + 1, '0');
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
}
