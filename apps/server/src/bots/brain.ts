import { EntityKind, RULES, VIEW, canEat, viewSize, type CustomDifficulty } from '@elymum/shared';
import type { Cell, Player } from '../game/entities';
import type { Rng } from '../game/rng';
import type { World } from '../game/world';

/**
 * A practice bot's brain. Bots exist only in free custom rooms whose creator asked for them (see
 * `PracticeBots`), and they play FAIR: a bot sees exactly what a person of its size would see on a
 * 16:9 screen (the same view rectangle the server sends a player, `viewSize` and `VIEW.serverMargin`),
 * nothing outside it, never an invisible coin, no other bot's knowledge (no teams, no shared reports),
 * and it reacts with a delay and aims with an error that depend on the difficulty. It steers like a
 * person with a mouse: it picks a point to move to, and sometimes splits.
 */

export type BotLevel = 'easy' | 'normal' | 'hard';

export interface BotTuning {
  /** Time between two decisions (ms). */
  thinkMs: number;
  /** Aim error, radians (uniform in ±aimNoise). */
  aimNoise: number;
  /** Weight of fleeing against eating (higher: more careful). */
  caution: number;
  /** Chases coins it can eat. */
  hunts: boolean;
  /** Splits on a reachable prey. */
  splits: boolean;
  /** Chance a decision overlooks threats and prey (a distracted moment: it just grazes). */
  missChance: number;
}

export const BOT_TUNING: Readonly<Record<BotLevel, BotTuning>> = Object.freeze({
  easy: { thinkMs: 650, aimNoise: 0.75, caution: 0.35, hunts: false, splits: false, missChance: 0.35 },
  normal: { thinkMs: 450, aimNoise: 0.45, caution: 0.6, hunts: true, splits: false, missChance: 0.25 },
  hard: { thinkMs: 300, aimNoise: 0.25, caution: 0.9, hunts: true, splits: true, missChance: 0.12 },
});

/** An attentive person's intent (the integrity simulation's honest players), independent of the practice bots' tuning. */
export const HUMAN_PROXY_TUNING: Readonly<BotTuning> = Object.freeze({ thinkMs: 260, aimNoise: 0.22, caution: 1, hunts: true, splits: false, missChance: 0 });

/** The level of each new bot for a room's difficulty choice (`mixed`: a third of each). */
export function levelFor(difficulty: CustomDifficulty, rng: Rng): BotLevel {
  if (difficulty === 'easy') return 'easy';
  if (difficulty === 'hard') return 'hard';
  const r = rng();
  return r < 1 / 3 ? 'easy' : r < 2 / 3 ? 'normal' : 'hard';
}

/** What a bot does this decision. */
export interface BotDecision {
  target: { x: number; y: number };
  split: boolean;
}

/** Distance a freshly split half flies (boost only), as in the simulation. */
export const SPLIT_REACH = RULES.splitSpeed / -Math.log(RULES.splitDecayPerSec);

/** The rectangle a player of `p`'s size sees (the server's snapshot rectangle on a 16:9 screen). */
export function botView(p: Player): { x0: number; y0: number; x1: number; y1: number } {
  const c = p.center();
  const v = viewSize(p.totalMass(), 16 / 9);
  const hw = (v.w / 2) * VIEW.serverMargin;
  const hh = (v.h / 2) * VIEW.serverMargin;
  return { x0: c.x - hw, y0: c.y - hh, x1: c.x + hw, y1: c.y + hh };
}

export class BotBrain {
  private nextThinkAt: number;

  constructor(
    readonly level: BotLevel,
    private readonly rng: Rng,
    now: number,
    private readonly tuning: Readonly<BotTuning> = BOT_TUNING[level],
  ) {
    // first decisions spread out (bots do not all think on the same tick)
    this.nextThinkAt = now + rng() * tuning.thinkMs;
  }

  shouldThink(now: number): boolean {
    return now >= this.nextThinkAt;
  }

  /** One decision from what `me` can see now; null when it has no cells. */
  think(world: World, me: Player, now: number): BotDecision | null {
    const T = this.tuning;
    this.nextThinkAt = now + T.thinkMs * (0.8 + this.rng() * 0.4);
    const big = me.biggestCell();
    if (!big) return null;
    const c = me.center();
    const view = botView(me);
    // a distracted moment: it does not notice threats or prey this time, it only grazes
    const distracted = this.rng() < T.missChance;

    // what a person of this size sees: cells of others (visible ones only), food, cacti
    let fleeX = 0;
    let fleeY = 0;
    let prey: { cell: Cell; score: number } | null = null;
    let foodX = 0;
    let foodY = 0;
    const cactusAhead: { x: number; y: number; r: number }[] = [];
    const tooBigForCacti = big.mass > RULES.virusMass * RULES.virusPopRatio;
    world.forEachVisible(view.x0, view.y0, view.x1, view.y1, (e) => {
      if (e.kind === EntityKind.Cell) {
        const cell = e as Cell;
        const owner = cell.player;
        if (owner === me || !owner.alive || world.isInvisible(owner)) return;
        const dx = cell.x - c.x;
        const dy = cell.y - c.y;
        const d = Math.max(1, Math.hypot(dx, dy) - big.r - cell.r);
        if (distracted) return;
        if (canEat(cell.mass, big.mass * 0.9)) {
          // a threat: run away, harder the closer it is
          const w = (T.caution * 1000) / d;
          fleeX -= (dx / (d + big.r)) * w;
          fleeY -= (dy / (d + big.r)) * w;
        } else if (T.hunts && canEat(big.mass, cell.mass)) {
          const score = cell.mass / (d + 50);
          if (!prey || score > prey.score) prey = { cell, score };
        }
      } else if (e.kind === EntityKind.Food || e.kind === EntityKind.Eject) {
        const dx = e.x - c.x;
        const dy = e.y - c.y;
        const d2 = Math.max(400, dx * dx + dy * dy);
        foodX += (dx * e.mass) / d2;
        foodY += (dy * e.mass) / d2;
      } else if (e.kind === EntityKind.Virus && tooBigForCacti) {
        cactusAhead.push({ x: e.x, y: e.y, r: e.r });
      }
    });

    // keep off the walls like a person who sees the border
    const pad = big.r * 2 + 120;
    if (c.x - world.x0 < pad) fleeX += 2;
    if (world.x1 - c.x < pad) fleeX -= 2;
    if (c.y - world.y0 < pad) fleeY += 2;
    if (world.y1 - c.y < pad) fleeY -= 2;

    let dirX: number;
    let dirY: number;
    let split = false;
    const fleeing = Math.hypot(fleeX, fleeY) > 0.6;
    const target = prey as { cell: Cell; score: number } | null;
    if (fleeing) {
      dirX = fleeX;
      dirY = fleeY;
    } else if (target) {
      dirX = target.cell.x - c.x;
      dirY = target.cell.y - c.y;
      const d = Math.hypot(dirX, dirY) - big.r;
      // a split attack only on a coin the half can eat and reach, with nobody dangerous around
      split = T.splits && me.cells.length < 4 && canEat(big.mass / 2, target.cell.mass) && d < SPLIT_REACH * 0.7 && this.rng() < 0.5;
    } else if (foodX !== 0 || foodY !== 0) {
      dirX = foodX;
      dirY = foodY;
    } else {
      // nothing in sight: drift toward the middle of the map
      const m = world.center();
      dirX = m.x - c.x + (this.rng() - 0.5) * 800;
      dirY = m.y - c.y + (this.rng() - 0.5) * 800;
    }

    // steer around cacti that would pop it
    for (const v of cactusAhead) {
      const vx = v.x - c.x;
      const vy = v.y - c.y;
      const d = Math.hypot(vx, vy);
      if (d < big.r + v.r + 200 && vx * dirX + vy * dirY > 0) {
        dirX -= (vx / d) * 1.5 * Math.hypot(dirX, dirY);
        dirY -= (vy / d) * 1.5 * Math.hypot(dirX, dirY);
      }
    }

    const len = Math.hypot(dirX, dirY) || 1;
    const angle = Math.atan2(dirY, dirX) + (this.rng() * 2 - 1) * T.aimNoise;
    const reach = Math.max(300, len > 0 ? 600 : 300);
    return { target: { x: c.x + Math.cos(angle) * reach, y: c.y + Math.sin(angle) * reach }, split };
  }
}
