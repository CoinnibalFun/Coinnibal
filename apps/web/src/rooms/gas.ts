/** Gas-token amounts (wei) as text: the room fee in the creator sheet and the admin card. */

/** A gas-token amount with as few decimals as it needs (0.05, 0.025). */
export function gasDecimals(wei: bigint): number {
  for (let d = 2; d <= 6; d++) if (wei % 10n ** BigInt(18 - d) === 0n) return d;
  return 6;
}

export function gasText(wei: bigint): string {
  const d = gasDecimals(wei);
  const s = (wei / 10n ** BigInt(18 - d)).toString().padStart(d + 1, '0');
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
}
