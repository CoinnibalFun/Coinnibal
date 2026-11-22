import { hash32 } from '@coinnibal/art';

/** The handle's coin and the hash behind it live in `@coinnibal/art` (the server draws the same coin on its cards). */
export { hash32, lookForHandle, seeded } from '@coinnibal/art';

/** The ticket number printed on a handle's card (0001-9999). */
export function ticketNumber(handle: string): number {
  return (hash32(`ticket:${handle.toLowerCase()}`) % 9999) + 1;
}

export const ticketNo = (handle: string): string => String(ticketNumber(handle)).padStart(4, '0');
