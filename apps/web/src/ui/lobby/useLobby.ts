import { arenaMeta, testArenaName } from '@coinnibal/shared';
import { useEffect, useMemo, useState } from 'react';
import { openSessionOf, useChainData } from '../../wallet/chain';
import { useAddress } from '../../wallet/store';
import { buildTickets, quickPlayTarget, ticketGate, type OpenSession, type TicketGate, type TicketKey, type TicketModel } from '../../wallet/ticket';
import { useUi } from '../../store';
import { useTokenText as useLightTokenText, type TokenText } from '../tokenText';

export { tokenText, type TokenText } from '../tokenText';

/**
 * The game token's display (ui/tokenText.ts) with the on-chain decimals once the wallet layer has read the config.
 * Until the token is set the symbol shows as "tokens" and amounts use 18 decimals (the contract's default).
 */
export function useTokenText(): TokenText {
  const chainDecimals = useChainData((s) => (s.config?.token ? s.config.decimals : undefined));
  return useLightTokenText(chainDecimals);
}

export const ticketName = (t: Pick<TicketModel, 'arenaId' | 'test'>, practice: string): string =>
  t.arenaId === null ? practice : t.test ? testArenaName(arenaMeta(t.arenaId).name) : arenaMeta(t.arenaId).name;

export interface LobbyModel {
  tickets: TicketModel[];
  gates: Record<string, TicketGate>;
  sessions: Record<number, OpenSession | null>;
  quick: TicketKey;
  walletConnected: boolean;
  verified: boolean;
  owner: string | null;
}

/** Tickets, what each one's button does, and Quick Play's pick. */
export function useLobbyModel(): LobbyModel {
  const owner = useAddress();
  const rooms = useUi((s) => s.rooms);
  const blocked = useUi((s) => s.blockedArenas);
  const chain = useUi((s) => s.chain);
  const auth = useUi((s) => s.auth);
  const lastArena = useUi((s) => s.settings.lastArena);
  const data = useChainData();
  const connected = owner !== null;
  const verified = connected && !!auth && auth.address.toLowerCase() === owner.toLowerCase();
  const [nowS, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => {
    const token = {
      enabled: !!chain?.enabled,
      tokenReady: chain?.tokenReady === true,
      decimals: data.config?.token ? data.config.decimals : (chain?.token?.decimals ?? 18),
    };
    const tickets = buildTickets(rooms, data.arenas, blocked, token, data.holdersOnly);
    const sessions: Record<number, OpenSession | null> = {};
    for (const [id, s] of Object.entries(data.sessions)) sessions[Number(id)] = openSessionOf(s);
    const arenasEnabled = !!chain?.arenasEnabled && data.deployed !== false;
    const gates: Record<string, TicketGate> = {};
    for (const t of tickets) {
      gates[t.key] = ticketGate({
        ticket: t,
        arenasEnabled,
        walletConnected: connected,
        verified,
        balance: data.tokenBalance,
        session: t.arenaId !== null ? (sessions[t.arenaId] ?? null) : null,
        pending: data.pending,
        nowS,
        holder: data.holder,
      });
    }
    const openSessions = Object.entries(sessions)
      .filter(([, s]) => s !== null)
      .map(([id]) => Number(id));
    const quick = quickPlayTarget({
      walletConnected: connected,
      balance: arenasEnabled ? data.tokenBalance : null,
      tickets: tickets.filter((t) => t.arenaId === null || (gates[t.key].kind !== 'offline' && gates[t.key].kind !== 'maintenance' && gates[t.key].kind !== 'soon')),
      lastArena,
      openSessions,
      holder: data.holder,
    });
    return { tickets, gates, sessions, quick, walletConnected: connected, verified, owner };
  }, [rooms, blocked, data, chain, connected, verified, nowS, lastArena, owner]);
}

/** `(max-width: …)` as React state (it lives in the design system now; the lobby keeps importing it from here). */
export { useMedia } from '../../design/useMedia';
