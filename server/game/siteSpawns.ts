// Authored entities in the open wilderness (docs/plan-poi-authoring.md gap 4).
//
// Wild mobs come from exactly one source otherwise: Wilderness.materializeChunk,
// a per-chunk procedural roll against a roster that DENYLISTS npc, friendly,
// fixture, sign, inert, shop, trainer and board-carrying templates — "quest
// givers/villagers, kept out of the wilderness on purpose". That filter is right
// for the procedural path and stays untouched. A camp needs exactly those
// templates, so this is the second source: a footprint's authored `spawns`,
// named explicitly rather than rolled, resolved against the baked layout.
//
// The resolution is deterministic in (site, epoch): same epoch → same camp
// population in the same places, which is what lets a chunk be despawned when
// nobody is looking and materialized again identically when someone returns.
//
// Positions are resolved by REGION, never by coordinate, because the arrangement
// re-rolls every epoch (plan Consequence 1). A boss pinned at footprint-local
// (34, 21) is inside a tent wall tomorrow.

import { bakeSiteFootprint } from './mapgen/bake.ts';
import { mulberry32, resolveSeed } from '../../shared/worldgen/noise.ts';
import type { RegionAtlas } from '../../shared/worldgen/atlas.ts';
import type { DungeonDef, Prefab, ZoneDef, ZoneSpawn } from '../../shared/types.ts';

/** One authored entity, resolved to a signed world tile for this epoch. */
export interface SiteSpawn {
  /** `${siteId}:${spawnIndex}:${n}` — stable across a despawn/materialize cycle,
   *  which is what makes "is this one still alive?" answerable. */
  key: string;
  siteId: string;
  entity: string;
  x: number;
  y: number;
  level?: number;
  spawnId?: string;
  region?: string;
  respawnSeconds?: number;
}

/** Tiles a spawn may never be placed on, beyond the zone's own blocking set.
 *  `portal` is the site entrance: a mob standing on it would be unattackable
 *  from the far side and would greet every arriving player nose-to-nose. */
const UNSPAWNABLE = new Set(['portal']);

function placeable(grid: string[][], x: number, y: number, blocking: ReadonlySet<string>): boolean {
  const t = grid[y]?.[x];
  return t !== undefined && !blocking.has(t) && !UNSPAWNABLE.has(t);
}

/**
 * Resolve every authored spawn on every placed site to world coordinates.
 *
 * Re-bakes each footprint rather than taking the grid off the atlas: the atlas
 * carries only the RLE'd stamp (no `bounds`, no grid), and the bake is pure and
 * cheap enough — a few milliseconds per site, once per epoch — that keeping a
 * second copy of it alive would cost more than recomputing it.
 */
export function resolveSiteSpawns(
  atlas: Pick<RegionAtlas, 'sites' | 'epoch'>,
  dungeons: readonly DungeonDef[],
  blockingTiles: ReadonlySet<string>,
  prefabs: Record<string, Prefab> = {},
): SiteSpawn[] {
  const byId = new Map(dungeons.map(d => [d.id, d]));
  const out: SiteSpawn[] = [];

  for (const site of atlas.sites) {
    const footprint = byId.get(site.id)?.footprint;
    if (!footprint?.spawns?.length) continue;
    const seed = `${site.id}:footprint:${atlas.epoch}`;
    const baked = bakeSiteFootprint(footprint as ZoneDef, seed, site.worldX, site.worldY, blockingTiles, prefabs);
    const rng = mulberry32(resolveSeed(`${seed}:spawns`));
    // One occupancy set across the whole footprint, so two spawn entries
    // scattering into the same region cannot stack on one tile.
    const taken = new Set<number>();

    footprint.spawns.forEach((spawn, index) => {
      const count = spawn.at ? 1 : Math.max(1, spawn.count ?? 1);
      for (let n = 0; n < count; n++) {
        const local = placeSpawn(spawn, baked, blockingTiles, rng, taken, site.id, index);
        if (!local) continue;
        taken.add(local.y * baked.width + local.x);
        out.push({
          key: `${site.id}:${index}:${n}`,
          siteId: site.id,
          entity: spawn.entity,
          x: baked.stamp.ox + local.x,
          y: baked.stamp.oy + local.y,
          level: spawn.level,
          spawnId: spawn.spawn_id,
          region: spawn.region,
          respawnSeconds: spawn.respawn_seconds,
        });
      }
    });
  }
  return out;
}

function placeSpawn(
  spawn: ZoneSpawn,
  baked: { grid: string[][]; width: number; height: number; bounds: Record<string, { x: number; y: number; w: number; h: number }> },
  blocking: ReadonlySet<string>,
  rng: () => number,
  taken: Set<number>,
  siteId: string,
  index: number,
): { x: number; y: number } | null {
  // `at` is an exact footprint-local tile, and is placed with no walkability
  // check so a torch can sit on a tent wall — the same escape hatch enclosed
  // zones give it. It is the one form that does NOT survive a re-roll, so it is
  // for decorations whose exact spot does not matter, not for a boss.
  if (spawn.at) return { x: spawn.at.x, y: spawn.at.y };

  let rect: { x: number; y: number; w: number; h: number };
  if (spawn.area) {
    rect = spawn.area;
  } else if (spawn.region) {
    const b = baked.bounds[spawn.region];
    if (!b) {
      if (!spawn.if_region) {
        console.warn(`[site] spawn '${spawn.entity}' on '${siteId}' names region '${spawn.region}', which did not generate this epoch — skipped.`);
      }
      return null;
    }
    rect = b;
  } else {
    // No region named: scatter across the whole footprint. Authored camp mobs
    // "surrounding the outside of the camp and distributed in the area" are
    // exactly this case.
    rect = { x: 0, y: 0, w: baked.width, h: baked.height };
  }

  for (let attempt = 0; attempt < 60; attempt++) {
    const x = rect.x + Math.floor(rng() * rect.w);
    const y = rect.y + Math.floor(rng() * rect.h);
    if (taken.has(y * baked.width + x)) continue;
    if (!placeable(baked.grid, x, y, blocking)) continue;
    return { x, y };
  }
  console.warn(`[site] spawn '${spawn.entity}' on '${siteId}' (#${index}) found no free tile — skipped.`);
  return null;
}
