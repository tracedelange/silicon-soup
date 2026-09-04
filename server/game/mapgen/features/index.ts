import type { GenOp } from '../../../../shared/types.ts';

// ─── Feature operators ─────────────────────────────────────────────────────────
//
// A feature operator is the single, unified concept for a named piece of zone
// content (a fountain, a market, a guard tower, a beach). It replaces the old
// trio of FeatureDef + BiomeConstraint + module: one registry, one toggle, one
// placement pass.
//
// An operator is a coordinate-free, optionally-parameterised bundle of ops with
// a placement PHASE. The phase gives coarse ordering so reservations land before
// the structures that must avoid them:
//
//   reserve  → claims space before buildings scatter (fountain/market discs)
//   build    → structural placement that competes for space (towers, walls, gates)
//   decorate → cosmetic placement after structure (the fountain basin, beaches)
//
// Within a phase, ops run in the order their features are listed. Biome-default
// features, zone-added features, and Implementor post-op features all resolve
// through this same pass (see resolveBiomeGenOps + the post_ops decorate path).

export type FeaturePhase = 'reserve' | 'build' | 'decorate';

/** A tunable numeric parameter on a feature operator (mirrors OpParam). */
export interface FeatureParam {
  field: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

/** Ops grouped by placement phase. An operator returning a bare GenOp[] has them
 *  assigned to its declared `phase` (default 'build'). */
export interface PhasedOps {
  reserve?: GenOp[];
  build?: GenOp[];
  decorate?: GenOp[];
}

export interface FeatureOperator {
  id: string;
  /** One or two sentences for an LLM selecting features for a zone. */
  note: string;
  /** Declared tunables. Resolved values (defaults overlaid with ref overrides)
   *  are passed to `blueprint`. Most operators declare none. */
  params?: FeatureParam[];
  /** Phase for ops returned as a bare array. Default 'build'. */
  phase?: FeaturePhase;
  /** Produces the operator's ops from resolved params. Coordinate-free; every
   *  placement is resolved by the engine against the live grid. */
  blueprint: (params: Record<string, number>) => GenOp[] | PhasedOps;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

import { fountain }      from './fountain.ts';
import { well }          from './well.ts';
import { marketSquare }  from './market_square.ts';
import { campfirePit }   from './campfire_pit.ts';
import { ruinedShrine }  from './ruined_shrine.ts';
import { guardTower }    from './guard_tower.ts';
import { cityWalls }     from './city_walls.ts';
import { wallGates }     from './wall_gates.ts';
import { beachN, beachS, beachE, beachW, beachNE, beachNW, beachSE, beachSW } from './ocean_border.ts';
import { riverVariants, bridgeVariants, RIVER_CODES, BRIDGE_CODES } from './river.ts';
import { wildernessBorder } from './wilderness_border.ts';
import { buildingPlots } from './building_plots.ts';
import { bossChamber }   from './boss_chamber.ts';

export const FEATURE_REGISTRY: Record<string, FeatureOperator> = {
  fountain,
  well,
  market_square:  marketSquare,
  campfire_pit:   campfirePit,
  ruined_shrine:  ruinedShrine,
  guard_tower:    guardTower,
  city_walls:     cityWalls,
  wall_gates:     wallGates,
  wilderness_border: wildernessBorder,
  building_plots: buildingPlots,
  boss_chamber:   bossChamber,
  beach_N:  beachN,
  beach_S:  beachS,
  beach_E:  beachE,
  beach_W:  beachW,
  beach_NE: beachNE,
  beach_NW: beachNW,
  beach_SE: beachSE,
  beach_SW: beachSW,
  ...riverVariants,
  ...bridgeVariants,
};

// ─── Biome policy (which features the cascade may select where) ─────────────────
//
// The engine places any feature on any zone, but the content cascade should
// only *select* features that make sense for a zone's biome. Two classes are
// excluded or restricted at selection time:
//
//   terrain  — beaches/rivers/bridges are world-gen-owned (fixed on the zone
//              graph). Never cascade-selected; they flow straight from the graph.
//   settlement — walls/towers/gates/fountains/markets read as broken in
//              wilderness (the "city_walls in a forest" bug), so they're gated
//              to settlement biomes.
//
// A content feature absent from FEATURE_BIOMES is universal (valid anywhere).

const TERRAIN_FEATURE_IDS = new Set<string>([
  'beach_N', 'beach_S', 'beach_E', 'beach_W', 'beach_NE', 'beach_NW', 'beach_SE', 'beach_SW',
  ...RIVER_CODES.map((c) => `river_${c}`),
  ...BRIDGE_CODES.map((c) => `bridge_${c}`),
]);

const FEATURE_BIOMES: Record<string, string[]> = {
  fountain:      ['village'],
  market_square: ['village'],
  city_walls:    ['village'],
  guard_tower:   ['village'],
  wall_gates:    ['village'],
  building_plots:['village'],
  well:          ['village', 'grassland', 'plains'],
};

/** Terrain features come from the zone graph, not the cascade. */
export const isTerrainFeature = (id: string): boolean => TERRAIN_FEATURE_IDS.has(id);

/** Biome restriction for a content feature ([] = any biome). For prompt annotation. */
export const featureBiomes = (id: string): string[] => FEATURE_BIOMES[id] ?? [];

/** Whether the cascade may select a content feature for a zone of `biome`.
 *  Terrain features are never selectable; an unrestricted feature is universal;
 *  an unknown biome (undefined) passes so callers without biome context don't drop. */
export function featureAllowedInBiome(id: string, biome?: string): boolean {
  if (isTerrainFeature(id)) return false;
  const allow = FEATURE_BIOMES[id];
  return !allow || !biome || allow.includes(biome);
}

/** Content feature ids (terrain excluded), optionally restricted to a biome. */
export function contentFeatureIds(biome?: string): string[] {
  return Object.keys(FEATURE_REGISTRY).filter((id) => featureAllowedInBiome(id, biome));
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/** A reference to a feature operator: its id plus optional param overrides. */
export interface FeatureRef {
  id: string;
  params?: Record<string, number>;
  /** Pin the feature's single placement op to this exact tile (hand-authoring). */
  at?: { x: number; y: number };
}

/** Whether a feature can be pinned to a tile (`at`): true if its resolved ops
 *  contain exactly one anchorable placement op — a count-1 scatter_sites, or a
 *  `place`. Multi/area features (walls, borders, building_plots) are not. */
export function isAnchorable(id: string): boolean {
  const op = FEATURE_REGISTRY[id];
  if (!op) return false;
  const r = op.blueprint(resolveParams(op.params, undefined));
  const all = Array.isArray(r) ? r : [...(r.reserve ?? []), ...(r.build ?? []), ...(r.decorate ?? [])];
  const placements = all.filter(o => o.type === 'place' || (o.type === 'scatter_sites' && o.count === 1));
  return placements.length === 1;
}

/** Inject a pinned `at` into a feature's single placement op (mutates in place). */
function applyAnchor(phased: ResolvedFeatures, at: { x: number; y: number }): void {
  for (const bucket of [phased.reserve, phased.build, phased.decorate]) {
    for (const o of bucket) {
      if (o.type === 'place' || (o.type === 'scatter_sites' && o.count === 1)) {
        (o as { at?: { x: number; y: number } }).at = at;
        return;
      }
    }
  }
}

/** Resolved ops bucketed by phase, ready to splice into the zone op list. */
export interface ResolvedFeatures {
  reserve: GenOp[];
  build: GenOp[];
  decorate: GenOp[];
}

/** Merge an operator's param defaults with a ref's overrides. */
function resolveParams(
  declared: FeatureParam[] | undefined,
  overrides: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of declared ?? []) out[p.field] = p.default;
  if (overrides) for (const [k, v] of Object.entries(overrides)) out[k] = v;
  return out;
}

/** True for an op whose primary painted tile is water — deferred to the end of
 *  the decorate phase so adjacent beaches don't clobber each other's water at
 *  corners (preserves the old resolveFeatureOps ordering). */
function isWaterOp(op: GenOp): boolean {
  return (op as { tile?: string }).tile === 'water';
}

/**
 * Resolves a list of feature refs to phase-bucketed ops. Unknown ids are warned
 * and skipped. Within the decorate phase, water-tile ops are deferred after all
 * non-water ops (beach-corner safety).
 */
export function resolveFeatureOperators(refs: FeatureRef[]): ResolvedFeatures {
  const out: ResolvedFeatures = { reserve: [], build: [], decorate: [] };
  for (const ref of refs) {
    const op = FEATURE_REGISTRY[ref.id];
    if (!op) { console.warn(`[features] Unknown feature '${ref.id}' — skipped.`); continue; }
    const params = resolveParams(op.params, ref.params);
    const result = op.blueprint(params);
    const phased: PhasedOps = Array.isArray(result) ? { [op.phase ?? 'build']: result } : result;
    // Pin this feature's placement op if the ref carries an `at` anchor. Done
    // per-ref so the anchor lands on THIS feature's op, not another's.
    const one: ResolvedFeatures = { reserve: phased.reserve ?? [], build: phased.build ?? [], decorate: phased.decorate ?? [] };
    if (ref.at) applyAnchor(one, ref.at);
    out.reserve.push(...one.reserve);
    out.build.push(...one.build);
    out.decorate.push(...one.decorate);
  }
  out.decorate.sort((a, b) => (isWaterOp(a) ? 1 : 0) - (isWaterOp(b) ? 1 : 0));
  return out;
}
