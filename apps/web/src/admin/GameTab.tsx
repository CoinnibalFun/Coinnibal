import { setPausedCall, updateArenaFrom } from "@elymum/sdk";
import { arenaName } from "@elymum/sdk/ops";
import {
  GAME_ACCESS_MODES,
  MAP_SCALE_LIMITS,
  mapSideFor,
  type GameAccess,
  type MapScaleSettings,
} from "@elymum/shared";
import { useCallback, useEffect, useState } from "react";
import { SiteApiError, type MapAdminView, type MapSettingsPatch } from "../site/api";
import { ArenaTab } from "./ArenaTab";
import { CustomRoomsCard } from "./CustomRoomsCard";
import { LeaderboardCard } from "./LeaderboardCard";
import { ShopCard } from "./ShopCard";
import { GAME_ACCESS_LABEL } from "./site/SettingsTab";
import {
  Btn,
  Card,
  FormError,
  NeedsSession,
  saveErrorText,
  type ChainCtx,
} from "./ui";

/** One row of segments: the live one is marked, a click asks to switch. */
export function SwitchRow<T extends string>({
  label,
  options,
  value,
  busy,
  onPick,
  testId,
}: {
  label: string;
  options: readonly { id: T; label: string; note?: string }[];
  value: T | null;
  busy?: boolean;
  onPick: (v: T) => void;
  testId?: string;
}) {
  return (
    <div
      className="ad-switchrow"
      role="group"
      aria-label={label}
      data-testid={testId}
    >
      <span className="ad-switchrow__label mono">{label}</span>
      <div className="ad-switchrow__segs">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`ad-seg${value === o.id ? " is-on" : ""}`}
            aria-pressed={value === o.id}
            disabled={busy || value === o.id}
            title={o.note}
            onClick={() => onPick(o.id)}
            data-value={o.id}
          >
            {value === o.id && (
              <span className="ad-seg__dot" aria-hidden="true" />
            )}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const ACCESS_OPTS = GAME_ACCESS_MODES.map((m) => ({
  id: m,
  label: m === "admins" ? "Admins" : m === "holders" ? "Holders" : m === "maintenance" ? "Maintenance" : "Public",
  note: GAME_ACCESS_LABEL[m].note,
}));

/** Game → start / stop: who may play (one switch row, saved on the server) and the arena's pause. */
function StartStopCard({ ctx }: { ctx: ChainCtx }) {
  const [access, setAccess] = useState<GameAccess | null>(null);
  const [env, setEnv] = useState<GameAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!ctx.api) return;
    let live = true;
    ctx.api.settings().then(
      (r) => {
        if (!live) return;
        setAccess(r.settings.gameAccess);
        setEnv(r.gameAccessEnv ?? null);
      },
      (e: Error) => live && setErr(e.message),
    );
    return () => {
      live = false;
    };
  }, [ctx.api]);
  const cfg = ctx.status?.arena?.config ?? null;
  const arena = ctx.net.arenaAddress;
  const pick = async (m: GameAccess) => {
    if (!ctx.api) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await ctx.api.saveSettings({ gameAccess: m });
      setAccess(r.settings.gameAccess);
      setEnv(r.gameAccessEnv ?? null);
      ctx.settingsChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Start / stop"
      id="game-switches"
      lede="Who may play is a server setting (instant, no transaction). The pause is on chain: it blocks new tickets only; settlements and refunds keep working."
    >
      <SwitchRow
        label="Who may play"
        options={ACCESS_OPTS}
        value={env ?? access}
        busy={busy || !ctx.api || !!env}
        onPick={(m) => void pick(m)}
        testId="game-access"
      />
      {env && (
        <p className="ad-note">
          GAME_ACCESS={env} is set on the server: it wins over this switch.
        </p>
      )}
      {arena && cfg && (
        <SwitchRow
          label="Arena tickets"
          options={[
            { id: "open", label: "Taking joins" },
            { id: "paused", label: "Paused" },
          ]}
          value={cfg.paused ? "paused" : "open"}
          onPick={(v) =>
            ctx.open({
              title:
                v === "paused"
                  ? "Pause the arena (no new tickets)"
                  : "Unpause the arena",
              contract: "ElymumArena",
              call: setPausedCall(arena, v === "paused"),
              ownerOf: arena,
              owner: cfg.admin,
              note:
                v === "paused"
                  ? "Pause blocks joins only; settlements and refunds keep working."
                  : undefined,
              onDone: () => ctx.refresh(),
            })
          }
          testId="arena-pause"
        />
      )}
      {arena && cfg && (ctx.status?.arena?.arenas.length ?? 0) > 0 && (
        <div
          className="ad-arenachips"
          role="group"
          aria-label="Arenas open for tickets"
        >
          <span className="ad-switchrow__label mono">Per arena</span>
          {ctx.status!.arena!.arenas.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`ad-seg ad-seg--chip${x.enabled ? " is-on" : ""}`}
              aria-pressed={x.enabled}
              data-testid={`arena-enable-${x.id}`}
              onClick={() =>
                ctx.open({
                  title: `${x.enabled ? "Close" : "Open"} arena #${x.id} ${arenaName(x.id)}`,
                  contract: "ElymumArena",
                  call: updateArenaFrom(arena, x, { enabled: !x.enabled }),
                  ownerOf: arena,
                  owner: cfg.admin,
                  onDone: () => ctx.refresh(),
                })
              }
            >
              {x.enabled && <span className="ad-seg__dot" aria-hidden="true" />}
              #{x.id} {arenaName(x.id)}
            </button>
          ))}
        </div>
      )}
      <NeedsSession api={ctx.api} />
      <FormError error={err} />
      <div className="ad-actions">
        <a className="kb-btn kb-btn--secondary kb-btn--sm" href="/play">
          <span className="kb-btn__label">
            <span className="kb-btn__text">Open the arena as admin</span>
          </span>
        </a>
      </div>
    </Card>
  );
}

const KIND_LABEL: Record<string, string> = {
  practiceRookie: "Practice · rookie",
  practicePro: "Practice · pro",
  arena: "Arenas",
  private: "Private rooms",
};
const kindLabel = (k: string) => KIND_LABEL[k] ?? k;

/** The map fields of each room kind that changed (for a partial PUT). */
export function mapsPatch(saved: MapAdminView["settings"], draft: MapAdminView["settings"]): MapSettingsPatch {
  const out: MapSettingsPatch = {};
  for (const [kind, d] of Object.entries(draft)) {
    const s = saved[kind];
    if (!s) continue;
    const p: Partial<MapScaleSettings> = {};
    for (const f of ["auto", "perPlayer", "min", "max"] as const)
      if (d[f] !== s[f]) (p as Record<string, unknown>)[f] = d[f];
    if (Object.keys(p).length) out[kind] = p;
  }
  return out;
}

/** The players the map table previews the curve for. */
const MAP_PREVIEW = [5, 10, 25, 50, 100] as const;

/** Game → map size: per room kind, auto on/off and the curve (side = per player x sqrt(players), within min..max). */
function MapScaleTable({
  draft,
  view,
  setMap,
}: {
  draft: Record<string, MapScaleSettings>;
  view: MapAdminView;
  setMap: (kind: string, p: Partial<MapScaleSettings>) => void;
}) {
  const L = MAP_SCALE_LIMITS;
  return (
    <>
      <p className="ad-note">
        Map size: with Auto on, each room&apos;s map is sized for the players it
        expects (its people, plus the practice bots of a free custom room): side = per player x
        &radic;players, kept within min..max. At a round start the map takes its
        new size; during play it only grows, a step every few seconds. Custom
        rooms set to Auto follow the private rooms&apos; curve.
      </p>
      <div className="ad-tablewrap">
        <table className="ad-table ad-bots" data-testid="maps-table">
          <thead>
            <tr>
              <th scope="col">Rooms</th>
              <th scope="col">Auto</th>
              <th
                scope="col"
                className="is-num"
                title={`Side of the square each player gets (${L.perPlayerMin}..${L.perPlayerMax})`}
              >
                Per player
              </th>
              <th scope="col" className="is-num">
                Min side
              </th>
              <th scope="col" className="is-num">
                Max side
              </th>
              <th
                scope="col"
                className="is-num"
                title={`Map side for ${MAP_PREVIEW.join(" / ")} players`}
              >
                {MAP_PREVIEW.join(" / ")} players
              </th>
              <th scope="col" className="is-num">
                Live
              </th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(draft).map(([kind, m]) => {
              const live = view.rooms.filter((r) => r.kind === kind).map((r) => r.mapSide);
              return (
                <tr key={kind} data-kind={kind}>
                  <td>
                    <strong>{kindLabel(kind)}</strong>
                  </td>
                  <td>
                    <label className="ad-switch ad-switch--inline">
                      <input
                        type="checkbox"
                        role="switch"
                        checked={m.auto}
                        onChange={() => setMap(kind, { auto: !m.auto })}
                        aria-label={`${kindLabel(kind)} map auto size`}
                      />
                    </label>
                  </td>
                  <td className="is-num">
                    <NumCell
                      value={m.perPlayer}
                      max={L.perPlayerMax}
                      label={`${kind} map per player`}
                      onChange={(n) => setMap(kind, { perPlayer: n })}
                    />
                  </td>
                  <td className="is-num">
                    <NumCell
                      value={m.min}
                      max={L.sideMax}
                      label={`${kind} map min`}
                      onChange={(n) => setMap(kind, { min: n })}
                    />
                  </td>
                  <td className="is-num">
                    <NumCell
                      value={m.max}
                      max={L.sideMax}
                      label={`${kind} map max`}
                      onChange={(n) => setMap(kind, { max: n })}
                    />
                  </td>
                  <td className="num is-num mono">
                    {m.auto
                      ? MAP_PREVIEW.map((n) => mapSideFor(n, m)).join(" / ")
                      : "preset"}
                  </td>
                  <td className="num is-num">
                    {live.length ? live.join(", ") : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NumCell({
  value,
  onChange,
  label,
  max,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  max: number;
}) {
  return (
    <input
      className="ad-input ad-input--num num"
      type="number"
      min={0}
      max={max}
      value={value}
      aria-label={label}
      onChange={(e) =>
        onChange(
          Math.max(0, Math.min(max, Math.floor(Number(e.target.value) || 0))),
        )
      }
    />
  );
}

/**
 * Game → maps: the adaptive map size per room kind and every room's live numbers. Arenas and practice ponds have
 * people only; practice bots exist only in free custom rooms (their creator turns them on).
 */
export function MapsCard({ ctx }: { ctx: ChainCtx }) {
  const [view, setView] = useState<MapAdminView | null>(null);
  const [draft, setDraft] = useState<MapAdminView["settings"] | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!ctx.api) return;
    ctx.api.maps().then(
      (v) => {
        setView(v);
        setDraft(structuredClone(v.settings));
        setState("ok");
      },
      (e) => {
        if (e instanceof SiteApiError && e.status === 404) setState("missing");
        else {
          setState("error");
          setErr((e as Error).message);
        }
      },
    );
  }, [ctx.api]);
  useEffect(load, [load]);
  // live counts refresh while the tab is open
  useEffect(() => {
    if (!ctx.api || state !== "ok") return;
    const id = window.setInterval(
      () => ctx.api!.maps().then((v) => setView((cur) => (cur ? { ...cur, rooms: v.rooms } : v)), () => {}),
      15_000,
    );
    return () => clearInterval(id);
  }, [ctx.api, state]);

  if (!ctx.api) return <Card title="Maps" id="maps" tone="quiet" lede="Sign in as the admin (top right) to see and change the map sizes." />;
  if (state === "missing")
    return <Card title="Maps" id="maps" tone="quiet" lede="This server has no map settings route yet (/api/admin/maps). Update the game server." />;
  if (!view || !draft)
    return <Card title="Maps" id="maps" tone="quiet" lede={state === "error" ? `Cannot load the map settings: ${err}` : "Loading the map settings…"} />;

  const patch = mapsPatch(view.settings, draft);
  const dirty = Object.keys(patch).length > 0;
  const setMap = (kind: string, p: Partial<MapScaleSettings>) => setDraft({ ...draft, [kind]: { ...draft[kind], ...p } });
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const v = await ctx.api!.saveMaps(patch);
      setView(v);
      setDraft(structuredClone(v.settings));
      setMsg("Map sizes saved: every room follows at once.");
    } catch (e) {
      setErr(saveErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const people = view.rooms.reduce((n, r) => n + r.humans, 0);
  const bots = view.rooms.reduce((n, r) => n + r.bots, 0);

  return (
    <Card
      title="Maps"
      id="maps"
      kicker={`${people} people · ${view.rooms.length} rooms${bots ? ` · ${bots} practice bots` : ""}`}
      lede="Arenas and practice ponds are played by people only. Practice bots exist only in free custom rooms, where the creator turns them on (count and difficulty); they are tagged BOT and carry no value."
    >
      <MapScaleTable draft={draft} view={view} setMap={setMap} />
      {view.rooms.length > 0 && (
        <details className="ad-rooms">
          <summary className="mono">Live rooms ({view.rooms.length})</summary>
          <ul className="ad-rooms__list">
            {view.rooms.map((r) => (
              <li key={r.id}>
                <span>{r.name}</span>
                <span className="num ad-dim">
                  {r.humans} people{r.bots ? ` · ${r.bots} practice bots` : ""} · map {r.mapSide}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="ad-actions">
        <Btn sun disabled={!dirty || busy} onClick={() => void save()} testId="maps-save">
          {busy ? "Saving…" : "Save map sizes"}
        </Btn>
        {dirty && <Btn onClick={() => setDraft(structuredClone(view.settings))}>Undo</Btn>}
        {msg && !dirty && <span className="ad-note">{msg}</span>}
      </div>
      <FormError error={err} />
    </Card>
  );
}

/**
 * `/admin → Game`: the owner's decisions first (who may play, the pause, each arena open or
 * closed, the map sizes), then the arena contract's status; its manual controls sit under Advanced.
 */
export function GameTab({ ctx }: { ctx: ChainCtx }) {
  return (
    <div className="ad-game">
      <StartStopCard ctx={ctx} />
      <MapsCard ctx={ctx} />
      <CustomRoomsCard ctx={ctx} />
      <ShopCard ctx={ctx} />
      <LeaderboardCard ctx={ctx} />
      <h2 className="ad-h3 ad-section-h">The arena contract</h2>
      <ArenaTab ctx={ctx} />
    </div>
  );
}
