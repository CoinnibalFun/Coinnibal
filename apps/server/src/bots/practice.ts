import { BASIC_SKINS, CUSTOM_LIMITS, PlayerFlag, RULES, type CustomDifficulty } from '@elymum/shared';
import type { Player } from '../game/entities';
import type { Rng } from '../game/rng';
import type { World } from '../game/world';
import { BotBrain, levelFor, type BotLevel } from './brain';

/**
 * Practice bots: the only bots Elymum has. A creator of a FREE custom room may ask for some (count and
 * difficulty) to practise alone or with friends, and the testnet's test arenas (`test-arenas.ts` in shared) are
 * populated with them. They never enter any other room with stakes (the room refuses to build them there), never
 * hold value (no ticket, never in the arena ledger, never pick up loot), see only what a person of their size would
 * see (`BotBrain`), and are labelled: every bot carries `PlayerFlag.Bot` (the client shows the BOT tag) and a
 * "Bot N" name. The room keeps exactly `count` of them: an eaten bot comes back a few seconds later.
 */

export interface PracticeBotsOptions {
  /** Bots in the room, 0..`max` (default `CUSTOM_LIMITS.botsMax`). */
  count: number;
  difficulty: CustomDifficulty;
  /** Most bots allowed (a test arena allows `TEST_ARENA_BOTS.max`); default `CUSTOM_LIMITS.botsMax`. */
  max?: number;
  /** Bots arrive one by one, about this many ms apart (± 40 %); absent / 0: all at once. */
  arriveMs?: number;
}

/** An eaten bot walks back in after this long (ms). */
export const BOT_RESPAWN_MS = { min: 3000, max: 7000 } as const;

export interface PracticeBot {
  player: Player;
  brain: BotBrain;
  /** "Bot 3": the number stays with the slot. */
  slot: number;
}

export class PracticeBots {
  readonly bots = new Map<number, PracticeBot>();
  /** Slot → when its bot comes back (eaten bots). */
  private readonly comeback = new Map<number, number>();
  count: number;
  /** Bots eaten so far (the admin's live status, the money simulation). */
  eaten = 0;
  opts: PracticeBotsOptions;

  constructor(
    private readonly world: World,
    opts: PracticeBotsOptions,
    private readonly rng: Rng,
  ) {
    this.opts = { ...opts };
    this.count = this.clamp(opts.count);
    this.schedule(1, this.count, world.now);
  }

  private clamp(n: number): number {
    return Math.max(0, Math.min(this.opts.max ?? CUSTOM_LIMITS.botsMax, Math.floor(n)));
  }

  /** Slots `from..to` arrive from `at`: at once, or one by one (`arriveMs`). */
  private schedule(from: number, to: number, at: number): void {
    const gap = this.opts.arriveMs ?? 0;
    let t = at;
    for (let slot = from; slot <= to; slot++) {
      this.comeback.set(slot, t);
      if (gap > 0) t += gap * (0.6 + this.rng() * 0.8);
    }
  }

  /**
   * New count and difficulty (a test arena's admin settings, applied live). New slots arrive one by one; a slot
   * above the new count leaves at once (a bot holds no value, nothing is settled). The difficulty applies to bots
   * that arrive from now on (a playing bot keeps its level until it is eaten).
   */
  reconfigure(count: number, difficulty: CustomDifficulty): number[] {
    this.opts = { ...this.opts, difficulty };
    const next = this.clamp(count);
    const gone: number[] = [];
    if (next > this.count) this.schedule(this.count + 1, next, this.world.now);
    for (const [pid, bot] of [...this.bots]) {
      if (bot.slot <= next) continue;
      this.bots.delete(pid);
      this.world.removePlayer(pid);
      gone.push(pid);
    }
    for (const slot of [...this.comeback.keys()]) if (slot > next) this.comeback.delete(slot);
    this.count = next;
    return gone;
  }

  isBot(pid: number): boolean {
    return this.bots.has(pid);
  }

  get size(): number {
    return this.bots.size;
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

  /** The world reported this bot's death: its slot comes back later. */
  onDeath(pid: number, now: number): void {
    const bot = this.bots.get(pid);
    if (!bot) return;
    this.bots.delete(pid);
    this.eaten++;
    const { min, max } = BOT_RESPAWN_MS;
    this.comeback.set(bot.slot, now + min + this.rng() * (max - min));
  }

  /** Every bot leaves the world (the room closes). Returns their player ids. */
  removeAll(): number[] {
    const gone = [...this.bots.keys()];
    for (const pid of gone) this.world.removePlayer(pid);
    this.bots.clear();
    this.comeback.clear();
    return gone;
  }

  /** Once per tick after `world.tick`: respawns due slots and lets brains decide. */
  update(now: number): void {
    for (const [slot, at] of this.comeback) {
      if (now < at) continue;
      this.comeback.delete(slot);
      this.spawn(slot);
    }
    for (const bot of this.bots.values()) {
      const p = bot.player;
      if (!p.alive || p.cells.length === 0 || !bot.brain.shouldThink(now)) continue;
      const d = bot.brain.think(this.world, p, now);
      if (!d) continue;
      this.world.setTarget(p.id, d.target.x, d.target.y);
      if (d.split) this.world.queueSplit(p.id);
    }
  }
}
