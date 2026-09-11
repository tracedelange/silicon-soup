// Baking an authored zone into a wilderness footprint (docs/plan-poi-authoring.md).
//
// A camp is AUTHORED as a ZoneDef — so it keeps the whole op pipeline, the
// feature registry, prefabs, and every tool that already edits a zone — and RUNS
// as a `grid` stamp painted onto the open field. This module is the seam between
// those two forms, and it is deliberately the ONLY one: the editor's footprint
// preview and the server's atlas bake both call it, so a preview cannot drift
// from what ships. A preview that lies is worse than no preview.
//
// It cannot live in shared/worldgen/ (which buildAtlas does) because it needs
// generateZoneGrid, and shared must never import server — that is the
// determinism contract that lets the client render terrain it was never sent.
// So the server bakes and APPENDS to the atlas instead; the client still
// receives nothing but pure descriptors.

import { generateZoneGrid } from './index.ts';
import type { RegionBounds } from './blackboard.ts';
import { encodeGridRuns, TRANSPARENT, type GridStamp, type WildStamp } from '../../../shared/worldgen/stamps.ts';
import type { DungeonDef, Prefab, ZoneDef } from '../../../shared/types.ts';

/** Tiles that fall through to the field beneath rather than painting. A camp
 *  whose every cell paints reads as a rectangular decal dropped on the forest;
 *  `transparent` lets the author ragged the perimeter by hand, and `void` — what
 *  mapgen leaves outside a zone's structures — means the same thing out here. */
const FALL_THROUGH = new Set([TRANSPARENT, 'void']);

export interface BakedFootprint {
  stamp: GridStamp;
  /** Tile ids present in the stamp that block movement, per the world's
   *  tileset. shared/ cannot read a tileset, so this rides on the atlas
   *  (RegionAtlas.stampBlocking) for the client to consult. */
  blocking: string[];
  /** Named regions the generator produced, in FOOTPRINT-LOCAL coords. Authored
   *  spawns address these by name — never by coordinate, because the
   *  arrangement re-rolls every epoch. */
  bounds: Record<string, RegionBounds>;
  width: number;
  height: number;
}

/**
 * Generate `zoneDef` at `seed` and bake the result into a stamp anchored so the
 * footprint's CENTER lands on (cx, cy) — placement picks a center tile, and a
 * caller that had to do the half-width arithmetic itself would eventually get it
 * wrong in one of the two places that do it.
 */
export function bakeSiteFootprint(
  zoneDef: ZoneDef,
  seed: string,
  cx: number,
  cy: number,
  blockingTiles: ReadonlySet<string>,
  prefabs: Record<string, Prefab> = {},
): BakedFootprint {
  // id defaults to the seed so mapgen's console.warn lines name the footprint
  // rather than 'undefined' — the editor surfaces those warnings verbatim.
  const { grid, bounds, width, height } = generateZoneGrid({ ...zoneDef, id: zoneDef.id || seed, seed }, blockingTiles, prefabs);

  const cells: string[] = new Array(width * height);
  const blocking = new Set<string>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = grid[y]![x]!;
      const paints = !FALL_THROUGH.has(tile);
      cells[y * width + x] = paints ? tile : TRANSPARENT;
      if (paints && blockingTiles.has(tile)) blocking.add(tile);
    }
  }

  return {
    stamp: {
      kind: 'grid',
      ox: cx - (width >> 1),
      oy: cy - (height >> 1),
      w: width,
      h: height,
      runs: encodeGridRuns(cells),
    },
    blocking: [...blocking],
    bounds,
    width,
    height,
  };
}

/** Footprint-local (lx, ly) → signed world tile. The inverse of the anchoring
 *  above; authored spawns and portal offsets both resolve through it. */
export function footprintToWorld(stamp: GridStamp, lx: number, ly: number): { x: number; y: number } {
  return { x: stamp.ox + lx, y: stamp.oy + ly };
}

/**
 * Bake every roster footprint onto `atlas`, in place.
 *
 * Runs on the server after buildAtlas and before the atlas is cached or served,
 * which is the only place it can: buildAtlas lives in shared/worldgen/ and must
 * never import mapgen. The client still receives nothing but pure descriptors,
 * so the determinism contract is untouched.
 *
 * Footprints append AFTER the procedural stamps placed during atlas build, so an
 * authored camp paints over the rock outcrop its own entrance sits in (paint
 * order is the contract). The entrance tile itself is safe either way —
 * wildTileAt returns 'portal' for a site position ahead of any stamp, so a
 * footprint can never seal its own door.
 */
export function bakeAtlasFootprints(
  atlas: { sites: readonly { id: string; worldX: number; worldY: number }[]; stamps: WildStamp[]; stampBlocking: string[]; epoch: number },
  dungeons: readonly DungeonDef[],
  blockingTiles: ReadonlySet<string>,
  prefabs: Record<string, Prefab> = {},
): void {
  const byId = new Map(dungeons.map(d => [d.id, d]));
  const blocking = new Set(atlas.stampBlocking);
  for (const site of atlas.sites) {
    const footprint = byId.get(site.id)?.footprint;
    if (!footprint) continue;
    const baked = bakeSiteFootprint(
      { ...footprint, id: `${site.id}__footprint` } as ZoneDef, `${site.id}:footprint:${atlas.epoch}`,
      site.worldX, site.worldY, blockingTiles, prefabs,
    );
    atlas.stamps.push(baked.stamp);
    for (const t of baked.blocking) blocking.add(t);
  }
  atlas.stampBlocking = [...blocking];
}
