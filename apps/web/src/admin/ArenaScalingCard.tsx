import { ARENA_SCALING_LIMITS, type ArenaScalingSettings, type ArenaScalingView } from '@coinnibal/shared';
import { useCallback, useEffect, useState } from 'react';
import { SiteApiError } from '../site/api';
import { SwitchRow } from './GameTab';
import { Btn, Card, FormError, saveErrorText, type ChainCtx } from './ui';

type NumField = keyof typeof ARENA_SCALING_LIMITS;

/** The admin fields, in the order of the rules: the instance range, scale up, scale down, the cooldown. */
const FIELDS: { f: NumField; label: string }[] = [
  { f: 'minInstances', label: 'Min instances per arena' },
  { f: 'maxInstances', label: 'Max instances per arena' },
  { f: 'fullHits', label: 'Up: times an instance filled up' },
  { f: 'windowMin', label: 'Up: within minutes' },
  { f: 'highPct', label: 'Up: or stays full % (busy line)' },
  { f: 'sustainMin', label: 'Up: for minutes' },
  { f: 'lowPct', label: 'Down: peak fill under %' },
  { f: 'lowMin', label: 'Down: for minutes' },
  { f: 'cooldownMin', label: 'Minutes between actions' },
];

/** The settings that changed (a partial PUT). */
export function scalingPatch(saved: ArenaScalingSettings, draft: ArenaScalingSettings): Partial<ArenaScalingSettings> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(saved) as (keyof ArenaScalingSettings)[]) if (draft[k] !== saved[k]) out[k] = draft[k];
  return out as Partial<ArenaScalingSettings>;
}

const ACTION_LABEL: Record<ArenaScalingView['log'][number]['action'], string> = {
  open: 'Opened',
  overflow: 'Overflow',
  drain: 'Draining',
  undrain: 'Taken back',
  close: 'Closed',
};

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/**
 * Game → arena instances: the auto-scaler of the official arenas (each ticket tier). Its settings, every arena's
 * instances (people, draining, the worker each runs on) and its last decisions. Nobody is ever evicted: a draining
 * instance takes no new seat and closes once its bell settled every ticket in it.
 */
export function ArenaScalingCard({ ctx }: { ctx: ChainCtx }) {
  const [view, setView] = useState<ArenaScalingView | null>(null);
  const [draft, setDraft] = useState<ArenaScalingSettings | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!ctx.api) return;
    ctx.api.arenaScaling().then(
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
  // instances and decisions refresh while the tab is open (the draft stays)
  useEffect(() => {
    if (!ctx.api || state !== 'ok') return;
    const id = window.setInterval(() => ctx.api!.arenaScaling().then((v) => setView((cur) => (cur ? { ...v, settings: cur.settings } : v)), () => {}), 10_000);
    return () => clearInterval(id);
  }, [ctx.api, state]);

  const title = 'Arena instances';
  if (!ctx.api) return <Card title={title} id="arena-scaling" tone="quiet" lede="Sign in as the admin (top right) to see the arena instances and their scaling." />;
  if (state === 'missing') return <Card title={title} id="arena-scaling" tone="quiet" lede="This server has no arena scaling yet (/api/admin/arena-scaling). Update the game server." />;
  if (!view || !draft) return <Card title={title} id="arena-scaling" tone="quiet" lede={state === 'error' ? `Cannot load the arena scaling: ${err}` : 'Loading the arena instances…'} />;

  const patch = scalingPatch(view.settings, draft);
  const dirty = Object.keys(patch).length > 0;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const v = await ctx.api!.saveArenaScaling(patch);
      setView(v);
      setDraft({ ...v.settings });
      setMsg('Scaling saved: the next decision uses it.');
    } catch (e) {
      setErr(saveErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const instances = view.arenas.reduce((n, a) => n + a.instances.length, 0);
  const people = view.arenas.reduce((n, a) => n + a.instances.reduce((m, i) => m + i.people, 0), 0);
  return (
    <Card
      title={title}
      id="arena-scaling"
      kicker={`${instances} instances · ${people} people`}
      lede="Each arena opens another instance when its instances keep filling up, and closes one when they stay mostly empty. Seats go to the fullest open instance first. A closing instance takes no new seat and closes after its bell, once every ticket in it is settled: nobody is evicted."
    >
      <SwitchRow
        label="Scale ahead of demand"
        options={[
          { id: 'on', label: 'On' },
          { id: 'off', label: 'Off (overflow only)' },
        ]}
        value={draft.enabled ? 'on' : 'off'}
        onPick={(v) => setDraft({ ...draft, enabled: v === 'on' })}
        testId="scaling-enabled"
      />
      <div className="ad-form2 ad-form3">
        {FIELDS.map(({ f, label }) => {
          const [lo, hi] = ARENA_SCALING_LIMITS[f];
          return (
            <label className="ad-field" key={f}>
              <span className="ad-field__label mono">{label}</span>
              <input
                className="ad-input ad-input--num num"
                type="number"
                min={lo}
                max={hi}
                value={draft[f]}
                aria-label={label}
                onChange={(e) => setDraft({ ...draft, [f]: Math.max(lo, Math.min(hi, Math.floor(Number(e.target.value) || 0))) })}
              />
            </label>
          );
        })}
      </div>
      <div className="ad-tablewrap">
        <table className="ad-table" data-testid="scaling-table">
          <thead>
            <tr>
              <th scope="col">Arena</th>
              <th scope="col" className="is-num">
                Fill
              </th>
              <th scope="col">Instances (people / seats)</th>
            </tr>
          </thead>
          <tbody>
            {view.arenas.length === 0 && (
              <tr>
                <td colSpan={3} className="ad-dim">
                  No arena is open on this server.
                </td>
              </tr>
            )}
            {view.arenas.map((a) => (
              <tr key={a.arenaId} data-arena={a.arenaId}>
                <td>
                  <strong>{a.name}</strong>
                  <span className="ad-dim mono"> #{a.arenaId}</span>
                </td>
                <td className="num is-num">{a.fillPct} %</td>
                <td>
                  <span className="ad-chips">
                    {a.instances.map((i) => (
                      <span key={i.id} className={`ad-inst mono${i.draining ? ' is-draining' : ''}`} title={i.draining ? 'Draining: no new seats, closes after its bell' : undefined}>
                        #{i.instance} {i.people}/{i.capacity}
                        {i.draining ? ' draining' : ''}
                        {i.thread ? ` · ${i.thread}` : ''}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="ad-rooms" open={view.log.length > 0 && view.log.length <= 5}>
        <summary className="mono">Decisions ({view.log.length})</summary>
        <ul className="ad-rooms__list" data-testid="scaling-log">
          {view.log.map((d) => (
            <li key={`${d.at}-${d.room}-${d.action}`}>
              <span>
                <strong>{ACTION_LABEL[d.action]}</strong> {d.room}: {d.reason}
              </span>
              <span className="num ad-dim">
                {d.people} people · {d.instances} taking seats · {clock(d.at)}
              </span>
            </li>
          ))}
        </ul>
      </details>
      <div className="ad-actions">
        <Btn sun disabled={!dirty || busy} onClick={() => void save()} testId="scaling-save">
          {busy ? 'Saving…' : 'Save scaling'}
        </Btn>
        {dirty && <Btn onClick={() => setDraft({ ...view.settings })}>Undo</Btn>}
        {msg && !dirty && <span className="ad-note">{msg}</span>}
      </div>
      <FormError error={err} />
    </Card>
  );
}
