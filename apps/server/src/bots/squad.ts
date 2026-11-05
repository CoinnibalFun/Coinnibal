import { RULES, canEat } from '@elymum/shared';
import type { Player } from '../game/entities';
import type { World } from '../game/world';

/**
 * The bot squad's shared picture of a room: the house's bots play as one team.
 *
 * - **Map-wide tracking.** Every `INTEL_MS` the squad notes where every person is (centre, mass,
 *   heading, split pieces, value). Bots use this the way a team on voice chat would: as slightly
 *   stale reports, never as live sight. Their own eyes still decide every bite and split.
 * - **Operations.** A bot that hunts a person can call for help. The squad assigns roles:
 *   the *pusher* herds the person, a *flanker* cuts off the way out (the trap), a small *feeder*
 *   tips mass into the pusher so its split reaches, and a big bot can *ambush* a person who chases
 *   a small teammate (the lure). Every role lapses unless renewed, so a squad never locks up.
 * - **Context.** The room tells the squad what each person is worth and how long the round has to run;
 *   tactics lean on that together with sizes, distance, walls and thorn bushes (see `BotBrain`).
 *
 * One instance per world (`squadIntel`), shared by every bot of that room. No allocation per bot thought
 * beyond the small op records.
 */

/** Reports are refreshed this often (ms): a team calls out positions, it does not stream them. */
/** The final-minute push lasts the last minute of an arena round (ms before the bell). */
export const FINAL_PUSH_MS = 60_000;
export const INTEL_MS = 1200;
/** An operation role lapses this long after its last renewal (ms). */
export const OP_TTL_MS = 2600;
/** A flanker is recruited only this close to the person (world units). */
export const FLANK_RANGE = 2600;
/** A big teammate answers a lure only this close to the chaser (world units). */
export const AMBUSH_RANGE = 1700;
/** A small teammate feeds a pusher only this close (world units). */
export const FEED_RANGE = 650;
/** People who joined less than this long ago are never the target of an operation (ms). */
export const OP_GRACE_MS = 25_000;
/**
 * Cover: a teammate this small (fresh in the room) gets a big one keeping an eye on it from a
 * distance; the cover ends once it has grown past `WARD_MASS * 1.6`.
 */
export const WARD_MASS = 140;
/** A guard is at least this big, and this many times its ward. */
export const GUARD_MIN_MASS = 260;
export const GUARD_RATIO = 3;
/** A guard is recruited only this close to its ward (world units), for this long (renewed while it lasts). */
export const GUARD_RANGE = 2600;
export const GUARD_TTL_MS = 15_000;

/** What the squad knows of one person (as of `at`). */
export interface Mark {
  pid: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Total mass and the biggest / smallest cell. */
  mass: number;
  big: number;
  small: number;
  cells: number;
  /** Ledger value (arenas; 0 elsewhere). */
  value: number;
  joinedAt: number;
  at: number;
}

/** What the squad knows of one of its own bots. */
export interface Mate {
  pid: number;
  x: number;
  y: number;
  mass: number;
  big: number;
  cells: number;
  skill: number;
}

export type OpRole = 'push' | 'flank' | 'feed' | 'ambush';

export interface Op {
  /** The person the operation is about. */
  target: number;
  pusher: number;
  flanker: number;
  feeder: number;
  /** Ambush: the big bot answering a lure (pusher is then the bait). */
  ambusher: number;
  until: number;
}

export class SquadIntel {
  readonly marks = new Map<number, Mark>();
  readonly mates = new Map<number, Mate>();
  /** Operations by target person. */
  private readonly ops = new Map<number, Op>();
  /** Bot pid → the target of the operation it holds a role in. */
  private readonly roleOf = new Map<number, number>();
  /** Cover: ward (a small bot) → its guard, and guard → ward. */
  private readonly guardOf = new Map<number, { guard: number; until: number }>();
  private readonly wardOf = new Map<number, number>();
  private refreshedAt = -Infinity;
  /** What a person is worth (the room plugs in its ledger; 0 by default). */
  valueOf: (pid: number) => number = () => 0;
  /** The room's entry fee (arenas): values are weighed against it. 0 elsewhere. */
  entryFee = 0;
  /** Milliseconds until the round's bell (Infinity in rooms without rounds). */
  roundLeftMs = Infinity;
  /** Operations are allowed in this room (off in the rookie league). */
  teamplay = true;
  /** The final-minute push (arenas, admin `finalPush`): the last minute is a hunt on people. */
  finalPush = false;

  /** The squad is in its final-minute push now. */
  pushing(): boolean {
    return this.finalPush && this.roundLeftMs < FINAL_PUSH_MS;
  }

  refresh(world: World, now: number): void {
    if (now - this.refreshedAt < INTEL_MS && now >= this.refreshedAt) return;
    const dt = (now - this.refreshedAt) / 1000;
    this.refreshedAt = now;
    const seen = new Set<number>();
    for (const p of world.players.values()) {
      if (!p.alive || p.cells.length === 0) continue;
      seen.add(p.id);
      const c = centre(p);
      if (p.isBot) {
        let skill = this.mates.get(p.id)?.skill ?? 1;
        if (skill < 0) skill = 1;
        this.mates.set(p.id, { pid: p.id, x: c.x, y: c.y, mass: c.mass, big: c.big, cells: p.cells.length, skill });
        continue;
      }
      // an invisible coin is not reported (nobody sees it)
      if (p.invisUntil > world.now) {
        this.marks.delete(p.id);
        continue;
      }
      const prev = this.marks.get(p.id);
      let vx = 0;
      let vy = 0;
      if (prev && dt > 0 && dt < 4) {
        vx = (c.x - prev.x) / dt;
        vy = (c.y - prev.y) / dt;
      }
      this.marks.set(p.id, {
        pid: p.id,
        x: c.x,
        y: c.y,
        vx,
        vy,
        mass: c.mass,
        big: c.big,
        small: c.small,
        cells: p.cells.length,
        value: this.valueOf(p.id),
        joinedAt: p.stats.joinedAt,
        at: now,
      });
    }
    for (const id of this.marks.keys()) if (!seen.has(id)) this.marks.delete(id);
    for (const id of this.mates.keys()) if (!seen.has(id)) this.mates.delete(id);
    for (const [t, op] of this.ops) if (op.until <= now || !this.marks.has(t)) this.dropOp(t);
    this.coverSmallOnes(now);
  }

  /**
   * Every small teammate gets a big one nearby to look after it (not glued to it: see `BotBrain`), and
   * keeps it while it is small; a guard that died, grew too small or left is replaced.
   */
  private coverSmallOnes(now: number): void {
    for (const [ward, g] of this.guardOf) {
      const w = this.mates.get(ward);
      const gm = this.mates.get(g.guard);
      if (!this.teamplay || !w || !gm || w.mass > WARD_MASS * 1.6 || gm.mass < w.mass * GUARD_RATIO || g.until <= now) {
        this.guardOf.delete(ward);
        if (this.wardOf.get(g.guard) === ward) this.wardOf.delete(g.guard);
      }
    }
    if (!this.teamplay) return;
    for (const w of this.mates.values()) {
      if (w.mass > WARD_MASS) continue;
      const g = this.guardOf.get(w.pid);
      if (g) {
        g.until = now + GUARD_TTL_MS;
        continue;
      }
      let best: Mate | null = null;
      let bestD = GUARD_RANGE;
      for (const m of this.mates.values()) {
        if (m.pid === w.pid || m.skill < 1 || m.mass < GUARD_MIN_MASS || m.mass < w.mass * GUARD_RATIO) continue;
        if (this.wardOf.has(m.pid) || this.roleOf.has(m.pid) || this.guardOf.has(m.pid)) continue;
        const d = Math.hypot(m.x - w.x, m.y - w.y);
        if (d < bestD) {
          bestD = d;
          best = m;
        }
      }
      if (best) {
        this.guardOf.set(w.pid, { guard: best.pid, until: now + GUARD_TTL_MS });
        this.wardOf.set(best.pid, w.pid);
      }
    }
  }

  /** The small teammate bot `pid` looks after (null: none). */
  wardFor(pid: number): Mate | null {
    const w = this.wardOf.get(pid);
    return w === undefined ? null : (this.mates.get(w) ?? null);
  }

  /** The guard looking after bot `pid` (null: none). */
  guardFor(pid: number): Mate | null {
    const g = this.guardOf.get(pid);
    return g ? (this.mates.get(g.guard) ?? null) : null;
  }

  /** The nearest person in the reports who could eat a cell of `mass` at (x, y), within `range` (null: none). */
  threatNear(x: number, y: number, mass: number, range: number): Mark | null {
    let best: Mark | null = null;
    let bestD = range;
    for (const m of this.marks.values()) {
      if (!canEat(m.big, mass)) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /** A bot tells the squad its skill (0 easy .. 2 hard): easy bots are never recruited. */
  setSkill(pid: number, skill: number): void {
    const m = this.mates.get(pid);
    if (m) m.skill = skill;
  }

  /** How much a person is worth as a target, 1 = an ordinary coin: value over the entry fee, more so late in a round. */
  worth(pid: number): number {
    const m = this.marks.get(pid);
    let w = 1;
    if (m && this.entryFee > 0 && m.value > 0) w += Math.min(1.5, Math.log2(1 + m.value / this.entryFee) * 0.6);
    // the bell pays whatever a coin holds: the last minute is when it pays to take it
    if (this.pushing()) w *= 1.9;
    else if (this.roundLeftMs < 60_000) w *= 1.35;
    else if (this.roundLeftMs < 120_000) w *= 1.12;
    // a person in pieces is at their weakest
    if (m && m.cells > 1 && m.small < m.mass * 0.3) w *= 1.25;
    return w;
  }

  /** The operation bot `pid` has a role in, and the role (null: none). */
  roleFor(pid: number, now: number): { op: Op; role: OpRole } | null {
    const t = this.roleOf.get(pid);
    if (t === undefined) return null;
    const op = this.ops.get(t);
    if (!op || op.until <= now) {
      this.roleOf.delete(pid);
      return null;
    }
    const role: OpRole | null = op.pusher === pid ? 'push' : op.flanker === pid ? 'flank' : op.feeder === pid ? 'feed' : op.ambusher === pid ? 'ambush' : null;
    if (!role) {
      this.roleOf.delete(pid);
      return null;
    }
    return { op, role };
  }

  /** True while bot `pid` holds any role (it does not wander off or go home mid-operation). */
  busy(pid: number, now: number): boolean {
    return this.roleFor(pid, now) !== null || this.wardOf.has(pid);
  }

  /** Bots holding a role against person `target`. */
  crew(target: number, now: number): number {
    const op = this.ops.get(target);
    if (!op || op.until <= now) return 0;
    return [op.pusher, op.flanker, op.feeder, op.ambusher].filter((x) => x >= 0).length;
  }

  /**
   * Bot `pid` hunts person `target`: it becomes (or stays) the pusher, and while `crewMax` allows,
   * the squad recruits a flanker (a teammate that could eat the person too, near enough) and a feeder
   * (a small teammate close to the pusher). Renews the operation.
   */
  hunt(pid: number, target: number, now: number, crewMax: number): Op | null {
    if (!this.teamplay) return null;
    const m = this.marks.get(target);
    if (!m || now - m.joinedAt < OP_GRACE_MS) return null;
    let op = this.ops.get(target);
    if (op && op.pusher !== pid && op.pusher >= 0 && this.mates.has(op.pusher) && op.until > now) return op;
    if (!op) {
      op = { target, pusher: pid, flanker: -1, feeder: -1, ambusher: -1, until: 0 };
      this.ops.set(target, op);
    }
    op.pusher = pid;
    op.until = now + OP_TTL_MS;
    this.roleOf.set(pid, target);
    const used = () => [op!.pusher, op!.flanker, op!.feeder, op!.ambusher].filter((x) => x >= 0).length;
    if (op.flanker < 0 || !this.mates.has(op.flanker)) {
      op.flanker = -1;
      if (used() < crewMax) {
        const f = this.pick(m.x, m.y, FLANK_RANGE, (b) => b.pid !== pid && b.skill >= 1 && canEat(b.big, m.big * 1.05));
        if (f) {
          op.flanker = f.pid;
          this.roleOf.set(f.pid, target);
        }
      }
    }
    const me = this.mates.get(pid);
    if (me && (op.feeder < 0 || !this.mates.has(op.feeder))) {
      op.feeder = -1;
      // a feeder only helps when a little more mass makes the pusher's split reach the person
      const needs = me.big / 2 < m.big * RULES.eatRatio * 1.04 && (me.big + 6 * RULES.ejectMass) / 2 >= m.big * RULES.eatRatio * 1.04;
      if (needs && used() < crewMax + 1) {
        const f = this.pick(me.x, me.y, FEED_RANGE, (b) => b.pid !== pid && b.pid !== op!.flanker && b.mass < me.mass * 0.45 && b.mass > RULES.ejectMinMass + 20);
        if (f) {
          op.feeder = f.pid;
          this.roleOf.set(f.pid, target);
        }
      }
    }
    return op;
  }

  /**
   * Bot `bait` is chased by person `chaser`: a big teammate near the chaser that can eat them is asked
   * to ambush. Returns where the bait should run (the ambusher), or null when nobody can help.
   */
  lure(bait: number, chaser: number, now: number): Mate | null {
    if (!this.teamplay) return null;
    const m = this.marks.get(chaser);
    if (!m || now - m.joinedAt < OP_GRACE_MS) return null;
    let op = this.ops.get(chaser);
    if (op && op.until > now) {
      // a teammate already on the chaser (ambushing or hunting it outright) is where to run
      for (const id of [op.ambusher, op.pusher]) {
        const mate = id >= 0 && id !== bait ? this.mates.get(id) : undefined;
        if (mate && canEat(mate.big, m.big * 1.08)) {
          op.until = now + OP_TTL_MS;
          return mate;
        }
      }
    }
    const a = this.pick(m.x, m.y, AMBUSH_RANGE, (b) => b.pid !== bait && b.skill >= 1 && canEat(b.big, m.big * 1.08) && !this.roleOf.has(b.pid));
    if (!a) return null;
    if (!op) {
      op = { target: chaser, pusher: -1, flanker: -1, feeder: -1, ambusher: -1, until: 0 };
      this.ops.set(chaser, op);
    }
    op.ambusher = a.pid;
    op.until = now + OP_TTL_MS;
    this.roleOf.set(a.pid, chaser);
    return a;
  }

  /** Renews a role the bot is still playing. */
  renew(pid: number, now: number): void {
    const r = this.roleFor(pid, now);
    if (r) r.op.until = Math.max(r.op.until, now + OP_TTL_MS * 0.6);
  }

  /** The bot gives up its role (it died, left, or the chase is over). */
  release(pid: number): void {
    // cover: a guard or a ward that leaves ends that cover
    const ward = this.wardOf.get(pid);
    if (ward !== undefined) {
      this.wardOf.delete(pid);
      this.guardOf.delete(ward);
    }
    const g = this.guardOf.get(pid);
    if (g) {
      this.guardOf.delete(pid);
      this.wardOf.delete(g.guard);
    }
    const t = this.roleOf.get(pid);
    this.roleOf.delete(pid);
    if (t === undefined) return;
    const op = this.ops.get(t);
    if (!op) return;
    if (op.pusher === pid) op.pusher = -1;
    if (op.flanker === pid) op.flanker = -1;
    if (op.feeder === pid) op.feeder = -1;
    if (op.ambusher === pid) op.ambusher = -1;
    if (op.pusher < 0 && op.flanker < 0 && op.ambusher < 0) this.dropOp(t);
  }

  /** Where a flanker should stand: ahead of the person, on the far side from the pusher (the way out). */
  interceptPoint(op: Op, out: { x: number; y: number }, lead = 0.9): boolean {
    const m = this.marks.get(op.target);
    if (!m) return false;
    const p = op.pusher >= 0 ? this.mates.get(op.pusher) : undefined;
    // the person runs away from the pusher; with no pusher, along their own heading
    let ux = p ? m.x - p.x : m.vx;
    let uy = p ? m.y - p.y : m.vy;
    const n = Math.hypot(ux, uy);
    if (n < 1) {
      out.x = m.x;
      out.y = m.y;
      return true;
    }
    ux /= n;
    uy /= n;
    const ahead = 380 + Math.sqrt(m.mass) * 14;
    out.x = m.x + m.vx * lead + ux * ahead;
    out.y = m.y + m.vy * lead + uy * ahead;
    return true;
  }

  /**
   * Patrol: the most promising person bot `pid` (centre x,y, biggest cell `big`) could eat, from the
   * squad's reports, or null. Score: worth over distance; people already worked by a full crew are skipped.
   */
  patrolTarget(pid: number, x: number, y: number, big: number, now: number, crewMax: number): Mark | null {
    let best: Mark | null = null;
    let bestScore = 0;
    for (const m of this.marks.values()) {
      if (now - m.joinedAt < OP_GRACE_MS) continue;
      if (!canEat(big, m.big * 1.1)) continue;
      const op = this.ops.get(m.pid);
      if (op && op.until > now && this.crew(m.pid, now) >= crewMax && this.roleOf.get(pid) !== m.pid) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      const s = (this.worth(m.pid) * Math.sqrt(m.mass)) / (d + 600);
      if (s > bestScore) {
        bestScore = s;
        best = m;
      }
    }
    return best;
  }

  /** The nearest teammate within `range` of (x, y) passing `ok` that holds no role. */
  private pick(x: number, y: number, range: number, ok: (b: Mate) => boolean): Mate | null {
    let best: Mate | null = null;
    let bestD = range;
    for (const b of this.mates.values()) {
      if (this.roleOf.has(b.pid) || this.wardOf.has(b.pid)) continue;
      if (!ok(b)) continue;
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  private dropOp(target: number): void {
    const op = this.ops.get(target);
    this.ops.delete(target);
    if (!op) return;
    for (const b of [op.pusher, op.flanker, op.feeder, op.ambusher]) if (b >= 0 && this.roleOf.get(b) === target) this.roleOf.delete(b);
  }

  /** Live operations (tests, admin). */
  get opCount(): number {
    return this.ops.size;
  }

  op(target: number): Op | undefined {
    return this.ops.get(target);
  }
}

function centre(p: Player): { x: number; y: number; mass: number; big: number; small: number } {
  let m = 0;
  let sx = 0;
  let sy = 0;
  let big = 0;
  let small = Infinity;
  for (const c of p.cells) {
    m += c.mass;
    sx += c.x * c.mass;
    sy += c.y * c.mass;
    if (c.mass > big) big = c.mass;
    if (c.mass < small) small = c.mass;
  }
  return { x: sx / m, y: sy / m, mass: m, big, small };
}

const intel = new WeakMap<World, SquadIntel>();

/** The squad of a world (created on first use). */
export function squadIntel(world: World): SquadIntel {
  let s = intel.get(world);
  if (!s) intel.set(world, (s = new SquadIntel()));
  return s;
}
