import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Kb } from '../src/design';
import { arenaTarget } from '../src/rooms/invite';
import { requestTicket, useUi } from '../src/store';
import type { TicketModel } from '../src/wallet/ticket';
import { TicketList } from '../src/ui/lobby/TicketList';

const M = 10n ** 18n;
const practice: TicketModel = { key: 'practice', arenaId: null, entryFee: 0n, humans: 0, bots: 0, loot: 0, open: true };
const official: TicketModel = { key: 'arena:1', arenaId: 1, entryFee: 1000n * M, humans: 3, bots: 0, loot: 0, open: true };
const test: TicketModel = { ...official, key: 'test:1', humans: 1, bots: 10, test: true };

afterEach(() => useUi.setState({ testSeat: null, paidSeat: null, lobbyIntent: null }));

describe('lobby: the testnet test arenas', () => {
  it('lists the test arena after the official arenas, with a TEST badge, its note and its bots', () => {
    render(
      <Kb>
        <TicketList
          tickets={[practice, official, test]}
          gates={{ practice: { kind: 'practice' }, 'arena:1': { kind: 'buy' }, 'test:1': { kind: 'buy' } }}
          openTickets={[]}
          value="arena:1"
          onChange={() => {}}
          onActivate={() => {}}
        />
      </Kb>,
    );
    const rows = [...document.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute('data-kb-value'));
    expect(rows).toEqual(['arena:1', 'test:1', 'practice']);
    expect(screen.getAllByTestId('test-badge')).toHaveLength(1);
    expect(screen.getByText('TEST')).toBeTruthy();
    expect(screen.getByText('testnet test room with bots; same tickets and payouts')).toBeTruthy();
    expect(screen.getByText('Test rooms · testnet')).toBeTruthy();
    expect(document.querySelector('[data-test-arena="1"]')?.textContent).toMatch(/Test · /);
    expect(document.querySelector('[data-test-arena="1"]')?.textContent).toMatch(/10 bots/);
  });

  it('a ticket picked in the test arena joins arena:<id>:test; an official one the arena; "New ticket" stays where it played', () => {
    expect(arenaTarget(1)).toBe('arena:1');
    useUi.setState({ testSeat: 1 });
    expect(arenaTarget(1)).toBe('arena:1:test');
    expect(arenaTarget(2)).toBe('arena:2');
    requestTicket(1);
    expect(useUi.getState().lobbyIntent?.ticket).toBe('test:1');
    useUi.setState({ testSeat: null });
    requestTicket(1);
    expect(useUi.getState().lobbyIntent?.ticket).toBe('arena:1');
  });
});
