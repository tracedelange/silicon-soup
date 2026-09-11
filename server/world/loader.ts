import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import yaml from 'js-yaml';
import { BLOCKING_TILES, MOB_ROLES } from '../../shared/constants.ts';
import { WILD_BIOMES } from '../../shared/worldgen/field.ts';
import {
  BIOME_REGISTRY,
  resolveBiomeGenOps,
  mergeFeatures,
  mixZoneSeed,
  type BiomeDef,
} from '../game/mapgen/biomes/index.ts';
import { resolveFeatureOperators } from '../game/mapgen/features/index.ts';
import { resolveSeed, mulberry32 } from '../game/mapgen/rng.ts';
import { normalizeZoneFeatures, compilePrefabFeatureOps } from '../game/mapgen/zoneFeatures.ts';
import type {
  AbilityDef, Affix, Archetype, DungeonDef, ItemBase, Material, MobTemplate, Prefab, QuestDef, Tileset,
  WorldDefs, ZoneDef,
} from '../../shared/types.ts';
import { validateQuestDef } from './quest_schema.ts';
import { validateAbilityDef } from './ability_schema.ts';
import { composeBases } from '../game/items/bases.ts';
import { AFFINITY_TAGS } from '../game/items/generator.ts';

function readYaml<T>(path: string): T {
  return yaml.load(readFileSync(path, 'utf8')) as T;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Authored min/max overrides stored in world/biome-params.json. */
type BiomeParamOverrides = Record<string, {
  zoneParams?: Record<string, { min?: number; max?: number }>;
  opParams?:   Record<string, Record<string, { min?: number; max?: number }>>;
}>;

export function loadBiomeParamOverrides(worldDir: string): BiomeParamOverrides {
  try { return JSON.parse(readFileSync(join(worldDir, 'biome-params.json'), 'utf8')); }
  catch { return {}; }
}

/** Derives a deterministic value within [min, max] snapped to step, keyed by seed + path. */
function seedParam(
  p: { min: number; max: number; step: number },
  overrides: { min?: number; max?: number } | undefined,
  zoneSeed: string,
  path: string,
): number {
  const min = overrides?.min ?? p.min;
  const max = overrides?.max ?? p.max;
  const rng = mulberry32(resolveSeed(`${zoneSeed}:param:${path}`));
  const steps = Math.round((max - min) / p.step);
  return min + Math.round(rng() * steps) * p.step;
}

/**
 * Seed a biome's zone-level and basePipeline op-level params from the zone seed
 * (within authored min/max bounds), then overlay explicit zone-file overrides.
 * Shared by resolveBiomeOps and the zone-editor's biome-eject path so a baked
 * zone reproduces the same seeded params the biome would have produced.
 */
export function seedBiomeParams(
  biomeDef: BiomeDef,
  paramOverrides: BiomeParamOverrides,
  zone: ZoneDef,
  rawSeed: string,
): { mergedZoneParams: Record<string, number>; mergedOpParams: Record<string, Record<string, number>> } {
  const biomeOver = paramOverrides[biomeDef.id] ?? {};

  const seededZoneParams: Record<string, number> = {};
  for (const p of biomeDef.zoneParams ?? []) {
    seededZoneParams[p.id] = seedParam(p, biomeOver.zoneParams?.[p.id], rawSeed, p.id);
  }
  const mergedZoneParams = { ...seededZoneParams, ...(zone.zoneParams ?? {}) };

  const seededOpParams: Record<string, Record<string, number>> = {};
  for (const entry of biomeDef.basePipeline) {
    if (entry.id && entry.params?.length) {
      seededOpParams[entry.id] = {};
      for (const p of entry.params) {
        const over = biomeOver.opParams?.[entry.id]?.[p.field];
        seededOpParams[entry.id]![p.field] = seedParam(p, over, rawSeed, `${entry.id}:${p.field}`);
      }
    }
  }
  // Field-level merge: zone file overrides win per field, not per entry.
  const mergedOpParams: Record<string, Record<string, number>> = { ...seededOpParams };
  for (const [entryId, fields] of Object.entries(zone.opParams ?? {})) {
    mergedOpParams[entryId] = { ...(mergedOpParams[entryId] ?? {}), ...fields };
  }
  return { mergedZoneParams, mergedOpParams };
}

/**
 * When a zone specifies a `biome`, derive its `ops` from the biome pipeline
 * at load time. All declared biome params (zone-level and op-level) are seeded
 * from the zone seed for deterministic per-zone variation. Authored min/max
 * bounds from biome-params.json constrain the seeded range. Explicit zone-file
 * overrides in `zoneParams` / `opParams` always take precedence.
 */
export function resolveBiomeOps(
  zone: ZoneDef,
  paramOverrides: BiomeParamOverrides,
  prefabs: Record<string, Prefab> = {},
): ZoneDef {
  // No biome: the zone's `ops` are authored verbatim, but its `features` still
  // resolve through the same registry/prefab path a biome zone uses — so a
  // deconstructed ("ejected") zone keeps fountains/markets/prefabs as named,
  // toggleable feature entries rather than inlined raw ops. Feature ops are
  // woven around the authored base ops by phase (reserve → base → build →
  // decorate); only the feature ops get seed-mixed (authored ops are left as-is).
  if (!zone.biome) {
    if (!zone.features?.length) return zone;
    const normalized = normalizeZoneFeatures(zone.features, prefabs);
    const feat = resolveFeatureOperators(mergeFeatures([], normalized.overrides));
    const seed = resolveSeed(zone.seed ?? `${zone.id}:default`);
    const ops = [
      ...mixZoneSeed(feat.reserve, seed),
      ...(zone.ops ?? []),
      ...mixZoneSeed(feat.build, seed),
      ...mixZoneSeed(feat.decorate, seed),
    ];
    const post_ops = [
      ...(zone.post_ops ?? []),
      ...compilePrefabFeatureOps(normalized.prefabEntries, prefabs, zone.id),
    ];
    return { ...zone, ops, ...(post_ops.length ? { post_ops } : {}) };
  }

  const biomeDef = BIOME_REGISTRY[zone.biome];
  if (!biomeDef) {
    console.warn(`[loader] Zone '${zone.id}' references unknown biome '${zone.biome}' — skipping op derivation.`);
    return zone;
  }

  const rawSeed = zone.seed ?? `${zone.id}:default`;
  const { mergedZoneParams, mergedOpParams } = seedBiomeParams(biomeDef, paramOverrides, zone, rawSeed);

  // Split the zone's features into registry-operator overrides (merged with the
  // biome's defaults) and prefab features (compiled into post_ops below).
  const normalized = normalizeZoneFeatures(zone.features, prefabs);
  const features = mergeFeatures(biomeDef.features, normalized.overrides);
  const { ops } = resolveBiomeGenOps(biomeDef, rawSeed, {
    opParams: mergedOpParams,
    features,
  });

  const inset = zone.inset ?? mergedZoneParams['inset'] ?? 0;

  const post_ops = [
    ...(zone.post_ops ?? []),
    ...compilePrefabFeatureOps(normalized.prefabEntries, prefabs, zone.id),
    ...(biomeDef.defaultPostOps ?? []),
  ];
  const spawns = [
    ...(zone.spawns ?? []),
    ...(biomeDef.defaultSpawns ?? []),
  ];

  return {
    tileset:      zone.tileset      ?? biomeDef.tileset,
    width:        zone.width        ?? biomeDef.width,
    height:       zone.height       ?? biomeDef.height,
    default_tile: zone.default_tile ?? biomeDef.defaultTile,
    ...zone,
    inset,
    ops,
    ...(post_ops.length ? { post_ops } : {}),
    ...(spawns.length ? { spawns } : {}),
  };
}

/**
 * Load the world.
 *
 * `wildEpoch` seeds the per-epoch dungeon instances (see shared/worldgen/epoch.ts):
 * a dungeon's roster entry is a zone PROGRAM with no seed, and the interior is
 * re-derived from (dungeon id, epoch) every rotation. Tools that only inspect
 * static content can leave it at 0 and get a stable world.
 */
export function loadWorld(rootDir: string, wildEpoch = 0): WorldDefs {
  const zones: Record<string, ZoneDef> = {};
  const dungeons: Record<string, DungeonDef> = {};
  const mobs: Record<string, MobTemplate> = {};
  const itemBases: Record<string, ItemBase> = {};
  const affixes: { prefixes: Affix[]; suffixes: Affix[] } = { prefixes: [], suffixes: [] };
  const quests: Record<string, QuestDef> = {};
  const abilities: Record<string, AbilityDef> = {};
  const tilesets: Record<string, Tileset> = {};
  const prefabs: Record<string, Prefab> = {};

  // Named prefabs (optional dir). Loaded before zones because prefab feature
  // entries compile against the registry. Available by id to stamp/place ops.
  const prefabsDir = join(rootDir, 'prefabs');
  if (existsSync(prefabsDir)) {
    for (const file of walk(prefabsDir)) {
      if (extname(file) !== '.json') continue;
      const prefab = readJson<Prefab>(file);
      const id = prefab.id || basename(file, '.json');
      prefabs[id] = { ...prefab, id };
    }
  }

  const paramOverrides = loadBiomeParamOverrides(rootDir);
  const zonesDir = join(rootDir, 'zones');
  for (const file of walk(zonesDir)) {
    const ext = extname(file);
    let zone: ZoneDef | null = null;
    if (ext === '.yaml') zone = readYaml<ZoneDef>(file);
    else if (ext === '.json') zone = readJson<ZoneDef>(file);
    if (!zone) continue;
    zones[zone.id] = resolveBiomeOps(zone, paramOverrides, prefabs);
  }

  // Dungeon roster. Each entry contributes BOTH a placement record (consumed by
  // the atlas) and a zone instance keyed by the dungeon id, seeded from the wild
  // epoch — so the same named dungeon has a different interior each rotation
  // while every reference to it (portals, discoveries, quests) stays stable.
  const dungeonsDir = join(rootDir, 'dungeons');
  if (existsSync(dungeonsDir)) {
    for (const file of walk(dungeonsDir)) {
      if (extname(file) !== '.json') continue;
      const def = readJson<DungeonDef>(file);
      const id = def.id || basename(file, '.json');
      if (zones[id]) {
        throw new Error(`Dungeon "${id}" (${file}): a zone with this id already exists in world/zones/.`);
      }
      if ('id' in def.zone || 'seed' in def.zone) {
        throw new Error(`Dungeon "${id}" (${file}): the zone template must not set 'id' or 'seed' — both are supplied per epoch.`);
      }
      dungeons[id] = { ...def, id };
      const instance: ZoneDef = { ...def.zone, id, seed: `${id}:${wildEpoch}` };
      zones[id] = resolveBiomeOps(instance, paramOverrides, prefabs);
      // An exterior footprint is a zone program too, so it gets the same biome-op
      // resolution the interior does — otherwise `features` on a camp would be
      // silently inert. It is NOT registered in `zones`: it is never entered, it
      // is baked onto the field (server/game/mapgen/bake.ts).
      if (def.footprint) {
        const resolved = resolveBiomeOps({ ...def.footprint, id: `${id}__footprint` } as ZoneDef, paramOverrides, prefabs);
        const { id: _id, seed: _seed, ...template } = resolved;
        dungeons[id]!.footprint = template;
      }
    }
  }

  // Abilities load before mobs so a mob's ability references can be validated.
  const abilitiesDir = join(rootDir, 'abilities');
  if (existsSync(abilitiesDir)) {
    for (const file of walk(abilitiesDir)) {
      if (extname(file) !== '.yaml') continue;
      const ability = validateAbilityDef(readYaml(file), file);
      abilities[ability.id] = ability;
    }
  }

  const mobsDir = join(rootDir, 'entities', 'mobs');
  for (const file of walk(mobsDir)) {
    if (extname(file) !== '.yaml') continue;
    const mob = readYaml<MobTemplate>(file);
    if (!(mob.role in MOB_ROLES)) {
      const valid = Object.keys(MOB_ROLES).join(', ');
      throw new Error(`Mob "${mob.id}" (${file}): invalid role "${mob.role}". Must be one of: ${valid}`);
    }
    for (const entry of mob.abilities ?? []) {
      if (!abilities[entry.ability]) {
        throw new Error(`Mob "${mob.id}" (${file}): unknown ability "${entry.ability}". Define it in world/abilities/.`);
      }
    }
    for (const b of mob.biomes ?? []) {
      if (!WILD_BIOMES.includes(b)) {
        throw new Error(`Mob "${mob.id}" (${file}): invalid biome "${b}". Must be one of: ${WILD_BIOMES.join(', ')}`);
      }
    }
    // A featured shelf whose affinity terms aren't in the AFFINITY_TAGS
    // vocabulary silently maps to no tags, which degrades the shelf to an
    // unfiltered roll — a weaponsmith quietly selling greaves. Catch the typo
    // at load, the way role/biome typos already are.
    for (const a of mob.featured_stock?.affinity ?? []) {
      if (!(a in AFFINITY_TAGS)) {
        const valid = Object.keys(AFFINITY_TAGS).join(', ');
        throw new Error(`Mob "${mob.id}" (${file}): invalid featured_stock affinity "${a}". Must be one of: ${valid}`);
      }
    }
    mobs[mob.id] = mob;
  }

  const basesDir = join(rootDir, 'entities', 'items', 'bases');
  for (const file of walk(basesDir)) {
    if (extname(file) !== '.yaml') continue;
    const base = readYaml<ItemBase>(file);
    itemBases[base.id] = base;
  }

  // Procedural bases: material × archetype. Hand-authored bases above win on id
  // collision (e.g. the tuned iron_sword), so only add ids not already present.
  const itemsDir = join(rootDir, 'entities', 'items');
  const materialsPath = join(itemsDir, 'materials.yaml');
  const archetypesPath = join(itemsDir, 'archetypes.yaml');
  if (existsSync(materialsPath) && existsSync(archetypesPath)) {
    const materials = readYaml<{ materials: Material[] }>(materialsPath).materials || [];
    const archetypes = readYaml<{ archetypes: Archetype[] }>(archetypesPath).archetypes || [];
    for (const base of composeBases(materials, archetypes)) {
      if (!itemBases[base.id]) itemBases[base.id] = base;
    }
  }

  const affixesDir = join(rootDir, 'entities', 'items', 'affixes');
  for (const file of walk(affixesDir)) {
    if (extname(file) !== '.yaml') continue;
    const doc = readYaml<{ prefixes?: Affix[]; suffixes?: Affix[] }>(file);
    if (doc.prefixes) affixes.prefixes.push(...doc.prefixes);
    if (doc.suffixes) affixes.suffixes.push(...doc.suffixes);
  }

  const questsDir = join(rootDir, 'quests');
  for (const file of walk(questsDir)) {
    if (extname(file) !== '.yaml') continue;
    const quest = readYaml<QuestDef>(file);
    validateQuestDef(quest, file);
    quests[quest.id] = quest;
  }

  const tilesetsDir = join(rootDir, 'tilesets');
  for (const file of walk(tilesetsDir)) {
    if (extname(file) !== '.json') continue;
    const ts = readJson<Tileset>(file);
    tilesets[ts.name || basename(file, '.json')] = ts;
  }

  // Extend the base blocking set with any tile entries that carry blocking: true.
  const blockingTiles = new Set(BLOCKING_TILES);
  for (const ts of Object.values(tilesets)) {
    for (const [name, entry] of Object.entries(ts.tiles)) {
      if (entry.blocking) blockingTiles.add(name);
    }
  }

  return { zones, mobs, itemBases, affixes, quests, abilities, tilesets, prefabs, dungeons, blockingTiles };
}
