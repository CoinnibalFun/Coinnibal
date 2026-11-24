import { ClientOp, WORLD_PRESETS, type IntegrityTransfer } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import { World } from '../src/game/world';
import { IntegrityMonitor, type MonitorRoom } from '../src/integrity/telemetry';
import type { SessionSummary } from '../src/integrity/types';

const T = 1_791_000_000_000;

function setup() {
  const world = new World({ ...WORLD_PRESETS.arena, powerUps: false, coinRain: false, seed: 1 });
  const clock = { wall: T, mono: 0 };
  const done: SessionSummary[] = [];
  const transfers: IntegrityTransfer[] = [];
  const mon = new IntegrityMonitor({ mono: () => clock.mono, onSession: (s) => done.push(s), onTransfer: (t) => transfers.push(t) });
  const room: MonitorRoom = { id: 'arena-1-1', now: () => clock.wall, round: () => ({ n: 5, endsAt: 6 * 300_000, joinsCloseAt: 6 * 300_000 - 60_000 }), opts: { stake: { arenaId: 1, buyIn: 100 } } };
  const add = (name: string, x: number, y: number, mass: number, key: number) => {
    const p = world.addPlayer({ name, skin: 0, x, y, mass });
    mon.onJoin(room, p.id, { wallet: name, session: `s${key}`, sessionId: key, arenaId: 1, entryFee: 100, ipHash: 'ip', fpHash: null });
    return p;
  };
  /** An input as a room hands it on: the telemetry first, then the world (a target becomes the coin's aim). */
  const input = (p: ReturnType<typeof add>, msg: Parameters<IntegrityMonitor['onInput']>[2]) => {
    mon.onInput(room.id, p, msg);
    if (msg.op === ClientOp.Target) world.setTarget(p.id, msg.x, msg.y);
  };
  return { world, clock, done, transfers, mon, room, add, input };
}

describe('audit: a coin standing still counted as walking into its eater (fixed)', () => {
  // the suicide-feeding detector reads the last seconds before a death: a feeder walks into the mouth. A coin at rest
  // (the cursor on it, or on the spot it already reached) only has the direction of its last aim, which pointed
  // anywhere: an eater coming from that side made a stationary victim a "feeder" and the eater its beneficiary
  const eatenAtRest = (aimDx: number, move: boolean) => {
    const { world, clock, mon, room, add, done, input } = setup();
    const small = add('small', 1000, 1000, 40, 1);
    const whale = add('whale', 1600, 1000, 900, 2);
    const aim = { op: ClientOp.Target, x: 1000 + aimDx, y: 1000 } as const;
    input(small, aim);
    // the small coin reaches its aim (or rests on it); the whale comes from the east
    world.setTarget(whale.id, 900, 1000);
    for (let i = 0; i < 24; i++) {
      if (move) world.tick(1000 / 30);
      clock.wall += 1000 / 15;
      if (i % 2 === 0) mon.sample(room.id, world.players.values(), clock.wall);
      if (!move) {
        // nothing moves in the world but the whale (the test drives it)
        whale.cells[0].x -= 8;
      }
    }
    mon.onEnd(room, small.id, { reason: 'death', payout: 0, killer: whale });
    return done[0].death!;
  };

  it('a coin resting with the cursor on it is not walking toward the eater', () => {
    const d = eatenAtRest(5, false);
    expect(d.samples).toBeGreaterThanOrEqual(5);
    expect(d.approach).toBe(0);
  });

  it('a coin that reached the spot it was sent to (no new input since) is not walking either', () => {
    const d = eatenAtRest(120, true);
    expect(d.samples).toBeGreaterThanOrEqual(5);
    expect(d.approach).toBeLessThan(0.6);
  });

  it('a coin really heading into the eater still is', () => {
    const { world, clock, mon, room, add, done, input } = setup();
    const small = add('small', 1000, 1000, 40, 1);
    const whale = add('whale', 1700, 1000, 900, 2);
    input(small, { op: ClientOp.Target, x: 2500, y: 1000 });
    for (let i = 0; i < 16; i++) {
      clock.wall += 1000 / 15;
      mon.sample(room.id, world.players.values(), clock.wall);
    }
    mon.onEnd(room, small.id, { reason: 'death', payout: 0, killer: whale });
    expect(done[0].death!.approach).toBe(1);
  });
});

describe('integrity telemetry', () => {
  it('times moved aims only, counts whole-number aims and turns', () => {
    const { clock, mon, room, add, done, input } = setup();
    const p = add('a', 1000, 1000, 50, 1);
    for (let i = 0; i < 10; i++) {
      clock.mono += 40;
      input(p, { op: ClientOp.Target, x: 1500 + i * 3.5, y: 1000.25 });
      // a keep-alive with the same aim is ignored
      clock.mono += 5;
      input(p, { op: ClientOp.Target, x: 1500 + i * 3.5, y: 1000.25 });
    }
    input(p, { op: ClientOp.Split });
    input(p, { op: ClientOp.Target, x: 900, y: 900 });
    mon.onEnd(room, p.id, { reason: 'round', payout: 100, killer: null });
    const s = done[0];
    expect(s.input.aims).toBe(11);
    expect(s.input.intAims).toBe(1);
    expect(s.input.n).toBe(10);
    expect(s.input.splits).toBe(1);
    expect(s.input.turnHist.reduce((a, b) => a + b, 0)).toBe(10);
    expect(s.key).toBe('s1#1');
    expect(s.round).toBe(5);
    expect(s.roundStartsAt).toBe(5 * 300_000);
  });

  it('measures the reaction to a new threat (moving toward it, then turning away)', () => {
    const { world, clock, mon, room, add, done, input } = setup();
    const me = add('me', 1000, 1000, 40, 1);
    input(me, { op: ClientOp.Target, x: 1400, y: 1000 }); // heading east
    mon.sample(room.id, world.players.values(), clock.wall);
    const big = add('big', 1100 + 60, 1000, 400, 2); // a threat appears to the east
    clock.mono += 10;
    mon.sample(room.id, world.players.values(), clock.wall);
    clock.mono += 230;
    input(me, { op: ClientOp.Target, x: 600, y: 1000 }); // turns west
    mon.onEnd(room, me.id, { reason: 'round', payout: 100, killer: null });
    expect(done[0].input.reactionMs).toEqual([230]);
    void big;
  });

  it('records transfers, idle time, value received while idle, ejects eaten and the approach before a death', () => {
    const { world, clock, mon, room, add, done, transfers, input } = setup();
    const small = add('small', 1000, 1000, 40, 1);
    const whale = add('whale', 1300, 1000, 900, 2);
    input(small, { op: ClientOp.Target, x: 1600, y: 1000 }); // walking into the whale
    mon.onAfk(room.id, whale.id, true, clock.wall); // the whale is idle (disconnected)
    for (let i = 0; i < 8; i++) {
      clock.wall += 200;
      mon.sample(room.id, world.players.values(), clock.wall);
    }
    mon.onEjectEaten(room.id, small.id, whale.id);
    mon.onEjectEaten(room.id, small.id, whale.id);
    mon.onEjectEaten(room.id, small.id, 9999); // a bot or anyone untracked
    mon.onTransfer(room, small.id, whale.id, 100, 1, true);
    mon.onEnd(room, small.id, { reason: 'death', payout: 0, killer: whale });
    mon.onEnd(room, whale.id, { reason: 'round', payout: 200, killer: null });
    const [s, w] = done;
    expect(s.death).toMatchObject({ by: 'whale', samples: 8 });
    expect(s.death!.approach).toBe(1);
    expect(s.ejects).toEqual({ eatenBy: { whale: 2 }, eatenOther: 1 });
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ from: 'small', to: 'whale', amount: 100, fee: 100, fromKey: 's1#1', toKey: 's2#2', afkEater: true, others: 1 });
    expect(w.receivedWhileAfk).toBe(100);
    expect(w.afkAtEnd).toBe(true);
    expect(w.afkMs).toBe(1600);
    expect(mon.size).toBe(0);
  });
});
