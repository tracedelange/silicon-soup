import { findWalkableEdgeTile, generateZoneGrid, isBlocked, type RegionBounds, type ZoneGrid } from './mapgen/index.ts';
import { makeMob } from './entities.ts';
import { WILD } from '../../shared/worldgen/config.ts';
import { isWildBlocked, wildTileAt, type FieldSeeds } from '../../shared/worldgen/field.ts';
import { siteAt, type DungeonSite, type Gate, type RegionAtlas } from '../../shared/worldgen/atlas.ts';
import { randomUUID } from 'node:crypto';
import type {
  AbilityTargetSide, DamageEffect, Direction, Entity, EntitySnapshot, GroundItemEntity,
  HealEffect, MobEntity, PlayerEntity, SpawnPoint, TeleportFxEvent, WorldDefs, ZoneDef, ZoneSnapshot,
} from '../../shared/types.ts';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function nearestWalkable(
  grid: ReturnType<typeof generateZoneGrid>['grid'],
  origin: { x: number; y: number },
  width: number,
  height: number,
  blockingTiles: ReadonlySet<string>,
): { x: number; y: number } | null {
  if (!isBlocked(grid, origin.x, origin.y, blockingTiles)) return origin;
  const visited = new Uint8Array(width * height);
  const queue: Array<{ x: number; y: number }> = [origin];
  visited[origin.y * width + origin.x] = 1;
  while (queue.length) {
    const cur = queue.shift()!;
    for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]] as const) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const idx = ny * width + nx;
      if (visited[idx]) continue;
      visited[idx] = 1;
      if (!isBlocked(grid, nx, ny, blockingTiles)) return { x: nx, y: ny };
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}

export const DEFAULT_RESPAWN_SECONDS = 120;
export const TICKS_PER_SECOND = 10;
const RESPAWN_RETRY_TICKS = 20;

interface ZoneRuntime extends ZoneGrid { def: ZoneDef }
interface PendingRespawn { spawnIndex: number; dueTick: number }

// A persistent ground zone (see shared/types.ts ZoneEffect) — independent of
// any entity, unlike a `modifier`. Ticked by abilities.ts's tickZones (same
// "single read/write site" pattern as tickModifiers), which owns the actual
// damage/heal application; World just stores + creates them.
export interface ActiveZone {
  id: string;
  zoneId: string;
  x: number;
  y: number;
  radius: number;
  expiresAt: number;
  nextTickAt: number;
  tickInterval: number;
  effect: DamageEffect | HealEffect;
  side: AbilityTargetSide;
  ownerId: string;
}

export class World {
  defs: WorldDefs = null as unknown as WorldDefs;
  zones: Record<string, ZoneRuntime> = {};
  entities: Map<string, Entity> = new Map();
  byZone: Map<string, Set<string>> = new Map();
  pendingRespawns: Map<string, PendingRespawn[]> = new Map();
  /** Ticked/consumed by abilities.ts's tickZones; created here (mirrors the
   *  _spawnOne / addEntity split for mobs). */
  activeZones: Map<string, ActiveZone> = new Map();
  /** Current time of day: 0=midnight, 0.25=dawn, 0.5=noon, 0.75=dusk. */
  timeOfDay = 0.25;
  /** Mirrors GameLoop.tick (set there each tick) — sent on snapshots so clients
   *  can compute a modifier's remaining duration from its `expiresAt` tick
   *  without the server pushing a per-second countdown itself. */
  currentTick = 0;
  /** Continuous-wilderness field seeds + atlas, set once at boot by index.ts.
   *  When null the wilderness is impassable (no field to sample). */
  wildSeeds: FieldSeeds | null = null;
  atlas: RegionAtlas | null = null;

  setDefinitions(defs: WorldDefs): void {
    this.defs = defs;
    for (const zoneId of Object.keys(defs.zones)) {
      this._rebuildZone(zoneId);
    }
    // After all grids are built, synthesize portal entries for connections that
    // lack explicit portals. This lets the LLM write only `connections:` and skip
    // the `portals:` block for cardinal edge transitions.
    this._synthesizeConnectionPortals();
    // Wire post_ops portals (zone_connect) to their destination spawn points,
    // then auto-synthesize the matching return portals from non-cardinal connections.
    this._synthesizePostOpPortals();
    this._synthesizeReturnPortals();
  }

  /**
   * Resolve each `portal` post-op to a full ZonePortal entry pointing at the
   * target zone's spawn point. The source tile was painted during generation;
   * the destination is the target's resolved spawn point.
   */
  private _synthesizePostOpPortals(): void {
    for (const zone of Object.values(this.zones)) {
      for (const { at, toZone, transition } of zone.postOpPortals) {
        // Wilderness target: land at the atlas gate whose zone-side portal tile
        // matches this post-op's position, so each village exit maps to its own
        // wilderness gate. Falls back to the settlement's primary gate.
        if (toZone === WILD) {
          // A dungeon's exit lands on its own entrance tile, not a village gate.
          // The entrance re-rolls every epoch, so this is resolved from the live
          // atlas rather than written into the dungeon template.
          const site = this.atlas?.sites.find(s => s.id === zone.def.id);
          if (site) {
            zone.def.portals = zone.def.portals ?? [];
            zone.def.portals.push({ at, to: { zone: WILD, x: site.worldX, y: site.worldY }, transition });
            continue;
          }
          const st = this.atlas?.settlements.find(s => s.id === zone.def.id) ?? this.atlas?.settlements[0];
          const g = st?.gates.find(gt => gt.villageX === at.x && gt.villageY === at.y);
          const dst = g
            ? { x: g.wildX, y: g.wildY }
            : st ? { x: st.portalX, y: st.portalY } : { x: 0, y: 0 };
          zone.def.portals = zone.def.portals ?? [];
          zone.def.portals.push({ at, to: { zone: WILD, x: dst.x, y: dst.y }, transition });
          continue;
        }
        if (!this.zones[toZone]) {
          console.warn(`[world] post_op portal in '${zone.def.id}' targets unknown zone '${toZone}' — skipped.`);
          continue;
        }
        const dst = this.getZoneSpawnPoint(toZone);
        zone.def.portals = zone.def.portals ?? [];
        zone.def.portals.push({ at, to: { zone: toZone, x: dst.x, y: dst.y }, transition });
      }
    }
  }

  /**
   * For each non-cardinal connection (e.g. `surface`, `cellar`) on a zone, if no
   * portal back to the parent already exists, synthesize a return portal at this
   * zone's spawn point pointing to the parent's spawn point. This means the
   * Implementor only writes the outbound portal; the inbound is free.
   */
  private _synthesizeReturnPortals(): void {
    const CARDINAL = new Set(['north', 'south', 'east', 'west']);
    for (const [zoneId, zone] of Object.entries(this.zones)) {
      const connections = zone.def.connections ?? {};
      for (const [key, parentId] of Object.entries(connections)) {
        if (CARDINAL.has(key) || !parentId) continue;
        const parent = this.zones[parentId];
        if (!parent) continue;
        const already = (zone.def.portals ?? []).some(p => p.to?.zone === parentId);
        if (already) continue;

        // Build egress tile list — one entry per egress_point, or a single spawn_point fallback.
        const egressSpawnPoints = zone.def.egress_points ?? [undefined];
        const egressPoints = egressSpawnPoints.map(sp => this.getZoneSpawnPoint(zoneId, sp));

        // All parent portals pointing into this zone, matched in order to egress points.
        const entrancePortals = (parent.def.portals ?? []).filter(p => p.to?.zone === zoneId);

        zone.def.portals = zone.def.portals ?? [];
        for (let i = 0; i < egressPoints.length; i++) {
          const at = egressPoints[i]!;
          // Land back on the Nth entrance portal, falling back to the first or the parent spawn.
          const dst = (entrancePortals[i] ?? entrancePortals[0])?.at ?? this.getZoneSpawnPoint(parentId);
          zone.def.portals.push({ at, to: { zone: parentId, x: dst.x, y: dst.y }, transition: 'ascend' });
          // Paint the portal tile — generateZoneGrid ran before synthesis.
          if (zone.grid[at.y]?.[at.x] !== undefined) zone.grid[at.y]![at.x] = 'portal';
        }
      }
    }
  }

  private _synthesizeConnectionPortals(): void {
    const OPPOSITE: Record<Direction, Direction> = {
      north: 'south', south: 'north', east: 'west', west: 'east',
    };
    for (const zone of Object.values(this.zones)) {
      for (const { at, dir, toZone: toZoneId } of zone.autoConnectionPortals) {
        const toZone = this.zones[toZoneId];
        if (!toZone) continue;
        const oppDir = OPPOSITE[dir];
        const dst = findWalkableEdgeTile(toZone.grid, toZone.width, toZone.height, oppDir, this.defs.blockingTiles);
        if (!dst) continue;
        zone.def.portals = zone.def.portals ?? [];
        zone.def.portals.push({ at, to: { zone: toZoneId, x: dst.x, y: dst.y } });
      }
    }
  }

  private _rebuildZone(zoneId: string): void {
    const def = this.defs.zones[zoneId]!;
    const prev = this.zones[zoneId];
    this.zones[zoneId] = { ...generateZoneGrid(def, this.defs.blockingTiles, this.defs.prefabs), def };

    if (prev) {
      for (const id of [...(this.byZone.get(zoneId) || [])]) {
        const e = this.entities.get(id);
        if (e && e.type !== 'player') this.removeEntity(id);
      }
    } else {
      this.byZone.set(zoneId, new Set());
    }

    this._spawnZoneEntities(zoneId);
  }

  private _spawnZoneEntities(zoneId: string): void {
    this.pendingRespawns.set(zoneId, []);
    const spawns = this.zones[zoneId]!.def.spawns || [];
    for (let i = 0; i < spawns.length; i++) {
      const spawn = spawns[i]!;
      if (!this.defs.mobs[spawn.entity]) continue;
      // Exact placement is a single entity; region placement scatters `count`.
      const count = spawn.at ? 1 : (spawn.count || 1);
      for (let k = 0; k < count; k++) {
        this._spawnOne(zoneId, i);
      }
    }
  }

  private _spawnOne(zoneId: string, spawnIndex: number): MobEntity | null {
    const z = this.zones[zoneId]!;
    const spawn = z.def.spawns![spawnIndex]!;
    const template = this.defs.mobs[spawn.entity];
    if (!template) return null;
    // `at` places at an exact tile (no scatter, may be a wall — sconce-style);
    // a named region scatters within it; no region at all scatters zone-wide
    // (the Implementor's coordinate-free default for zones whose generated
    // region names it cannot know).
    let pos: { x: number; y: number } | null;
    if (spawn.at) {
      pos = { x: spawn.at.x, y: spawn.at.y };
    } else if (spawn.area) {
      // Inline author-drawn rectangle — scatter the group within it.
      pos = this._findFreeTileInRegion(zoneId, spawn.area);
    } else if (spawn.region) {
      const region = z.bounds[spawn.region];
      if (!region) {
        if (!spawn.if_region) {
          console.warn(`[world] spawn '${spawn.entity}' in '${zoneId}' names unknown region '${spawn.region}' — skipped.`);
        }
        return null;
      }
      pos = this._findFreeTileInRegion(zoneId, region);
    } else {
      const h = z.grid.length;
      const w = z.grid[0]?.length ?? 0;
      pos = this._findFreeTileInRegion(zoneId, { x: 0, y: 0, w, h }, 60);
    }
    if (!pos) return null;
    const mob = makeMob(template, { zone: zoneId, x: pos.x, y: pos.y, spawnId: spawn.spawn_id, level: spawn.level });
    if (spawn.region) mob.components.ai.spawn_region = spawn.region;
    mob.spawnRef = { zoneId, spawnIndex };
    this.addEntity(mob);
    return mob;
  }

  scheduleRespawn(mob: MobEntity, currentTick: number): void {
    const ref = mob?.spawnRef;
    if (!ref) return;
    const spawn = this.zones[ref.zoneId]?.def?.spawns?.[ref.spawnIndex];
    if (!spawn) return;
    const delaySec = spawn.respawn_seconds ?? DEFAULT_RESPAWN_SECONDS;
    if (delaySec <= 0) return;
    const dueTick = currentTick + Math.max(1, Math.round(delaySec * TICKS_PER_SECOND));
    const q = this.pendingRespawns.get(ref.zoneId) || [];
    q.push({ spawnIndex: ref.spawnIndex, dueTick });
    this.pendingRespawns.set(ref.zoneId, q);
  }

  tickRespawns(currentTick: number): Set<string> {
    const dirty = new Set<string>();
    for (const [zoneId, q] of this.pendingRespawns) {
      if (!q.length) continue;
      const remaining: PendingRespawn[] = [];
      for (const item of q) {
        if (currentTick < item.dueTick) { remaining.push(item); continue; }
        const z = this.zones[zoneId];
        const spawn = z?.def?.spawns?.[item.spawnIndex];
        if (!spawn) continue;
        const mob = this._spawnOne(zoneId, item.spawnIndex);
        if (mob) {
          dirty.add(zoneId);
        } else {
          remaining.push({ spawnIndex: item.spawnIndex, dueTick: currentTick + RESPAWN_RETRY_TICKS });
        }
      }
      this.pendingRespawns.set(zoneId, remaining);
    }
    return dirty;
  }

  /** Create a persistent ground zone centered on (x,y) — see ActiveZone.
   *  Ticking/consuming happens in abilities.ts's tickZones. */
  spawnZone(opts: {
    zoneId: string; x: number; y: number; radius: number; currentTick: number;
    durationTicks: number; tickInterval: number; effect: DamageEffect | HealEffect;
    side: AbilityTargetSide; ownerId: string;
  }): ActiveZone {
    const zone: ActiveZone = {
      id: randomUUID(),
      zoneId: opts.zoneId,
      x: opts.x,
      y: opts.y,
      radius: opts.radius,
      expiresAt: opts.currentTick + opts.durationTicks,
      nextTickAt: opts.currentTick + opts.tickInterval,
      tickInterval: opts.tickInterval,
      effect: opts.effect,
      side: opts.side,
      ownerId: opts.ownerId,
    };
    this.activeZones.set(zone.id, zone);
    return zone;
  }

  private _findFreeTileInRegion(zoneId: string, region: RegionBounds, attempts = 20): { x: number; y: number } | null {
    const grid = this.zones[zoneId]?.grid;
    for (let i = 0; i < attempts; i++) {
      const x = region.x + 1 + Math.floor(Math.random() * Math.max(1, region.w - 2));
      const y = region.y + 1 + Math.floor(Math.random() * Math.max(1, region.h - 2));
      if (grid?.[y]?.[x] === 'portal') continue;
      if (this.canMoveTo(zoneId, x, y) && !this.entityAt(zoneId, x, y)) return { x, y };
    }
    return null;
  }

  addEntity(entity: Entity): void {
    this.entities.set(entity.id, entity);
    const zone = entity.position.zone;
    if (!this.byZone.has(zone)) this.byZone.set(zone, new Set());
    this.byZone.get(zone)!.add(entity.id);
  }

  removeEntity(id: string): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.byZone.get(e.position.zone)?.delete(id);
    this.entities.delete(id);
  }

  private _relocate(entity: Entity, toZoneId: string, x: number, y: number, facing: Direction | null = null): Entity {
    this.byZone.get(entity.position.zone)?.delete(entity.id);
    entity.position.zone = toZoneId;
    entity.position.x = x;
    entity.position.y = y;
    if (facing && entity.type !== 'ground_item' && entity.type !== 'corpse') entity.facing = facing;
    if (!this.byZone.has(toZoneId)) this.byZone.set(toZoneId, new Set());
    this.byZone.get(toZoneId)!.add(entity.id);
    return entity;
  }

  getZoneSpawnPoint(zoneId: string, override?: SpawnPoint): { x: number; y: number } {
    const z = this.zones[zoneId];
    if (!z) return { x: 0, y: 0 };
    const sp = override ?? z.def?.spawn_point;
    let candidate: { x: number; y: number } | null = null;
    if (sp) {
      if ('focal' in sp) {
        candidate = z.focal ?? null;
      } else if ('region' in sp) {
        const r = z.bounds[sp.region];
        if (r) candidate = { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
      } else {
        candidate = { x: sp.x, y: sp.y };
      }
    }
    if (!candidate) candidate = { x: Math.floor(z.width / 2), y: Math.floor(z.height / 2) };
    return nearestWalkable(z.grid, candidate, z.width, z.height, this.defs.blockingTiles) ?? candidate;
  }

  entitiesInZone(zoneId: string): Entity[] {
    const ids = this.byZone.get(zoneId) || new Set<string>();
    return [...ids].map(id => this.entities.get(id)).filter((e): e is Entity => Boolean(e));
  }

  canMoveTo(zoneId: string, x: number, y: number): boolean {
    if (zoneId === WILD) {
      if (!this.wildSeeds) return false;
      return !isWildBlocked(wildTileAt(x, y, this.wildSeeds, this.atlas ?? undefined), this.atlas ?? undefined);
    }
    const z = this.zones[zoneId];
    if (!z) return false;
    return !isBlocked(z.grid, x, y, this.defs.blockingTiles);
  }

  /** Nearest walkable wilderness tile to (x,y) — spiral search. Used when
   *  landing a player in the open via a portal. */
  private _findFreeWild(x0: number, y0: number, maxRadius = 12): { x: number; y: number } {
    if (this.canMoveTo(WILD, x0, y0) && !this.entityAt(WILD, x0, y0)) return { x: x0, y: y0 };
    for (let r = 1; r <= maxRadius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x0 + dx, ny = y0 + dy;
          if (this.canMoveTo(WILD, nx, ny) && !this.entityAt(WILD, nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return { x: x0, y: y0 };
  }

  entityAt(zoneId: string, x: number, y: number): Entity | null {
    const ids = this.byZone.get(zoneId);
    if (!ids) return null;
    for (const id of ids) {
      const e = this.entities.get(id);
      if (!e || (e as GroundItemEntity).passable) continue;
      if (e.position.x === x && e.position.y === y) return e;
    }
    return null;
  }

  groundItemsAt(zoneId: string, x: number, y: number): GroundItemEntity[] {
    const ids = this.byZone.get(zoneId);
    const out: GroundItemEntity[] = [];
    if (!ids) return out;
    for (const id of ids) {
      const e = this.entities.get(id);
      if (!e || e.type !== 'ground_item') continue;
      if (e.position.x === x && e.position.y === y) out.push(e);
    }
    return out;
  }

  regionBounds(zoneId: string, regionId: string): RegionBounds | null {
    return this.zones[zoneId]?.bounds[regionId] || null;
  }

  /**
   * The one place a discontinuous relocation announces itself, so every source
   * of teleportation looks the same to a player: a puff of smoke where the
   * entity was, and another where it reappears. Set by the server (index.ts);
   * unset in tools and tests, which have no sockets to emit on.
   *
   * Deliberately NOT hooked into _relocate. Walking off the edge of a zone
   * (transitionPlayer) also relocates, and a smoke puff on every zone seam
   * would turn ordinary travel into a firework show — the distinction between
   * "moved" and "teleported" is the caller's to make, so the explicit teleport
   * entry points below call this and the continuous ones do not.
   */
  onTeleport: ((fx: TeleportFxEvent) => void) | null = null;

  /** Emit the departure/arrival pair for an entity that has ALREADY been moved.
   *  `from` is where it stood beforehand. Public so the ability engine's blink,
   *  which repositions in place rather than through teleportPlayer, funnels
   *  through the same effect. */
  teleportFx(entity: Entity, from: { zone: string; x: number; y: number }): void {
    if (!this.onTeleport) return;
    this.onTeleport({ entityId: entity.id, zoneId: from.zone, x: from.x, y: from.y, phase: 'depart' });
    this.onTeleport({
      entityId: entity.id,
      zoneId: entity.position.zone,
      x: entity.position.x,
      y: entity.position.y,
      phase: 'arrive',
    });
  }

  teleportPlayer(entity: PlayerEntity, toZoneId: string, toX: number, toY: number): boolean {
    const from = { ...entity.position };
    if (toZoneId === WILD) {
      const { x, y } = this._findFreeWild(toX | 0, toY | 0);
      this._relocate(entity, WILD, x, y);
      this.teleportFx(entity, from);
      return true;
    }
    const toZone = this.zones[toZoneId];
    if (!toZone) return false;
    const ex = clamp(toX, 0, toZone.width - 1);
    const ey = clamp(toY, 0, toZone.height - 1);
    const { x, y } = this._findFreeNear(toZoneId, ex, ey) || { x: ex, y: ey };
    this._relocate(entity, toZoneId, x, y);
    this.teleportFx(entity, from);
    return true;
  }

  portalAt(zoneId: string, x: number, y: number) {
    const portals = this.zones[zoneId]?.def?.portals || [];
    return portals.find(p => p.at?.x === x && p.at?.y === y) || null;
  }

  /** Dungeon site whose entrance tile sits on (x,y), if any. Drives the
   *  wilderness→dungeon transition, the mirror of wildReturnTargetAt. */
  wildSiteAt(x: number, y: number): DungeonSite | null {
    if (!this.atlas) return null;
    return siteAt(this.atlas, x, y);
  }

  /** Settlement + gate whose wilderness gate tile sits on (x,y), if any.
   *  Drives the wilderness→settlement return transition. */
  wildReturnTargetAt(x: number, y: number): { zoneId: string; gate: Gate } | null {
    if (!this.atlas) return null;
    for (const st of this.atlas.settlements) {
      for (const g of st.gates) {
        if (g.wildX === x && g.wildY === y) return { zoneId: st.id, gate: g };
      }
    }
    return null;
  }

  /** Move a player from the wilderness back into an enclosed zone, dropping them
   *  just inside the gap they returned through (gate.returnX/Y). */
  exitWilderness(entity: PlayerEntity, toZoneId: string, gate?: Gate): boolean {
    if (!this.zones[toZoneId]) return false;
    const from = { ...entity.position };
    const target = gate ? { x: gate.returnX, y: gate.returnY } : this.getZoneSpawnPoint(toZoneId);
    const { x, y } = this._findFreeNear(toZoneId, target.x, target.y) || target;
    this._relocate(entity, toZoneId, x, y);
    this.teleportFx(entity, from);
    return true;
  }

  transitionPlayer(entity: PlayerEntity, dir: Direction, toZoneId: string): boolean {
    const toZone = this.zones[toZoneId];
    if (!toZone) return false;
    const { x: fromX, y: fromY } = entity.position;
    let entryX: number, entryY: number;
    if (dir === 'north')      { entryX = clamp(fromX, 0, toZone.width - 1);  entryY = toZone.height - 1; }
    else if (dir === 'south') { entryX = clamp(fromX, 0, toZone.width - 1);  entryY = 0; }
    else if (dir === 'east')  { entryX = 0;                                  entryY = clamp(fromY, 0, toZone.height - 1); }
    else                       { entryX = toZone.width - 1;                   entryY = clamp(fromY, 0, toZone.height - 1); }
    const { x, y } = this._findFreeNear(toZoneId, entryX, entryY) || { x: entryX, y: entryY };
    this._relocate(entity, toZoneId, x, y, dir);
    return true;
  }

  /** Nearest unoccupied walkable tile to (x0,y0) — spiral search. Public so the
   *  autopath chase system (loop.ts) can re-aim at a moving target without
   *  duplicating the search. */
  findFreeNear(zoneId: string, x0: number, y0: number, maxRadius = 8): { x: number; y: number } | null {
    return this._findFreeNear(zoneId, x0, y0, maxRadius);
  }

  private _findFreeNear(zoneId: string, x0: number, y0: number, maxRadius = 8): { x: number; y: number } | null {
    if (this.canMoveTo(zoneId, x0, y0) && !this.entityAt(zoneId, x0, y0)) return { x: x0, y: y0 };
    for (let r = 1; r <= maxRadius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x0 + dx, ny = y0 + dy;
          if (this.canMoveTo(zoneId, nx, ny) && !this.entityAt(zoneId, nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  snapshotZone(zoneId: string): ZoneSnapshot | null {
    const z = this.zones[zoneId];
    if (!z) return null;
    return {
      id: zoneId,
      name: z.def?.name ?? (z.def?.biome ? z.def.biome.charAt(0).toUpperCase() + z.def.biome.slice(1) : zoneId),
      width: z.width,
      height: z.height,
      grid: z.grid,
      timeOfDay: this.timeOfDay,
      no_edge_haze: z.def?.no_edge_haze,
      tileset: z.def?.tileset,
      tick: this.currentTick,
      entities: this.entitiesInZone(zoneId).map((e) => this.entityToSnapshot(e)),
      activeZones: [...this.activeZones.values()]
        .filter((az) => az.zoneId === zoneId)
        .map((az) => ({ id: az.id, x: az.x, y: az.y, radius: az.radius, expiresAt: az.expiresAt, kind: az.effect.kind })),
    };
  }

  /** Map one entity to its wire snapshot. Shared by whole-zone snapshots and
   *  the per-chunk wilderness stream so both produce identical entity shapes. */
  entityToSnapshot(e: Entity): EntitySnapshot {
    const zoneId = e.position.zone;
    const sprite = (e as MobEntity | GroundItemEntity).sprite
      || (e.type === 'player' ? 'player' : null);
    const snap: EntitySnapshot = {
      id: e.id,
      type: e.type,
      name: e.name,
      sprite,
      position: e.position,
      components: (e as PlayerEntity | MobEntity).components,
    };
    if (e.type === 'player') {
      snap.klass  = (e as PlayerEntity).klass;
      snap.color  = (e as PlayerEntity).color;
      snap.facing = (e as PlayerEntity).facing;
    }
    if (e.type === 'mob') {
      const mob = e as MobEntity;
      const templateId = mob.components.ai?.template_id;
      snap.templateId = templateId;
      snap.spawnId    = mob.components.ai?.spawn_id;
      snap.level      = mob.level;
      if (templateId && this.defs.mobs[templateId]?.shop?.length) snap.hasShop = true;
      { const tc = templateId ? this.defs.mobs[templateId]?.trainer?.class : undefined; if (tc) snap.trainerClass = tc; }
      if (mob.components.ai?.fixture) snap.fixture = true;
      const tmpl = templateId ? this.defs.mobs[templateId] : undefined;
      if (tmpl?.role === 'npc' || tmpl?.friendly) snap.npc = true;
      snap.disposition = (tmpl?.role === 'npc' || tmpl?.friendly) ? 'friendly'
        : tmpl?.role === 'passive' ? 'passive'
        : 'hostile';
      if (mob.components.ai?.sign && mob.dialogue.length) snap.signText = mob.dialogue;
      if (mob.components.ai?.board_id) snap.boardId = `${zoneId}:${mob.components.ai.board_id}`;
      const lr = templateId ? this.defs.mobs[templateId]?.light_radius : undefined;
      if (lr) snap.lightRadius = lr;
      const ds = templateId ? this.defs.mobs[templateId]?.draw_scale : undefined;
      if (ds != null) snap.drawScale = ds;
    }
    if (e.type === 'ground_item') {
      snap.base = e.base;
      snap.gold = e.gold;
      snap.item = e.item;
    }
    if (e.type === 'corpse') {
      snap.loot = e.loot;
      snap.createdAtMs = e.createdAtMs;
    }
    return snap;
  }
}
