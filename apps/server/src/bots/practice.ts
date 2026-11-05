import { BASIC_SKINS, CUSTOM_LIMITS, PlayerFlag, RULES, type CustomDifficulty } from '@elymum/shared';
import type { Player } from '../game/entities';
import type { Rng } from '../game/rng';
import type { World } from '../game/world';
import { BotBrain, levelFor, type BotLevel } from './brain';

/**
 * Practice bots: the only bots Elymum has. A creator of a FREE custom room may ask for some (count and
 * difficulty) to practise alone or with friends. They never enter a room with stakes (the room refuses
 * to build them there), never hold value, see only what a person of their size would see (`BotBrain`),
 * and are labelled: every bot carries `PlayerFlag.Bot` (the client shows the BOT tag) and a "Bot N"
 * name. The room keeps exactly `count` of them: an eaten bot comes back a few seconds later.
 */

export interface PracticeBotsOptions {
  /** Bots in the room, 0..`CUSTOM_LIMITS.botsMax`. */
  count: number;
  difficulty: CustomDifficulty;
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
  readonly count: number;

  constructor(
    private readonly world: World,
    readonly opts: PracticeBotsOptions,
    private readonly rng: Rng,
  ) {
    this.count = Math.max(0, Math.min(CUSTOM_LIMITS.botsMax, Math.floor(opts.count)));
    for (let slot = 1; slot <= this.count; slot++) this.comeback.set(slot, world.now);
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
