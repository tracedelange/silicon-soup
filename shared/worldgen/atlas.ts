// Region atlas — the prebaked structural/semantic layer (docs/rework.md §5.2).
// Generated once server-side at world creation and shipped to clients as a
// static asset (R5.2a/R8.8). It is the single in-game MAP object and the
// engine's structural query surface.
//
// This module is PURE (no fs) so it bundles cleanly into the client. The
// server owns disk-caching + serving it (see server/game/wilderness.ts).
//
// For the vertical slice the atlas stores the settlement registry + danger
// parameters; danger itself is computable pointwise from origin (field.ts), so
// no per-cell danger bake is needed yet. Per-cell baking (allowed_axis_mask,
// macro elevation) is a reserved seam — see R5.2b.
//
// It also stores STAMPS: compact procedural-shape descriptors (see stamps.ts)
// that wildTileAt paints on top of the field so a settlement reads as an authored
// place on both client and server. They are evaluated pointwise — not baked into
// a tile map — so a whole grove is a few bytes in the atlas, not thousands of
// entries. For the central village the stamps make a GROVE of trees at the wild
// origin with a cleared mouth on each cardinal side, so the four town exits
// emerge out of the treeline (the village reads as nestled inside the grove).
// This is the previously-reserved footprint seam (R6.3) — deterministic,
// JSON-serializable, consumed identically on both sides.

import type { Direction, DungeonDef, WorldBiome } from '../types.ts';
import { mulberry32, resolveSeed } from './noise.ts';
import { type WildStamp } from './stamps.ts';
import {
  biomeAt, dangerAt, deriveSeeds, getLevelBand, isWildBlocked, LEVEL_BAND_COUNT, LEVEL_BAND_WIDTH, wildTileAt,
  type FieldSeeds,
} from './field.ts';
import { DANGER_RADIUS, DEFAULT_WORLD_SEED, REGION_CELL_SIZE, WILD } from './config.ts';

/** A single walkable exit between a settlement's enclosed zone and the open
 *  wilderness. The player leaves town through the zone-side portal tile at
 *  (villageX, villageY) and lands on the wilderness gate tile (wildX, wildY);
 *  stepping back onto that gate returns them to (returnX, returnY) inside the
 *  zone (just inside the same gap they left through). One gate per cardinal
 *  direction gives the village exits in all four directions (R6.6). */
export interface Gate {
  dir: Direction;
  /** Wilderness gate tile — walkable `portal`, and the return trigger. */
  wildX: number;
  wildY: number;
  /** Zone-side portal tile (painted by a `portal` post-op in the zone JSON). */
  villageX: number;
  villageY: number;
  /** Where to drop the player inside the zone on return (just inside the gap). */
  returnX: number;
  returnY: number;
}

/** A placed enclosed zone with a footprint on the wilderness field (R6.3). */
export interface Settlement {
  /** Enclosed-zone id this settlement maps to (e.g. 'zone_0_0'). */
  id: string;
  /** World-tile center of the settlement on the atlas. */
  worldX: number;
  worldY: number;
  /** Primary wilderness gate (kept for callers that want a single representative
   *  gate, e.g. the client fog-of-war reveal). Mirrors gates[0]. */
  portalX: number;
  portalY: number;
  /** All wilderness exits for this settlement, one per open direction. */
  gates: Gate[];
  /** Discovery default for the slice — the central village is always known. */
  band: number;
}

/** A dungeon roster entry placed into this epoch's wilderness. The entrance is
 *  a walkable `portal` tile at (worldX, worldY) — stepping on it enters the
 *  zone whose id is `id`. Position re-rolls every epoch; the id/name do not,
 *  which is what makes "discovered once, mapped forever" work (see DungeonDef). */
export interface DungeonSite {
  /** Dungeon def id — also the zone id and the discovery key. */
  id: string;
  name: string;
  /** Entrance tile in signed world coords. */
  worldX: number;
  worldY: number;
  /** Level band tier at the entrance (getLevelBand), for map/UI labeling. */
  band: number;
  minLevel: number;
  maxLevel: number;
}

/** Bump whenever the baked footprint/gate layout changes, so disk-cached
 *  atlases from a previous shape are rejected and rebuilt (see index.ts
 *  loadOrBuildAtlas). Otherwise a stale cache silently serves the old layout. */
export const ATLAS_REV = 7;

export interface RegionAtlas {
  version: 1;
  /** Content revision of the baked layout — see ATLAS_REV. */
  rev: number;
  seed: string;
  /** Numeric seed both sides resolve the field streams from. */
  numericSeed: number;
  /** Wild epoch this atlas was baked for (shared/worldgen/epoch.ts). The client
   *  compares it against its own cached copy to detect a rotation. */
  epoch: number;
  cellSize: number;
  dangerRadius: number;
  settlements: Settlement[];
  /** Procedural stamps painted over the field by wildTileAt (see stamps.ts).
   *  Evaluated pointwise on both sides, so authored wilderness shapes cost a
   *  few descriptors here rather than a baked per-tile map. */
  stamps: WildStamp[];
  /** Tile ids painted by `grid` stamps that block movement. shared/ cannot read
   *  a tileset, so the server fills this at bake time and both sides consult it
   *  through isWildBlocked (see field.ts). Empty until a footprint is baked. */
  stampBlocking: string[];
  /** Dungeon entrances placed for this epoch. */
  sites: DungeonSite[];
  /** Reserved (R5.2b/§10): per-cell allowed combat-axis mask, baked later. */
  // allowedAxisMask?: number[];
}

// ── Grove geometry (wild-side, centered on origin) ────────────────────────────
// A large tree grove at the wild origin, expressed as stamps: one organic `blob`
// of trees plus one `line` clearing per cardinal axis carving a grass mouth so
// the town's four exits emerge out of the grove. The gate/portal sits inside each
// mouth, so the player steps through a gap in the trees into open wild.
const GROVE_R = 48;             // nominal grove radius (edge feathers ±FEATHER)
const FEATHER = 12;             // ragged treeline band width
const GROVE_NOISE_SCALE = 26;   // grove edge lobe size (bigger = broader blobs)
const MOUTH_HALF = 1;           // mouth half-width (→ 3-tile clearing)
const MOUTH_INNER = 4;          // how far the mouth cuts back inside the gate
const MOUTH_OUTER = FEATHER + 3;// how far the mouth clears past the gate (through the edge)
const GATE_R = GROVE_R;         // gate sits at the nominal treeline

/** Build the grove as a handful of stamps (see stamps.ts): a feathered tree blob,
 *  then a grass mouth carved out to each gate. Pure in `numericSeed` so client +
 *  server evaluate an identical grove. */
function buildCentralStamps(gates: Gate[], numericSeed: number): WildStamp[] {
  const gseed = (numericSeed ^ 0x9e3779b1) >>> 0; // independent grove noise stream
  const stamps: WildStamp[] = [
    { kind: 'blob', cx: 0, cy: 0, radius: GROVE_R, feather: FEATHER, noiseScale: GROVE_NOISE_SCALE, seed: gseed, tile: 'tree' },
  ];
  // A grass mouth per gate: a segment along the gate's cardinal axis, from a few
  // tiles inside the treeline out through the ragged edge. Painted after the blob
  // so the corridor is never re-blocked. Cardinal unit vector from the gate coord.
  for (const g of gates) {
    const ux = Math.sign(g.wildX);
    const uy = Math.sign(g.wildY);
    stamps.push({
      kind: 'line',
      x0: ux * (GATE_R - MOUTH_INNER), y0: uy * (GATE_R - MOUTH_INNER),
      x1: ux * (GATE_R + MOUTH_OUTER), y1: uy * (GATE_R + MOUTH_OUTER),
      half: MOUTH_HALF, tile: 'grass',
    });
  }
  return stamps;
}

/** The four cardinal gates for the central village. Each sits recessed at the
 *  back of its grove mouth. The zone-side portal tiles (villageX/Y) are painted
 *  by matching `portal` post-ops in zone_0_0.json; the return-drop tiles sit a
 *  few tiles inside the same town gap. */
function centralGates(): Gate[] {
  return [
    { dir: 'north', wildX: 0, wildY: -GATE_R, villageX: 57, villageY: 4,   returnX: 57, returnY: 8 },
    { dir: 'south', wildX: 0, wildY: GATE_R,  villageX: 57, villageY: 110, returnX: 57, returnY: 106 },
    { dir: 'east',  wildX: GATE_R, wildY: 0,  villageX: 110, villageY: 57, returnX: 106, returnY: 57 },
    { dir: 'west',  wildX: -GATE_R, wildY: 0, villageX: 4,   villageY: 57, returnX: 8,   returnY: 57 },
  ];
}

// ── Dungeon site placement ─────────────────────────────────────────────────
// Danger is radial and seed-independent (field.ts dangerAt), so a level band
// IS a radius annulus from the origin. That is the whole placement constraint:
// re-rolling the world moves a dungeon around its ring, never across bands, so
// a level-8 dungeon is a level-8 dungeon every epoch.
const LEVEL_CAP = LEVEL_BAND_COUNT * LEVEL_BAND_WIDTH;
/** No site inside this radius — keeps entrances clear of the origin grove/town. */
const SITE_MIN_RADIUS = 140;
/** Minimum spacing between two entrances, so a ring never reads as a cluster. */
const SITE_MIN_SEPARATION = 220;
const SITE_PLACE_ATTEMPTS = 240;

// Entrance footprint: a small rock outcrop with a cleared mouth, so an entrance
// reads as a place from a distance instead of a lone portal pixel in open field.
const SITE_ROCK_R = 6;
const SITE_MOUTH_R = 2;

// A site with an AUTHORED exterior (DungeonDef.footprint) needs room for the
// whole camp, not just a standable entrance tile. Sample a coarse lattice across
// the rect rather than every cell — 240 placement attempts x 64x64 tiles would
// be a quarter-million field evaluations per site, and a lake or a mountain
// shoulder is many tiles wide, so it cannot hide between samples.
const FOOTPRINT_SAMPLE_STEP = 6;
/** Fraction of the sampled lattice that must be buildable ground. */
const FOOTPRINT_OPEN_FRAC = 0.8;

function siteStamps(x: number, y: number, seed: number): WildStamp[] {
  return [
    { kind: 'blob', cx: x, cy: y, radius: SITE_ROCK_R, feather: 2, noiseScale: 7, seed, tile: 'rock' },
    { kind: 'blob', cx: x, cy: y, radius: SITE_MOUTH_R, feather: 0, noiseScale: 1, seed, tile: 'dirt' },
  ];
}

/** Radius annulus a placement's level band maps to, clamped clear of the origin. */
function bandRadii(minLevel: number, maxLevel: number): [number, number] {
  const lo = (Math.max(1, minLevel) - 1) / LEVEL_CAP;
  const hi = Math.min(LEVEL_CAP, Math.max(minLevel, maxLevel)) / LEVEL_CAP;
  return [Math.max(SITE_MIN_RADIUS, lo * DANGER_RADIUS), Math.max(SITE_MIN_RADIUS + 60, hi * DANGER_RADIUS)];
}

// An entrance must sit on open ground with room to stand around it — a portal
// tile is always walkable itself, but one ringed by trees or water is a
// dead-end the player can reach only by luck.
function entranceViable(x: number, y: number, seeds: FieldSeeds): boolean {
  const tile = wildTileAt(x, y, seeds);
  if (tile === 'water' || tile === 'swamp_water' || isWildBlocked(tile)) return false;
  let open = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const t = wildTileAt(x + dx, y + dy, seeds);
      if (t !== 'water' && t !== 'swamp_water' && !isWildBlocked(t)) open++;
    }
  }
  return open >= 16; // of 25 sampled — a genuine clearing, not a gap in a thicket
}

// The stamp paints over whatever is under it, so a camp in a lake still
// *functions* — this is an aesthetic constraint, not a correctness one, and the
// bar is set accordingly. Trees are fine (a clearing hacked out of a forest is
// exactly right); water and mountain are not, because the camp would read as
// pasted on and the approach to it would be walled or drowned.
function footprintViable(cx: number, cy: number, w: number, h: number, seeds: FieldSeeds): boolean {
  const x0 = cx - (w >> 1);
  const y0 = cy - (h >> 1);
  let open = 0;
  let total = 0;
  for (let y = 0; y < h; y += FOOTPRINT_SAMPLE_STEP) {
    for (let x = 0; x < w; x += FOOTPRINT_SAMPLE_STEP) {
      const t = wildTileAt(x0 + x, y0 + y, seeds);
      total++;
      if (t !== 'water' && t !== 'swamp_water' && t !== 'rock') open++;
    }
  }
  return total === 0 || open / total >= FOOTPRINT_OPEN_FRAC;
}

/** Half-extent a site occupies, for spacing. A bare entrance is its outcrop; an
 *  authored exterior is however big the author drew it. */
function siteExtent(def: DungeonDef): number {
  const fp = def.footprint;
  if (!fp) return SITE_ROCK_R;
  return Math.max(fp.width ?? 0, fp.height ?? 0) / 2;
}

function matchesSiteBiome(allowed: WorldBiome[] | undefined, biome: WorldBiome): boolean {
  return !allowed?.length || allowed.includes(biome);
}

/** Whether the wilderness level band AT this tile overlaps the dungeon's own. */
function bandOverlaps(x: number, y: number, seeds: FieldSeeds, def: DungeonDef): boolean {
  const local = getLevelBand(dangerAt(x, y, seeds, { dangerRadius: DANGER_RADIUS }));
  return local.minLevel <= def.placement.max_level && local.maxLevel >= def.placement.min_level;
}

/**
 * Place each roster dungeon once, deterministically from (seed, dungeon id).
 * EVERY roster entry is placed every epoch — a discovered dungeon that vanished
 * for a day would make the map lie, and the roster is small enough that finding
 * a spot on its ring is easy. Biome is the soft constraint: if a themed biome
 * can't be found on the ring, the last third of the attempts drop it rather
 * than dropping the dungeon.
 */
function placeSites(dungeons: DungeonDef[], numericSeed: number): { sites: DungeonSite[]; stamps: WildStamp[] } {
  const seeds = deriveSeeds(numericSeed);
  const sites: DungeonSite[] = [];
  const stamps: WildStamp[] = [];
  // Parallel to `sites` — how much room each placed site takes up, so a large
  // authored camp is spaced by its own size rather than by an entrance pixel.
  const extents: number[] = [];
  // Sort by id so roster file order can't perturb placement — the earlier a
  // site is placed the more freedom it has, and that must be seed-determined.
  for (const def of [...dungeons].sort((a, b) => a.id.localeCompare(b.id))) {
    const dseed = (resolveSeed(def.id) ^ numericSeed) >>> 0;
    const rng = mulberry32(dseed);
    const [rMin, rMax] = bandRadii(def.placement.min_level, def.placement.max_level);
    const extent = siteExtent(def);
    const fp = def.footprint;
    // An authored exterior has far fewer viable spots on its ring than a single
    // standable tile does, so it starts relaxing theming halfway rather than at
    // two thirds. Every roster entry must still be placed every epoch.
    const strictUntil = SITE_PLACE_ATTEMPTS * (fp ? 0.5 : 2 / 3);
    let placed: { x: number; y: number } | null = null;
    for (let attempt = 0; attempt < SITE_PLACE_ATTEMPTS && !placed; attempt++) {
      const angle = rng() * Math.PI * 2;
      const r = rMin + rng() * (rMax - rMin);
      const x = Math.round(Math.cos(angle) * r);
      const y = Math.round(Math.sin(angle) * r);
      if (sites.some((st, i) => Math.hypot(st.worldX - x, st.worldY - y) < SITE_MIN_SEPARATION + extent + extents[i]!)) continue;
      if (!entranceViable(x, y, seeds)) continue;
      if (fp && !footprintViable(x, y, fp.width ?? 0, fp.height ?? 0, seeds)) continue;
      // Theming constraints are enforced for the first stretch of the attempts,
      // then relaxed — placing the dungeon somewhere off-theme beats not
      // placing it (a discovered site must never go missing, see the doc above).
      const strict = attempt < strictUntil;
      if (strict && !matchesSiteBiome(def.placement.biomes, biomeAt(x, y, seeds))) continue;
      // The annulus fixes the RADIAL danger, but wobble can leave a spot's
      // local band far from the dungeon's own. Prefer entrances whose ambient
      // wilderness overlaps the dungeon's band, so the mobs outside the door
      // are roughly the mobs behind it.
      if (strict && !bandOverlaps(x, y, seeds, def)) continue;
      placed = { x, y };
    }
    if (!placed) {
      console.warn(`[atlas] no viable entrance found for dungeon '${def.id}' — not placed this epoch`);
      continue;
    }
    sites.push({
      id: def.id,
      name: def.name,
      worldX: placed.x,
      worldY: placed.y,
      band: Math.max(1, Math.ceil(def.placement.min_level / LEVEL_BAND_WIDTH)),
      minLevel: def.placement.min_level,
      maxLevel: def.placement.max_level,
    });
    extents.push(extent);
    // The outcrop exists to make a lone portal tile read as a place from a
    // distance. An authored exterior does that job itself, and a ring of rock
    // showing through the camp's transparent cells would only look like a bug.
    if (!fp) stamps.push(...siteStamps(placed.x, placed.y, dseed));
  }
  return { sites, stamps };
}

/** The site whose entrance tile sits exactly on (x,y), if any. */
export function siteAt(atlas: RegionAtlas, x: number, y: number): DungeonSite | null {
  for (const st of atlas.sites) if (st.worldX === x && st.worldY === y) return st;
  return null;
}

/**
 * Build the atlas deterministically from a seed. Pure — same seed → same atlas.
 * The slice places a single central village at origin whose enclosed zone is the
 * hand-authored starting village; the same registry supports N settlements at
 * higher bands with no structural change (R9.2).
 */
export function buildAtlas(
  seed: string = DEFAULT_WORLD_SEED,
  centralVillageZoneId = 'zone_0_0',
  dungeons: DungeonDef[] = [],
  epoch = 0,
): RegionAtlas {
  const gates = centralGates();
  const numericSeed = resolveSeed(seed);
  const { sites, stamps: siteFootprints } = placeSites(dungeons, numericSeed);
  return {
    version: 1,
    rev: ATLAS_REV,
    seed,
    numericSeed,
    epoch,
    cellSize: REGION_CELL_SIZE,
    dangerRadius: DANGER_RADIUS,
    settlements: [
      // Central village at origin. Its enclosed zone is the hand-authored
      // starting village; four gates open out through the tree grove footprint
      // in the wilderness so leaving town in any direction stays cohesive.
      {
        id: centralVillageZoneId,
        worldX: 0, worldY: 0,
        portalX: gates[0]!.wildX, portalY: gates[0]!.wildY,
        gates,
        band: 0,
      },
    ],
    // Site footprints paint after the central grove — they never overlap it
    // (SITE_MIN_RADIUS clears the grove), but paint order is the contract.
    stamps: [...buildCentralStamps(gates, numericSeed), ...siteFootprints],
    // Filled by the server when it bakes authored footprints onto the atlas —
    // shared/ has no tileset to resolve blocking from (see field.ts).
    stampBlocking: [],
    sites,
  };
}

export { WILD };
