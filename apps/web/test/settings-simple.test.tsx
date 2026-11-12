import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Kb } from '../src/design';
import { useUi } from '../src/store';
import { SettingsSheet } from '../src/ui/game/SettingsSheet';
import { ProfilePage } from '../src/ui/profile/ProfilePage';

const ui0 = useUi.getState();
afterEach(() => {
  act(() => useUi.setState(ui0, true));
});

describe('the settings sheet: simple is the best', () => {
  it('shows plain labels and controls: no kicker, no section labels, no helper lines, no "How to play" link', () => {
    act(() => useUi.setState({ modal: 'settings' }));
    render(
      <Kb>
        <SettingsSheet />
      </Kb>,
    );
    const sheet = document.querySelector('.g-settings')!;
    expect(sheet).not.toBeNull();
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(sheet.querySelector('.kb-sheet__kicker')).toBeNull();
    expect(sheet.querySelector('.gs-h, .gs-note, .gs-track__note, .kb-field__note')).toBeNull();
    expect(screen.queryByText('How to play')).toBeNull();
    // the controls are all still there, the country picker first
    expect(screen.getByTestId('country-pick')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Wear the flag on my coin' })).toBeTruthy();
    expect(screen.getByTestId('lang-pick')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Chat' })).toBeTruthy();
    expect(screen.getByRole('radiogroup')).toBeTruthy();
  });
});

describe('the profile page', () => {
  it('has no settings section, and "Link X" sits right under the member card, before the name and coin', () => {
    render(
      <Kb>
        <ProfilePage />
      </Kb>,
    );
    expect(document.getElementById('pf-settings-h')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Chat' })).toBeNull();
    const card = document.querySelector('.pf-card')!;
    const x = screen.getByTestId('link-x');
    const name = document.getElementById('pf-name-h')!;
    expect(card.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(x.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.nextElementSibling).toBe(x);
  });
});
