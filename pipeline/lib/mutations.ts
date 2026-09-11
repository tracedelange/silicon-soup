// The atomic, validated mutation boundary (Implementor v3).
//
// This is the single seam every world change commits through. The Implementer's
// entire response is a flat list of discriminated `Mutation` ops; this module:
//
//   1. structurally validates each op (Zod, at the schema boundary), then
//   2. semantically validates the whole set up front — roles, references,
//      grids, field shapes, per-opportunity-type op scope — in ONE place
//      (`validateMutations`), partitioning into { valid, failed } so a single
//      bad op is isolated, not fatal, and
//   3. applies the valid set atomically (`applyMutations`): it snapshots every
//      file it will touch and rolls all of them back if any write throws, so a
//      failure never leaves the world half-mutated.
//
// This replaces three scattered, drift-prone validators (the old
// implementer.collectBodyErrors, fileOps.applyFileOps inline checks, and
// refValidate.validateReferences) with one source of truth. `MOB_ROLES` etc.
// are imported once; a bad role is a Zod enum rejection at the boundary.

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import { REPO_ROOT, WORLD_DIR } from './io.ts';
import { MOB_ROLES } from '../../shared/constants.ts';
import { BIOME_REGISTRY } from '../../server/game/mapgen/biomes/index.ts';
import { FEATURE_REGISTRY } from '../../server/game/mapgen/features/index.ts';
import { LevelBandSchema, FeatureEntrySchema, NewZoneSpecSchema, buildZoneStubFromSpec } from './zoneStub.ts';
import { QuestBodySchema, validateStageGraph } from '../../server/world/quest_schema.ts';
import type { WorldDefs, ZoneDef, ZoneSpawn, PrefabData, ZoneFeatureEntry, QuestDef } from '../../shared/types.ts';

// ── Op schemas ────────────────────────────────────────────────────────────────
// Each member is a PURE ZodObject (no .superRefine wrappers) so the set can form
// a discriminatedUnion on `op`. Cross-field and reference checks live in
// `validateMutations`, not here — structure at the boundary, semantics in one
// pass.

const ID_RE = /^[a-z0-9_]+$/;
const RangeSchema = z.tuple([z.number(), z.number()]);

const MobRoleSchema = z.enum(Object.keys(MOB_ROLES) as [string, ...string[]]);
const LootEntrySchema = z.object({ item: z.string().min(1), chance: z.number().min(0).max(1) }).strict();
const ShopEntrySchema = z.object({ item: z.string().min(1), price: z.number().nonnegative() }).strict();
const MobStatsSchema = z.object({
  strength: z.number().int().optional(),
  dexterity: z.number().int().optional(),
  intelligence: z.number().int().optional(),
  constitution: z.number().int().optional(),
}).strict();
const MobAbilitySchema = z.object({
  ability: z.string().min(1),
  weight: z.number().optional(),
  hp_below: z.number().min(0).max(1).optional(),
}).strict();

// The mob template body, shared by create_mob (the op IS this body + a tag) and
// patch_mob (which validates the MERGED result against it — see validateOne).
const MOB_BODY = {
  id: z.string().regex(ID_RE),
  name: z.string().min(1),
  sprite: z.string().min(1),
  level: z.number().int().positive(),
  role: MobRoleSchema,
  speed: z.number().nonnegative(),
  behavior: z.string().min(1),
  aggro_range: z.number().nonnegative(),
  xp: z.number().int().nonnegative().optional(),
  dialogue: z.array(z.string()).optional(),
  loot_table: z.array(LootEntrySchema).optional(),
  loot_affinity: z.array(z.string()).optional(),
  loot_brand: z.array(z.string()).optional(),
  shop: z.array(ShopEntrySchema).optional(),
  fixture: z.boolean().optional(),
  unique: z.boolean().optional(),
  sign: z.boolean().optional(),
  board_id: z.string().optional(),
  light_radius: z.number().optional(),
  draw_scale: z.number().optional(),
  sprite_facing: z.enum(['east', 'west']).optional(),
  respawn_seconds: z.number().optional(),
  stats: MobStatsSchema.optional(),
  armor: z.number().optional(),
  abilities: z.array(MobAbilitySchema).optional(),
  leash_radius: z.number().nonnegative().optional(),
} as const;
export const MobBodySchema = z.object(MOB_BODY).strict();

const CreateMobSchema = z.object({ op: z.literal('create_mob'), ...MOB_BODY }).strict();

// Surgical edit of an existing mob: merge `set` onto the on-disk template and
// validate the RESULT (not the partial) against MobBodySchema, so a typo'd key
// or bad value is caught even though `set` itself is loosely typed. Lets a cheap
// model fix one field without re-emitting the whole template.
const PatchMobSchema = z.object({
  op: z.literal('patch_mob'),
  id: z.string().regex(ID_RE),
  set: z.record(z.string(), z.unknown()),
}).strict();

const ItemSlotSchema = z.enum([
  'mainhand', 'helmet', 'chest', 'gloves', 'leggings', 'boots', 'ring1', 'ring2', 'amulet',
  'ring', 'currency', 'quest', 'consumable',
]);

// Item base body, shared by create_item and patch_item (validates the merged result).
const ITEM_BODY = {
  id: z.string().regex(ID_RE),
  name: z.string().min(1),
  slot: ItemSlotSchema,
  tags: z.array(z.string()),
  sprite: z.string().optional(),
  base_damage: RangeSchema.optional(),
  base_defense: RangeSchema.optional(),
  base_speed: z.number().optional(),
  value: z.union([RangeSchema, z.number()]).optional(),
  sell_value: z.number().optional(),
  use_effect: z.object({ heal: z.union([RangeSchema, z.number()]).optional() }).strict().optional(),
  scaling: z.record(z.string(), z.string()).optional(),
  min_ilvl: z.number().int().optional(),
} as const;
export const ItemBodySchema = z.object(ITEM_BODY).strict();

const CreateItemSchema = z.object({ op: z.literal('create_item'), ...ITEM_BODY }).strict();

// Surgical edit of an existing item base (merge-then-validate, like patch_mob).
const PatchItemSchema = z.object({
  op: z.literal('patch_item'),
  id: z.string().regex(ID_RE),
  set: z.record(z.string(), z.unknown()),
}).strict();

const CreateQuestSchema = QuestBodySchema.extend({ op: z.literal('create_quest') });

// Surgical edit of an existing quest (merge-then-validate). For one-stage fixes
// without re-emitting the whole quest. The merged result is checked exactly as
// create_quest is (stage graph + giver/zone/objective references).
const PatchQuestSchema = z.object({
  op: z.literal('patch_quest'),
  id: z.string().regex(ID_RE),
  set: z.record(z.string(), z.unknown()),
}).strict();

const CreatePrefabSchema = z.object({
  op: z.literal('create_prefab'),
  id: z.string().regex(ID_RE),
  description: z.string().optional(),
  data: z.string().min(1),
  legend: z.record(z.string(), z.string()),
  anchors: z.record(z.string(), z.string()).optional(),
}).strict();

const CreateZoneSchema = NewZoneSpecSchema.extend({ op: z.literal('create_zone') });

const SpawnEntrySchema = z.object({
  entity: z.string().min(1),
  region: z.string().min(1).optional(),
  count: z.number().int().positive().optional(),
  respawn_seconds: z.number().positive().optional(),
  spawn_id: z.string().min(1).optional(),
}).strict();

const AddSpawnsSchema = z.object({
  op: z.literal('add_spawns'),
  zone_id: z.string().min(1),
  spawns: z.array(SpawnEntrySchema).min(1),
}).strict();

// The consolidate verb: thin an over-populated zone by dropping every file-level
// spawn entry whose entity is named here. Biome-default spawns are injected at
// load and cannot be removed this way (a no-match is a soft apply-time warning).
const RemoveSpawnsSchema = z.object({
  op: z.literal('remove_spawns'),
  zone_id: z.string().min(1),
  entities: z.array(z.string().min(1)).min(1),
}).strict();

const AddFeaturesSchema = z.object({
  op: z.literal('add_features'),
  zone_id: z.string().min(1),
  features: z.array(FeatureEntrySchema).min(1),
}).strict();

// Consolidate verb for structures: drop Implementor-added feature entries by id.
// Biome-default features aren't in the file (disable those via add_features with
// { id, enabled: false }); a no-match is a soft apply-time warning.
const RemoveFeaturesSchema = z.object({
  op: z.literal('remove_features'),
  zone_id: z.string().min(1),
  features: z.array(z.string().min(1)).min(1),
}).strict();

const SetZoneFieldSchema = z.object({
  op: z.literal('set_zone_field'),
  zone_id: z.string().min(1),
  field: z.enum(['name', 'level_band']),
  value: z.unknown(),
}).strict();

const TileEntrySchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a #rrggbb hex string' }),
  blocking: z.boolean().optional(),
}).passthrough();

const UpdateTilesetSchema = z.object({
  op: z.literal('update_tileset'),
  tileset: z.string().min(1),
  tiles: z.record(z.string(), TileEntrySchema).optional(),
  sprites: z.record(z.string(), TileEntrySchema).optional(),
}).strict();

const UpdateLoreSchema = z.object({
  op: z.literal('update_lore'),
  zones_append: z.array(z.unknown()).optional(),
  factions_append: z.array(z.unknown()).optional(),
  geography_append: z.array(z.unknown()).optional(),
  zones_replace: z.array(z.unknown()).optional(),
  factions_replace: z.array(z.unknown()).optional(),
  geography_replace: z.array(z.unknown()).optional(),
  unresolved_resolve: z.array(z.string()).optional(),
  unresolved_append: z.array(z.string()).optional(),
  unresolved_replace: z.array(z.string()).optional(),
}).passthrough();

export const MutationSchema = z.discriminatedUnion('op', [
  CreateMobSchema,
  PatchMobSchema,
  CreateItemSchema,
  PatchItemSchema,
  CreateQuestSchema,
  PatchQuestSchema,
  CreatePrefabSchema,
  CreateZoneSchema,
  AddSpawnsSchema,
  RemoveSpawnsSchema,
  AddFeaturesSchema,
  RemoveFeaturesSchema,
  SetZoneFieldSchema,
  UpdateTilesetSchema,
  UpdateLoreSchema,
]);

export type Mutation = z.infer<typeof MutationSchema>;
export type MutationOp = Mutation['op'];

// ── Per-opportunity-type op allow-list ──────────────────────────────────────
// Constrains the op set an opportunity type may emit, so over-reach (a
// mob_populate emitting an update_tileset) is rejected with a clear message
// instead of adding failure surface. A type absent from this map allows any op.
// The single source of truth, enforced here AND rendered into the per-type
// Implementer prompt (prompts.ts imports this), so the allowed-op list the model
// is told and the list the engine enforces can never drift.
export const OPS_BY_TYPE: Record<string, readonly MutationOp[]> = {
  zone_enhance: ['add_features', 'remove_features', 'add_spawns', 'remove_spawns', 'set_zone_field', 'create_prefab', 'create_mob', 'patch_mob', 'create_item', 'patch_item', 'update_lore'],
  zone_connect: ['create_zone', 'add_features', 'create_prefab', 'create_mob', 'create_item', 'update_lore'],
  mob_populate: ['create_mob', 'patch_mob', 'create_item', 'patch_item', 'add_spawns', 'remove_spawns', 'update_tileset'],
  merchant_add: ['create_mob', 'patch_mob', 'create_item', 'patch_item'],
  prefab_create: ['create_prefab', 'add_features', 'remove_features'],
  quest_add: ['create_quest', 'patch_quest', 'create_mob', 'create_item', 'add_spawns'],
  quest_refactor: ['create_quest', 'patch_quest'],
  lore_refactor: ['update_lore'],
  tile_create: ['update_tileset'],
};

// Legacy/hand-written opportunity-type aliases (opportunities.yaml is human-editable).
export const TYPE_ALIASES: Record<string, string> = {
  add_entity: 'mob_populate', add_quest: 'quest_add', refactor_quest: 'quest_refactor',
  refactor_lore: 'lore_refactor', add_tile: 'tile_create', deepen_zone: 'zone_enhance',
  refactor_zone: 'zone_enhance',
};

/** The op set an opportunity type may emit, or null when unconstrained. */
export function allowedOpsFor(opportunityType: string | undefined): ReadonlySet<MutationOp> | null {
  if (!opportunityType) return null;
  const resolved = OPS_BY_TYPE[opportunityType] ?? OPS_BY_TYPE[TYPE_ALIASES[opportunityType] ?? ''];
  return resolved ? new Set(resolved) : null;
}

// ── Prefab grid validation ───────────────────────────────────────────────────

const MAX_PREFAB_W = Math.max(...Object.values(BIOME_REGISTRY).map((b) => b.width));
const MAX_PREFAB_H = Math.max(...Object.values(BIOME_REGISTRY).map((b) => b.height));

/** Rectangular, sized to fit a zone, every glyph covered by the legend.
 *  Returns an error string, or null when valid. */
export function validatePrefabGrid(prefab: Pick<PrefabData, 'data' | 'legend'>): string | null {
  if (typeof prefab.data !== 'string' || !prefab.data.length) return 'prefab.data must be a non-empty string';
  const rows = prefab.data.replace(/\n+$/, '').split('\n');
  const width = rows[0]?.length ?? 0;
  if (width > MAX_PREFAB_W || rows.length > MAX_PREFAB_H) {
    return `prefab grid ${width}x${rows.length} exceeds the largest zone ` +
      `(${MAX_PREFAB_W}x${MAX_PREFAB_H}) — it could never be stamped. Shrink it.`;
  }
  for (let r = 0; r < rows.length; r++) {
    if (rows[r]!.length !== width) {
      return `prefab grid is not rectangular: row ${r} has length ${rows[r]!.length}, expected ${width}`;
    }
    for (const ch of rows[r]!) {
      if (!(ch in (prefab.legend ?? {}))) return `prefab data uses character '${ch}' not present in legend`;
    }
  }
  return null;
}

// ── Zone file IO (format-preserving) ─────────────────────────────────────────

interface ZoneFile { path: string; format: 'json' | 'yaml'; doc: ZoneDef & Record<string, unknown> }

function readZoneFile(zoneId: string): ZoneFile {
  const jsonPath = join(WORLD_DIR, 'zones', `${zoneId}.json`);
  const yamlPath = join(WORLD_DIR, 'zones', `${zoneId}.yaml`);
  if (existsSync(jsonPath)) return { path: jsonPath, format: 'json', doc: JSON.parse(readFileSync(jsonPath, 'utf8')) };
  if (existsSync(yamlPath)) return { path: yamlPath, format: 'yaml', doc: yaml.load(readFileSync(yamlPath, 'utf8')) as ZoneFile['doc'] };
  throw new Error(`[mutations] zone '${zoneId}' not found (looked for ${zoneId}.json / .yaml).`);
}

function serializeZoneFile(zf: ZoneFile): string {
  return zf.format === 'json' ? JSON.stringify(zf.doc, null, 2) + '\n' : yaml.dump(zf.doc, { lineWidth: -1, noRefs: true });
}

// Named/singleton NPC dedup: append_spawns must never duplicate a `unique: true`
// mob already present in the zone or its biome defaults.
const uniqueEntityCache = new Map<string, boolean>();
function isUniqueEntity(entity: string): boolean {
  const cached = uniqueEntityCache.get(entity);
  if (cached !== undefined) return cached;
  let unique = false;
  const p = join(WORLD_DIR, 'entities', 'mobs', `${entity}.yaml`);
  if (existsSync(p)) {
    try { unique = (yaml.load(readFileSync(p, 'utf8')) as Record<string, unknown> | null)?.unique === true; }
    catch { /* malformed — treat as non-unique */ }
  }
  uniqueEntityCache.set(entity, unique);
  return unique;
}

// A quest giver is a de-facto singleton: placing it twice means the same quest
// is offered from two bodies. We dedup givers like unique NPCs even when the
// mob lacks `unique: true` — a cheap model routinely forgets the flag, and the
// duplicate would otherwise slip through. Built by scanning the quests dir;
// invalidated (set to null) whenever a quest is written this run.
let questGiverCache: Set<string> | null = null;
function isQuestGiver(entity: string): boolean {
  if (questGiverCache === null) {
    questGiverCache = new Set<string>();
    const dir = join(WORLD_DIR, 'quests');
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
        try {
          const giver = (yaml.load(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown> | null)?.giver;
          if (typeof giver === 'string') questGiverCache.add(giver);
        } catch { /* malformed quest — skip */ }
      }
    }
  }
  return questGiverCache.has(entity);
}

// ── Reference universe ───────────────────────────────────────────────────────
// IDs that will exist after this whole op set is applied: world state + every
// entity/item/prefab/zone/tile created by an op in the same set.

interface Refs {
  mobs: Set<string>; items: Set<string>; prefabs: Set<string>; zones: Set<string>;
  tiles: Set<string>; sprites: Set<string>; spawnIds: Set<string>;
  /** Entity template ids spawned in each zone (world spawns + this response's
   *  add_spawns / create_zone). Lets a quest verify its giver actually lives in
   *  the quest's zone, so a template giver is genuinely zone-scoped. */
  spawnedByZone: Map<string, Set<string>>;
}

function collectRefs(ops: Mutation[], world: WorldDefs): Refs {
  const refs: Refs = {
    mobs: new Set(Object.keys(world.mobs)),
    items: new Set(Object.keys(world.itemBases)),
    prefabs: new Set(Object.keys(world.prefabs)),
    zones: new Set(Object.keys(world.zones)),
    tiles: new Set(), sprites: new Set(), spawnIds: new Set(),
    spawnedByZone: new Map(),
  };
  const addSpawned = (zoneId: string, entity: string): void => {
    let s = refs.spawnedByZone.get(zoneId);
    if (!s) { s = new Set(); refs.spawnedByZone.set(zoneId, s); }
    s.add(entity);
  };
  for (const ts of Object.values(world.tilesets)) {
    for (const t of Object.keys(ts.tiles)) refs.tiles.add(t);
    for (const s of Object.keys(ts.sprites)) refs.sprites.add(s);
  }
  for (const z of Object.values(world.zones)) {
    for (const s of z.spawns ?? []) { if (s.spawn_id) refs.spawnIds.add(s.spawn_id); addSpawned(z.id, s.entity); }
  }
  for (const op of ops) {
    switch (op.op) {
      case 'create_mob': refs.mobs.add(op.id); break;
      case 'create_item': refs.items.add(op.id); break;
      case 'create_prefab': refs.prefabs.add(op.id); break;
      case 'create_zone': refs.zones.add(op.id); for (const s of op.spawns ?? []) addSpawned(op.id, s.entity); break;
      case 'add_spawns': for (const s of op.spawns) { if (s.spawn_id) refs.spawnIds.add(s.spawn_id); addSpawned(op.zone_id, s.entity); } break;
      case 'update_tileset':
        for (const t of Object.keys(op.tiles ?? {})) refs.tiles.add(t);
        for (const s of Object.keys(op.sprites ?? {})) refs.sprites.add(s);
        break;
    }
  }
  return refs;
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface MutationFailure { op: Mutation; error: string }
export interface ValidateResult { valid: Mutation[]; failed: MutationFailure[] }

export interface ValidateOpts {
  /** Opportunity type — constrains the allowed op set (over-reach guard). */
  opportunityType?: string;
  /** Zone ids a zone-modifying op (add_spawns/add_features/set_zone_field) may
   *  touch. Without this, no scope check runs. Created zones are always allowed. */
  allowedZoneIds?: Set<string>;
}

function checkSpawns(spawns: Array<{ entity: string }>, refs: Refs, where: string, errs: string[]): void {
  for (const s of spawns) {
    if (!refs.mobs.has(s.entity)) {
      errs.push(`${where}: spawn entity '${s.entity}' does not exist and is not created in this response`);
    }
  }
}

// A mob's referenced sprite / loot / shop items must exist (in the world or
// created this response). Shared by create_mob and patch_mob (which runs it on
// the merged result) so the reference rules can't diverge between the two.
function checkMobRefs(
  mob: { sprite?: string; loot_table?: Array<{ item: string }>; shop?: Array<{ item: string }> },
  refs: Refs, where: string, errs: string[],
): void {
  if (mob.sprite && !refs.sprites.has(mob.sprite)) {
    errs.push(`${where}: sprite '${mob.sprite}' is not in any tileset — add it via an update_tileset op or use an existing sprite`);
  }
  for (const l of mob.loot_table ?? []) {
    if (!refs.items.has(l.item)) errs.push(`${where}: loot_table item '${l.item}' does not exist and is not created in this response`);
  }
  for (const s of mob.shop ?? []) {
    if (!refs.items.has(s.item)) errs.push(`${where}: shop item '${s.item}' does not exist and is not created in this response`);
  }
}

// A weapon base must carry base_damage or it equips as junk. Shared by
// create_item and patch_item (run on the merged result).
function checkItemBody(item: { slot: string; tags: string[]; base_damage?: unknown }, where: string, errs: string[]): void {
  const isWeapon = item.slot === 'mainhand' || (item.tags ?? []).includes('weapon') || (item.tags ?? []).includes('melee');
  if (isWeapon && !item.base_damage) {
    errs.push(`${where}: a weapon base must define base_damage: [min, max] — a damageless weapon equips as junk`);
  }
}

// Stage graph + reference + zone-scope checks for a quest body. Shared by
// create_quest and patch_quest (run on the merged result). A TEMPLATE giver must
// declare `zone` and actually be spawned there, so the quest binds to that one
// region rather than lighting up on every mob of that template across the map.
// A spawn_id giver is already instance-bound, so it is exempt from the zone rule.
function checkQuestBody(q: QuestDef, refs: Refs, where: string, errs: string[]): void {
  try { validateStageGraph(q as never, where); } catch (e) { errs.push((e as Error).message); }

  if (q.zone && !refs.zones.has(q.zone)) errs.push(`${where}: zone '${q.zone}' does not exist`);

  if (q.giver) {
    const isSpawnId = refs.spawnIds.has(q.giver);
    const isTemplate = refs.mobs.has(q.giver);
    if (!isSpawnId && !isTemplate) {
      errs.push(`${where}: giver '${q.giver}' matches no mob template or spawn_id and is not created in this response`);
    } else if (isTemplate && !isSpawnId) {
      // Template giver: must be scoped to a zone it actually inhabits.
      if (!q.zone) {
        errs.push(`${where}: giver '${q.giver}' is a mob template — set 'zone' so the quest is offered only in that region (or use a spawn_id for one specific mob). Without a zone, every '${q.giver}' on the map would offer this quest.`);
      } else if (refs.zones.has(q.zone) && !(refs.spawnedByZone.get(q.zone)?.has(q.giver))) {
        errs.push(`${where}: giver '${q.giver}' is not spawned in zone '${q.zone}' — add an add_spawns placing it there, or pick a giver that already lives in the zone.`);
      }
    }
  }

  for (const stage of q.stages ?? []) {
    const obj = stage.objective;
    if (!obj) continue;
    const at = `${where} stage '${stage.id}'`;
    if ('template_id' in obj && obj.template_id && !refs.mobs.has(obj.template_id)) {
      errs.push(`${at}: objective template_id '${obj.template_id}' does not exist and is not created in this response`);
    }
    if (obj.kind === 'collect_count' && !refs.items.has(obj.item_base)) {
      errs.push(`${at}: objective item_base '${obj.item_base}' does not exist and is not created in this response`);
    }
    if (obj.kind === 'talk' && !refs.mobs.has(obj.target_template)) {
      errs.push(`${at}: objective target_template '${obj.target_template}' does not exist and is not created in this response`);
    }
    if ('zone' in obj && obj.zone && !refs.zones.has(obj.zone)) errs.push(`${at}: objective zone '${obj.zone}' does not exist`);
  }

  for (const r of q.rewards ?? []) {
    if (r.item && !refs.items.has(r.item)) errs.push(`${where}: reward item '${r.item}' does not exist and is not created in this response`);
  }
}

// Region names are player-facing identities and must be globally unique.
// Anchored gardener runs only see the local neighborhood, so the model can pick
// a name already used by a distant zone (e.g. two "Salty Reach"); this is the
// only place that sees the WHOLE world, so it is where uniqueness is enforced.
// Returns the colliding zone id, or null. Comparison is case-insensitive.
function findNameCollision(name: string, world: WorldDefs, selfId?: string): string | null {
  const norm = name.trim().toLowerCase();
  for (const z of Object.values(world.zones)) {
    if (z.id === selfId) continue;
    if (z.name && z.name.trim().toLowerCase() === norm) return z.id;
  }
  return null;
}

function checkFeatures(entries: ZoneFeatureEntry[], refs: Refs, where: string, errs: string[]): void {
  for (const raw of entries) {
    const e = typeof raw === 'string' ? { id: raw } as { id: string; portal_to?: string } : raw;
    if (!(e.id in FEATURE_REGISTRY) && !refs.prefabs.has(e.id)) {
      errs.push(`${where}: feature '${e.id}' is neither a feature operator nor a prefab, and is not created in this response`);
    }
    if (e.portal_to && !refs.zones.has(e.portal_to)) {
      errs.push(`${where}: feature '${e.id}' portal_to '${e.portal_to}' does not exist and is not created in this response`);
    }
    if (e.portal_to && e.id in FEATURE_REGISTRY) {
      errs.push(`${where}: feature '${e.id}' is a feature operator — portal_to is only valid on prefab features`);
    }
  }
}

/** All semantic checks for one op. Returns error strings (empty = valid). */
function validateOne(op: Mutation, refs: Refs, world: WorldDefs, allowed: ReadonlySet<MutationOp> | null, scope: Set<string> | undefined, createdZoneIds: Set<string>): string[] {
  const errs: string[] = [];

  if (allowed && !allowed.has(op.op)) {
    errs.push(`op '${op.op}' is not permitted for this opportunity type (allowed: ${[...allowed].sort().join(', ')})`);
    return errs; // no point checking refs of an op that can't run here
  }

  // Scope guard for zone-modifying ops: only the opportunity's target zone (or a
  // zone created in this same response) may be touched — NOT any real world zone.
  // Without this, a model that emits an unrelated real zone_id silently rewrites
  // that zone (the original crash-class-#2 clobber).
  if (op.op === 'add_spawns' || op.op === 'remove_spawns' || op.op === 'add_features' || op.op === 'remove_features' || op.op === 'set_zone_field') {
    if (scope) {
      const inScope = scope.has(op.zone_id) || createdZoneIds.has(op.zone_id);
      if (!inScope) {
        errs.push(
          scope.size > 0
            ? `${op.op} targets zone '${op.zone_id}', outside this opportunity's scope (${[...scope].sort().join(', ')}). ` +
              `Re-target it to the opportunity's zone, or drop it.`
            : `${op.op} targets zone '${op.zone_id}', but this opportunity names no target zone. ` +
              `A zone-modifying op must act on the opportunity's declared target_zone.`,
        );
      }
    }
    if (!refs.zones.has(op.zone_id)) {
      errs.push(`${op.op}: zone '${op.zone_id}' does not exist and is not created in this response`);
    }
  }

  switch (op.op) {
    case 'create_mob':
      checkMobRefs(op, refs, `create_mob '${op.id}'`, errs);
      break;
    case 'patch_mob': {
      const existing = world.mobs[op.id];
      if (!existing) {
        errs.push(`patch_mob '${op.id}': no mob template with that id exists to patch (create_mob it instead)`);
        break;
      }
      if ('id' in op.set || 'op' in op.set) {
        errs.push(`patch_mob '${op.id}': set may not change 'id' or 'op'`);
        break;
      }
      // Validate the MERGED result, not the partial: a typo'd key or bad value
      // is caught even though `set` is loosely typed.
      const merged = { ...existing, ...op.set };
      const parsed = MobBodySchema.safeParse(merged);
      if (!parsed.success) {
        errs.push(`patch_mob '${op.id}': result invalid — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        break;
      }
      checkMobRefs(parsed.data, refs, `patch_mob '${op.id}'`, errs);
      break;
    }
    case 'create_item':
      checkItemBody(op, `create_item '${op.id}'`, errs);
      break;
    case 'patch_item': {
      const existing = world.itemBases[op.id];
      if (!existing) { errs.push(`patch_item '${op.id}': no item base with that id exists to patch (create_item it instead)`); break; }
      if ('id' in op.set || 'op' in op.set) { errs.push(`patch_item '${op.id}': set may not change 'id' or 'op'`); break; }
      const parsed = ItemBodySchema.safeParse({ ...existing, ...op.set });
      if (!parsed.success) {
        errs.push(`patch_item '${op.id}': result invalid — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        break;
      }
      checkItemBody(parsed.data, `patch_item '${op.id}'`, errs);
      break;
    }
    case 'create_quest':
      checkQuestBody(op, refs, `create_quest '${op.id}'`, errs);
      break;
    case 'patch_quest': {
      const existing = world.quests[op.id];
      if (!existing) { errs.push(`patch_quest '${op.id}': no quest with that id exists to patch (create_quest it instead)`); break; }
      if ('id' in op.set || 'op' in op.set) { errs.push(`patch_quest '${op.id}': set may not change 'id' or 'op'`); break; }
      const parsed = QuestBodySchema.safeParse({ ...existing, ...op.set });
      if (!parsed.success) {
        errs.push(`patch_quest '${op.id}': result invalid — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        break;
      }
      checkQuestBody(parsed.data, refs, `patch_quest '${op.id}'`, errs);
      break;
    }
    case 'create_prefab': {
      const err = validatePrefabGrid(op);
      if (err) errs.push(`create_prefab '${op.id}': ${err}`);
      break;
    }
    case 'create_zone': {
      if (!world.zones[op.parent_zone]) errs.push(`create_zone '${op.id}': parent_zone '${op.parent_zone}' does not exist`);
      const clash = findNameCollision(op.name, world);
      if (clash) errs.push(`create_zone '${op.id}': name '${op.name}' is already used by zone '${clash}' — pick a distinct name unique to this region.`);
      checkSpawns(op.spawns ?? [], refs, `create_zone '${op.id}'`, errs);
      break;
    }
    case 'add_spawns': checkSpawns(op.spawns, refs, `add_spawns(${op.zone_id})`, errs); break;
    case 'add_features': checkFeatures(op.features, refs, `add_features(${op.zone_id})`, errs); break;
    case 'set_zone_field': {
      if (op.field === 'level_band') {
        const r = LevelBandSchema.safeParse(op.value);
        if (!r.success) errs.push(`set_zone_field(${op.zone_id}): level_band must be { tier, minLevel, maxLevel }`);
      } else if (typeof op.value !== 'string' || !op.value.trim()) {
        errs.push(`set_zone_field(${op.zone_id}): name must be a non-empty string`);
      } else {
        const clash = findNameCollision(op.value, world, op.zone_id);
        if (clash) errs.push(`set_zone_field(${op.zone_id}): name '${op.value}' is already used by zone '${clash}' — pick a distinct, evocative name unique to this region.`);
      }
      break;
    }
    case 'update_tileset': {
      if (!world.tilesets[op.tileset]) errs.push(`update_tileset: tileset '${op.tileset}' not found`);
      if (!Object.keys(op.tiles ?? {}).length && !Object.keys(op.sprites ?? {}).length) {
        errs.push('update_tileset must add at least one tile or sprite');
      }
      break;
    }
  }
  return errs;
}

/**
 * Validate the whole op set up front. Pure: no disk writes. Returns the ops
 * partitioned into { valid, failed }, each failure carrying a precise message
 * the caller can feed back to the model for a targeted repair.
 */
export function validateMutations(ops: Mutation[], world: WorldDefs, opts: ValidateOpts = {}): ValidateResult {
  const refs = collectRefs(ops, world);
  const allowed = allowedOpsFor(opts.opportunityType);
  // Zones created in THIS op set — always in scope for a same-response add_*/set.
  const createdZoneIds = new Set(ops.flatMap((o) => (o.op === 'create_zone' ? [o.id] : [])));
  const valid: Mutation[] = [];
  const failed: MutationFailure[] = [];
  for (const op of ops) {
    const errs = validateOne(op, refs, world, allowed, opts.allowedZoneIds, createdZoneIds);
    if (errs.length) failed.push({ op, error: errs.join('; ') });
    else valid.push(op);
  }
  return { valid, failed };
}

// ── Lore bible merge (format-preserving header) ──────────────────────────────

interface LoreBible { [k: string]: unknown; factions?: unknown[]; geography?: unknown[]; zones?: unknown[]; unresolved?: string[] }

function splitLoreHeader(text: string): { header: string; body: string } {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trimStart().startsWith('#'))) i++;
  return { header: lines.slice(0, i).join('\n'), body: lines.slice(i).join('\n') };
}

// Explicit delta shape. Derived from UpdateLoreSchema, but written out rather
// than `Omit<Extract<Mutation,...>, 'op'>`: that schema uses .passthrough(), whose
// inferred string index signature makes Omit drop the named keys (they collapse
// to `{}`), so field accesses below lose their types. Spelled out to keep them.
interface LoreDelta {
  zones_append?: unknown[]; factions_append?: unknown[]; geography_append?: unknown[];
  zones_replace?: unknown[]; factions_replace?: unknown[]; geography_replace?: unknown[];
  unresolved_append?: string[]; unresolved_resolve?: string[]; unresolved_replace?: string[];
}

function mergeLore(bible: LoreBible, u: LoreDelta): void {
  for (const key of ['zones', 'factions', 'geography'] as const) {
    const replace = u[`${key}_replace`] as unknown[] | undefined;
    if (replace !== undefined) { bible[key] = replace; }
    else {
      const append = u[`${key}_append`] as unknown[] | undefined;
      if (append && append.length) bible[key] = [...(bible[key] ?? []), ...append];
    }
  }
  if (u.unresolved_replace !== undefined) { bible.unresolved = u.unresolved_replace; }
  else {
    if (u.unresolved_resolve?.length) {
      bible.unresolved = (bible.unresolved ?? []).filter((entry) => !u.unresolved_resolve!.some((n) => String(entry).includes(n)));
    }
    if (u.unresolved_append?.length) bible.unresolved = [...(bible.unresolved ?? []), ...u.unresolved_append];
  }
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface ApplyResult {
  /** Ops actually applied (a unique-NPC-dedup no-op still counts as applied). */
  applied: Mutation[];
  created: string[];     // repo-relative paths created
  modified: string[];    // repo-relative paths modified in place
  touchedZones: string[]; // zone ids whose grid changed (re-render)
  createdZones: string[]; // zone ids newly created this run (eligible for seed-repair)
  absPaths: string[];    // absolute paths touched (git staging)
  warnings: string[];
}

const LORE_REL = 'world/lore/bible.yaml';
const relOf = (abs: string): string => (abs.startsWith(REPO_ROOT) ? abs.slice(REPO_ROOT.length + 1) : abs);

/** Resolve the tileset JSON path whose `name` matches (loader keys by name). */
function resolveTilesetPath(name: string): string | null {
  const dir = join(WORLD_DIR, 'tilesets');
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = join(dir, f);
    try { if ((JSON.parse(readFileSync(p, 'utf8')) as { name?: string }).name === name) return p; } catch { /* skip */ }
  }
  return null;
}

/**
 * Apply a list of (already-validated) mutations atomically. Every file the run
 * will touch is snapshotted before the first write; if any op throws, ALL
 * snapshots are restored and the error rethrown — the world is never left
 * half-mutated. Pass only the `valid` ops from `validateMutations`.
 */
export function applyMutations(ops: Mutation[], world: WorldDefs, opts: { dryRun?: boolean } = {}): ApplyResult {
  const result: ApplyResult = { applied: [], created: [], modified: [], touchedZones: [], createdZones: [], absPaths: [], warnings: [] };
  const touched = new Set<string>();
  const createdZones = new Set<string>();
  const snapshot = new Map<string, string | null>();

  const snap = (abs: string): void => { if (!snapshot.has(abs)) snapshot.set(abs, existsSync(abs) ? readFileSync(abs, 'utf8') : null); };
  const writeFile = (abs: string, body: string): boolean => {
    snap(abs);
    const existed = existsSync(abs);
    if (!opts.dryRun) writeFileSync(abs, body.endsWith('\n') ? body : body + '\n', 'utf8');
    const rel = relOf(abs);
    (existed ? result.modified : result.created).push(rel);
    result.absPaths.push(abs);
    return existed;
  };
  const writeEntity = (subdir: string, id: string, body: string): void => { writeFile(join(WORLD_DIR, subdir, `${id}.yaml`), body); };
  // Read each zone once per run: successive ops on the same zone mutate (and
  // re-serialize) the same in-memory doc instead of re-reading + re-parsing it.
  const zoneCache = new Map<string, ZoneFile>();
  const readZoneCached = (zoneId: string): ZoneFile => {
    let zf = zoneCache.get(zoneId);
    if (!zf) { zf = readZoneFile(zoneId); zoneCache.set(zoneId, zf); }
    return zf;
  };
  // The on-disk body is the op minus its discriminator. `withoutOp` strips it
  // once; `dump` is the YAML form (create_mob/item/quest), JSON callers reuse it.
  const withoutOp = (op: Mutation): Record<string, unknown> => { const { op: _drop, ...body } = op as Record<string, unknown>; return body; };
  const dump = (op: Mutation): string => yaml.dump(withoutOp(op), { lineWidth: -1, noRefs: true });

  try {
    for (const op of ops) {
      switch (op.op) {
        case 'create_mob': writeEntity('entities/mobs', op.id, dump(op)); break;
        case 'patch_mob':
          // Merge onto the on-disk template (existence + validity checked already).
          writeEntity('entities/mobs', op.id, yaml.dump({ ...world.mobs[op.id], ...op.set }, { lineWidth: -1, noRefs: true }));
          break;
        case 'create_item': writeEntity('entities/items/bases', op.id, dump(op)); break;
        case 'patch_item':
          writeEntity('entities/items/bases', op.id, yaml.dump({ ...world.itemBases[op.id], ...op.set }, { lineWidth: -1, noRefs: true }));
          break;
        case 'create_quest': writeEntity('quests', op.id, dump(op)); questGiverCache = null; break;
        case 'patch_quest':
          writeEntity('quests', op.id, yaml.dump({ ...world.quests[op.id], ...op.set }, { lineWidth: -1, noRefs: true }));
          questGiverCache = null;
          break;
        case 'create_prefab':
          writeFile(join(WORLD_DIR, 'prefabs', `${op.id}.json`), JSON.stringify(withoutOp(op), null, 2));
          break;
        case 'create_zone': {
          const { op: _o, ...spec } = op;
          const parent = world.zones[op.parent_zone]!;
          const stub = buildZoneStubFromSpec(spec, parent);
          writeFile(join(WORLD_DIR, 'zones', `${op.id}.json`), JSON.stringify(stub, null, 2));
          touched.add(op.id);
          createdZones.add(op.id);
          // Host-synthesized lore entry for the new sub-zone.
          applyLore(world, {
            zones_append: [{ id: op.id, summary: op.lore_summary, connections: [op.parent_zone], implemented: new Date().toISOString().slice(0, 10) }],
          }, snap, result, opts);
          break;
        }
        case 'add_spawns': {
          const zf = readZoneCached(op.zone_id);
          const biome = zf.doc.biome ? BIOME_REGISTRY[zf.doc.biome] : undefined;
          const present = new Set<string>([...(zf.doc.spawns ?? []).map((s) => s.entity), ...((biome?.defaultSpawns ?? []).map((s) => s.entity))]);
          const toAdd: ZoneSpawn[] = [];
          for (const s of op.spawns as ZoneSpawn[]) {
            if ((isUniqueEntity(s.entity) || isQuestGiver(s.entity)) && present.has(s.entity)) {
              result.warnings.push(`[mutations] ${op.zone_id}: skipped duplicate singleton NPC '${s.entity}' — reuse the existing one.`);
              continue;
            }
            toAdd.push(s); present.add(s.entity);
          }
          if (toAdd.length) {
            zf.doc.spawns = [...(zf.doc.spawns ?? []), ...toAdd];
            writeFile(zf.path, serializeZoneFile(zf));
            touched.add(op.zone_id);
          }
          break;
        }
        case 'remove_spawns': {
          const zf = readZoneCached(op.zone_id);
          const before = zf.doc.spawns ?? [];
          const drop = new Set(op.entities);
          const after = before.filter((s) => !drop.has(s.entity));
          if (after.length < before.length) {
            zf.doc.spawns = after;
            writeFile(zf.path, serializeZoneFile(zf));
            touched.add(op.zone_id);
          } else {
            // Nothing matched: the entities aren't in the zone FILE. They may be
            // biome defaults (injected at load, not removable here) or already gone.
            result.warnings.push(
              `[mutations] ${op.zone_id}: remove_spawns matched no file-level spawns ` +
              `(${op.entities.join(', ')} — biome defaults cannot be removed this way).`,
            );
          }
          break;
        }
        case 'add_features': {
          const zf = readZoneCached(op.zone_id);
          const cur = zf.doc.features ?? [];
          const existing = new Set(cur.map((f) => (typeof f === 'string' ? f : f.id)));
          const merged = [...cur];
          for (const f of op.features) {
            const id = typeof f === 'string' ? f : f.id;
            if (!existing.has(id)) { merged.push(f); existing.add(id); }
          }
          zf.doc.features = merged;
          writeFile(zf.path, serializeZoneFile(zf));
          touched.add(op.zone_id);
          break;
        }
        case 'remove_features': {
          const zf = readZoneCached(op.zone_id);
          const before = zf.doc.features ?? [];
          const drop = new Set(op.features);
          const after = before.filter((f) => !drop.has(typeof f === 'string' ? f : f.id));
          if (after.length < before.length) {
            zf.doc.features = after;
            writeFile(zf.path, serializeZoneFile(zf));
            touched.add(op.zone_id);
          } else {
            result.warnings.push(
              `[mutations] ${op.zone_id}: remove_features matched no file-level features ` +
              `(${op.features.join(', ')} — disable a biome default via add_features { id, enabled: false } instead).`,
            );
          }
          break;
        }
        case 'set_zone_field': {
          const zf = readZoneCached(op.zone_id);
          (zf.doc as Record<string, unknown>)[op.field] = op.value;
          writeFile(zf.path, serializeZoneFile(zf));
          touched.add(op.zone_id);
          break;
        }
        case 'update_tileset': {
          const path = resolveTilesetPath(op.tileset);
          if (!path) throw new Error(`[mutations] update_tileset target not found: ${op.tileset}`);
          snap(path);
          const doc = JSON.parse(readFileSync(path, 'utf8')) as { tiles?: Record<string, unknown>; sprites?: Record<string, unknown> };
          doc.tiles = doc.tiles ?? {}; doc.sprites = doc.sprites ?? {};
          let added = 0;
          for (const [k, v] of Object.entries(op.tiles ?? {})) if (!(k in doc.tiles)) { doc.tiles[k] = v; added++; }
          for (const [k, v] of Object.entries(op.sprites ?? {})) if (!(k in doc.sprites)) { doc.sprites[k] = v; added++; }
          if (added > 0) {
            if (!opts.dryRun) writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
            result.modified.push(relOf(path)); result.absPaths.push(path);
          } else {
            result.warnings.push(`[mutations] update_tileset ${op.tileset}: no new entries (all already present)`);
          }
          break;
        }
        case 'update_lore': {
          const { op: _o, ...delta } = op;
          applyLore(world, delta as LoreDelta, snap, result, opts);
          break;
        }
      }
      result.applied.push(op);
    }
  } catch (err) {
    // Roll the world back to its pre-apply state, then surface the error so the
    // caller's per-opportunity safety net can block this opportunity cleanly.
    if (!opts.dryRun) {
      for (const [abs, prev] of snapshot) {
        if (prev === null) { if (existsSync(abs)) unlinkSync(abs); }
        else writeFileSync(abs, prev, 'utf8');
      }
    }
    throw err;
  }

  result.touchedZones = [...touched];
  result.createdZones = [...createdZones];
  result.created = [...new Set(result.created)];
  result.modified = [...new Set(result.modified)];
  result.absPaths = [...new Set(result.absPaths)];
  return result;
}

// Merge a lore delta into the bible file (used by update_lore and the
// host-synthesized entry for create_zone). Header comments are preserved.
function applyLore(_world: WorldDefs, delta: LoreDelta, snap: (abs: string) => void, result: ApplyResult, opts: { dryRun?: boolean }): void {
  const abs = join(REPO_ROOT, LORE_REL);
  snap(abs);
  const raw = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  const { header, body } = splitLoreHeader(raw);
  const bible = (yaml.load(body) ?? {}) as LoreBible;
  mergeLore(bible, delta);
  const dumped = yaml.dump(bible, { lineWidth: -1, noRefs: true });
  if (!opts.dryRun) writeFileSync(abs, (header ? header.replace(/\s*$/, '\n\n') : '') + dumped, 'utf8');
  if (!result.modified.includes(LORE_REL)) { result.modified.push(LORE_REL); result.absPaths.push(abs); }
}
