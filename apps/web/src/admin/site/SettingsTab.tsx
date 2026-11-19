import { GAME_ACCESS_MODES, normalizeXHandle, type GameAccess, type SiteSettings } from '@coinnibal/shared';
import { useEffect, useState } from 'react';
import { Field, InkButton, StampSpinner } from '../../design';
import { errText, useFlash, type TabProps } from './common';

const DOORS = ['mintOpen', 'wlOpen', 'collabOpen'] as const;
type Door = (typeof DOORS)[number];

export const GAME_ACCESS_LABEL: Record<GameAccess, { label: string; note: string }> = {
  admins: { label: 'Admins only', note: 'Only admin wallets can play. Visitors see no Play or Faucet link; /play says the game is not open yet.' },
  holders: { label: 'NFT holders', note: 'Wallets holding a Coinnibal NFT (and admins) can play. Everyone sees the Play and Faucet links.' },
  public: { label: 'Everyone', note: 'The game is open to every visitor. Practice needs no wallet.' },
  maintenance: { label: 'Maintenance', note: 'Only admins can play. The Play link stays; /play says the game is paused and back soon.' },
};

/** Site switches: what visitors can see (the game, the mint page, WL and collab applications) and the X handle. */
export function SettingsTab({ api, onSiteChange }: TabProps) {
  const [saved, setSaved] = useState<SiteSettings | null>(null);
  const [draft, setDraft] = useState<SiteSettings | null>(null);
  const [env, setEnv] = useState<GameAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [handleErr, setHandleErr] = useState<string | null>(null);
  const [flashNode, flash] = useFlash();

  useEffect(() => {
    api.settings().then(
      (r) => {
        setSaved(r.settings);
        setDraft(r.settings);
        setEnv(r.gameAccessEnv ?? null);
      },
      (e) => flash('err', errText(e)),
    );
  }, [api, flash]);

  if (!draft || !saved) return <StampSpinner label="Loading" />;

  const toggle = (k: Door) => setDraft({ ...draft, [k]: !draft[k] });
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const save = async () => {
    const h = normalizeXHandle(draft.xHandle);
    if (!h) {
      setHandleErr('Not an X handle (1 to 15 letters, numbers or underscores).');
      return;
    }
    setBusy(true);
    try {
      const patch: Partial<SiteSettings> = {};
      for (const k of DOORS) if (draft[k] !== saved[k]) patch[k] = draft[k];
      if (draft.gameAccess !== saved.gameAccess) patch.gameAccess = draft.gameAccess;
      if (h !== saved.xHandle) patch.xHandle = h;
      const r = await api.saveSettings(patch);
      setSaved(r.settings);
      setDraft(r.settings);
      setEnv(r.gameAccessEnv ?? null);
      flash('ok', 'Settings saved.');
      onSiteChange?.();
    } catch (e) {
      flash('err', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const switchRow = (k: Door, label: string, note: string) => (
    <label className="ad-check ad-switch" key={k}>
      <input type="checkbox" role="switch" checked={draft[k]} onChange={() => toggle(k)} />
      <span>
        {label}
        <span className="ad-check__sub">{note}</span>
      </span>
    </label>
  );

  return (
    <section className="ad-card" aria-labelledby="ad-set-h">
      <h2 className="ad-card__title" id="ad-set-h">
        Site settings
      </h2>
      <p className="ad-card__lede">Nothing here touches the chain. Changes apply when you save.</p>
      <h3 className="ad-h3">What visitors can see</h3>
      <p className="ad-note">
        A closed part has no link or button anywhere on the site, and its page says “not open yet”. The landing and the guide (/docs) are always open. Signed in as admin, you still
        see every closed page, so you can check it before you open it.
      </p>
      <fieldset className="ad-access" aria-describedby="ad-access-note">
        <legend className="mono ad-cap">Game access</legend>
        <div className="ad-opts">
          {GAME_ACCESS_MODES.map((m) => (
            <label className={`ad-opt${draft.gameAccess === m ? ' is-picked' : ''}${saved.gameAccess === m ? ' is-live' : ''}`} key={m}>
              <input type="radio" name="ad-game-access" value={m} checked={draft.gameAccess === m} onChange={() => setDraft({ ...draft, gameAccess: m })} />
              <span>
                <span className="ad-opt__title">{GAME_ACCESS_LABEL[m].label}</span>
                <span className="ad-opt__note">{GAME_ACCESS_LABEL[m].note}</span>
              </span>
              {saved.gameAccess === m && <span className="ad-phase__live mono">Live</span>}
            </label>
          ))}
        </div>
        <p className="ad-note" id="ad-access-note">
          {env ? `GAME_ACCESS=${env} is set on the server (COINNIBAL_GAME_ACCESS in /opt/elymum/.env on the VPS): it wins over this setting.` : 'The server reads this on every room entry.'}
        </p>
      </fieldset>
      {switchRow('mintOpen', 'Mint page open', 'On: visitors see /mint and the Mint links. Off: /mint says “not open yet”. This does not change the mint phase on the chain (Mint tab).')}
      {switchRow('wlOpen', 'WL applications open', 'On: visitors can apply on /wl. Off: no new entries; someone who applied before can still sign in on /wl to see their status. The WL tab keeps working.')}
      {switchRow('collabOpen', 'Collab applications open', 'On: communities can apply on /collab. Off: /collab says “not open yet”. The Collabs tab keeps working.')}
      <h3 className="ad-h3">X account</h3>
      <Field
        label="X handle"
        prefix="@"
        value={draft.xHandle}
        onChange={(e) => {
          setDraft({ ...draft, xHandle: e.target.value });
          setHandleErr(null);
        }}
        error={handleErr ?? undefined}
        autoComplete="off"
      />
      <div className="ad-actions">
        <InkButton variant="pink" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save settings'}
        </InkButton>
        {dirty && (
          <InkButton variant="paper" size="sm" onClick={() => setDraft(saved)}>
            Undo changes
          </InkButton>
        )}
      </div>
      {flashNode}
    </section>
  );
}
