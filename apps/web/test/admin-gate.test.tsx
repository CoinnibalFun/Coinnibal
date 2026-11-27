import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { resolveNetwork } from '../src/admin/net';
import { AdminHome } from '../src/admin/site/AdminHome';

describe('/admin before an admin session', () => {
  it('shows the sign-in alone: no drawers, no status, nothing of the workshop', () => {
    localStorage.clear();
    render(<AdminHome net={resolveNetwork(null)} reloadNet={async () => {}} />);
    expect(screen.getByTestId('admin-gate')).toBeTruthy();
    expect(screen.getByTestId('start-signin')).toBeTruthy();
    const text = document.body.textContent ?? '';
    for (const word of ['Advanced', 'Appetizers', 'Workshop', 'Drawer', 'Mint', 'Integrity', 'Settings']) expect(text).not.toContain(word);
  });
});
