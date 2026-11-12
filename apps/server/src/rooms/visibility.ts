import { EntityKind, lootTier, type EntityRecord, type PlayerInfo, type Removal, type SnapshotData } from '@elymum/shared';
import type { DynamicEntity, StaticEntity } from '../game/entities';
import type { World } from '../game/world';

interface Known {
  /** Last version sent. */
  v: number;
  /** Generation in which it was last visible. */
  g: number;
}

/**
 * Per-connection view state: which entities (and at which version) and which
 * player infos the client already has. Used to send minimal delta snapshots.
 */
export class ViewState {
  readonly known = new Map<number, Known>();
  /**
   * Player infos the client holds: the info signature sent, and the generation a cell of that player was last in
   * view. A player with no cell in view is forgotten at once: the client lets go of players without a coin in its
   * mirror (`prunePlayers`), so a coin coming back into view must bring its info (name tag, flag, skin) again.
   * Without this a big coin seen before came back as a bare default coin with no name tag (owner playtest 2026-11).
   */
  readonly knownPlayers = new Map<number, { sig: string; g: number }>();
  private gen = 0;
  /** `World.boundsVersion` this client last heard (-1: never, the next snapshot carries the bounds). */
  private boundsSent = -1;

  reset(): void {
    this.known.clear();
    this.knownPlayers.clear();
    this.gen = 0;
    this.boundsSent = -1;
  }

  forgetPlayer(pid: number): void {
    this.knownPlayers.delete(pid);
  }

  /**
   * Builds the delta for a view rectangle. Returns null when nothing changed.
   * `entryFee` (arena rooms) sizes loot pieces (`lootTier`). `avatars`: player id → profile picture
   * id (humans who wear one; a player's info is sent again when it changes). `selfPid`: the
   * viewer's own player (null: a spectator).
   *
   * Anti-cheat: the cells of an invisible player (a bought Invisibility) are left out for everyone
   * but that player, so a hacked client has nothing to show. The client already holding them sees
   * them removed (no eater) and gets them again, as new entities, when the effect ends.
   */
  build(
    world: World,
    rect: { x0: number; y0: number; x1: number; y1: number },
    view: SnapshotData['view'],
    entryFee = 0,
    avatars?: ReadonlyMap<number, string>,
    selfPid: number | null = null,
  ): SnapshotData | null {
    const gen = ++this.gen;
    const upserts: EntityRecord[] = [];
    const players: PlayerInfo[] = [];
    const now = world.now;

    world.forEachVisible(rect.x0, rect.y0, rect.x1, rect.y1, (e: StaticEntity | DynamicEntity) => {
      if (e.kind === EntityKind.Cell && e.player.invisUntil > now && e.player.id !== selfPid) return;
      const k = this.known.get(e.id);
      if (!k) {
        this.known.set(e.id, { v: e.version, g: gen });
        upserts.push(toRecord(e, entryFee));
      } else {
        k.g = gen;
        if (k.v !== e.version) {
          k.v = e.version;
          upserts.push(toRecord(e, entryFee));
        }
      }
      if (e.kind === EntityKind.Cell) {
        const p = e.player;
        const avatar = p.isBot ? undefined : avatars?.get(p.id);
        // one signature per player and tick (every viewer of every one of its cells compares it)
        if (p.infoSigTick !== world.tickCount || p.infoSigAvatar !== avatar) {
          p.infoSig = `${p.skin}|${p.flags}|${p.name}|${avatar ?? ''}|${p.country ?? ''}|${p.xHandle ?? ''}`;
          p.infoSigTick = world.tickCount;
          p.infoSigAvatar = avatar;
        }
        const sig = p.infoSig;
        const kp = this.knownPlayers.get(p.id);
        if (kp && kp.sig === sig) kp.g = gen;
        else {
          this.knownPlayers.set(p.id, { sig, g: gen });
          const info: PlayerInfo = { id: p.id, skin: p.skin, flags: p.flags, name: p.name, isBot: p.isBot };
          if (avatar) info.avatar = avatar;
          if (p.country) info.country = p.country;
          if (p.xHandle && !p.isBot) info.xHandle = p.xHandle;
          players.push(info);
        }
      }
    });

    // players with no cell in view any more: forgotten, so their info rides again with their next visible cell
    for (const [pid, kp] of this.knownPlayers) if (kp.g !== gen) this.knownPlayers.delete(pid);

    const removals: Removal[] = [];
    for (const [id, k] of this.known) {
      if (k.g !== gen) {
        removals.push({ id, eaterId: world.removed.get(id) ?? 0 });
        this.known.delete(id);
      }
    }

    if (this.boundsSent !== world.boundsVersion) {
      this.boundsSent = world.boundsVersion;
      return { tick: world.tickCount, view, bounds: { x0: world.x0, y0: world.y0, x1: world.x1, y1: world.y1 }, players, upserts, removals };
    }
    return { tick: world.tickCount, view, players, upserts, removals };
  }
}

function toRecord(e: StaticEntity | DynamicEntity, entryFee: number): EntityRecord {
  switch (e.kind) {
    case EntityKind.Cell:
      return { id: e.id, kind: e.kind, x: e.x, y: e.y, r: e.r, playerId: e.player.id, flags: e.flags };
    case EntityKind.Food:
      return { id: e.id, kind: e.kind, x: e.x, y: e.y, r: e.r, variant: e.variant };
    case EntityKind.Eject:
      return { id: e.id, kind: e.kind, x: e.x, y: e.y, r: e.r, variant: e.skin };
    case EntityKind.Virus:
      return { id: e.id, kind: e.kind, x: e.x, y: e.y, r: e.r };
    case EntityKind.PowerUp:
      return { id: e.id, kind: e.kind, x: e.x, y: e.y, r: e.r, variant: e.type };
    case EntityKind.Loot:
      return { id: e.id, kind: e.kind, x: e.x, y: e.y, r: e.r, variant: lootTier(e.value, entryFee) };
  }
}
