// Continuous-wilderness streaming (docs/rework.md §8). The open world is one
// effectively-infinite field; we stream it as N×N chunks, one Socket.IO room
// per chunk (R8.1). Terrain is NEVER sent — the client derives it from the same
// shared field module (R8.2). This module owns:
//   - which chunks a player is subscribed to (load radius),
//   - deterministic per-chunk mob spawns, materialized while observed (§7.1),
//   - per-chunk entity broadcasts.

import { randomUUID } from 'node:crypto';
import type { Server as IOServer } from 'socket.io';
import { DEFAULT_RESPAWN_SECONDS as DEFAULT_SITE_RESPAWN_SECONDS, TICKS_PER_SECOND, type World } from './world.ts';
import { makeMob } from './entities.ts';
import { CHUNK_SIZE, WILD, WILD_LOAD_RADIUS } from '../../shared/worldgen/config.ts';
import { biomeAt, dangerAt, getLevelBand, isWildBlocked, wildTileAt } from '../../shared/worldgen/field.ts';
import { stampTileAt } from '../../shared/worldgen/stamps.ts';
import type { SiteSpawn } from './siteSpawns.ts';
import { mulberry32, gaussianSample } from '../../shared/worldgen/noise.ts';
import type { RegionAtlas } from '../../shared/worldgen/atlas.ts';
import type {
  ActiveZoneSnapshot, ClientToServerEvents, Entity, MobTemplate, PlayerEntity, ServerToClientEvents, WorldBiome,
} from '../../shared/types.ts';

type IO = IOServer<ClientToServerEvents, ServerToClientEvents>;

export const chunkOf = (x: number, y: number) => ({
  cx: Math.floor(x / CHUNK_SIZE),
  cy: Math.floor(y / CHUNK_SIZE),
});
const chunkKey = (cx: number, cy: number) => `${cx},${cy}`;
export const roomName = (cx: number, cy: number) => `wild:${cx},${cy}`;

// Every role spawns in the open except npc (quest-givers/villagers, kept out
// of the wilderness on purpose) — a denylist so new roles are huntable by
// default with no registry edit needed here.
function isHuntable(t: MobTemplate): boolean {
  return t.role !== 'npc'
    && !t.friendly && !t.fixture && !t.sign && !t.inert
    && !t.shop && !t.trainer && !t.board_id;
}

// Levels a template is thematically valid at. Falls back to a small buffer
// around its authored `level` when `level_range` isn't set (see MobTemplate).
function levelRange(t: MobTemplate): [number, number] {
  return t.level_range ?? [Math.max(1, t.level - 2), t.level + 2];
}

function inLevelRange(t: MobTemplate, level: number): boolean {
  const [lo, hi] = levelRange(t);
  return level >= lo && level <= hi;
}

// Biomes a template may spawn in. No `biomes` (or empty) = any biome, so
// untagged mobs keep spawning everywhere (the filter is purely additive).
function matchesBiome(t: MobTemplate, biome: WorldBiome): boolean {
  return !t.biomes?.length || t.biomes.includes(biome);
}

export class Wilderness {
  private world: World;
  private atlas: RegionAtlas;
  private io: IO;
  /** chunkKey → entityIds observing it. */
  private subscribers = new Map<string, Set<string>>();
  /** chunkKey → mob entity ids spawned for that chunk. */
  private chunkMobs = new Map<string, Set<string>>();
  /** entityId → chunkKeys it is currently subscribed to. */
  private playerChunks = new Map<string, Set<string>>();
  private huntable: MobTemplate[] = [];
  /** chunkKey → authored site spawns whose tile falls in that chunk. */
  private siteSpawns = new Map<string, SiteSpawn[]>();
  /** SiteSpawn.key → the entity currently standing for it. */
  private liveSiteMobs = new Map<string, string>();
  /** SiteSpawn.key → tick it may be re-spawned at, after being killed. */
  private siteRespawnAt = new Map<string, number>();

  constructor(world: World, atlas: RegionAtlas, io: IO) {
    this.world = world;
    this.atlas = atlas;
    this.io = io;
    this.refreshTemplates();
  }

  /**
   * Point the streamer at a new epoch's world (docs/rotating-wilds.md). Drops
   * every scrap of per-chunk state: the mob rosters were rolled from the old
   * seed, and `playerChunks` must go too or syncPlayer sees each player as
   * already subscribed to their surroundings and never re-sends them.
   *
   * The caller owns removing the culled mob entities from the world and
   * re-syncing players afterwards; this only clears the streamer's bookkeeping.
   */
  rotate(atlas: RegionAtlas): void {
    this.atlas = atlas;
    this.subscribers.clear();
    this.chunkMobs.clear();
    this.playerChunks.clear();
    // The site plan is resolved from the OLD epoch's layout — every position in
    // it is meaningless now. The caller installs the next epoch's plan.
    this.siteSpawns.clear();
    this.liveSiteMobs.clear();
    this.siteRespawnAt.clear();
    this.refreshTemplates();
  }

  /** Install this epoch's authored site population (see siteSpawns.ts). Bucketed
   *  by chunk so materializeChunk is an O(1) lookup rather than a scan. */
  setSiteSpawns(spawns: readonly SiteSpawn[]): void {
    this.siteSpawns.clear();
    for (const sp of spawns) {
      const { cx, cy } = chunkOf(sp.x, sp.y);
      const key = chunkKey(cx, cy);
      let bucket = this.siteSpawns.get(key);
      if (!bucket) { bucket = []; this.siteSpawns.set(key, bucket); }
      bucket.push(sp);
    }
  }

  /** Re-read the spawnable mob roster from world.defs. Must run after any
   *  definition reload — the roster is filtered once and cached, so without
   *  this a hot-reloaded (or newly added) mob never reaches the wilderness. */
  refreshTemplates(): void {
    this.huntable = Object.values(this.world.defs.mobs).filter(isHuntable);
  }

  /** Settlement whose wilderness gate sits on (x,y), if any (return-portal check). */
  returnTargetAt(x: number, y: number): string | null {
    for (const st of this.atlas.settlements) {
      for (const g of st.gates) {
        if (g.wildX === x && g.wildY === y) return st.id;
      }
    }
    return null;
  }

  // ── Subscription / room management ─────────────────────────────────────────

  /** Reconcile a player's chunk subscriptions to their current position. Joins
   *  newly-in-range rooms (materializing their mobs + sending an initial chunk
   *  payload) and leaves out-of-range rooms (despawning unobserved mobs). */
  syncPlayer(player: PlayerEntity, socketIds: Iterable<string>): void {
    const sids = [...socketIds];
    // No live socket to join/emit to (e.g. a disconnect landed the same tick as
    // this move) — recording subscriptions nobody holds would leak chunks that
    // never get cleaned up until removePlayer eventually runs. Skip the
    // reconcile; the disconnect path owns cleanup.
    if (sids.length === 0) return;
    const { cx, cy } = chunkOf(player.position.x, player.position.y);
    const desired = new Set<string>();
    for (let dx = -WILD_LOAD_RADIUS; dx <= WILD_LOAD_RADIUS; dx++) {
      for (let dy = -WILD_LOAD_RADIUS; dy <= WILD_LOAD_RADIUS; dy++) {
        desired.add(chunkKey(cx + dx, cy + dy));
      }
    }
    const prev = this.playerChunks.get(player.id) ?? new Set<string>();

    for (const key of desired) {
      if (prev.has(key)) continue;
      const [kx, ky] = key.split(',').map(Number) as [number, number];
      this.materializeChunk(kx, ky);
      this.addSub(key, player.id);
      for (const sid of sids) this.io.sockets.sockets.get(sid)?.join(roomName(kx, ky));
      // Initial payload for the joining player only.
      const entities = this.chunkEntities(kx, ky);
      const activeZones = this.chunkActiveZones(kx, ky);
      for (const sid of sids) {
        this.io.sockets.sockets.get(sid)?.emit('wild_chunk', { cx: kx, cy: ky, entities, tick: this.world.currentTick, activeZones });
      }
    }
    for (const key of prev) {
      if (desired.has(key)) continue;
      const [kx, ky] = key.split(',').map(Number) as [number, number];
      this.removeSub(key, player.id);
      for (const sid of sids) {
        this.io.sockets.sockets.get(sid)?.leave(roomName(kx, ky));
        this.io.sockets.sockets.get(sid)?.emit('wild_leave', { cx: kx, cy: ky });
      }
    }
    this.playerChunks.set(player.id, desired);
  }

  /** Drop a player from all wilderness subscriptions (logout / exit to a zone). */
  removePlayer(playerId: string, socketIds: Iterable<string>): void {
    const prev = this.playerChunks.get(playerId);
    if (!prev) return;
    const sids = [...socketIds];
    for (const key of prev) {
      const [kx, ky] = key.split(',').map(Number) as [number, number];
      this.removeSub(key, playerId);
      for (const sid of sids) this.io.sockets.sockets.get(sid)?.leave(roomName(kx, ky));
    }
    this.playerChunks.delete(playerId);
  }

  private addSub(key: string, playerId: string): void {
    let set = this.subscribers.get(key);
    if (!set) { set = new Set(); this.subscribers.set(key, set); }
    set.add(playerId);
  }

  private removeSub(key: string, playerId: string): void {
    const set = this.subscribers.get(key);
    if (!set) return;
    set.delete(playerId);
    if (set.size === 0) {
      this.subscribers.delete(key);
      this.despawnChunk(key);
    }
  }

  // ── Per-chunk entity broadcast ──────────────────────────────────────────────

  /** Push the authoritative entity list for every observed chunk to its room.
   *  Called each tick the wilderness is dirty. Full-replace semantics: a moving
   *  entity naturally leaves one chunk's list and joins the next. */
  broadcast(): void {
    for (const key of this.subscribers.keys()) {
      const [kx, ky] = key.split(',').map(Number) as [number, number];
      this.io.to(roomName(kx, ky)).emit('wild_chunk', {
        cx: kx, cy: ky,
        entities: this.chunkEntities(kx, ky),
        tick: this.world.currentTick,
        activeZones: this.chunkActiveZones(kx, ky),
      });
    }
  }

  private chunkEntities(cx: number, cy: number) {
    const out = [];
    for (const e of this.world.entitiesInZone(WILD)) {
      const c = chunkOf(e.position.x, e.position.y);
      if (c.cx === cx && c.cy === cy) out.push(this.world.entityToSnapshot(e));
    }
    return out;
  }

  // Ground zones (see World.activeZones / ZoneEffect) pushed to every chunk
  // their radius actually overlaps, not just the chunk their center falls in —
  // combat/heal application already applies zone-wide (see wild room broadcast),
  // so a player just across a chunk boundary but inside the effect's radius
  // needs it in their chunk feed too, or they take damage/heal with nothing drawn.
  private chunkActiveZones(cx: number, cy: number): ActiveZoneSnapshot[] {
    const out: ActiveZoneSnapshot[] = [];
    const minX = cx * CHUNK_SIZE, minY = cy * CHUNK_SIZE;
    const maxX = minX + CHUNK_SIZE, maxY = minY + CHUNK_SIZE;
    for (const z of this.world.activeZones.values()) {
      if (z.zoneId !== WILD) continue;
      const closestX = Math.max(minX, Math.min(z.x, maxX));
      const closestY = Math.max(minY, Math.min(z.y, maxY));
      const dx = z.x - closestX, dy = z.y - closestY;
      if (dx * dx + dy * dy > z.radius * z.radius) continue;
      out.push({ id: z.id, x: z.x, y: z.y, radius: z.radius, expiresAt: z.expiresAt, kind: z.effect.kind });
    }
    return out;
  }

  // ── Deterministic spawns ────────────────────────────────────────────────────

  private materializeChunk(cx: number, cy: number): void {
    const key = chunkKey(cx, cy);
    if (this.chunkMobs.has(key)) return;
    const ids = new Set<string>();
    this.chunkMobs.set(key, ids);
    // Authored site population first: it is named content, not a roll, and it
    // claims its tiles before the procedural scatter looks for free ground.
    this.materializeSiteSpawns(key, ids, this.world.currentTick);
    if (this.huntable.length === 0 || !this.world.wildSeeds) return;

    const rng = mulberry32((this.atlas.numericSeed ^ Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0);
    const cxTile = cx * CHUNK_SIZE + CHUNK_SIZE / 2;
    const cyTile = cy * CHUNK_SIZE + CHUNK_SIZE / 2;
    const danger = dangerAt(cxTile, cyTile, this.world.wildSeeds, this.atlas);
    const band = getLevelBand(danger);
    const count = Math.round(1 + danger * 3); // 1..4 candidates, denser when deadlier

    // The band's [minLevel, maxLevel] is treated as ±1 SD around its center, so
    // sampled levels occasionally spill past the nominal band instead of
    // hard-clamping at chunk boundaries.
    const bandCenter = (band.minLevel + band.maxLevel) / 2;
    const bandSd = (band.maxLevel - band.minLevel) / 2;

    for (let i = 0; i < count; i++) {
      if (rng() > 0.7) continue;
      const level = Math.max(1, Math.min(100, Math.round(gaussianSample(rng, bandCenter, bandSd))));
      const anchor = this.findSpawnTile(cx, cy, rng);
      if (!anchor) continue;
      // Only spawn mobs valid at this level AND biome (no starter critters in the
      // deep field, no desert mobs in tundra); if none fit here, skip rather than
      // mis-theme. Biome is sampled at the actual spawn tile, not the chunk center.
      const biome = biomeAt(anchor.x, anchor.y, this.world.wildSeeds!);
      const candidates = this.huntable.filter((t) => inLevelRange(t, level) && matchesBiome(t, biome));
      if (candidates.length === 0) continue;
      const template = candidates[Math.floor(rng() * candidates.length)]!;
      if (template.pack) {
        this.spawnPack(template, anchor, level, rng, ids);
      } else {
        const mob = makeMob(template, { zone: WILD, x: anchor.x, y: anchor.y, level });
        this.world.addEntity(mob);
        ids.add(mob.id);
      }
    }
  }

  /** Spawn every authored entity in this chunk that is neither alive nor still
   *  cooling down. Idempotent, so it doubles as the respawn step. */
  private materializeSiteSpawns(key: string, ids: Set<string>, tick: number): boolean {
    const bucket = this.siteSpawns.get(key);
    if (!bucket) return false;
    let spawned = false;
    for (const sp of bucket) {
      const liveId = this.liveSiteMobs.get(sp.key);
      if (liveId && this.world.entities.has(liveId)) continue;
      if (liveId) {
        // It existed and is gone: killed, or despawned with its chunk. Start the
        // clock now rather than at the moment of death, so a camp cleared while
        // you stood in it does not refill the instant you walk back in.
        this.liveSiteMobs.delete(sp.key);
        this.siteRespawnAt.set(sp.key, tick + Math.max(1, Math.round((sp.respawnSeconds ?? DEFAULT_SITE_RESPAWN_SECONDS) * TICKS_PER_SECOND)));
        continue;
      }
      const due = this.siteRespawnAt.get(sp.key);
      if (due !== undefined && tick < due) continue;
      const template = this.world.defs.mobs[sp.entity];
      if (!template) continue;
      // No isHuntable filter here on purpose — that denylist exists to keep
      // quest-givers and fixtures out of the PROCEDURAL roll. Naming one in a
      // camp's spawn list is the author saying they want it there.
      const mob = makeMob(template, { zone: WILD, x: sp.x, y: sp.y, level: sp.level, spawnId: sp.spawnId });
      if (sp.region) mob.components.ai.spawn_region = sp.region;
      this.world.addEntity(mob);
      ids.add(mob.id);
      this.liveSiteMobs.set(sp.key, mob.id);
      this.siteRespawnAt.delete(sp.key);
      spawned = true;
    }
    return spawned;
  }

  /**
   * Respawn authored site entities that have died. The wilderness has no
   * equivalent of World._rebuildZone — it iterates `defs.zones` and WILD is not
   * one of them — so this is the wild's respawn tick.
   *
   * Only OBSERVED chunks are considered: an unobserved chunk has been despawned
   * wholesale and will re-materialize identically when someone returns, so
   * running timers out there would be work nobody can see.
   */
  tickSiteSpawns(tick: number): boolean {
    if (this.siteSpawns.size === 0) return false;
    let dirty = false;
    for (const key of this.subscribers.keys()) {
      const ids = this.chunkMobs.get(key);
      if (!ids) continue;
      if (this.materializeSiteSpawns(key, ids, tick)) dirty = true;
    }
    return dirty;
  }

  // Spawns a whole pack around `anchor` instead of the lone-mob path above.
  // `pack.members`, if set, spawns that exact roster (each at its own template
  // level, e.g. a goblin_shaman leading two goblin_chanters) rather than N
  // copies of `template` at the band-sampled `level`. Every packmate shares a
  // groupId (joint aggro, see alertGroup in ai.ts) and wander_anchor (roams
  // together instead of drifting apart independently).
  private spawnPack(
    template: MobTemplate, anchor: { x: number; y: number }, level: number, rng: () => number, ids: Set<string>,
  ): void {
    const pack = template.pack!;
    const groupId = randomUUID();
    const wanderAnchor = { x: anchor.x, y: anchor.y, radius: pack.radius };
    const roster: { member: MobTemplate; memberLevel: number }[] = pack.members
      ? pack.members
          .map((id) => this.world.defs.mobs[id])
          .filter((t): t is MobTemplate => !!t)
          .map((t) => ({ member: t, memberLevel: t.level }))
      : Array.from({ length: this.rollPackSize(pack, rng) }, () => ({ member: template, memberLevel: level }));

    for (const { member, memberLevel } of roster) {
      const pos = this.findSpawnTileNear(anchor, pack.radius, rng);
      if (!pos) continue;
      const mob = makeMob(member, { zone: WILD, x: pos.x, y: pos.y, level: memberLevel, groupId, wanderAnchor });
      this.world.addEntity(mob);
      ids.add(mob.id);
    }
  }

  private rollPackSize(pack: NonNullable<MobTemplate['pack']>, rng: () => number): number {
    const [lo, hi] = pack.size ?? [3, 3];
    return lo + Math.floor(rng() * (hi - lo + 1));
  }

  private despawnChunk(key: string): void {
    const ids = this.chunkMobs.get(key);
    if (!ids) return;
    // Forget the authored entities in this chunk BEFORE removing them. Nobody
    // is watching, so this is not a death: dropping the mapping while the entity
    // still exists is how materializeSiteSpawns tells "despawned, put it back"
    // apart from "killed, start the respawn clock".
    for (const sp of this.siteSpawns.get(key) ?? []) {
      const liveId = this.liveSiteMobs.get(sp.key);
      const e = liveId ? this.world.entities.get(liveId) : undefined;
      // Skip mid-fight survivors, which the loop below keeps alive — forgetting
      // one would spawn a second copy of it on top of the first.
      if (e && !(e.type === 'mob' && e.components.ai?.target)) this.liveSiteMobs.delete(sp.key);
    }
    const survivors = new Set<string>();
    for (const id of ids) {
      const e = this.world.entities.get(id);
      // Keep mobs that are mid-fight, and keep tracking them under this chunk key
      // so a later despawnChunk call (once they're idle) can still clean them up —
      // otherwise materializeChunk would treat the chunk as empty and spawn a
      // fresh roster on top of the still-alive survivor.
      if (e && e.type === 'mob' && e.components.ai?.target) { survivors.add(id); continue; }
      if (e) this.world.removeEntity(id);
    }
    if (survivors.size > 0) this.chunkMobs.set(key, survivors);
    else this.chunkMobs.delete(key);
  }

  /** Any baked footprint's rectangle, transparent cells included. */
  private insideFootprint(x: number, y: number): boolean {
    for (const st of this.atlas.stamps) {
      if (st.kind !== 'grid') continue;
      if (x >= st.ox && y >= st.oy && x < st.ox + st.w && y < st.oy + st.h) return true;
    }
    return false;
  }

  private findSpawnTile(cx: number, cy: number, rng: () => number): { x: number; y: number } | null {
    return this.findSpawnTileWhere(rng, () => ({
      x: cx * CHUNK_SIZE + Math.floor(rng() * CHUNK_SIZE),
      y: cy * CHUNK_SIZE + Math.floor(rng() * CHUNK_SIZE),
    }));
  }

  // Same walkability rules as findSpawnTile, but candidates cluster around a
  // pack anchor instead of scattering across the whole chunk.
  private findSpawnTileNear(
    anchor: { x: number; y: number }, radius: number, rng: () => number,
  ): { x: number; y: number } | null {
    return this.findSpawnTileWhere(rng, () => ({
      x: anchor.x + Math.floor(rng() * (radius * 2 + 1)) - radius,
      y: anchor.y + Math.floor(rng() * (radius * 2 + 1)) - radius,
    }));
  }

  private findSpawnTileWhere(
    rng: () => number, candidate: () => { x: number; y: number },
  ): { x: number; y: number } | null {
    const seeds = this.world.wildSeeds!;
    // 40 attempts (was 12) — in dense mountain/water/stamp regions 12 tries
    // could exhaust without finding open ground, silently under-spawning.
    for (let attempt = 0; attempt < 40; attempt++) {
      const { x, y } = candidate();
      const tile = wildTileAt(x, y, seeds, this.atlas);
      if (tile === 'water' || tile === 'swamp_water' || tile === 'portal' || isWildBlocked(tile, this.atlas)) continue;
      // Keep stamped ground (the grove + its cleared mouths) mob-free so the
      // treeline reads as safe ground, not a monster camp.
      if (stampTileAt(x, y, this.atlas.stamps)) continue;
      // An authored footprint is off limits WHOLE, not just where it painted:
      // its transparent cells are the gaps between the tents, and a wandering
      // band mob in there undercuts the authorship the camp exists for. Its
      // population comes from the site's own spawn list instead.
      if (this.insideFootprint(x, y)) continue;
      if (this.world.entityAt(WILD, x, y)) continue;
      return { x, y };
    }
    return null;
  }
}

export type { Entity };
