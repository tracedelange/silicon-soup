// Pointwise wilderness fields — live, never stored (docs/rework.md §5.1–5.4).
// The SINGLE module both server and client import so terrain + danger are
// identical from the same (x, y, seed). No global iteration, no neighbor state:
// every value is a pure function of world tile coords + the atlas seed.

import type { LevelBand, WorldBiome } from '../types.ts';
import { octaveNoise, resolveSeed } from './noise.ts';
import type { RegionAtlas } from './atlas.ts';
import { stampTileAt } from './stamps.ts';
import {
  BIOME_BLEND_AMOUNT, BIOME_BLEND_SCALE, CLIMATE_SCALE, DANGER_WOBBLE_SCALE, ELEV_SCALE,
  ELEVATION_BIAS, ELEVATION_CONTRAST, GRASSLAND_CLUMP_DENSITY, GRASSLAND_CLUMP_HI, GRASSLAND_CLUMP_LO,
  GRASSLAND_CLUMP_SCALE, GRASSLAND_SPARSE_DENSITY, MOISTURE_BIAS, MOISTURE_CONTRAST, MOUNTAIN_LEVEL,
  NOISE_LACUNARITY, NOISE_OCTAVES, NOISE_PERSISTENCE, PLAINS_TREE_DENSITY, RIVER_SCALE, SEA_LEVEL,
  SPAWN_ANCHOR_ELEV, SPAWN_ANCHOR_MOIST, SPAWN_ANCHOR_RADIUS, SPAWN_ANCHOR_STRENGTH, SPAWN_ANCHOR_TEMP,
  TEMPERATURE_BIAS, TEMPERATURE_CONTRAST, TREE_SCALE, WEIRDNESS_SCALE, WEIRDNESS_THRESHOLD, WOBBLE_AMP,
} from './config.ts';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Derive independent noise streams from the base seed (same mixing style as
// server/game/mapgen/worldgen.ts) so elevation/temp/moisture/rivers/etc don't
// correlate.
function mix(seed: number): number {
  return (seed * 1664525 + 1013904223) >>> 0;
}
export interface FieldSeeds {
  elev: number; temp: number; moist: number;
  river: number; tree: number; wobble: number; weird: number;
  blendT: number; blendM: number; clump: number;
}
export function deriveSeeds(seed: number | string): FieldSeeds {
  const base = resolveSeed(seed);
  const elev = base;
  const temp = mix(elev);
  const moist = mix(temp);
  const river = mix(moist);
  const tree = mix(river);
  const wobble = mix(tree);
  const weird = mix(wobble);
  const blendT = mix(weird);
  const blendM = mix(blendT);
  const clump = mix(blendM);
  return { elev, temp, moist, river, tree, wobble, weird, blendT, blendM, clump };
}

const fbm = (x: number, y: number, scale: number, seed: number) =>
  octaveNoise(x, y, NOISE_OCTAVES, scale, NOISE_PERSISTENCE, NOISE_LACUNARITY, seed);

// Reshaping knobs for elevation/temperature/moisture — see config.ts. Exposed
// as an optional param object (defaulting to the shipped config constants) so
// the world-gen tool can explore alternatives live without perturbing the
// live game's compile-time defaults (R4.4). Every call site that omits `p`
// gets the same constants on client and server, so determinism (R8.7) holds.
export interface FieldGenParams {
  elevScale: number; climateScale: number;
  octaves: number; persistence: number; lacunarity: number;
  elevBias: number; elevContrast: number;
  tempBias: number; tempContrast: number;
  moistBias: number; moistContrast: number;
  weirdScale: number; weirdThreshold: number;
  spawnAnchorRadius: number; spawnAnchorStrength: number;
  spawnAnchorTemp: number; spawnAnchorMoist: number; spawnAnchorElev: number;
  blendScale: number; blendAmount: number;
}
export const DEFAULT_FIELD_PARAMS: FieldGenParams = {
  elevScale: ELEV_SCALE, climateScale: CLIMATE_SCALE,
  octaves: NOISE_OCTAVES, persistence: NOISE_PERSISTENCE, lacunarity: NOISE_LACUNARITY,
  elevBias: ELEVATION_BIAS, elevContrast: ELEVATION_CONTRAST,
  tempBias: TEMPERATURE_BIAS, tempContrast: TEMPERATURE_CONTRAST,
  moistBias: MOISTURE_BIAS, moistContrast: MOISTURE_CONTRAST,
  weirdScale: WEIRDNESS_SCALE, weirdThreshold: WEIRDNESS_THRESHOLD,
  spawnAnchorRadius: SPAWN_ANCHOR_RADIUS, spawnAnchorStrength: SPAWN_ANCHOR_STRENGTH,
  spawnAnchorTemp: SPAWN_ANCHOR_TEMP, spawnAnchorMoist: SPAWN_ANCHOR_MOIST, spawnAnchorElev: SPAWN_ANCHOR_ELEV,
  blendScale: BIOME_BLEND_SCALE, blendAmount: BIOME_BLEND_AMOUNT,
};

// Contrast > 1 stretches raw noise (which clusters near 0.5) toward the
// extremes before biome classification; bias shifts the global mean.
const reshape = (raw: number, bias: number, contrast: number) => clamp01((raw - 0.5) * contrast + 0.5 + bias);

// Pulls a reshaped climate value toward `target` near the origin, fading
// linearly to no effect at spawnAnchorRadius, so the starting area trends
// temperate without a hard boundary (R = spawn radial fade, mirrors dangerAt's
// radial trend but shrinking instead of growing with distance).
function anchorTemperate(x: number, y: number, value: number, target: number, p: FieldGenParams): number {
  const dist = Math.hypot(x, y);
  const fade = clamp01(1 - dist / p.spawnAnchorRadius);
  const weight = fade * p.spawnAnchorStrength;
  return value * (1 - weight) + target * weight;
}

export function elevation(x: number, y: number, s: FieldSeeds, p: FieldGenParams = DEFAULT_FIELD_PARAMS): number {
  const raw = octaveNoise(x, y, p.octaves, p.elevScale, p.persistence, p.lacunarity, s.elev);
  return anchorTemperate(x, y, reshape(raw, p.elevBias, p.elevContrast), p.spawnAnchorElev, p);
}
export function temperature(x: number, y: number, s: FieldSeeds, p: FieldGenParams = DEFAULT_FIELD_PARAMS): number {
  const raw = octaveNoise(x, y, p.octaves, p.climateScale, p.persistence, p.lacunarity, s.temp);
  return anchorTemperate(x, y, reshape(raw, p.tempBias, p.tempContrast), p.spawnAnchorTemp, p);
}
export function moisture(x: number, y: number, s: FieldSeeds, p: FieldGenParams = DEFAULT_FIELD_PARAMS): number {
  const raw = octaveNoise(x, y, p.octaves, p.climateScale, p.persistence, p.lacunarity, s.moist);
  return anchorTemperate(x, y, reshape(raw, p.moistBias, p.moistContrast), p.spawnAnchorMoist, p);
}

// A fourth noise field, signed [-1, 1]. Sampled at p.weirdScale, deliberately
// smaller/higher-frequency than elevation, so weird pockets cut across biome
// boundaries rather than tracking them. Magnitude gates rare terrain (badlands,
// see resolveBiome); a raw, roughly bell-distributed value keeps that gate easy
// to calibrate (abs(weirdnessAt) > threshold has a predictable, percentile-
// stable incidence — see the threshold's doc comment in config.ts).
export function weirdnessAt(x: number, y: number, s: FieldSeeds, p: FieldGenParams = DEFAULT_FIELD_PARAMS): number {
  return octaveNoise(x, y, p.octaves, p.weirdScale, p.persistence, p.lacunarity, s.weird) * 2 - 1;
}

// Triangle-fold weirdness into peaks/valleys: as raw weirdness sweeps [-1, 1],
// the folded value ramps up, peaks, back down, dips negative, peaks again —
// multiple "personality" zero-crossings instead of one smooth ramp. This is
// texture only (flavors normal terrain in wildTileAt); it is deliberately NOT
// used for the badlands gate above, because folding a narrow bell-distributed
// input concentrates most of the map at one of the fold's poles rather than
// making extremes rare — the opposite of what a rarity gate needs.
function foldWeirdness(w: number): number {
  return 1 - Math.abs(3 * Math.abs(w) - 2);
}

// Whittaker-style biome table (temperature × moisture). Lifted from
// server/game/mapgen/worldgen.ts so the wilderness reads biome the same way.
const BIOME_TABLE: [number, number, number, number, WorldBiome][] = [
  [0.0, 0.25, 0.0, 1.0, 'tundra'],
  [0.25, 0.45, 0.0, 0.3, 'plains'],
  [0.25, 0.45, 0.3, 0.6, 'grassland'],
  [0.25, 0.45, 0.6, 1.0, 'forest'],
  [0.45, 0.65, 0.0, 0.25, 'desert'],
  [0.45, 0.65, 0.25, 0.5, 'plains'],
  [0.45, 0.65, 0.5, 0.75, 'grassland'],
  [0.45, 0.65, 0.75, 1.0, 'swamp'],
  [0.65, 1.0, 0.0, 0.3, 'desert'],
  [0.65, 1.0, 0.3, 0.6, 'plains'],
  [0.65, 1.0, 0.6, 0.8, 'grassland'],
  [0.65, 1.0, 0.8, 1.0, 'swamp'],
];

// The walkable land biomes a wild mob can spawn in — every WorldBiome except
// `ocean` (not walkable). The canonical vocabulary for mob biome affinity
// (MobTemplate.biomes), the wilderness spawn filter, and mob generation. Any
// mob generated for the wilds is anchored to one of these.
export const WILD_BIOMES: readonly WorldBiome[] = [
  'tundra', 'plains', 'grassland', 'forest', 'swamp', 'desert', 'mountain', 'badlands',
];

export function classifyBiome(temp: number, moist: number, elev: number): WorldBiome {
  if (elev < SEA_LEVEL) return 'ocean';
  if (elev > MOUNTAIN_LEVEL) return 'mountain';
  for (const [tMin, tMax, mMin, mMax, biome] of BIOME_TABLE) {
    if (temp >= tMin && temp < tMax && moist >= mMin && moist < mMax) return biome;
  }
  return 'plains';
}

// Climate-picked biome + weirdness override, shared by biomeAt and wildTileAt
// so both see the exact same `badlands` pockets. ocean/mountain are hard
// elevation calls that weirdness never overrides.
function resolveBiome(x: number, y: number, s: FieldSeeds, p: FieldGenParams): { biome: WorldBiome; weird: number } {
  // Patchy jitter on the table inputs — not the underlying fields — so a tile
  // near a boundary can land on either side while tiles well inside a biome
  // stay put. Independent per-axis noise (not a single scalar) keeps the edge
  // organic rather than sliding uniformly along one diagonal.
  const tJit = (octaveNoise(x, y, 2, p.blendScale, 0.5, 2, s.blendT) * 2 - 1) * p.blendAmount;
  const mJit = (octaveNoise(x, y, 2, p.blendScale, 0.5, 2, s.blendM) * 2 - 1) * p.blendAmount;
  const temp = clamp01(temperature(x, y, s, p) + tJit);
  const moist = clamp01(moisture(x, y, s, p) + mJit);
  const biome = classifyBiome(temp, moist, elevation(x, y, s, p));
  const weird = weirdnessAt(x, y, s, p);
  if (biome !== 'ocean' && biome !== 'mountain' && Math.abs(weird) > p.weirdThreshold) {
    return { biome: 'badlands', weird };
  }
  return { biome, weird };
}

export function biomeAt(x: number, y: number, s: FieldSeeds, p: FieldGenParams = DEFAULT_FIELD_PARAMS): WorldBiome {
  return resolveBiome(x, y, s, p).biome;
}

// ── Tiles ────────────────────────────────────────────────────────────────────
// wildTileAt is the one function both render and collision call. Returns a tile
// id present in the overworld tileset. Water (open water + swamp water) blocks
// movement; rock (mountain) stays traversable highland — contiguous mountain
// masses would otherwise wall players in (and can surround a settlement gate).
// Settlement gates render as a walkable `portal` tile (overriding terrain in
// wildTileAt) so an entrance is never sealed off by surrounding water.
// Baked footprints (grid stamps) paint zone tiles — walls, palisades, thatch —
// into the open world, and those must block too. Which of them block is a
// property of the world's TILESET, which shared/ deliberately cannot read, so
// the server resolves it at bake time and ships the answer on the atlas
// (RegionAtlas.stampBlocking). Both sides then agree for free, the same way they
// agree about terrain.
export const WILD_BLOCKING: ReadonlySet<string> = new Set(['tree', 'water', 'swamp_water']);

const stampBlockingCache = new WeakMap<object, ReadonlySet<string>>();

export function isWildBlocked(tile: string, atlas?: Pick<RegionAtlas, 'stampBlocking'>): boolean {
  if (WILD_BLOCKING.has(tile)) return true;
  if (!atlas?.stampBlocking?.length) return false;
  let set = stampBlockingCache.get(atlas);
  if (!set) { set = new Set(atlas.stampBlocking); stampBlockingCache.set(atlas, set); }
  return set.has(tile);
}

export function wildTileAt(
  x: number, y: number, s: FieldSeeds, atlas?: RegionAtlas, p: FieldGenParams = DEFAULT_FIELD_PARAMS,
): string {
  // Settlement gates render as a walkable portal tile, overriding terrain so the
  // entrance is always reachable (R6.6) and identical on client + server.
  // Stamps (e.g. the origin tree grove + its cleared mouths) paint over the field
  // beneath them so a settlement reads identically on both sides (R6.3).
  if (atlas) {
    for (const st of atlas.settlements) {
      for (const g of st.gates) {
        if (g.wildX === x && g.wildY === y) return 'portal';
      }
    }
    // Dungeon entrances get the same treatment as settlement gates: a walkable
    // portal tile that overrides both the field and its own rock footprint, so
    // an entrance is never sealed by the outcrop stamped around it.
    for (const site of atlas.sites) {
      if (site.worldX === x && site.worldY === y) return 'portal';
    }
    const stamped = stampTileAt(x, y, atlas.stamps);
    if (stamped) return stamped;
  }
  const e = elevation(x, y, s, p);
  if (e < SEA_LEVEL) return 'water';
  if (e > MOUNTAIN_LEVEL) return 'rock';

  const { biome, weird } = resolveBiome(x, y, s, p);

  // Cosmetic river ribbon: a continuous banded noise value in a narrow range
  // reads as water. Continuity is free across chunk boundaries (R5.2 step 4).
  const ribbon = fbm(x, y, RIVER_SCALE, s.river);
  if (ribbon > 0.49 && ribbon < 0.51) return 'water';

  if (biome === 'badlands') {
    // Striped mesa/canyon texture from a separate high-frequency banding
    // noise, built from existing tile primitives (no new sprites needed).
    const band = fbm(x, y, TREE_SCALE * 4, s.weird + 1);
    if (band < 0.15) return 'rock';
    if (band < 0.5) return 'dirt';
    return 'sand';
  }

  // Folded weirdness flavors normal terrain: positive = lusher/denser
  // vegetation, negative = sparser/blighted, oscillating (multiple
  // peaks/valleys) rather than one smooth ramp as you cross the map.
  // Continuous rather than a discrete variant, so it needs no new tile ids.
  const flavor = foldWeirdness(weird);
  const density = (base: number) => Math.max(0.01, Math.min(0.9, base * (1 + flavor * 0.6)));

  if (biome === 'desert') return 'sand';
  if (biome === 'tundra') return treeRoll(x, y, s, density(0.04)) ? 'tree' : 'snow';
  if (biome === 'swamp') return treeRoll(x, y, s, density(0.10)) ? 'tree' : (ribbon < 0.42 ? 'swamp_water' : 'dirt');
  if (biome === 'forest') return treeRoll(x, y, s, density(0.34)) ? 'tree' : 'grass';
  if (biome === 'grassland') return treeRoll(x, y, s, density(grasslandTreeDensity(x, y, s))) ? 'tree' : 'grass';
  // plains: flat, sparse, no clumps — stays open
  return treeRoll(x, y, s, density(PLAINS_TREE_DENSITY)) ? 'tree' : 'grass';
}

// Coarse mask picks out clump zones (small groves) that fade into sparse
// individual trees everywhere else — grassland reads as "mostly open,
// occasional clumps" rather than an even sprinkle (see config.ts doc comment).
function grasslandTreeDensity(x: number, y: number, s: FieldSeeds): number {
  const mask = fbm(x, y, GRASSLAND_CLUMP_SCALE, s.clump);
  const t = clamp01((mask - GRASSLAND_CLUMP_LO) / (GRASSLAND_CLUMP_HI - GRASSLAND_CLUMP_LO));
  return GRASSLAND_SPARSE_DENSITY + t * (GRASSLAND_CLUMP_DENSITY - GRASSLAND_SPARSE_DENSITY);
}

// Deterministic per-tile tree scatter: fine-grained noise below a density
// threshold places a tree. Same coords + seed → same result on both sides.
function treeRoll(x: number, y: number, s: FieldSeeds, density: number): boolean {
  return octaveNoise(x, y, 2, TREE_SCALE, 0.5, 2, s.tree) < density;
}

// ── Danger ─────────────────────────────────────────────────────────────────
// danger = radial_trend(distance_from_origin) + wobble (R5.5). Wobble produces
// local minima — survivable pockets — so settlements and safe corridors can
// exist in dangerous bands (R5.6). Plateaus past DANGER_RADIUS (R4.2/R5.5).
// Takes only the danger radius off the atlas, not the whole atlas, so the atlas
// builder itself can call this while placing sites (it has no atlas yet).
export function dangerAt(x: number, y: number, s: FieldSeeds, atlas: Pick<RegionAtlas, 'dangerRadius'>): number {
  const dist = Math.hypot(x, y);
  const radial = Math.min(1, dist / atlas.dangerRadius);
  const wob = octaveNoise(x, y, 3, DANGER_WOBBLE_SCALE, 0.5, 2, s.wobble); // [0,1)
  return clamp01(radial + WOBBLE_AMP * (wob - 0.5) * 2);
}

// Danger → level band. Danger rises linearly to level 100 in fixed 5-level
// increments (20 bands) rather than the old 5-tier accelerating curve, so
// progression is uniform all the way to the plateau.
export const LEVEL_BAND_WIDTH = 5;
export const LEVEL_BAND_COUNT = 20; // 20 * LEVEL_BAND_WIDTH = level 100 cap

export function getLevelBand(danger: number): LevelBand {
  const bucket = Math.min(LEVEL_BAND_COUNT - 1, Math.floor(clamp01(danger) * LEVEL_BAND_COUNT));
  const minLevel = bucket * LEVEL_BAND_WIDTH + 1;
  return { tier: bucket + 1, minLevel, maxLevel: minLevel + LEVEL_BAND_WIDTH - 1 };
}
