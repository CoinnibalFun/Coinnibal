import { BASIC_SKINS, PlayerFlag, RULES, botCountry, botWearsFlag, clamp, pickBotName, type LeftReason } from '@elymum/shared';
import type { Player } from '../game/entities';
import { randRange, type Rng } from '../game/rng';
import type { World } from '../game/world';
import { BotBrain } from './brain';
import { squadIntel } from './squad';
import { rollPersonality, type BotMix } from './personality';
import type { StakedBotTicket } from './staked';

export interface BotManagerOptions {
  /**
   * Typical squad size: the bots a room fields, whoever else plays. The live plan drifts around it
   * (see `BotManager.planned`), within `min..max`. People never replace bots.
   */
  target: number;
  /** Fewest bots in a room (never below `BOT_FLOOR` unless the cap is lower). */
  min: number;
  /** The bot cap of the room (admin `cap`). */
  max: number;
  /** Difficulty mix (default `standard`). */
  mix?: BotMix;
  /** Bots on (default true). Off: every bot goes home and none spawns. */
  enabled?: boolean;
  /**
   * Most mass a bot keeps (per room kind, admin `massCap`; see `DEFAULT_BOT_MASS_CAPS`): bots never
   * spawn above it and shed whatever they eat past it within a second or two. Absent: no cap.
   */
  massCap?: number;
  /**
   * Bot strength in percent (admin `strength`, default 100): above 100 bots hunt harder, react
   * faster and aim better; below, the reverse (see `BotBrain.strength`).
   */
  strength?: number;
  /** Most bots working one person at once (admin `maxChasers`; absent: no limit). */
  maxChasers?: number;
  /** Squad play: traps, lures, feeding and map-wide tracking (default on; off in the rookie league). */
  teamplay?: boolean;
  /**
   * Rooms that play rounds (arenas): the squad size is rolled once per round, every bot of it walks in
   * within the round's first minute, and no bot goes home before the bell (a person cannot leave a
   * round either). Set by the room.
   */
  rounds?: boolean;
}

/** Every room (every round of an arena) fields at least this many bots, unless the admin cap is lower. */
export const BOT_FLOOR = 3;

/**
 * Arrival pacing. Bots join one by one like people do, at random moments: the first `BOT_FLOOR`
 * within a few seconds of a room opening (or an arena round starting), the rest of the planned squad
 * before `windowMs` is out (a bot that turns up late would be easy prey for coins that already grew).
 */
export const ARRIVAL = {
  /** Every planned bot is in by this long after a room opens or a round starts (ms). */
  windowMs: 55_000,
  /** Least gap between two arrivals inside the window (ms). */
  windowGapMin: 1500,
  /** Gap between two arrivals while the room is below its floor (ms). */
  openingMin: 1200,
  openingMax: 4500,
  /** Gap between two arrivals above the floor (ms). */
  steadyMin: 5000,
  steadyMax: 20_000,
  /** A bot that was eaten comes back (as itself or someone new) after this long (ms). */
  rejoinMin: 3000,
  rejoinMax: 12_000,
  /** The planned squad size is re-rolled around the target this often (ms). */
  driftMin: 90_000,
  driftMax: 180_000,
  /** Above the plan, one bot leaves at most this often (ms). */
  leaveMin: 12_000,
  leaveMax: 35_000,
} as const;

/** Share of a capped bot's excess mass that stays after one second (the rest is shed). */
const MASS_CAP_KEEP_PER_SEC = 0.2;
/**
 * Most brains that think in one tick: about a quarter of the room (thoughts are staggered every
 * 120-300 ms anyway; this only flattens rare bursts). Bots over the budget think next tick.
 */
const thinkBudget = (bots: number): number => Math.max(3, Math.ceil(bots / 4));

/**
 * Level of detail: a zero-value bot this far (world units) from every human coin is out of every
 * player's view, so it thinks less often (at most every `FAR_THINK_MS`). Rooms without a human keep
 * the full rate (spectators may watch them), and staked bots always do (they carry value).
 */
export const FAR_FROM_HUMANS = 3200;
export const FAR_THINK_MS = 600;
const FAR_CHECK_MS = 500;

export interface Bot {
  player: Player;
  brain: BotBrain;
  /** Bots "go home" after a while so the leaderboard keeps changing (staked bots: never). */
  retireAt: number;
  /** Testnet staked bots only: the arena ticket the bot plays (see `StakedBotSource`). */
  staked?: StakedBotTicket;
}

/** A bot that left the room without dying (the room shows "<name> went home"). */
export interface BotDeparture {
  pid: number;
  name: string;
  skin: number;
  reason: LeftReason;
}

/** Names bots wore lately in this room: some come back as "regulars". */
const REGULARS_KEPT = 40;

/** Emote ids (see @elymum/shared EMOTES). */
const EMOTE_GM = 0;
const EMOTE_WAGMI = 1;
const EMOTE_ROCKET = 2;
const EMOTE_YUM = 5;

/**
 * The room's bot squad: bots are players of the house's own team, not seat fillers. They join one
 * at a time over the game (a few right away, the rest spread out), leave and come back now and then,
 * and the squad size drifts naturally around the admin's target. People joining or leaving never
 * changes it. Also drives every bot's brain.
 */
export class BotManager {
  readonly bots = new Map<number, Bot>();
  /** When the next bot walks in (0: not scheduled yet). */
  private nextArrivalAt = 0;
  /** When a bot over the plan may leave next. */
  private nextLeaveAt = 0;
  /** The squad size the room is heading for now (drifts around the target). */
  private plan = -1;
  private nextDriftAt = 0;
  /** When the current arrival window (room open / round start) began (-1: not yet). */
  private windowStart = -1;
  /** Arrivals are allowed now (the room closes them with its round's joins). */
  joinsOpen: () => boolean = () => true;
  private pendingEmotes: { pid: number; id: number }[] = [];
  /** Player ids of bots that left this tick (rooms forget their player info). */
  retired: number[] = [];
  /** Bots that went home (not died) since the last `takeDepartures`. */
  private departures: BotDeparture[] = [];
  private regulars: string[] = [];
  private opts: BotManagerOptions;
  private lastUpdateAt: number | null = null;
  /** Bots in a stable order for the round-robin think budget (rebuilt when the set changes). */
  private order: Bot[] = [];
  private orderDirty = true;
  private cursor = 0;
  /** Bots far from every human (recomputed every `FAR_CHECK_MS`), and when each may think next. */
  private readonly far = new Map<number, number>();
  private farCheckAt = 0;

  constructor(
    private readonly world: World,
    opts: BotManagerOptions,
    private readonly rng: Rng,
  ) {
    this.opts = { ...opts };
  }

  get options(): Readonly<BotManagerOptions> {
    return this.opts;
  }

  get enabled(): boolean {
    return this.opts.enabled !== false;
  }

  /** The room's bot cap. */
  get cap(): number {
    return this.enabled ? Math.max(0, this.opts.max) : 0;
  }

  /** The squad size the admin asked for: `clamp(target, max(min, BOT_FLOOR), cap)`, 0 when bots are off. */
  desired(): number {
    return BotManager.desiredOf(this.opts);
  }

  /** `desired` for a set of options (a room sizes its map before its bot manager exists). */
  static desiredOf(o: BotManagerOptions): number {
    if (o.enabled === false) return 0;
    const cap = Math.max(0, o.max);
    return clamp(o.target, BotManager.floorOf(o), cap);
  }

  /** Fewest bots a room of these options fields: `max(min, BOT_FLOOR)`, never above the cap. */
  static floorOf(o: BotManagerOptions): number {
    if (o.enabled === false) return 0;
    const cap = Math.max(0, o.max);
    return Math.min(cap, Math.max(BOT_FLOOR, o.min));
  }

  /** The squad size the room is heading for right now (the plan drifts around `desired`). */
  get planned(): number {
    return this.plan < 0 ? this.desired() : this.plan;
  }

  /** Rolls the plan: any whole number from the floor (`max(min, BOT_FLOOR)`) to the cap, evenly (6-9 by default). */
  private rollPlan(now: number): void {
    const floor = BotManager.floorOf(this.opts);
    const cap = this.cap;
    this.plan = cap <= floor ? cap : floor + Math.floor(this.rng() * (cap - floor + 1));
    // a round keeps its squad size until the bell; free rooms drift now and then
    this.nextDriftAt = this.opts.rounds ? Infinity : now + randRange(this.rng, ARRIVAL.driftMin, ARRIVAL.driftMax);
  }

  /**
   * Seats the whole planned squad at once (natural size mix). Rooms never do this (bots walk in one by
   * one); it is for tests, benchmarks and tools that need a full room right away.
   */
  fill(now = this.world.now): number {
    if (this.plan < 0) this.rollPlan(now);
    const want = this.enabled ? this.plan : 0;
    const cap = this.opts.massCap;
    let n = 0;
    while (this.bots.size < want) {
      const mass = Math.round(20 + Math.pow(this.rng(), 2.2) * 420);
      this.spawnBot(cap !== undefined ? Math.min(mass, Math.max(20, Math.round(cap * 0.9))) : mass);
      n++;
    }
    this.scheduleArrival(now);
    return n;
  }

  /**
   * Schedules the next arrival: the floor first (a few seconds apart), then the rest of the plan at
   * random moments that still land inside the arrival window; after the window, the slow pace of
   * people dropping in (a bot that was eaten comes back sooner, see `onDeath`).
   */
  private scheduleArrival(now: number): void {
    if (this.windowStart < 0) this.windowStart = now;
    const remaining = Math.max(0, this.planned - this.bots.size);
    const windowEnd = this.windowStart + ARRIVAL.windowMs;
    if (this.bots.size < BotManager.floorOf(this.opts) && now < windowEnd) {
      this.nextArrivalAt = now + randRange(this.rng, ARRIVAL.openingMin, ARRIVAL.openingMax);
    } else if (remaining > 0 && now < windowEnd) {
      // spread what is left over the time left, at random; the last one still makes the window
      const room = windowEnd - now;
      const gap = randRange(this.rng, Math.min(ARRIVAL.windowGapMin, room), Math.max(ARRIVAL.windowGapMin, (room / remaining) * 1.6));
      this.nextArrivalAt = now + Math.min(gap, room);
    } else {
      this.nextArrivalAt = now + randRange(this.rng, ARRIVAL.steadyMin, ARRIVAL.steadyMax);
    }
  }

  isBot(pid: number): boolean {
    return this.bots.has(pid);
  }

  /** Testnet staked bots in the room (they hold a ticket). */
  get stakedCount(): number {
    let n = 0;
    for (const b of this.bots.values()) if (b.staked) n++;
    return n;
  }

  /** Remembers a name for a later comeback (a "regular" of this room). */
  private remember(name: string): void {
    const i = this.regulars.indexOf(name);
    if (i >= 0) this.regulars.splice(i, 1);
    this.regulars.push(name);
    if (this.regulars.length > REGULARS_KEPT) this.regulars.shift();
  }

  /** A natural name nobody in the room wears (humans included); sometimes a returning regular. */
  private pickName(): string {
    const used: string[] = [];
    for (const p of this.world.players.values()) used.push(p.name);
    return pickBotName(this.rng, used, this.regulars);
  }

  /** Bots wear the basic skins only. */
  private pickSkin(): number {
    return Math.floor(this.rng() * BASIC_SKINS.length);
  }

  spawnBot(mass?: number, staked?: StakedBotTicket): Bot {
    const taken = new Set([...this.world.players.values()].map((p) => p.name.toLowerCase()));
    const name = staked?.name && !taken.has(staked.name.toLowerCase()) ? staked.name : this.pickName();
    const player = this.world.addPlayer({
      name,
      skin: this.pickSkin(),
      // some bots paint their coin with their flag (the flag skin), always the same ones by name
      flags: (staked ? PlayerFlag.Bot | PlayerFlag.Staker : PlayerFlag.Bot) | (botWearsFlag(name) ? PlayerFlag.FlagSkin : 0),
      isBot: true,
      // a plausible flag, the same one every time this name plays
      country: botCountry(name),
      mass,
    });
    const bot: Bot = {
      player,
      brain: new BotBrain(rollPersonality(this.rng, this.opts.mix ?? 'standard'), this.rng, this.world.now),
      retireAt: staked ? Infinity : this.world.now + randRange(this.rng, 4 * 60_000, 12 * 60_000),
      ...(staked ? { staked } : {}),
    };
    this.tune(bot);
    this.bots.set(player.id, bot);
    this.orderDirty = true;
    if (this.rng() < 0.2) this.pendingEmotes.push({ pid: player.id, id: EMOTE_GM });
    return bot;
  }

  /** Applies the room's mass cap, strength and chaser limit to a bot's brain. */
  private tune(bot: Bot): void {
    const b = bot.brain;
    b.pid = bot.player.id;
    b.massCap = this.opts.massCap ?? Infinity;
    b.strength = (this.opts.strength ?? 100) / 100;
    b.maxChasers = this.opts.maxChasers !== undefined && this.opts.maxChasers > 0 ? this.opts.maxChasers : Infinity;
    b.teamplay = this.opts.teamplay !== false;
    squadIntel(this.world).teamplay = this.opts.teamplay !== false;
  }

  /** The world reported this bot's death: forget it and maybe respawn later. */
  onDeath(pid: number, now: number): void {
    const bot = this.bots.get(pid);
    if (!bot) return;
    bot.brain.releaseClaim(this.world);
    this.bots.delete(pid);
    this.orderDirty = true;
    this.remember(bot.player.name);
    // the eaten one (or a friend) comes back after a while
    const back = now + randRange(this.rng, ARRIVAL.rejoinMin, ARRIVAL.rejoinMax);
    if (this.nextArrivalAt === 0 || back < this.nextArrivalAt) this.nextArrivalAt = back;
  }

  /** A bot goes home now: it leaves the world and a departure is recorded. */
  private sendHome(bot: Bot, reason: LeftReason): void {
    const p = bot.player;
    bot.brain.releaseClaim(this.world);
    this.bots.delete(p.id);
    this.orderDirty = true;
    this.world.removePlayer(p.id);
    this.retired.push(p.id);
    this.remember(p.name);
    this.departures.push({ pid: p.id, name: p.name, skin: p.skin, reason });
  }

  /**
   * Sends zero-value bots home until at most `want` bots are left (staked bots hold a ticket and
   * stay until death or the bell). Picks bots out of danger first, then the smallest. Returns how many left.
   */
  trimTo(want: number, reason: LeftReason): number {
    let n = 0;
    while (this.bots.size > want) {
      let pick: Bot | null = null;
      let pickScore = Infinity;
      for (const b of this.bots.values()) {
        if (b.staked) continue;
        const score = b.player.totalMass() + (b.brain.lastDanger > 0.2 ? 1e9 : 0);
        if (score < pickScore) {
          pick = b;
          pickScore = score;
        }
      }
      if (!pick) break;
      this.sendHome(pick, reason);
      n++;
    }
    return n;
  }

  /** New admin settings, applied live: bots over the new cap (or all, when off) go home now; the plan is re-rolled. */
  setOptions(opts: BotManagerOptions, now = this.world.now): number {
    this.opts = { ...opts };
    for (const b of this.bots.values()) this.tune(b);
    this.rollPlan(now);
    if (this.nextArrivalAt === 0 || this.nextArrivalAt > now + ARRIVAL.openingMax) this.scheduleArrival(now);
    return this.trimTo(this.enabled ? this.cap : 0, 'settings');
  }

  /** Bots that went home since the last call (the room broadcasts the feed lines). */
  takeDepartures(): BotDeparture[] {
    const d = this.departures;
    this.departures = [];
    return d;
  }

  /**
   * Round reset: every bot leaves the world with the bell, like the people who were paid, and the
   * squad walks back in one by one in the new round (a few at once, the rest over the round).
   * Returns the removed player ids.
   */
  resetRound(): number[] {
    const gone = [...this.bots.keys()];
    for (const b of this.bots.values()) {
      b.brain.releaseClaim(this.world);
      this.remember(b.player.name);
    }
    for (const pid of gone) this.world.removePlayer(pid);
    this.bots.clear();
    this.orderDirty = true;
    this.nextArrivalAt = 0;
    this.plan = -1;
    // a new arrival window opens with the new round
    this.windowStart = -1;
    return gone;
  }

  /** A bot ate a player: sometimes it gloats. */
  onKill(pid: number): void {
    if (this.bots.has(pid) && this.rng() < 0.3) this.pendingEmotes.push({ pid, id: this.rng() < 0.7 ? EMOTE_YUM : EMOTE_ROCKET });
  }

  /** Recomputes which zero-value bots are far from every human coin (see `FAR_FROM_HUMANS`). */
  private updateFar(now: number): void {
    if (now < this.farCheckAt) return;
    this.farCheckAt = now + FAR_CHECK_MS;
    const hx: number[] = [];
    const hy: number[] = [];
    for (const p of this.world.players.values()) {
      if (p.isBot || !p.alive) continue;
      for (const c of p.cells) {
        hx.push(c.x);
        hy.push(c.y);
      }
    }
    const far2 = FAR_FROM_HUMANS * FAR_FROM_HUMANS;
    for (const bot of this.bots.values()) {
      const p = bot.player;
      let far = hx.length > 0 && !bot.staked && p.cells.length > 0;
      for (let i = 0; far && i < hx.length; i++) {
        for (const c of p.cells) {
          const dx = c.x - hx[i];
          const dy = c.y - hy[i];
          if (dx * dx + dy * dy < far2) {
            far = false;
            break;
          }
        }
      }
      if (!far) this.far.delete(p.id);
      else if (!this.far.has(p.id)) this.far.set(p.id, 0);
    }
    for (const pid of this.far.keys()) if (!this.bots.has(pid)) this.far.delete(pid);
  }

  /** Called once per tick after `world.tick`. `humans` is only used for the squad's tactics, never for its size. */
  update(now: number, _humans = 0): { emotes: { pid: number; id: number }[] } {
    this.retired = [];
    const cap = this.opts.massCap;
    if (this.plan < 0 || now >= this.nextDriftAt) this.rollPlan(now);
    const plan = this.enabled ? this.plan : 0;
    if (this.nextArrivalAt === 0) this.scheduleArrival(now);

    // the mass cap: whatever a bot eats past it melts away
    const dt = this.lastUpdateAt === null ? 0 : Math.max(0, now - this.lastUpdateAt) / 1000;
    this.lastUpdateAt = now;
    if (cap !== undefined && dt > 0) {
      const shed = 1 - Math.pow(MASS_CAP_KEEP_PER_SEC, dt);
      for (const bot of this.bots.values()) if (bot.player.alive) this.world.shedMass(bot.player, cap, shed);
    }

    // arrivals: one bot at a time walks in, like a person pressing Play (never while the round's joins are closed)
    if (now >= this.nextArrivalAt) {
      if (this.bots.size < plan && this.joinsOpen()) this.spawnBot(cap !== undefined ? Math.min(RULES.startMass, cap) : RULES.startMass);
      this.scheduleArrival(now);
    }
    // over the plan (the plan drifted down in a free room): one leaves now and then; a round keeps its bots
    if (!this.opts.rounds && this.bots.size > plan && now >= this.nextLeaveAt) {
      this.nextLeaveAt = now + randRange(this.rng, ARRIVAL.leaveMin, ARRIVAL.leaveMax);
      this.trimTo(this.bots.size - 1, 'retired');
    }

    // a bot whose time is up goes home (one at a time, never mid-fight); someone else walks in later
    for (const bot of this.bots.values()) {
      if (this.opts.rounds || now < bot.retireAt) continue;
      if (bot.brain.lastDanger > 0.2 || bot.brain.busy) {
        bot.retireAt = now + 10_000;
        continue;
      }
      this.sendHome(bot, 'retired');
      break;
    }

    // the squad's shared picture of the map (who is where), refreshed on its own slow clock
    squadIntel(this.world).refresh(this.world, now);

    // brains think on their own staggered clocks; a round-robin budget flattens bursts
    if (this.orderDirty) {
      this.order = [...this.bots.values()];
      this.orderDirty = false;
      if (this.cursor >= this.order.length) this.cursor = 0;
    }
    this.updateFar(now);
    const n = this.order.length;
    let budget = thinkBudget(n);
    const start = this.cursor;
    for (let i = 0; i < n && budget > 0; i++) {
      const bot = this.order[(start + i) % n];
      const p = bot.player;
      if (!p.alive || p.cells.length === 0) continue;
      if (!bot.brain.shouldThink(now)) continue;
      const farAt = this.far.get(p.id);
      if (farAt !== undefined) {
        if (now < farAt) continue;
        this.far.set(p.id, now + FAR_THINK_MS);
      }
      budget--;
      this.cursor = (start + i + 1) % n;
      const d = bot.brain.think(this.world, p, now);
      if (!d) continue;
      this.world.setTarget(p.id, d.target.x, d.target.y);
      if (d.split) this.world.queueSplit(p.id);
      if (d.eject) this.world.queueEject(p.id);
      if (this.rng() < 0.0008) this.pendingEmotes.push({ pid: p.id, id: this.rng() < 0.5 ? EMOTE_WAGMI : EMOTE_ROCKET });
    }

    const emotes = this.pendingEmotes;
    this.pendingEmotes = [];
    return { emotes };
  }
}
