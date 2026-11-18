import { BASIC_SKINS, CUSTOM_LIMITS, PlayerFlag, RULES, canEat, type CustomDifficulty, type LeftReason } from '@elymum/shared';
import type { Player } from '../game/entities';
import type { Rng } from '../game/rng';
import type { World } from '../game/world';
import { BotBrain, botView, levelFor, type BotLevel } from './brain';

/**
 * Practice bots: the only bots Coinnibal has. A creator of a FREE custom room may ask for some (count and
 * difficulty) to practise alone or with friends, and the testnet's test arenas (`test-arenas.ts` in shared) are
 * populated with them. They never enter any other room with stakes (the room refuses to build them there), never
 * hold value (no ticket, never in the arena ledger, never pick up loot), see only what a person of their size would
 * see (`BotBrain`), and are labelled: every bot carries `PlayerFlag.Bot` (the client shows the BOT tag) and a
 * "Bot N" name. An eaten bot comes back a few seconds later.
 *
 * A free custom room keeps exactly `count` of them. A test arena makes room for people (`makeRoom`): `count` is the
 * number of bots in an EMPTY room and every person's coin in it takes one bot's place, so the room plays with
 * `max(0, count − people)` bots (`target`). A person seated: one bot leaves (a bot still on its way in is called off
 * first, else the playing bot least in the way, `pickLeaver`). A person gone (eaten, or settled at the bell): a bot
 * comes back with the arrival pacing, one at a time, never all at once. A leaving bot turns harmless (it eats nobody
 * and nobody eats it), swims to an edge away from the people and leaves the world once no connection has it in view
 * (at the latest after `BOT_LEAVE_MAX_MS`). A bot holds no value, so its leaving moves none: the books, the loot and
 * the burns stay exactly as they are.
 */

export interface PracticeBotsOptions {
  /** Bots in the room, 0..`max` (default `CUSTOM_LIMITS.botsMax`); with `makeRoom` the bots of an EMPTY room. */
  count: number;
  difficulty: CustomDifficulty;
  /** Most bots allowed (a test arena allows `TEST_ARENA_BOTS.max`); default `CUSTOM_LIMITS.botsMax`. */
  max?: number;
  /** Bots arrive one by one, about this many ms apart (± 40 %); absent / 0: all at once. */
  arriveMs?: number;
  /** Every person present takes one bot's place (the testnet's test arenas: the room sets it, from `RoomOptions.test`). */
  makeRoom?: boolean;
}

/** An eaten bot walks back in after this long (ms). */
export const BOT_RESPAWN_MS = { min: 3000, max: 7000 } as const;

/** A leaving bot is gone at the latest this long after it started to leave, seen or not (ms). */
export const BOT_LEAVE_MAX_MS = 8000;

export interface PracticeBot {
  player: Player;
  brain: BotBrain;
  /** "Bot 3": the number stays with the slot. */
  slot: number;
  /** On its way out (a person took its place, or the admin lowered the count): harmless, it swims off. */
  leaving?: { until: number; reason: LeftReason };
}

/** What the room tells its bots each tick. */
export interface BotSurroundings {
  /** The coins of the people in the room (connected or away): with `makeRoom`, each takes one bot's place. */
  people: readonly Player[];
  /** Some connection has this player's coin in view right now. */
  seen(pid: number): boolean;
}

const NOBODY: BotSurroundings = { people: [], seen: () => false };

/** A bot that left the world (the room tells the viewers: a "went home" feed line). */
export interface BotDeparture {
  player: Player;
  reason: LeftReason;
}

/**
 * A bot on its way in. `new`: an arrival, paced one by one (`arriveMs`); `back`: an eaten bot's comeback, with its
 * slot. A slot of null takes the lowest free one when the bot walks in.
 */
interface Arrival {
  at: number;
  slot: number | null;
  kind: 'new' | 'back';
}

export class PracticeBots {
  /** Every bot in the world: playing and leaving ones. */
  readonly bots = new Map<number, PracticeBot>();
  /** Bots on their way in (new arrivals, comebacks of eaten bots), soonest first. */
  private readonly arrivals: Arrival[] = [];
  /** The setting: bots in the room (with `makeRoom`, in an empty room). */
  count: number;
  /** Bots eaten so far (the admin's live status, the money simulation). */
  eaten = 0;
  /** Bots that left the world to make room for people or after a lower setting. */
  left = 0;
  opts: PracticeBotsOptions;
  /** People's coins in the room at the last update (`makeRoom`). */
  private people = 0;
  /** The earliest time the next new arrival may come (one by one). */
  private nextArrivalAt = -Infinity;
  /** When the last new arrival walked in (two never walk in closer than `0.6 × arriveMs`). */
  private lastArrivedAt = -Infinity;

  constructor(
    private readonly world: World,
    opts: PracticeBotsOptions,
    private readonly rng: Rng,
  ) {
    this.opts = { ...opts };
    this.count = this.clamp(opts.count);
    // the first bot of a new room walks in at once, the others one by one
    for (let i = 0; i < this.count; i++) this.arrivals.push({ at: this.arrivalTime(world.now, i === 0), slot: i + 1, kind: 'new' });
  }

  private clamp(n: number): number {
    return Math.max(0, Math.min(this.opts.max ?? CUSTOM_LIMITS.botsMax, Math.floor(n)));
  }

  /** When a new arrival comes: about `arriveMs` after the one before it (± 40 %), and (unless `immediate`) after now. */
  private arrivalTime(now: number, immediate: boolean): number {
    const gap = this.opts.arriveMs ?? 0;
    if (gap <= 0) return now;
    const step = () => gap * (0.6 + this.rng() * 0.8);
    const at = Math.max(this.nextArrivalAt, immediate ? now : now + step());
    this.nextArrivalAt = at + step();
    return at;
  }

  /** The bots the room plays with while `people` people's coins are in it. */
  targetFor(people: number): number {
    return this.opts.makeRoom ? Math.max(0, this.count - Math.max(0, people)) : this.count;
  }

  /** The bots the room plays with now. */
  get target(): number {
    return this.targetFor(this.people);
  }

  /**
   * New count and difficulty (a test arena's admin settings, applied live). Missing bots arrive one by one; extra
   * ones leave the way a bot makes room for a person (a bot holds no value, nothing is settled). The difficulty
   * applies to bots that arrive from now on (a playing bot keeps its level until it is eaten).
   */
  reconfigure(count: number, difficulty: CustomDifficulty, around: BotSurroundings = NOBODY): BotDeparture[] {
    this.opts = { ...this.opts, difficulty };
    this.count = this.clamp(count);
    return this.balance(this.world.now, around);
  }

  /** Keeps the room at its target right now (a person was just seated): returns the bots that left the world. */
  fit(around: BotSurroundings): BotDeparture[] {
    return this.balance(this.world.now, around);
  }

  isBot(pid: number): boolean {
    return this.bots.has(pid);
  }

  /** Bots playing: in the world and not leaving. */
  get size(): number {
    let n = 0;
    for (const b of this.bots.values()) if (!b.leaving) n++;
    return n;
  }

  /** Bots leaving: still in the world (harmless), on their way out. */
  get leavingCount(): number {
    return this.bots.size - this.size;
  }

  /** Bots on their way in (new arrivals and comebacks). */
  get arriving(): number {
    return this.arrivals.length;
  }

  /** The level a slot plays at (fixed per slot, so "Bot 2" stays the same opponent). */
  private levelOf(slot: number): BotLevel {
    if (this.opts.difficulty !== 'mixed') return levelFor(this.opts.difficulty, this.rng);
    return (['easy', 'normal', 'hard'] as const)[(slot - 1) % 3];
  }

  private spawn(slot: number): PracticeBot {
    const player = this.world.addPlayer({
      name: `Bot ${slot}`,
      skin: (slot - 1) % BASIC_SKINS.length,
      flags: PlayerFlag.Bot,
      isBot: true,
      mass: RULES.startMass,
    });
    const bot: PracticeBot = { player, slot, brain: new BotBrain(this.levelOf(slot), this.rng, this.world.now) };
    this.bots.set(player.id, bot);
    return bot;
  }

  /** The world reported this bot's death: its slot comes back later (unless the room needs a bot fewer by then). */
  onDeath(pid: number, now: number): void {
    const bot = this.bots.get(pid);
    if (!bot) return;
    this.bots.delete(pid);
    this.eaten++;
    // a leaving bot was on its way out anyway: it does not come back
    if (bot.leaving) return;
    const { min, max } = BOT_RESPAWN_MS;
    this.arrivals.push({ at: now + min + this.rng() * (max - min), slot: bot.slot, kind: 'back' });
    this.arrivals.sort((a, b) => a.at - b.at);
  }

  /** Every bot leaves the world (the room closes). Returns their player ids. */
  removeAll(): number[] {
    const gone = [...this.bots.keys()];
    for (const pid of gone) this.world.removePlayer(pid);
    this.bots.clear();
    this.arrivals.length = 0;
    return gone;
  }

  /**
   * Keeps the room at its target: a bot too many is first called off on its way in (the latest arrival), else a
   * playing bot starts to leave; a missing one is scheduled with the arrival pacing.
   */
  private balance(now: number, around: BotSurroundings): BotDeparture[] {
    if (this.opts.makeRoom) this.people = around.people.length;
    const target = this.target;
    let playing = this.size;
    while (playing + this.arrivals.length > target && this.arrivals.length > 0) {
      const off = this.arrivals.pop()!;
      // its turn in the pacing goes to the next arrival
      this.nextArrivalAt = Math.min(this.nextArrivalAt, off.at);
    }
    while (playing > target) {
      const bot = this.pickLeaver(around.people);
      if (!bot) break;
      // the setting itself is below what plays: the admin's change; otherwise a person took the place
      this.startLeaving(bot, now, playing > this.count ? 'settings' : 'make_room', around.people);
      playing--;
    }
    const missing = target - playing - this.arrivals.length;
    if (missing > 0) {
      for (let n = 0; n < missing; n++) this.arrivals.push({ at: this.arrivalTime(now, false), slot: null, kind: 'new' });
      this.arrivals.sort((a, b) => a.at - b.at);
    }
    return this.sweepLeavers(now, around);
  }

  /**
   * The bot that makes room: one neither chasing a person nor chased by one, the farthest from the people (on a tie
   * the smaller); when every bot is busy with a person, the smallest.
   */
  private pickLeaver(people: readonly Player[]): PracticeBot | null {
    let best: { bot: PracticeBot; free: boolean; dist: number; mass: number } | null = null;
    for (const bot of this.bots.values()) {
      if (bot.leaving) continue;
      const p = bot.player;
      const mass = p.totalMass();
      const c = p.center();
      let free = true;
      let dist = Infinity;
      for (const person of people) {
        if (!person.alive || person.cells.length === 0) continue;
        const pc = person.center();
        dist = Math.min(dist, Math.hypot(pc.x - c.x, pc.y - c.y));
        if (free && inChase(p, person)) free = false;
      }
      const better = !best || (free !== best.free ? free : free ? dist > best.dist || (dist === best.dist && mass < best.mass) : mass < best.mass);
      if (better) best = { bot, free, dist, mass };
    }
    return best?.bot ?? null;
  }

  /** The bot turns harmless and heads for the way out. */
  private startLeaving(bot: PracticeBot, now: number, reason: LeftReason, people: readonly Player[]): void {
    const until = now + BOT_LEAVE_MAX_MS;
    bot.leaving = { until, reason };
    // shielded until it is gone: it eats nobody (no person's value spills because of it) and nobody eats it
    bot.player.shieldUntil = Math.max(bot.player.shieldUntil, until + 1000);
    this.steerOut(bot, people);
  }

  /** Toward the edge it reaches well ahead of every person (nobody around: the nearest edge). */
  private steerOut(bot: PracticeBot, people: readonly Player[]): void {
    const w = this.world;
    const c = bot.player.center();
    const exits = [
      { x: w.x0 - 400, y: c.y },
      { x: w.x1 + 400, y: c.y },
      { x: c.x, y: w.y0 - 400 },
      { x: c.x, y: w.y1 + 400 },
    ];
    let best = exits[0];
    let bestScore = -Infinity;
    for (const e of exits) {
      const way = Math.hypot(e.x - c.x, e.y - c.y);
      let clear = Infinity;
      for (const person of people) {
        if (!person.alive || person.cells.length === 0) continue;
        const pc = person.center();
        clear = Math.min(clear, Math.hypot(e.x - pc.x, e.y - pc.y));
      }
      const score = clear === Infinity ? -way : clear - way;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    w.setTarget(bot.player.id, best.x, best.y);
  }

  /** Leaving bots nobody sees any more (or whose time is up) leave the world. */
  private sweepLeavers(now: number, around: BotSurroundings): BotDeparture[] {
    const gone: BotDeparture[] = [];
    for (const [pid, bot] of this.bots) {
      if (!bot.leaving) continue;
      if (now < bot.leaving.until && around.seen(pid)) continue;
      this.bots.delete(pid);
      this.world.removePlayer(pid);
      this.left++;
      gone.push({ player: bot.player, reason: bot.leaving.reason });
    }
    return gone;
  }

  /** The lowest slot no bot in the world or on its way in holds. */
  private freeSlot(): number {
    const used = new Set<number>();
    for (const b of this.bots.values()) used.add(b.slot);
    for (const a of this.arrivals) if (a.slot !== null) used.add(a.slot);
    let s = 1;
    while (used.has(s)) s++;
    return s;
  }

  /**
   * Once per tick after `world.tick`: keeps the room at its target (the setting, the people present), brings in the
   * arrivals that are due (never more bots in the world than the setting, leaving ones included: an arrival waits
   * until they are gone), lets brains decide and steers the leaving bots out. Returns the bots that left the world.
   */
  update(now: number, around: BotSurroundings = NOBODY): BotDeparture[] {
    const gone = this.balance(now, around);
    const minGap = (this.opts.arriveMs ?? 0) * 0.6;
    for (let i = 0; i < this.arrivals.length && this.bots.size < this.count; ) {
      const a = this.arrivals[i];
      if (a.at > now) break;
      // new arrivals walk in one by one, even after a wait (a leaving bot still in the world held them back)
      if (a.kind === 'new' && now - this.lastArrivedAt < minGap) {
        i++;
        continue;
      }
      this.arrivals.splice(i, 1);
      if (a.kind === 'new') this.lastArrivedAt = now;
      this.spawn(a.slot ?? this.freeSlot());
    }
    for (const bot of this.bots.values()) {
      const p = bot.player;
      if (!p.alive || p.cells.length === 0) continue;
      if (bot.leaving) {
        this.steerOut(bot, around.people);
        continue;
      }
      if (!bot.brain.shouldThink(now)) continue;
      const d = bot.brain.think(this.world, p, now);
      if (!d) continue;
      this.world.setTarget(p.id, d.target.x, d.target.y);
      if (d.split) this.world.queueSplit(p.id);
    }
    return gone;
  }
}

/** A bot and a person in a chase: one sees the other (the view of a person of that size) and one could eat the other. */
function inChase(bot: Player, person: Player): boolean {
  const sees = (a: Player, b: Player): boolean => {
    const v = botView(a);
    for (const cell of b.cells) if (cell.x + cell.r > v.x0 && cell.x - cell.r < v.x1 && cell.y + cell.r > v.y0 && cell.y - cell.r < v.y1) return true;
    return false;
  };
  if (!sees(bot, person) && !sees(person, bot)) return false;
  const span = (p: Player) => {
    let lo = Infinity;
    let hi = 0;
    for (const c of p.cells) {
      lo = Math.min(lo, c.mass);
      hi = Math.max(hi, c.mass);
    }
    return { lo, hi };
  };
  const b = span(bot);
  const h = span(person);
  return canEat(b.hi, h.lo) || canEat(h.hi, b.lo);
}
