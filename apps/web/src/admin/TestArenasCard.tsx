import { CUSTOM_DIFFICULTIES, type CustomDifficulty, type TestArenaSettings, type TestArenaView } from '@coinnibal/shared';
import { useCallback, useEffect, useState } from 'react';
import { SiteApiError } from '../site/api';
import { SwitchRow } from './GameTab';
import { Btn, Card, FormError, saveErrorText, type ChainCtx } from './ui';

/** The settings that changed (a partial PUT). */
export function testArenaPatch(saved: TestArenaSettings, draft: TestArenaSettings): Partial<TestArenaSettings> {
  const out: Partial<TestArenaSettings> = {};
  if (draft.enabled !== saved.enabled) out.enabled = draft.enabled;
  if (draft.bots !== saved.bots) out.bots = draft.bots;
  if (draft.difficulty !== saved.difficulty) out.difficulty = draft.difficulty;
  return out;
}

const DIFFICULTY_LABEL: Record<CustomDifficulty, string> = { easy: 'Easy', mixed: 'Mixed', hard: 'Hard' };

/**
 * Game → Test arenas (testnet): for every official arena one test arena with practice bots, on the same tickets,
 * rounds and payouts. On/off, the bots of an empty test arena (every person in it takes one bot's place), difficulty
 * and the live test arenas. On the mainnet the card only says that test arenas do not exist there (the server refuses
 * the setting).
 */
export function TestArenasCard({ ctx }: { ctx: ChainCtx }) {
  const [view, setView] = useState<TestArenaView | null>(null);
  const [draft, setDraft] = useState<TestArenaSettings | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!ctx.api) return;
    ctx.api.testArenas().then(
      (v) => {
        setView(v);
        setDraft({ ...v.settings });
        setState('ok');
      },
      (e) => {
        if (e instanceof SiteApiError && e.status === 404) setState('missing');
        else {
          setState('error');
          setErr((e as Error).message);
        }
      },
    );
  }, [ctx.api]);
  useEffect(load, [load]);
  // the live status refreshes while the tab is open (the draft stays)
  useEffect(() => {
    if (!ctx.api || state !== 'ok') return;
    const id = window.setInterval(() => ctx.api!.testArenas().then((v) => setView((cur) => (cur ? { ...v, settings: cur.settings } : v)), () => {}), 10_000);
    return () => clearInterval(id);
  }, [ctx.api, state]);

  const title = 'Test arenas (testnet)';
  const id = 'test-arenas';
  if (!ctx.api) return <Card title={title} id={id} tone="quiet" lede="Sign in as the admin (top right) to see the test arenas." />;
  if (state === 'missing') return <Card title={title} id={id} tone="quiet" lede="This server has no test arenas yet (/api/admin/test-arenas). Update the game server." />;
  if (!view || !draft) return <Card title={title} id={id} tone="quiet" lede={state === 'error' ? `Cannot load the test arenas: ${err}` : 'Loading the test arenas…'} />;
  if (!view.available) {
    return (
      <Card
        title={title}
        id={id}
        tone="quiet"
        kicker={`chain ${view.chainId}`}
        lede="Test arenas exist on a testnet only. This server runs on the mainnet: the setting is refused and no test arena opens."
      />
    );
  }

  const patch = testArenaPatch(view.settings, draft);
  const dirty = Object.keys(patch).length > 0;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const v = await ctx.api!.saveTestArenas(patch);
      setView(v);
      setDraft({ ...v.settings });
      setMsg(v.active ? 'Saved: the test arenas take it now (bots arrive and leave one by one).' : 'Saved: test arenas are off. Each one closes after its bell, once every ticket in it is settled.');
    } catch (e) {
      setErr(saveErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const { botsMin, botsMax } = view.limits;
  const people = view.rooms.reduce((n, r) => n + r.people, 0);
  return (
    <Card
      title={title}
      id={id}
      kicker={view.active ? `${view.rooms.length} open · ${people} people` : 'off'}
      lede="For every official arena, one test arena with practice bots: the same on-chain tickets, rounds, settlement, fee and loot burns, with bots that carry no value (eating one gives mass, never tokens). Every person in a test arena takes one bot's place: a bot leaves when someone is seated and comes back, one at a time, after they are gone. Listed after the official arenas, marked TEST; quick play never goes there; results stay off the leaderboards. Testnet only."
    >
      <SwitchRow
        label="Test arenas with bots"
        options={[
          { id: 'on', label: 'On' },
          { id: 'off', label: 'Off' },
        ]}
        value={draft.enabled ? 'on' : 'off'}
        onPick={(v) => setDraft({ ...draft, enabled: v === 'on' })}
        testId="test-arenas-enabled"
      />
      <div className="ad-form2">
        <label className="ad-field">
          <span className="ad-field__label mono">Bots in an empty test arena</span>
          <input
            className="ad-input ad-input--num num"
            type="number"
            min={botsMin}
            max={botsMax}
            value={draft.bots}
            aria-label="Bots in an empty test arena"
            data-testid="test-arenas-bots"
            aria-describedby="test-arenas-bots-hint"
            onChange={(e) => setDraft({ ...draft, bots: Math.max(botsMin, Math.min(botsMax, Math.floor(Number(e.target.value) || botsMin))) })}
          />
          <span className="ad-field__hint" id="test-arenas-bots-hint">
            With people in it, a test arena plays with this many bots minus the people (down to none).
          </span>
        </label>
      </div>
      <SwitchRow
        label="Bot difficulty"
        options={CUSTOM_DIFFICULTIES.map((d) => ({ id: d, label: DIFFICULTY_LABEL[d] }))}
        value={draft.difficulty}
        onPick={(v) => setDraft({ ...draft, difficulty: v })}
        testId="test-arenas-difficulty"
      />
      <div className="ad-tablewrap">
        <table className="ad-table" data-testid="test-arenas-table">
          <thead>
            <tr>
              <th scope="col">Test arena</th>
              <th scope="col" className="is-num">
                People
              </th>
              <th scope="col" className="is-num">
                Bots playing
              </th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {view.rooms.length === 0 && (
              <tr>
                <td colSpan={4} className="ad-dim">
                  {view.active ? 'No arena is open on this server.' : 'Test arenas are off.'}
                </td>
              </tr>
            )}
            {view.rooms.map((r) => (
              <tr key={r.id} data-room={r.id}>
                <td>
                  <strong>{r.name}</strong>
                  <span className="ad-dim mono"> {r.id}</span>
                </td>
                <td className="num is-num">
                  {r.people}/{r.capacity}
                </td>
                <td className="num is-num">{r.bots}</td>
                <td className="mono">
                  {r.closing ? 'closing after its bell' : 'open'}
                  {r.thread ? ` · ${r.thread}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ad-actions">
        <Btn sun disabled={!dirty || busy} onClick={() => void save()} testId="test-arenas-save">
          {busy ? 'Saving…' : 'Save test arenas'}
        </Btn>
        {dirty && <Btn onClick={() => setDraft({ ...view.settings })}>Undo</Btn>}
        {msg && !dirty && <span className="ad-note">{msg}</span>}
      </div>
      <FormError error={err} />
    </Card>
  );
}
