// Types shared between server and client. No runtime side effects.

export type Direction = 'north' | 'south' | 'east' | 'west';

export type ClassId = 'fighter' | 'rogue' | 'wizard';

export type EquipSlot =
  | 'mainhand'
  | 'helmet'
  | 'chest'
  | 'gloves'
  | 'leggings'
  | 'boots'
  | 'ring1'
  | 'ring2'
  | 'amulet';

export type StatId = 'strength' | 'dexterity' | 'intelligence' | 'constitution';

export type ScalingLetter = 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | '-';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';

export type Range = [number, number];

export interface Position {
  zone: string;
  x: number;
  y: number;
}

export interface RolledStats {
  damage: Range | null;
  defense: Range | null;
  speed?: number;
  scaling: Partial<Record<StatId, ScalingLetter>> | null;
  /** A BRAND_KEY: when a weapon rolls an elemental affix, its whole swing
   *  (base + scaling + the affix's own flat bonus) is tagged with this type for
   *  resistance purposes, instead of dealing untyped physical damage plus an
   *  untyped bonus. Stamped by generateItem; only meaningful when `damage` is set. */
  weapon_brand?: string;
  /** `<brand>_resistance` fields (e.g. `fire_resistance`) — percentage points,
   *  summed across equipped slots and capped in combat's resistanceMult. */
  [extra: string]: unknown;
}

export interface ItemEntity {
  id: string;
  type: 'item';
  components: {
    equipment: {
      base: string;
      affixes: string[];
      rolled: RolledStats;
      rarity?: Rarity;
    };
  };
}

export interface InventoryStack {
  base: string;
  item: ItemEntity | null;
  name: string;
  sprite: string;
  /** What a merchant pays for THIS stack — the base's worth plus a cut of what
   *  the item's roll added (see server/game/items/pricing.ts), not the flat
   *  `ItemBase.sell_value`. A display hint for the client: the trade handler
   *  recomputes rather than trusting it, and absent means unsellable. */
  sell_value?: number;
  item_slot?: string;
  /** The attack this weapon makes (`staff_bolt`, …), copied from its ItemBase by
   *  makeStack. A display hint for the client, which has no item defs: the
   *  server always reads the base itself (see attackAbilityFor), so a stack
   *  saved before this field existed still bolts, it just needs the login
   *  refresh to draw the right hotbar slot. Absent → the base names no attack. */
  attack_ability?: string;
  /** The weapon's swing-rate multiplier, copied from its ItemBase by makeStack —
   *  the same display hint as `attack_ability`, for the same reason. The server
   *  reads the base itself (see weaponSpeed); the client needs it to show the
   *  right attack speed and to predict the right cooldown for a shop staple,
   *  which has no rolled item to carry `speed`. */
  base_speed?: number;
  /** The base's damage range and stat scaling, copied by makeStack — the same
   *  display hint as `base_speed`, for the same reason. The server reads the
   *  base itself (see combat's weaponBase); the client needs them to show the
   *  right damage for a weapon with no rolled item to carry them. */
  base_damage?: Range;
  base_scaling?: Partial<Record<StatId, ScalingLetter>>;
}

export type Equipment = Record<EquipSlot, InventoryStack | null>;

export interface HealthComponent { current: number; max: number }
export interface ManaComponent { current: number; max: number }
export interface InventoryComponent { slots: (InventoryStack | null)[] }
export interface WalletComponent { gold: number }
export interface StatsComponent {
  strength?: number;
  dexterity?: number;
  intelligence?: number;
  constitution?: number;
  speed?: number;
  damage?: Range | number;
  /** Flat armor override for mobs; if absent, defense is derived from constitution. */
  armor?: number;
  /** Per-brand damage multiplier for mobs (see MobTemplate.resistances). */
  resistances?: Partial<Record<string, number>>;
}
export interface ProgressComponent { level: number; xp: number; unspent_points: number }
export interface QuestStateEntry {
  questId: string;
  stage: string;
  accepted_at: number;
  // Per-stage counters keyed by objective-defined keys (e.g. "killed",
  // "collected"). Reset to {} when a stage transitions.
  progress: Record<string, number>;
}
export interface QuestsComponent {
  active: QuestStateEntry[];
  completed: string[];
}
/** A mob's reference to a usable ability + when the AI should prefer it.
 *  The AI picks the highest-weight eligible entry (off cooldown, conditions met,
 *  target within the ability's range), else falls back to the basic attack. */
export interface MobAbilityEntry {
  ability: string;       // ability id in the registry
  weight?: number;       // selection priority, higher first (default 1)
  hp_below?: number;     // only eligible when the mob's hp fraction is below this (0..1)
}

export interface AIComponent {
  behavior: string;
  aggro_range: number;
  template_id: string;
  /** Abilities this mob can use, copied from its template. */
  abilities?: MobAbilityEntry[];
  /** Optional stable identifier for a specific spawn entry (set from ZoneSpawn.spawn_id).
   *  When present, quest givers can target this mob exclusively rather than any mob
   *  sharing the same template_id. */
  spawn_id?: string;
  target: string | null;
  spawn_region?: string;
  fixture?: boolean;
  /** Marks this mob as a readable sign. Its dialogue lines are shown in a read modal
   *  rather than broadcast to zone chat. */
  sign?: boolean;
  /** Stable identifier for a player-writable message board (e.g. "firdale_notice_board").
   *  Persists across server restarts; used as the DB key for board_messages. */
  board_id?: string;
  /** Set when a non-aggressive mob is hit by a player; causes it to fight back
   *  until the threat dies, flees, or the mob's leash breaks (see breakLeash). */
  provoked?: boolean;
  /** The tile this mob was standing on when it acquired its current target. The
   *  leash is a radius around THIS, not around the target, so a player can't tow
   *  a mob across the map by staying inside its chase range. Also the tile the
   *  mob walks back to when the leash breaks. Cleared when threat drops. */
  leash_origin?: { x: number; y: number };
  /** Per-template override of the leash radius in tiles (see leashRadius in
   *  ai.ts for the default). */
  leash_radius?: number;
  /** True while the mob is walking back to `leash_origin` after a leash break.
   *  A resetting mob has already been restored to full: it ignores aggro and
   *  provocation, and takes no damage or CC, until it gets home. */
  resetting?: boolean;
  /** Tick at which a stalled reset gives up and finishes wherever it stands, so
   *  a mob that can't retrace its steps never stays immune forever. */
  reset_deadline?: number;
  /** When true, this mob absorbs hits but never retaliates (e.g. practice dummy). */
  inert?: boolean;
  /** Tiles this mob tries to hold from its target when it has a ready ranged
   *  ability. Absent = always closes to melee (today's behavior). */
  preferred_range?: number;
  /** Shared identifier for mobs spawned together as a pack (see MobTemplate.pack).
   *  When one packmate aggros a player, others sharing this id are alerted too
   *  (see alertGroup in ai.ts). */
  groupId?: string;
  /** Circular wander bounds for a pack, keeping it roaming together instead of
   *  drifting apart — used in place of spawn_region (a named rectangular zone
   *  region) for wilderness packs, which have no named regions to bound them. */
  wander_anchor?: { x: number; y: number; radius: number };
  /** Accumulated threat, keyed by the id of whoever generated it. Damage dealt
   *  to this mob credits its dealer 1:1; healing done to anyone already on the
   *  table credits the healer a fraction (HEAL_THREAT_FACTOR). `target` is
   *  chosen off this table each tick (see selectTarget in ai.ts), which is what
   *  lets a tank hold a pack instead of every mob picking whoever it stood
   *  nearest to. Cleared whenever threat drops or the leash breaks; never
   *  serialized to clients (snapshotZone builds mob fields explicitly). */
  threat?: Record<string, number>;
}

export interface PlayerEntity {
  id: string;
  type: 'player';
  name: string;
  klass: ClassId;
  color?: string;
  sprite?: string;
  position: Position;
  facing: Direction;
  nextActTick: number;
  /** Next tick the global cooldown clears: shared by basic attack + every ability
   *  so casts can't be chained faster than the GCD. Shorter than the attack gate. */
  nextGcdTick?: number;
  nextRegenTick: number;
  /** Next tick mana may regenerate (combat-locked, mirrors nextRegenTick). */
  nextManaRegenTick?: number;
  /** Next tick a 'move' action is honored — the movement-speed gate ("slow"
   *  lengthens this). Mobs don't need this: their whole turn (move/cast/attack)
   *  already shares one cadence via nextActTick; players had no equivalent
   *  gate on movement specifically until this field existed. */
  nextMoveTick?: number;
  /** Ability id -> tick the ability is next castable. Absent = ready. */
  abilityCooldowns?: Record<string, number>;
  /** Debug toggle (/god): when true, all incoming damage is negated. */
  godMode?: boolean;
  components: {
    health: HealthComponent;
    mana?: ManaComponent;
    inventory: InventoryComponent;
    equipment: Equipment;
    wallet: WalletComponent;
    stats: StatsComponent;
    progress: ProgressComponent;
    quests: QuestsComponent;
    /** Learned player abilities: ability id -> current rank (1..N). Persisted.
     *  See docs/plan-class-abilities.md. */
    knownAbilities: KnownAbilities;
    /** Player-configured hotbar layout for ability slots 1..9 (index 0 = slot 1;
     *  slot 0 / basic attack is fixed and not stored here). Each entry is an
     *  ability id or null (empty). Absent = fall back to the derived layout
     *  (equippedAbilityIds). Length HOTBAR_SLOTS - 1. Persisted. */
    hotbar?: (string | null)[];
    modifiers?: TimedModifier[];
  };
}

/** Ability id -> current rank. A player only knows abilities present here. */
export type KnownAbilities = Record<string, number>;

export interface MobEntity {
  id: string;
  type: 'mob';
  name: string;
  sprite: string;
  level: number;
  position: Position;
  facing: Direction;
  nextActTick: number;
  nextGcdTick?: number;
  nextRegenTick?: number;
  nextManaRegenTick?: number;
  nextChatterTick?: number;
  xpReward: number;
  dialogue: string[];
  spawnRef?: { zoneId: string; spawnIndex: number };
  /** Entity id of whoever cast the summon ability that created this mob. Absent
   *  for normally-spawned mobs. Drives faction resolution (stats.ts factionOf)
   *  and despawn-on-summoner-death (server/index.ts). */
  summonedBy?: string;
  /** Ability id -> tick the ability is next castable. Absent = ready. */
  abilityCooldowns?: Record<string, number>;
  components: {
    health: HealthComponent;
    mana?: ManaComponent;
    stats: StatsComponent;
    ai: AIComponent;
    inventory: InventoryComponent;
    modifiers?: TimedModifier[];
  };
}

export interface GroundItemEntity {
  id: string;
  type: 'ground_item';
  name: string;
  sprite: string;
  position: Position;
  passable: true;
  base: string;
  item: ItemEntity | null;
  gold: number;
}

export interface LootSlot {
  id: string;
  name: string;
  base: string;
  item: ItemEntity | null;
  gold: number;
}

export interface CorpseEntity {
  id: string;
  type: 'corpse';
  name: string;
  position: Position;
  passable: true;
  loot: LootSlot[];
  createdAtMs: number;
}

export type Entity = PlayerEntity | MobEntity | GroundItemEntity | CorpseEntity;

// Snapshot subset broadcast to clients — strips spawnRef and other server-only fields.
export interface EntitySnapshot {
  id: string;
  type: Entity['type'];
  name: string;
  sprite: string | null;
  position: Position;
  components: unknown;
  klass?: ClassId;
  base?: string;
  gold?: number;
  item?: ItemEntity | null;
  // For mobs: the template id (e.g. "barkeep", "merchant"). Lets the client
  // identify quest-giver eligibility against the byGiver index from /api/quests.
  templateId?: string;
  // For mobs: the spawn_id from the zone's spawn entry, when one was defined.
  // Overrides templateId for quest-giver matching — a quest whose giver is a
  // spawn_id will only show on the one specific mob that carries that spawn_id.
  spawnId?: string;
  // For players: custom hex color chosen at character creation.
  color?: string;
  // For players: last movement direction, used to mirror the sprite.
  facing?: Direction;
  // For merchant mobs: true when the mob's template has a shop array.
  hasShop?: boolean;
  // For class-trainer mobs: the class whose abilities this trainer teaches.
  trainerClass?: ClassId;
  // For fixture mobs: indestructible world objects that only talk when clicked.
  fixture?: boolean;
  // For non-hostile NPC mobs (role 'npc'): clicking defaults to dialogue, not
  // combat. They retaliate only when explicitly attacked.
  npc?: boolean;
  // For sign fixtures: the readable text lines shown in the read modal.
  signText?: string[];
  // For board fixtures: stable board id used to load/post messages.
  boardId?: string;
  // For mobs: their level (1–50).
  level?: number;
  // For mobs: disposition for minimap/targeting coloring — 'hostile' (attacks),
  // 'passive' (flees/ignores), or 'friendly' (NPCs). Derived from role/flags.
  disposition?: 'hostile' | 'passive' | 'friendly';
  // For light-emitting mobs (torches, bonfires, etc.): radius in tiles.
  lightRadius?: number;
  // Fraction of a tile to render the entity square at.
  drawScale?: number;
  // For corpses:
  loot?: LootSlot[];
  createdAtMs?: number;
}

export interface ZoneSnapshot {
  id: string;
  name: string;
  width: number;
  height: number;
  grid: string[][];
  entities: EntitySnapshot[];
  /** 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk */
  timeOfDay?: number;
  /** Suppress the atmospheric edge-haze vignette (for interior/indoor zones). */
  no_edge_haze?: boolean;
  /** Resolved tileset name for this zone (e.g. "overworld"). */
  tileset?: string;
  /** Server tick this snapshot was built at — lets the client compute a
   *  modifier's remaining duration from its `expiresAt` tick. */
  tick?: number;
  /** Persistent ground zones currently active in this zone (see
   *  World.activeZones / ZoneEffect) — sent so the client can actually draw
   *  the hazard/boon area, not just react to its tick damage/heal floats. */
  activeZones?: ActiveZoneSnapshot[];
}

/** Client-facing subset of server/game/world.ts's ActiveZone. */
export interface ActiveZoneSnapshot {
  id: string;
  x: number;
  y: number;
  radius: number;
  expiresAt: number;
  kind: 'damage' | 'heal';
}

// --- World definitions (YAML-loaded) ---

/** What reading a scroll does. Scrolls are the consumables whose effect is a
 *  world action rather than a stat change, so they hang off UseEffect beside
 *  heal/mana instead of replacing it — one item-use path, one client affordance.
 *  `kind` is the discriminator every future scroll type adds a member to, and
 *  like ability effect kinds it is an engine primitive: minting a new one is
 *  code, not data (see the registry note in README).
 *
 *  - `scribe` — charts one point of interest the character has not found yet,
 *    for the current epoch only. Permanence is still earned by visiting. */
export type ScrollEffect =
  | { kind: 'scribe' };

export interface UseEffect {
  heal?: Range | number;
  mana?: Range | number;
  /** A timed stat buff applied on use (e.g. a haste potion's +speed) — the
   *  same shape abilities push onto components.modifiers (see TimedModifier). */
  modifier?: { stats: Record<string, number>; duration_ticks: number; cc?: CcKind[] };
  /** Reading effect — see ScrollEffect. Resolved before anything is consumed,
   *  so a scroll that has nothing to do is not spent. */
  scroll?: ScrollEffect;
}

export interface ItemBase {
  id: string;
  name: string;
  slot: EquipSlot | 'ring' | 'currency' | 'quest' | 'consumable';
  sprite?: string;
  tags: string[];
  base_damage?: Range;
  base_defense?: Range;
  base_speed?: number;
  /** Ability id this base attacks with when equipped as the mainhand;
   *  absent → `unarmed_strike`. */
  attack_ability?: string;
  value?: Range | number;
  sell_value?: number;
  use_effect?: UseEffect;
  scaling?: Partial<Record<StatId, ScalingLetter>>;
  /** Minimum item-level a drop must roll for this base to be eligible.
   *  Set by the material tier for procedurally-composed bases; absent → 1. */
  min_ilvl?: number;
}

export interface Affix {
  id: string;
  name_prefix?: string;
  name_suffix?: string;
  applies_to: string[];
  /** Minimum item rarity at which this affix becomes eligible (default common). */
  rarity?: Rarity;
  bonus?: Record<string, number | Range>;
}

/** A merchant's rotating high-end stock (MobTemplate.featured_stock). */
export interface FeaturedStockSpec {
  /** How many rotating slots this merchant carries. */
  count: number;
  /** Loot-affinity terms (the AFFINITY_TAGS vocabulary, same as
   *  MobTemplate.loot_affinity) the stock draws from — `[weapon, blade]` for a
   *  weaponsmith, `[armor, heavy_armor]` for an armorer. Enforced, not merely
   *  biased: a weaponsmith's featured row is always a weapon. */
  affinity: string[];
  /** Item-level band each slot rolls in. High by design — this is the gear a
   *  player saves for, not the staple stock. */
  ilvl: Range;
}

/** One rolled item on a merchant's featured shelf, as sent to the client. */
export interface FeaturedStockEntry {
  /** Stable within a refresh window; what `TradeMessage.featuredId` names. */
  id: string;
  price: number;
  ilvl: number;
  /** The item itself, as the very stack the buyer receives — name, sprite,
   *  slot and rarity all read off this rather than being copied beside it. */
  stack: InventoryStack;
}

/** A material tier used to procedurally compose item bases (materials.yaml). */
export interface Material {
  id: string;
  name: string;
  /** Which archetypes this material can form (matched against Archetype.material_classes). */
  class: string;
  min_ilvl: number;
  dmg_mult?: number;
  def_mult?: number;
  value_mult?: number;
  /** Weight tag (heavy/light) merged into composed bases — armor slots only. */
  armor_tag?: string;
}

/** An item shape used to procedurally compose item bases (archetypes.yaml). */
export interface Archetype {
  id: string;
  name: string;
  slot: EquipSlot | 'ring';
  /** Material classes this archetype accepts. */
  material_classes: string[];
  tags: string[];
  sprite?: string;
  base_damage?: Range;
  base_defense?: Range;
  base_speed?: number;
  base_value?: number;
  /** Ability id weapons of this archetype attack with — the hook for giving a
   *  weapon type its own reach, name and (later) behaviour. Material-independent,
   *  so unlike damage/defense it is copied through composeBases unscaled. */
  attack_ability?: string;
  scaling?: Partial<Record<StatId, ScalingLetter>>;
}

export interface AffixPools { prefixes: Affix[]; suffixes: Affix[] }

export type MobRole = 'tank' | 'pest' | 'soldier' | 'ranged' | 'support' | 'npc' | 'passive';

export interface MobTemplate {
  id: string;
  name: string;
  sprite: string;
  level: number;
  /** Levels this mob is thematically valid at, for band-based wilderness spawn
   *  selection (server/game/wilderness.ts). Defaults to a small buffer around
   *  `level` when unset. Unrelated to hand-authored zone spawns, which always
   *  use `level` (or an explicit spawn override) directly. */
  level_range?: [number, number];
  /** Wild land biomes this mob spawns in (server/game/wilderness.ts filters wild
   *  spawns by the biome at the spawn tile). Values must be WILD_BIOMES entries.
   *  Unset = spawns in any biome (backward-compatible; the filter is additive).
   *  Unrelated to hand-authored zone spawns, which ignore this. */
  biomes?: WorldBiome[];
  role: MobRole;
  speed: number;
  behavior: string;
  aggro_range: number;
  xp?: number;
  dialogue?: string[];
  loot_table?: { item: string; chance: number }[];
  /** Loot theme for the universal procedural drop (set by the generator from a
   *  mob's archetype/faction). `loot_affinity` biases which base type drops
   *  (e.g. light_armor, weapon, trinket); `loot_brand` biases affixes toward an
   *  element (a BRAND_KEY: fire_damage, cold_damage, …). Soft bias, not a filter. */
  loot_affinity?: string[];
  loot_brand?: string[];
  shop?: { item: string; price: number }[];
  /** Rotating high-end stock. Unlike `shop` (fixed bases at fixed prices, in
   *  unlimited supply), these are individually *rolled* items — one copy each,
   *  re-rolled on a wall-clock cadence, priced off what they actually rolled.
   *  See server/game/items/featured_stock.ts. */
  featured_stock?: FeaturedStockSpec;
  /** Class trainer: teaches this class's player abilities (plus all `global`
   *  abilities) for gold. See docs/plan-class-abilities.md. */
  trainer?: { class: ClassId };
  fixture?: boolean;
  /** When true, this mob absorbs hits but never retaliates. */
  inert?: boolean;
  /** Override the derived max HP directly, ignoring level/role/constitution scaling. */
  hp?: number;
  /** Named/singleton NPC. The content pipeline refuses to spawn more than one
   *  per zone (deduped at the fileOps write layer), preventing the Implementor
   *  from re-adding an NPC that already exists. */
  unique?: boolean;
  /** When true, clicking this mob opens a read modal showing all dialogue lines. */
  sign?: boolean;
  /** Stable key for a player-writable message board (e.g. "firdale_notice_board"). */
  board_id?: string;
  /** Radius in tiles for a light source; creates a glow in the night overlay. */
  light_radius?: number;
  /** Fraction of a tile to render the entity square at (1 = full tile, 0.75 = default margin). */
  draw_scale?: number;
  respawn_seconds?: number;
  /** Override individual stats; unset fields fall back to role-derived values. */
  stats?: Partial<{ strength: number; dexterity: number; intelligence: number; constitution: number }>;
  /** Explicit flat armor value; if absent, defense is derived from constitution. */
  armor?: number;
  /** Abilities this mob can use (referenced by id from world/abilities/). */
  abilities?: MobAbilityEntry[];
  /** When true, clicking this mob defaults to dialogue rather than combat, regardless of role. */
  friendly?: boolean;
  /** Damage multiplier per brand (a BRAND_KEY, e.g. fire_damage): 0 = immune,
   *  1 = normal, >1 = vulnerable. Absent brands take normal damage. */
  resistances?: Partial<Record<string, number>>;
  /** Tiles this mob tries to hold from its target when it has a ready ranged
   *  ability (see stepMob in ai.ts). Absent = always closes to melee (today's behavior). */
  preferred_range?: number;
  /** Radius in tiles, measured from where the mob engaged, that it will chase a
   *  target before breaking off (see breakLeash in ai.ts). Absent = derived from
   *  aggro_range. */
  leash_radius?: number;
  /** Wilderness spawns: when set, this template spawns as a pack instead of a
   *  lone mob (see Wilderness.materializeChunk). `members`, if given, spawns a
   *  fixed mixed roster (by template id) instead of `size` copies of this
   *  template — e.g. a goblin_shaman entry with `members: [goblin_shaman,
   *  goblin_chanter, goblin_chanter]` spawns that exact trio. Packmates share a
   *  groupId (joint aggro) and wander_anchor (roam together). */
  pack?: { size?: [number, number]; radius: number; members?: string[] };
}

export interface ZonePortal {
  at: { x: number; y: number };
  to: { zone: string; x: number; y: number };
  tile?: string | null;
  /** Client transition animation for non-cardinal portals (descend/ascend/teleport). */
  transition?: 'descend' | 'ascend' | 'teleport';
}

export interface ZoneSpawn {
  entity: string;
  /** Region to scatter the spawn(s) within. Either `region` or `at` is required.
   *  Ignored when `at` is set. */
  region?: string;
  /** Inline rectangular area (tile coords) to scatter the spawn(s) within — an
   *  author-drawn alternative to a named `region`, needing no generated region.
   *  Takes precedence over `region`; ignored when `at` is set. */
  area?: { x: number; y: number; w: number; h: number };
  /**
   * When true, a missing `region` silently skips this spawn instead of logging a
   * warning. Use when the region is created by an optional or toggled feature.
   */
  if_region?: boolean;
  /** Exact tile placement for a single entity (e.g. a torch or other fixture).
   *  Takes precedence over `region`; `count` is treated as 1. Placed precisely
   *  here with no scatter, so it can sit on a wall tile as a sconce. */
  at?: { x: number; y: number };
  count?: number;
  respawn_seconds?: number;
  /** Per-spawn level override. When set, the mob spawns at this level instead of
   *  its template's, so one template can appear at different levels in different
   *  zones (e.g. a husk at L5 in a starter zone, L45 in a heartland zone). */
  level?: number;
  /** Optional stable identifier for this specific spawn entry.
   *  Stored on the spawned mob as AIComponent.spawn_id and surfaced in EntitySnapshot.spawnId.
   *  Quest giver field can reference this instead of a template id to restrict the quest
   *  to one particular mob instance. */
  spawn_id?: string;
}

// --- Zone structure: archetypes, landmarks, focal points, constraints ---

/**
 * Structural archetype — the zone's internal spatial grammar. Not a tile
 * layout; a statement of how the zone organizes itself (entry/exit, focal
 * point, internal variety). Drives focal-point defaults and authoring
 * guidance. See server/game/mapgen/archetypes.ts for the library.
 */
export type ZoneArchetype =
  | 'approach'    // traversed: entry → choke points → far-end payoff
  | 'crucible'    // fought in: defensible perimeter, cover, sightlines
  | 'sanctuary'   // explored: dense branching interior, scattered interest
  | 'threshold'   // transitional: one face echoes from, one anticipates to
  | 'hearth';     // inhabited: a center of gravity with activity around it

export const ZONE_ARCHETYPES: readonly ZoneArchetype[] =
  ['approach', 'crucible', 'sanctuary', 'threshold', 'hearth'] as const;

/**
 * The zone's heart point — the ruin, the wellspring, the collapsed gate.
 * Used as the default focal-point anchor and drawn on the render overlay.
 *
 * Can be declared as explicit tile coordinates OR as a region reference —
 * the engine resolves the region to its center tile at generation time.
 * Prefer the region form for new zones: `landmark: { region: <id> }`.
 */
export type Landmark = { x: number; y: number } | { region: string };

/**
 * The structurally most significant tile of a zone — where spatially-anchored
 * narrative content (objectives, key NPCs, interactables) should cluster.
 * If omitted, it defaults to the landmark, else the zone center (see
 * resolveFocalPoint). `landmark_offset` places it relative to the landmark.
 */
export type FocalPoint =
  | { region: string }
  | { x: number; y: number }
  | { landmark_offset: { dx: number; dy: number } };

export type SpatialConstraintType = 'adjacency' | 'elevation' | 'visibility' | 'distance';

/**
 * A declared spatial relationship to another zone. The Gardener proposes
 * these; the Implementer satisfies the structurally-enforceable ones.
 * Only `adjacency` is enforceable in the current graph model (it implies a
 * matching connection) — `elevation`, `visibility`, and `distance` are
 * recorded authorial intent surfaced to the LLM and lints.
 */
export interface SpatialConstraint {
  type: SpatialConstraintType;
  /** Target zone id this relationship is declared against. */
  target: string;
  /** For adjacency: which side of THIS zone the target should sit on. */
  direction?: Direction;
  /** For elevation: whether this zone is above/below the target. */
  relation?: 'above' | 'below';
  /** For distance: minimum number of neutral zones that should separate them. */
  min_zones?: number;
  /** Free-text rationale carried through from the opportunity. */
  note?: string;
}

/**
 * Per-feature noise parameters for organic feature distribution. The active
 * mechanism is the `noise_patch` op; this optional list documents a zone's
 * feature-noise intent in one place and keeps seeds named and stable.
 */
export interface NoiseSeedSpec {
  feature: string;
  tile: string;
  seed: string | number;
  frequency?: number;
  threshold?: number;
}

// --- Mapgen ops (deterministic) ---

export type ShapeSpec =
  | { kind: 'rect'; w: number; h: number }
  | { kind: 'circle'; r: number }
  | { kind: 'ellipse'; rx: number; ry: number }
  | { kind: 'polygon'; points: [number, number][] };

export type PositionSpec =
  | { center: true }
  | { x: number; y: number }
  | { relative_to: string; side: Direction; gap?: number };

export type BoundsRef =
  | { region: string }
  | { rect: { x: number; y: number; w: number; h: number } }
  | { all: true }
  /** Zone-wide bounds shrunk by `inset` tiles on every side. */
  | { inset: number }
  /** A strip of `depth` tiles along the given edge, full zone width/height. */
  | { edge_strip: Direction; depth: number }
  /** A depth×depth square at the given corner. */
  | { corner_patch: 'NE' | 'NW' | 'SE' | 'SW'; depth: number };

export type PointAnchor = 'center' | 'north' | 'south' | 'east' | 'west';

export type PointRef =
  | { x: number; y: number }
  | { region: string; anchor?: PointAnchor }
  // Parametric point on a zone edge. `t` is 0..1 along the edge
  // (0 = west/north corner, 1 = east/south corner). Defaults to 0.5.
  // `inset` moves the point inward from the edge by this many tiles (default 0).
  | { edge: Direction; t?: number; inset?: number }
  // A named feature placed by an earlier pass (site/anchor/region). Resolves to
  // the feature's point (or region center). Lets later atoms wire to generated
  // features by name instead of hand-guessed coordinates.
  | { feature: string }
  // Zone center (floor(width/2), floor(height/2)).
  | { center: true };

/**
 * Coordinate-free placement descriptors for the Implementor's `post_ops` layer.
 * The model never emits X/Y; it picks a descriptor that matches the *intent* and
 * the engine resolves it against the live grid at generation time (see
 * resolveSemanticAt in mapgen/index.ts). Resolution returns null when nothing
 * matches, in which case the owning post-op is skipped (never crashes load).
 */
export type SemanticAt =
  // Free tile of `near_tile`, at least `margin` tiles from any blocking tile.
  // With `near_region`, additionally within ~3 tiles of a region whose id
  // starts with that prefix (e.g. "building" matches "building_0").
  | { near_tile: string; near_region?: string; margin?: number }
  // Any tile of exactly this type (e.g. place on an existing road/path).
  | { on_tile: string }
  // Any unclaimed passable tile. Last resort.
  | { random_free: true }
  // Free tile inside the named region's bounding box.
  // `order: 'edge_in'` tries perimeter cells first (default is center-out).
  // `edge` restricts candidates to a single edge row/column, sorted center-out.
  | { in_region: string; order?: 'edge_in'; edge?: 'north' | 'south' | 'east' | 'west' }
  // Free tile within `distance` tiles of the named region's centroid. Default 4.
  | { near_region: string; distance?: number }
  // The centroid tile of the named region (nearest free tile if blocked).
  | { center_of_region: string }
  // Free tile on the given perimeter edge, `inset` tiles inward. Default 1.
  | { free_edge: Direction; inset?: number }
  // The tile tagged with anchor key `anchor` from the most recently stamped
  // prefab named `anchor_of` earlier in this post_ops sequence.
  | { anchor_of: string; anchor: string };

/**
 * A prefab is an ASCII tile grid with a legend and optional anchor map. Used
 * inline in stamp/place ops, or as a named entry loaded from world/prefabs/.
 */
export interface PrefabData {
  data: string;
  legend: Record<string, string>;
  /** char -> anchor tag; those cells become anchor features, left walkable. */
  anchors?: Record<string, string>;
}

export interface Prefab extends PrefabData {
  id: string;
  description?: string;
}

/** A stamp/place prefab: an inline definition, or the id of a named prefab. */
export type PrefabRef = PrefabData | string;

/** Keepout claim categories, named for YAML. Mirrors CLAIM in blackboard.ts. */
export type ClaimCategory = 'reserved' | 'building' | 'road' | 'water' | 'site';

export interface WallsSpec {
  tile: string;
  door?: { side: Direction; tile?: string };
}

/** Controls how an op is spatially anchored relative to the zone's inset boundary.
 *  - `internal`  — placement is bounded to the interior (inside the inset wall).
 *  - `perimeter` — placement is on the inset line itself (walls, gates, towers).
 *  When `inset` is 0 on the zone, all placements behave as if no boundary exists. */
export type Placement = 'internal' | 'perimeter';

export type GenOp =
  | { type: 'fill'; tile: string; bounds?: BoundsRef; only_over?: string | string[]; placement?: Placement; region?: string }
  | {
      type: 'region';
      id: string;
      shape: ShapeSpec;
      at: PositionSpec;
      floor?: string;
      walls?: WallsSpec;
      /** Only paint floor where current tile is in this list. Useful for organic
       *  regions that should respect already-placed terrain (e.g. don't stomp trees). */
      only_over?: string | string[];
    }
  | { type: 'shape'; shape: ShapeSpec; at: PositionSpec; tile: string; only_over?: string | string[] }
  | { type: 'road'; from: PointRef; to: PointRef; tile: string; width?: number }
  // Multi-point polyline. With `jitter > 0`, deterministically meanders
  // perpendicular to the path (seeded). For rivers, winding trails, etc.
  | {
      type: 'path';
      points: PointRef[];
      tile: string;
      width?: number;
      jitter?: number;
      seed?: number | string;
      placement?: Placement;
    }
  // Quadratic curve from `from` to `to` with `bulge` cells of perpendicular
  // offset on the control point. Positive bulge curves right of travel.
  | {
      type: 'arc';
      from: PointRef;
      to: PointRef;
      bulge: number;
      tile: string;
      width?: number;
    }
  // Deterministic point scatter within `bounds`. Each placement consults
  // `over` (when set) to only overwrite specific tiles.
  | {
      type: 'scatter';
      bounds: BoundsRef;
      tile: string;
      count: number;
      seed: number | string;
      over?: string | string[];
    }
  | {
      type: 'noise_patch';
      bounds?: BoundsRef;
      tile: string;
      threshold: number;
      scale: number;
      seed: number | string;
      over?: string | string[];
      placement?: Placement;
    }
  // Literal ASCII grid painted onto the zone. Each character in `data` maps to
  // a tile via `legend`; unmapped characters are skipped (passthrough). `scale`
  // tiles-per-character lets a compact sketch drive a large zone.
  | {
      type: 'sketch';
      data: string;
      legend: Record<string, string>;
      at?: { x: number; y: number };
      scale?: number;
    }
  // Cellular-automata cavern. Fills `bounds` (default: whole zone) with an
  // organic, connected open space: random seed → smoothing passes → small-pocket
  // pruning → tunnel-carving so every open cell is reachable. Open cells get
  // `floor`; solid cells get `wall` (if set, else left as-is). The open area's
  // AABB is registered under `region` (if given) for spawns/spawn_point/roads,
  // and an always-open `anchor` cell is exposed via the zone's focal point.
  | {
      type: 'cave';
      bounds?: BoundsRef;
      floor: string;
      wall?: string;
      seed: number | string;
      /** Initial wall probability (higher = sparser). Default 0.45. */
      fill?: number;
      /** Smoothing iterations (higher = blobbier). Default 5. */
      iterations?: number;
      /** Open pockets smaller than this are filled solid. Default 12. */
      min_pocket?: number;
      /** Carve tunnels to join surviving pockets. Default true. */
      connect?: boolean;
      /** Width of carved connector tunnels. Default 2. */
      tunnel_width?: number;
      /** Register the open-area AABB as a named region. */
      region?: string;
    }
  // Binary space partition into rooms joined by corridors — built interiors
  // (keeps, barracks, dungeons), the complement to `cave`'s organic spaces.
  // Recursively splits `bounds`, carves a room in each leaf, and connects sibling
  // rooms with L-shaped (4-connected) corridors so the whole interior is one
  // reachable graph. Each room is registered as a region (`<prefix>_N`); the
  // largest is also `<prefix>_main` for spawn_point/focal use.
  | {
      type: 'bsp';
      bounds?: BoundsRef;
      floor: string;
      /** If set, fill bounds with this wall tile before carving (for non-wall zones). */
      wall?: string;
      seed: number | string;
      /** Minimum room side length. Default 4. */
      min_room?: number;
      /** Maximum room side length. Default 10. */
      max_room?: number;
      /** Gap between a room and its partition edge (wall thickness). Default 1. */
      margin?: number;
      /** Max partition recursion depth. Default 5. */
      max_depth?: number;
      /** Corridor width. Default 1. */
      corridor_width?: number;
      /** Region id prefix for rooms. Default 'room'. */
      region_prefix?: string;
      /** Tags applied to each room region. */
      tags?: string[];
    }
  // Blue-noise (Poisson-disk) site placement. Scatters `count` points within
  // `bounds`, each at least `spacing` apart and on a free (un-claimed) cell,
  // registering every one as a `site` feature and reserving a disc of keepout
  // around it. Later atoms (route, stamp) target these sites by id/tag. The
  // backbone of settlement/camp/ruin layouts.
  | {
      type: 'scatter_sites';
      bounds?: BoundsRef;
      count: number;
      spacing: number;
      seed: number | string;
      /** Feature id prefix: <prefix>_1, _2, … Default 'site'. */
      id_prefix?: string;
      /** Tags applied to each placed site (e.g. ['plot']) for tag-based routing. */
      tags?: string[];
      /** Only place on these tile(s) — e.g. ['grass'] to avoid water/rock. */
      over?: string | string[];
      /** Keepout radius reserved around each site. Default ceil(spacing/2). */
      claim_radius?: number;
      /** Which keepout category to stamp. Default 'site'. */
      claim?: ClaimCategory;
      /** Keep sites at least this far from the zone edge. Default 2. */
      margin?: number;
      /** Optionally clear a floor disc at each site (a plaza/plot). */
      clear?: { tile: string; radius?: number };
      /**
       * Weighted role distribution. Each placed site draws one role and gets it
       * added as an extra tag (e.g. 'tavern', 'blacksmith'). Later stamp ops can
       * read this tag via `role_prefabs` to choose a role-specific building footprint.
       */
      roles?: Array<{
        role: string;
        weight: number;
        /** Hard cap on how many sites receive this role. Unlimited when omitted. */
        max?: number;
        /**
         * Module id this role belongs to. When present and that module is
         * inactive, the role is stripped from the resolved op so no sites
         * receive it and the corresponding stamp role_prefab is also removed.
         */
        module?: string;
      }>;
      placement?: Placement;
      /**
       * Bias sites toward a point instead of scattering uniformly. `fx`/`fy` are
       * fractions of the placement region (0..1, default 0.5 = center). `magnitude`
       * is the pull strength: 0 = uniform (no bias), higher = tighter cluster
       * (each candidate's offset from the point is scaled by rng()**magnitude).
       */
      concentrate?: { fx?: number; fy?: number; magnitude: number };
      /** Pin the FIRST site to this exact tile (remaining sites scatter normally).
       *  Used by feature-entry `at` overrides on single-site features. */
      at?: { x: number; y: number };
    }
  // Place a hand-authored prefab (a "vault") at a site or point. The prefab is
  // an ASCII footprint; `legend` maps chars to tiles, `anchors` maps chars to
  // anchor tags (e.g. 'D' -> 'door'). Placement is CENTERED on each target.
  // Every non-anchor cell is claimed BUILDING (so routes go around it); anchor
  // cells stay un-claimed and are registered as anchor features (so routes can
  // connect to the door). `at_tag` stamps one prefab per matching feature —
  // turning scatter_sites plots into actual buildings. Optional seeded rotation
  // gives a row of identical houses real variety.
  | {
      type: 'stamp';
      /** Inline prefab, or the id of a named prefab loaded from world/prefabs/. */
      prefab: PrefabRef;
      /** Single placement point (mutually exclusive with at_tag). In post_ops
       *  this may also be a SemanticAt descriptor. */
      at?: PointRef | SemanticAt;
      /** Stamp once per feature carrying this tag (e.g. 'plot'). */
      at_tag?: string;
      seed?: number | string;
      /** Each char paints a scale×scale block. Default 1. */
      scale?: number;
      /** Keepout category for the footprint. Default 'building'. */
      claim?: ClaimCategory;
      /**
       * When true, skip cells already claimed as BUILDING — the stamp paints
       * only where no prior building footprint exists. Use for optional features
       * (markets, plazas) that should yield to buildings rather than overwrite them.
       */
      only_free?: boolean;
      /**
       * Controls how the stamp interacts with existing claims:
       *   false / absent — full check: must be in-bounds, unclaimed by any prior
       *     post_op, non-blocking, and not BUILDING/RESERVED from the biome pipeline.
       *   'biome' — bypasses the biome-pipeline BUILDING/RESERVED claim check only.
       *     Still rejects blocking tiles and tiles claimed by earlier post_ops.
       *     Use when stamping inside a feature-generated area (market, fountain,
       *     plaza) that the biome pipeline claimed, but where post-op stacking
       *     must still be avoided.
       *   true — only rejects out-of-bounds. Ignores blocking tiles, biome claims,
       *     and earlier post_op claims entirely. Use only for carve-through ops
       *     (cave entrance cutting through forest, portal overwriting a campfire).
       */
      overwrite?: boolean | 'biome';
      /**
       * If set, the stamp is skipped silently (no warning) when this region has
       * not been registered by the time the op runs. Use for ops that are
       * intentionally conditional on an optional or toggled feature.
       */
      if_region?: string;
      /** Feature-id prefix for registered anchors when not stamping by tag. Default 'stamp'. */
      anchor_prefix?: string;
      /** Rotate the footprint: a fixed quarter-turn or 'random' (seeded per target). */
      rotate?: 'random' | 0 | 90 | 180 | 270;
      /** Register each footprint's AABB as a region (<feature-id>_interior, or this id). */
      region?: string;
      /**
       * Role-specific prefab overrides. When stamping an `at_tag` site whose
       * tags include a key from this map, that prefab is used instead of the
       * default `prefab`. Roles are assigned by `scatter_sites.roles`.
       */
      role_prefabs?: Record<string, PrefabRef>;
      placement?: Placement;
      /**
       * Breathing room (post_ops only). When > 0, the stamp lands only where
       * every footprint cell also has `margin` Chebyshev tiles clear of blocking
       * terrain — keeping structures off cliffs/water/walls and, because earlier
       * stamps' walls are blocking, naturally spaced from other buildings.
       */
      margin?: number;
      /**
       * Minimum Chebyshev distance from the centre of any stamp placed earlier
       * in this same post_ops run (post_ops only). Spaces out wall-less
       * structures (campfires, shrines) that `margin` alone wouldn't separate.
       */
      spacing?: number;
      /**
       * Post_ops only. When the stamp targets an `in_region` area and the prefab
       * does not fit anywhere inside it, retry once over the whole zone
       * (random free space) instead of skipping. Use for stamps that carry a
       * connectivity portal: a portal must never be silently lost just because
       * its preferred region is too small.
       */
      fallback_free?: boolean;
    }
  // Find a free location and stamp a prefab atomically. Unlike `stamp`, no
  // explicit position is needed — the engine samples candidates within the
  // placement region, checks the full prefab bounding box against keepout,
  // and stamps on first fit. Footprint-aware: won't clip buildings or walls.
  | {
      type: 'place';
      /** Inline prefab, or the id of a named prefab loaded from world/prefabs/. */
      prefab: PrefabRef;
      seed: string | number;
      /** Pin placement: center the prefab on this exact tile instead of searching
       *  for free space. Used by feature-entry `at` overrides. */
      at?: { x: number; y: number };
      /** Restrict candidate search to the inset interior or the perimeter line. */
      placement?: Placement;
      /** Min gap between the prefab edge and the search region boundary. Default 1. */
      margin?: number;
      /** Only place on top of these tile types. */
      over?: string | string[];
      /** Register the placed AABB as a named region. */
      region?: string;
      /** Prefix for registered anchor features. Default 'place'. */
      anchor_prefix?: string;
      /** Keepout category for the footprint. Default 'building'. */
      claim?: ClaimCategory;
      /** Rotate the footprint randomly (seeded). Default false. */
      rotate?: boolean;
    }
  // Cost-aware path between two endpoints (A* over the routing-cost layer). Bends
  // around expensive/impassable terrain and reuses existing roads. `from_tag`
  // routes every feature carrying that tag to `to` (a star network). Carves
  // `tile`, claims it as road, and never cuts through building-claimed cells.
  // Edge selection: choose which nodes (features) should connect, forming a
  // road graph. `mst` spans all nodes with minimum total length (a tree);
  // `extra_edges` adds back a fraction of the shortest non-tree links for loops;
  // `star` connects every node to `hub`. Emits `edge` features (ends = two node
  // ids) tagged `edge_tag`, which a following `route { edges: <tag> }` carves.
  | {
      type: 'network';
      /** Gather every feature with this tag as a node. */
      nodes_tag?: string;
      /** Additional explicit node feature ids (e.g. a well/plaza). */
      nodes?: string[];
      method?: 'mst' | 'star';
      /** For star: the hub feature id every node links to (defaults to first node). */
      hub?: string;
      /** Fraction (0..1) of shortest non-tree edges to add as loops. Default 0. */
      extra_edges?: number;
      /** Tag applied to emitted edge features (route consumes this). Default 'road'. */
      edge_tag?: string;
      /** Edge feature id prefix. Default 'edge'. */
      edge_prefix?: string;
    }
  | {
      type: 'route';
      from?: PointRef;
      from_tag?: string;
      /** Route every `edge` feature carrying this tag (from ends[0] to ends[1]). */
      edges?: string;
      /** Required for from/from_tag; ignored in edges mode. */
      to?: PointRef;
      tile: string;
      width?: number;
      /** Claim carved cells as CLAIM.ROAD so later passes see the network. Default true. */
      claim_road?: boolean;
      /** Clearable obstacle tiles the road may cut through at a penalty (e.g. tree).
       *  The carve clears them; without this, routes only detour around them. */
      through?: string | string[];
      /** Routing penalty for cutting through a `through` tile. Default 6 (so a road
       *  prefers open ground but will breach forest rather than detour far). */
      through_cost?: number;
    }
  // Reachability repair. Floods walkable tiles from the entry seed(s) and, for
  // anything that should be reachable but isn't, carves a corridor to it from
  // the nearest reachable cell (clearing `through` obstacles). `ensure_tags`
  // guarantees specific features (e.g. every door) are reachable; `ensure_all`
  // guarantees every walkable tile is one connected component. With no `carve`
  // tile it runs report-only, logging what is stranded. Runs last in a recipe.
  | {
      type: 'ensure_reach';
      /** Entry seed point(s) the player reaches the zone from. */
      from?: PointRef | PointRef[];
      /** Also seed from every feature carrying this tag. */
      from_tag?: string;
      /** Feature tags that must be reachable; a corridor is carved to each stranded one. */
      ensure_tags?: string[];
      /** Guarantee every walkable tile is connected to the seeds. */
      ensure_all?: boolean;
      /** Tile for carved repair corridors. Omit to run report-only (warn). */
      carve?: string;
      /** Clearable obstacles a repair corridor may cut through (e.g. wall, tree). */
      through?: string | string[];
      through_cost?: number;
      width?: number;
    }
  // Voronoi region decomposition: partition `bounds` (default: whole zone) by
  // assigning each tile to the nearest cell seed, then painting that cell's
  // floor. Produces naturally irregular borders without hand-authoring; adding
  // a cell reshapes its neighbours automatically. `weight` biases a cell's
  // territory (multiplicatively-weighted distance — higher = larger). Each
  // cell is registered as a named region (AABB of its assigned tiles) so
  // spawns, spawn_point, and roads can reference it like any region.
  | {
      type: 'voronoi';
      bounds?: BoundsRef;
      cells: Array<{ id: string; at: PointRef; floor: string; weight?: number }>;
      /** Paint a 1-tile seam where two cells meet (ridgelines, walls, water). */
      border?: { tile: string };
      /** Only repaint tiles currently matching one of these (e.g. ['grass']). */
      over?: string | string[];
    }
  // Place a traversable portal tile that moves the player to `target_zone` on
  // contact. Intended for the post_ops layer (zone_connect): `at` resolves the
  // source tile (typically an `anchor_of` a stamped entrance prefab), the engine
  // paints `tile` there, and World resolves the destination to the target zone's
  // spawn point after all zones load. The reverse portal is auto-synthesized
  // from the target zone's non-cardinal `connections` key.
  | {
      type: 'portal';
      at: PointRef | SemanticAt;
      target_zone: string;
      /** Client transition animation. Default 'teleport'. */
      transition?: 'descend' | 'ascend' | 'teleport';
      /** Tile painted at the portal cell. Default 'portal'. */
      tile?: string;
    };

export type SpawnPoint =
  | { region: string }
  | { x: number; y: number }
  // Spawn the player at the zone's resolved focal point.
  | { focal: true };

// ─── World Generation ────────────────────────────────────────────────────────

export type WorldBiome =
  | 'ocean'
  | 'tundra'
  | 'plains'
  | 'grassland'
  | 'forest'
  | 'swamp'
  | 'desert'
  | 'mountain'
  /** Rare terrain gated by weirdness magnitude (shared/worldgen/field.ts),
   *  independent of climate — can appear anywhere the base biome isn't
   *  ocean/mountain. Striped mesa/canyon texture built from existing tiles. */
  | 'badlands';

export type WorldCellTag = 'beach' | 'river' | 'river_crossing';

export type BoundaryStyle = 'mountain' | 'ocean';

export type SettlementModifier = 'cursed' | 'blessed' | 'deserted' | 'ruined' | 'contested' | 'hidden';

export interface LevelBand {
  tier: number;
  minLevel: number;
  maxLevel: number;
}

export interface WorldCell {
  gridX: number;
  gridY: number;
  worldBiome: WorldBiome;
  /** Derived from world seed + grid position. Passed to zone generator. */
  seed: string;
  width: number;
  height: number;
  /** Noise values retained for debugging / editor overlays. */
  temperature: number;
  moisture: number;
  elevation: number;
  danger: number;
  levelBand: LevelBand;
  tags: WorldCellTag[];
  /** Edges this cell's river crosses (entry from upstream + exit downstream, or
   *  an ocean-mouth edge). 1-2 entries; used to route the zone-level water path
   *  between edge midpoints so rivers align across zone borders. Absent = no river. */
  riverEdges?: Direction[];
}

export type SettlementType = 'city' | 'village';

export interface WorldSettlement {
  type: SettlementType;
  gridX: number;
  gridY: number;
  worldBiome: WorldBiome;
  modifier?: SettlementModifier;
}

export interface WorldDef {
  seed: string;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  boundaryStyle: BoundaryStyle;
  /** Row-major: cells[row][col] */
  cells: WorldCell[][];
  /** Villages and dungeons. */
  settlements: WorldSettlement[];
  /** Cities — placed separately after villages, stored for easy lookup. */
  cities: WorldSettlement[];
}

// ─── Zone Definitions ────────────────────────────────────────────────────────

/**
 * One entry in a zone's `features` array — the single interface for dropping
 * content into a zone. The id names either a feature operator
 * (mapgen/features registry) or a named prefab (world/prefabs/); the engine
 * resolves placement in both cases. Prefab entries are compiled at load time
 * into the canonical stamp(+portal) post_op chain, so the anchor/region wiring
 * is generated, never hand-authored.
 */
export type ZoneFeatureEntry =
  | string
  | {
      id: string;
      /** `false` disables a biome-default feature. Default true. */
      enabled?: boolean;
      /** Param overrides for registry feature operators. */
      params?: Record<string, number>;
      /** Pin the feature's placement to an exact tile (hand-authoring). Honored
       *  by single-location features: the operator's one placement op (a count-1
       *  scatter_sites reserve, a `place`, or a prefab stamp) lands here instead
       *  of the engine choosing. Ignored by multi/area features (walls, borders). */
      at?: { x: number; y: number };
      /** Prefab entries only: pin placement inside a named region instead of
       *  open ground. Skipped silently when the region is absent. */
      in_region?: string;
      /** Prefab entries only: wire the prefab's portal anchor to this zone. */
      portal_to?: string;
      /** Portal transition kind. Default 'descend'. */
      transition?: 'descend' | 'ascend' | 'teleport';
    };

export interface ZoneDef {
  id: string;
  name?: string;
  /** Player-facing zone title (Implementor-owned). Falls back to a capitalized
   *  biome name in the client banner when unset. */
  display_name?: string;
  /** Level/difficulty band for this zone instance (Implementor-owned). */
  level_band?: LevelBand;
  tileset?: string;
  width?: number;
  height?: number;
  default_tile?: string;
  /** Structural archetype — drives focal-point default and authoring guidance. */
  archetype?: ZoneArchetype;
  /** The zone's heart point; default focal anchor and render overlay. */
  landmark?: Landmark;
  /** The narrative anchor tile; defaults to landmark, else zone center. */
  focal_point?: FocalPoint;
  /** Declared spatial relationships to other zones (from the Gardener). */
  spatial_constraints?: SpatialConstraint[];
  /** Optional directional bias for the zone's territory (forward-compat:
   *  consumed by a future inter-zone Voronoi model, not the current engine). */
  boundary_weights?: Partial<Record<Direction, number>>;
  /** Documented per-feature noise intent; the active mechanism is noise_patch. */
  noise_seeds?: NoiseSeedSpec[];
  ops?: GenOp[];
  /**
   * Implementor-appended ops that execute after the biome pipeline (and any
   * feature ops) resolve, operating on the already-generated grid. May use the
   * coordinate-free SemanticAt descriptors and the `portal` op. Skipped (with a
   * warning) when a descriptor can't be resolved — post_ops never crash load.
   */
  post_ops?: GenOp[];
  /** Zone-wide inset boundary in tiles. Ops with `placement: 'internal'` are
   *  bounded to this interior; `placement: 'perimeter'` places on this line. */
  inset?: number;
  /**
   * Biome-driven generation. When present, `ops` is derived at load time from
   * the named biome rather than read from the file. `ops` (if also present) is
   * ignored when `biome` is set.
   */
  biome?: string;
  /** Seed for biome pipeline variance. String or hex string. */
  seed?: string;
  /** Zone-level param overrides passed to the biome pipeline (e.g. { inset: 5 }). */
  zoneParams?: Record<string, number>;
  /** Op-level param overrides keyed by basePipeline entry id (e.g. { village_plots: { count: 8 } }). */
  opParams?: Record<string, Record<string, number>>;
  /**
   * Per-zone features — the single interface for zone content. An array of
   * entries: ['fountain', { id: 'crypt_entrance', portal_to: 'zone_x_crypt' },
   * { id: 'guard_tower', enabled: false }]. An entry id names a feature
   * operator (enable/disable/tune) or a world/prefabs prefab (engine-placed
   * landmark, optionally region-pinned or wired to a portal).
   * See normalizeZoneFeatures + mergeFeatures.
   */
  features?: ZoneFeatureEntry[];
  spawn_point?: SpawnPoint;
  /**
   * One or more egress tiles inside this zone for returning to the parent. When
   * set, `_synthesizeReturnPortals` places a return portal at each point (paired
   * in order with the parent's entrance portals). Falls back to a single portal
   * at `spawn_point` when absent.
   */
  egress_points?: SpawnPoint[];
  /** Suppress the atmospheric edge-haze vignette (for interior/indoor zones). */
  no_edge_haze?: boolean;
  spawns?: ZoneSpawn[];
  portals?: ZonePortal[];
  /**
   * Zone links. Cardinal keys (north/south/east/west) are edge transitions
   * resolved to perimeter portal tiles. Non-cardinal keys (e.g. `surface`,
   * `cellar`) name an interior connection back to a parent zone; the engine
   * auto-synthesizes a return portal for these at load time.
   */
  connections?: Record<string, string>;
}

/**
 * A named dungeon in the roster (world/dungeons/*.json) — the persistent half
 * of a rotating world. The NAME is the identity: it is what a character
 * discovers, and discovery survives every epoch rotation. Where the entrance
 * sits and what the interior looks like are the instance, re-rolled each epoch
 * from the epoch seed (docs/rework.md; shared/worldgen/epoch.ts).
 *
 * This is the same "novelty in the vocabulary, determinism in the instance"
 * split the forge uses, applied to a time axis rather than a generation run.
 */
export interface DungeonDef {
  /** Stable across epochs. Also the id of the zone this instantiates, and the
   *  key a character's discovery is recorded against. */
  id: string;
  /** Player-facing name, shown on the world map once discovered. */
  name: string;
  placement: {
    /** Level band the entrance sits in. Resolved to a radius annulus from the
     *  origin, since danger is radial and seed-independent (field.ts dangerAt). */
    min_level: number;
    max_level: number;
    /** Wilderness biomes the entrance may sit in. Omitted/empty = any land biome. */
    biomes?: WorldBiome[];
  };
  /** The zone program. `id` and `seed` are supplied per epoch by the loader, so
   *  a template must not set them — that is what makes the interior re-roll. */
  zone: Omit<ZoneDef, 'id' | 'seed'>;
  /** Optional EXTERIOR: a structure physically present in the open world around
   *  the entrance — a camp, a ruin, a walled compound — rather than a bare
   *  portal tile. Authored as a zone (so it keeps the whole op pipeline and
   *  every tool that edits a zone) and baked to a `grid` stamp painted onto the
   *  field; see server/game/mapgen/bake.ts and docs/plan-poi-authoring.md. It
   *  re-rolls with the epoch exactly as the interior does, so anything that
   *  references it must do so by region name, never by coordinate. Same rule as
   *  `zone`: no `id`, no `seed`. */
  footprint?: Omit<ZoneDef, 'id' | 'seed'>;
}

export interface TileEntry {
  color: string;
  /** If true, this tile blocks movement. Extends the base BLOCKING_TILES set
   *  at world-load time so new solid tiles don't require a code change. */
  blocking?: boolean;
  /** Size of this tile's sprite-variant library, if any: client/public/tiles/
   *  <tileId>_<n>.png for n in [0, variants). Baked by sprites/sprite_baker.py
   *  --kind tile from sprites/tiles.json. Omitted/0 means no art yet — the
   *  renderer falls back to `color`. Variant choice per-position is
   *  deterministic; see pickTileVariant in shared/tileset.ts. */
  variants?: number;
  /** Relative weight per variant index, length should match `variants`.
   *  Omitted = uniform (every variant equally likely). E.g. [3, 2, 2, 1, 1]
   *  makes variant 0 the common "default" look and variant 4 a rare accent.
   *  Applied on top of the same spatially-coherent noise pickTileVariant
   *  already uses for patch selection, so skewing the distribution doesn't
   *  reintroduce per-tile noise — it just resizes each variant's share of
   *  the existing coherent patches. */
  variantWeights?: number[];
  /** Opt this tile into seam dithering (pickSeamTile in shared/tileset.ts):
   *  where it borders another `blend` tile, the two interlock in a dithered
   *  band instead of meeting on a straight grid line. Cosmetic only — the id
   *  is unchanged everywhere else — so set it ONLY on walkable natural ground.
   *  A blocking tile (water, cell_bars) or a decoration (chest, campfire)
   *  would be drawn smeared into its neighbour, lying about the map. */
  blend?: boolean;
}

export interface Tileset {
  name: string;
  tile_size: number;
  tiles: Record<string, TileEntry>;
  sprites: Record<string, { color: string }>;
}

// Objective shapes are a discriminated union. Each kind is checked by the
// corresponding notify* hook in server/game/systems/quests.ts; new kinds
// require a new hook AND a new branch in tryAdvanceStage.
export type QuestObjective =
  | {
      kind: 'kill_count';
      target: number;
      template_id?: string;   // optional filter
      zone?: string;          // optional filter
    }
  | { kind: 'kill_specific'; target_id: string }
  | { kind: 'collect_count'; item_base: string; target: number }
  | { kind: 'talk'; target_template: string }
  | {
      kind: 'reach';
      radius: number;          // Chebyshev distance (tile-square)
      zone?: string;           // optional zone filter
      template_id?: string;    // satisfied when within radius of any mob with this template id
      x?: number;              // OR a fixed point in `zone` (zone required)
      y?: number;
    };

export interface QuestStageDef {
  id: string;
  text: string;
  on_complete?: string;
  // If omitted, server treats the stage as a talk-the-giver objective —
  // satisfied by clicking the giver in the quest modal.
  objective?: QuestObjective;
}
export interface QuestReward {
  gold?: number;
  item?: string;
  xp?: number;
}
export interface QuestDef {
  id: string;
  name?: string;
  /** Mob template id (e.g. "merchant") or a spawn_id from a zone spawn entry
   *  (e.g. "market_merchant"). When a spawn_id is used, only that specific mob
   *  instance can give and receive this quest. */
  giver?: string;
  zone?: string;
  description?: string;
  stages?: QuestStageDef[];
  rewards?: QuestReward[];
  /** Quest id(s) that must be completed before this quest becomes available. */
  unlock_after?: string | string[];
  /** If true, the quest can be accepted and completed any number of times. */
  repeatable?: boolean;
  [extra: string]: unknown;
}

// --- Abilities (see docs/plan-abilities.md) ---
// One generic primitive consumed by both mobs and players. An ability describes
// WHAT happens; a controller (player input / mob AI) decides WHEN to fire it.

/** `point` is a ground-targeted cast: the client sends a world (tx,ty) tile
 *  rather than an entity; the effect (e.g. blink) resolves against that tile.
 *  The actor is the sole "target" (resolveTargets returns [actor]). */
export type AbilityTargetShape = 'self' | 'target' | 'projectile' | 'area' | 'point';

/** Stat -> scaling grade letter (S/A/B/C/D/E, indexing SCALING_COEFFS). Same
 *  letter-graded shape weapons already use (RolledStats.scaling). A spell scales
 *  intelligence, a headbutt strength. */
export type AbilityScaling = Partial<Record<StatId, ScalingLetter>>;

export interface DamageEffect {
  kind: 'damage';
  base: Range;
  scaling?: AbilityScaling;
  brand?: string;
  /** Ability 0 only: derive damage from the actor's equipped weapon (base +
   *  scaling + brands) instead of the static `base`. Set in code, never YAML. */
  from_weapon?: boolean;
}
export interface HealEffect { kind: 'heal'; base: Range; scaling?: AbilityScaling }
/** Semantic crowd-control flags a modifier can carry, enforced at the systems
 *  that gate action/movement/casting (ai.ts, movement.ts, abilities.ts). A
 *  modifier may carry more than one (e.g. stun+silence on one cast). */
export type CcKind = 'stun' | 'root' | 'silence' | 'confuse' | 'fear' | 'antagonize';
/** Applies a timed bundle of stat deltas (buff/debuff). A dot/hot is a modifier
 *  whose `tick_effect` fires each tick while active. `stats` keys include
 *  max_health / max_mana, so resource bonuses are just modifier effects. */
export interface ModifierEffect {
  kind: 'modifier';
  stats: Record<string, number>;
  duration_ticks: number;
  tick_effect?: DamageEffect | HealEffect;
  cc?: CcKind[];
}
/** `blink` teleports the actor: with a ground-target point (shape 'point') it
 *  jumps to that tile, capped to `distance` (Chebyshev) and snapped to the
 *  nearest free tile — crossing walls/gaps. With no point it dashes along the
 *  actor's facing (the original mob-facing behavior). */
export interface MoveEffect { kind: 'move'; motion: 'charge' | 'leap' | 'knockback' | 'blink'; distance: number }
/** A persistent ground hazard/boon centered on the resolved target's position
 *  at cast time — independent of any entity, so it keeps hitting whoever
 *  stands in it (or leaves) for its duration, unlike `modifier` which travels
 *  with whatever it was applied to. `effect` fires every `tick_interval_ticks`
 *  (default MODIFIER_TICK_INTERVAL_TICKS) to everyone in `radius` matching
 *  `side` (default 'enemy', same convention as AbilityTargeting.side). See
 *  World.activeZones / spawnZone / tickZones. */
export interface ZoneEffect {
  kind: 'zone';
  radius: number;
  duration_ticks: number;
  tick_interval_ticks?: number;
  effect: DamageEffect | HealEffect;
  side?: AbilityTargetSide;
}
export type AbilityEffect = DamageEffect | HealEffect | ModifierEffect | MoveEffect | ZoneEffect;

/** Generalized cost map — only `mana` exists now; reserves the seam for
 *  rage/energy. `cost: {}` (or omitted) = free, cooldown-only. */
export interface AbilityCast { cost?: Record<string, number>; cooldown_ticks: number; wind_up_ticks?: number }
/** `radius` is only read when `shape === 'area'` (Chebyshev tiles around the
 *  resolved target, see resolveTargets in abilities.ts). */
/** Which faction (stats.ts factionOf) an ability may land on. Omitted = 'enemy'
 *  (every ability authored before this field existed keeps its old behavior). */
export type AbilityTargetSide = 'ally' | 'enemy' | 'any';
export interface AbilityTargeting {
  shape: AbilityTargetShape;
  range: number;
  radius?: number;
  side?: AbilityTargetSide;
  /** Where an `area` shape's radius is measured from. 'target' (the default,
   *  and every area ability authored before this field existed) centres the
   *  burst on the resolved target — a cleave that spills around whoever you
   *  hit. 'caster' centres it on the actor, which is the only way to express
   *  "everything around ME" (whirlwind, nova): resolveTargets otherwise has no
   *  caster-centred path, since `self` and `point` both resolve to just the
   *  actor. A target is still required and still range-checked, so this is
   *  "swing at someone, hit everyone near you", not an untargeted press. */
  origin?: 'caster' | 'target';
}

/** Who may use an ability. Mob abilities omit the player-only `class`/`ranks`. */
export type AbilityActor = 'player' | 'mob' | 'any';
/** A player ability's class home. `global` abilities are sold by every trainer
 *  and learnable by any class. (See docs/plan-class-abilities.md.) */
export type AbilityClass = ClassId | 'global';

/** One purchasable rank of a player ability. Rank 1 is the ability as authored
 *  (its `effects` at power_mult 1.0); higher ranks raise the `base` of damage /
 *  heal effects by `power_mult`. The only other things a rank can change are
 *  `range` and `cooldown_ticks` (see below), for abilities where reach or
 *  cast frequency itself is the power. */
export interface AbilityRank {
  rank: number;
  requires_level: number;
  cost_gold: number;
  power_mult: number;
  /** Absolute override, at this rank, for a point-shaped ability's targeting.range
   *  and a `move` effect's distance — the two travel together for ground-target
   *  dash/teleport abilities (e.g. blink) where "how far you can aim" and "how far
   *  you go" are the same number. Omitted ranks fall back to the ability's base
   *  targeting.range / effect.distance, so non-mobility abilities are unaffected. */
  range?: number;
  /** Absolute override, at this rank, for the ability's cast.cooldown_ticks —
   *  lets a rank ladder shorten the cooldown instead of (or as well as) raising
   *  power/range (e.g. blink). Omitted ranks fall back to cast.cooldown_ticks. */
  cooldown_ticks?: number;
}

export interface AbilityDef {
  id: string;
  name: string;
  /** Default 'any' when omitted. Player abilities set 'player'; the 5 authored
   *  mob abilities set 'mob'. */
  actor?: AbilityActor;
  /** Required when actor is 'player'. Gates which trainer teaches it. */
  class?: AbilityClass;
  targeting: AbilityTargeting;
  cast: AbilityCast;
  effects: AbilityEffect[];
  /** Player abilities only: the rank ladder (strictly ascending level + cost).
   *  Absent for mob abilities (treated as a single rank, power_mult 1.0). */
  ranks?: AbilityRank[];
  /** True for the attacks weapons make (ItemBase.attack_ability) and for
   *  unarmed_strike. These are never learned, ranked or sold; they're resolved
   *  from what the actor is holding. Exempts a silenced actor (you can still
   *  swing) and suppresses the cast callout (a swing isn't a spell). */
  weapon_attack?: boolean;
}

/** A live status effect on an actor: a timed bundle of stat deltas (read by
 *  effectiveStat) plus an optional per-interval tick_effect (the dot/hot). */
export interface TimedModifier {
  source: string;            // entity id that applied it
  ability?: string;          // originating ability id (display / future stacking)
  stats: Record<string, number>;
  expiresAt: number;         // tick at which it falls off
  tickEffect?: DamageEffect | HealEffect;
  nextTickAt?: number;       // next tick the tick_effect fires (dot/hot cadence)
  cc?: CcKind[];             // semantic crowd-control flags carried by this modifier
}

export interface WorldDefs {
  zones: Record<string, ZoneDef>;
  mobs: Record<string, MobTemplate>;
  itemBases: Record<string, ItemBase>;
  affixes: AffixPools;
  quests: Record<string, QuestDef>;
  abilities: Record<string, AbilityDef>;
  tilesets: Record<string, Tileset>;
  /** Named prefabs loaded from world/prefabs/, available by id to stamp/place ops. */
  prefabs: Record<string, Prefab>;
  /** Named dungeon roster (world/dungeons/). Placement metadata for the atlas;
   *  the zone instances themselves are already in `zones`, keyed by dungeon id. */
  dungeons: Record<string, DungeonDef>;
  /** Union of the base BLOCKING_TILES constant and any tileset tile entries
   *  with \`blocking: true\`. Computed by the world loader at load time. */
  blockingTiles: ReadonlySet<string>;
}

// --- Socket events ---

export interface ChatFrom { id: string; name: string; type: Entity['type'] }

export interface CharacterSummary {
  id: string;
  slot: number;
  name: string;
  klass: ClassId;
  color: string;
  level: number;
  zone: string;
}

export interface ListCharactersResponse {
  characters: CharacterSummary[];
  error?: string;
}

export interface JoinRequest {
  /** Firebase ID token obtained from the client SDK after sign-in. */
  firebase_token: string;
  /** Select a specific character by id (must belong to this account). */
  character_id?: string;
  /** Only required when creating a new character (server returns needsCharacter: true). */
  name?: string;
  klass?: ClassId;
  color?: string;
}

export interface JoinResponse {
  /** Set if the token was invalid or an unexpected server error occurred. */
  error?: string;
  /**
   * True when the authenticated account has no character yet.  The client
   * should prompt for a name/class and re-emit join with those fields.
   */
  needsCharacter?: boolean;
  entityId: string;
  /** Undefined when needsCharacter is true or error is set. */
  zone?: ZoneSnapshot;
  /** Undefined when needsCharacter is true or error is set. */
  self?: PlayerEntity;
}

export interface CombatEvent {
  attackerId: string;
  targetId: string;
  damage: number;
  fatal: boolean;
  dodged: boolean;
  at: { x: number; y: number } | null;
}

export interface PickupEvent {
  kind: 'gold' | 'item';
  name: string;
  amount?: number;
  slot?: number;
}

export interface XpEvent {
  gained: number;
  xp: number;
  level: number;
  xp_to_next: number;
  source: { name: string; id: string };
}

export interface LevelUpEvent {
  level: number;
  from_level: number;
  unspent_points: number;
}

export type ChatChannel = 'zone' | 'global' | 'whisper' | 'system';
export interface ChatMessage { from: ChatFrom; text: string; at: number; channel?: ChatChannel }

export interface RespawnEvent { zone: ZoneSnapshot; self: PlayerEntity }
export type DiedEvent = Record<string, never>;
/** Where someone fell. Broadcast to the whole zone rather than carried on
 *  `died`, because a death is a thing everyone standing there watched — and
 *  the corpse-less victim's own `self` copy is already stale by then (the
 *  server has teleported the entity to the respawn point). */
export interface DeathSplatEvent { zone: string; x: number; y: number }

export interface SelfEvent { self: PlayerEntity }

/** Why an ability cast was rejected by the server (sent back to the caster so
 *  the UI can explain a no-op). Canonical home for the union the executor returns. */
export type CastFailure = 'cooldown' | 'mana' | 'no_target' | 'not_learned' | 'stunned' | 'silenced';
export interface CastFailedEvent { abilityId: string; reason: CastFailure }

export interface QuestsEvent { quests: QuestsComponent }

export type QuestActionKind = 'accept' | 'decline' | 'abandon' | 'talk';
export interface QuestActionMessage {
  questId: string;
  action: QuestActionKind;
  // For action: 'talk' — template id of the NPC the player clicked. Server
  // verifies it matches the talk objective's target_template.
  talkingTo?: string;
}
export interface QuestActionResponse {
  ok: boolean;
  reason?: string;
  quests?: QuestsComponent;
}

export type ActionMessage =
  | { action: 'move'; dir: Direction }
  | { action: 'attack'; targetId?: string }
  | { action: 'ability'; abilityId: string; targetId?: string; tx?: number; ty?: number }
  | { action: 'autopath'; tx: number; ty: number; chaseTargetId?: string };

export interface HealSocketEvent {
  sourceId: string;
  targetId: string;
  amount: number;
  at: { x: number; y: number } | null;
}

/** Broadcast once per successful non-basic-attack cast (see abilities.ts's
 *  CastEvent) so the client can show a callout even for pure-CC/utility
 *  abilities that produce no damage/heal event of their own. `at` is the
 *  caster's position (the callout floats over them, not the target). */
export interface AbilityCastEvent {
  casterId: string;
  abilityId: string;
  targetId: string;
  at: { x: number; y: number } | null;
}

export interface ServerToClientEvents {
  zone: (snap: ZoneSnapshot) => void;
  combat: (ev: CombatEvent) => void;
  heal: (ev: HealSocketEvent) => void;
  pickup: (ev: PickupEvent) => void;
  xp: (ev: XpEvent) => void;
  levelup: (ev: LevelUpEvent) => void;
  chat: (msg: ChatMessage) => void;
  respawn: (ev: RespawnEvent) => void;
  died: (ev: DiedEvent) => void;
  /** Blood where a player fell, sent to everyone in that zone (the victim
   *  included — they have left the chunk rooms by then, so they get it
   *  directly). */
  death_splat: (ev: DeathSplatEvent) => void;
  self: (ev: SelfEvent) => void;
  quests: (ev: QuestsEvent) => void;
  cast_failed: (ev: CastFailedEvent) => void;
  ability_cast: (ev: AbilityCastEvent) => void;
  open_map: () => void;
  // ── Continuous wilderness (docs/rework.md §8) ──────────────────────────────
  /** Switch the client into wilderness render mode at a world tile. Terrain is
   *  derived locally; entities arrive via wild_chunk. */
  wild_enter: (ev: WildEnterEvent) => void;
  /** Authoritative entity list for one chunk (full-replace). Terrain never sent. */
  wild_chunk: (ev: WildChunkEvent) => void;
  /** A chunk left the player's load radius — drop its entities. */
  wild_leave: (ev: { cx: number; cy: number }) => void;
  /** A puff of smoke where someone blinked out of or into the world. Two are
   *  sent per teleport, one per end, each to its own zone room — so bystanders
   *  at the origin see the vanish and bystanders at the destination see the
   *  arrival, whether or not either of them can see the other end. */
  teleport_fx: (ev: TeleportFxEvent) => void;
  /** The wilds rotated (docs/rotating-wilds.md). Everything the client derived
   *  from the old seed — cached chunk terrain, streamed entities, the atlas
   *  itself — is invalid and must be dropped and refetched. Discoveries are
   *  keyed by site id, not position, and deliberately survive. */
  wild_reset: (ev: WildResetEvent) => void;
  /** Named dungeons/POIs this character has discovered. Sent in full on join
   *  and again (with `justFound` set) the moment a new one is sighted, so the
   *  client never has to infer discovery from position. */
  discoveries: (ev: DiscoveriesEvent) => void;
}

/** One end of a teleport. Every discontinuous relocation emits a pair — see
 *  World.teleportFx, the single funnel all of them go through. */
export interface TeleportFxEvent {
  /** Who moved. The client uses this only to skip drawing over a sprite that
   *  is already standing there (the arrival end of your own blink). */
  entityId: string;
  /** Zone the puff plays in — the room this event is broadcast to. Signed world
   *  tiles when it is the wilderness, like every other wild coordinate. */
  zoneId: string;
  x: number;
  y: number;
  phase: 'depart' | 'arrive';
}

export interface WildResetEvent {
  /** The epoch now live. */
  epoch: number;
  /** Wall-clock ms at which this epoch ends and the next rotation fires. */
  endsAt: number;
}

export interface DiscoveriesEvent {
  /** Every site id this character has ever discovered, across all epochs. */
  ids: string[];
  /** The site discovered just now, if this event was triggered by a sighting. */
  justFound?: { id: string; name: string };
  /** Site ids merely CHARTED for this epoch (a scribe's scroll), not found.
   *  Never written to the discoveries table and gone at the next rotation —
   *  permanence is earned by visiting. Always sent in full alongside `ids`,
   *  so the client can mirror both sets from any one of these events. */
  revealed?: string[];
  /** The site charted just now, with the position it holds THIS epoch — the
   *  only place a coordinate ever rides this event, because a charted site is
   *  the one map marker that means nothing without one. */
  justRevealed?: { id: string; name: string; x: number; y: number };
}

export interface WildEnterEvent {
  x: number;
  y: number;
  self: PlayerEntity;
  /** Server tick at entry — seeds the client's tick-extrapolation baseline
   *  (see ZoneSnapshot.tick) so status-effect countdowns work in the wilds too. */
  tick: number;
}
export interface WildChunkEvent {
  cx: number;
  cy: number;
  entities: EntitySnapshot[];
  /** Server tick this chunk payload was built at — refreshes the same
   *  extrapolation baseline as WildEnterEvent.tick on every chunk update. */
  tick: number;
  /** Active ground zones (see ActiveZoneSnapshot) whose center falls in this
   *  chunk. A zone straddling a chunk boundary only renders in the chunk(s)
   *  its center falls into — acceptable given zone radii are small relative
   *  to CHUNK_SIZE. */
  activeZones: ActiveZoneSnapshot[];
}

export type Ack<T> = (resp: T) => void;
export type ResultAck = Ack<{ ok: boolean; reason?: string; self?: PlayerEntity }>;

export interface TradeMessage {
  mobId: string;
  action: 'buy' | 'sell';
  itemBase?: string;  // for buy: the item base id to purchase
  /** For buy: a featured-stock entry id (see FeaturedStockEntry). Takes
   *  precedence over itemBase — a featured row is one specific rolled item, not
   *  a base, and two rows can share a base. */
  featuredId?: string;
  slotIndex?: number; // for sell: the inventory slot index to sell
}
export interface TradeResponse {
  ok: boolean;
  reason?: string;
  self?: PlayerEntity;
}

/** One row in a trainer's offer list (see docs/plan-class-abilities.md). */
export interface TrainOffer {
  abilityId: string;
  name: string;
  currentRank: number;        // 0 = not yet learned
  nextRank?: number;          // absent when already at max rank
  costGold?: number;          // next rank's gold cost
  requiresLevel?: number;     // next rank's level gate
  locked?: 'under_level' | 'insufficient_gold'; // why the next rank can't be bought yet
}
export interface TrainListResponse {
  ok: boolean;
  reason?: string;
  offers?: TrainOffer[];
}
export interface TrainMessage { mobId: string; abilityId: string }
export interface TrainResponse {
  ok: boolean;
  reason?: string;
  self?: PlayerEntity;
  rank?: number; // the rank now held after a successful purchase
}

export interface BoardMessage {
  id: string;
  authorName: string;
  text: string;
  postedAt: number;
}

export interface ReadBoardResponse {
  ok: boolean;
  messages?: BoardMessage[];
  reason?: string;
}

export interface PostBoardResponse {
  ok: boolean;
  reason?: string;
}

export interface ClientToServerEvents {
  list_characters: (req: { firebase_token: string }, ack: Ack<ListCharactersResponse>) => void;
  join: (req: JoinRequest, ack: Ack<JoinResponse>) => void;
  action: (msg: ActionMessage) => void;
  allocate: (msg: { stat: StatId }, ack: ResultAck) => void;
  equip: (msg: { slot: number }, ack: ResultAck) => void;
  unequip: (msg: { slot: EquipSlot }, ack: ResultAck) => void;
  drop_item: (msg: { slot: number }, ack: ResultAck) => void;
  chat: (msg: { text: string }) => void;
  quest_action: (msg: QuestActionMessage, ack: Ack<QuestActionResponse>) => void;
  poke_mob: (msg: { mobId: string }) => void;
  trade: (msg: TradeMessage, ack: Ack<TradeResponse>) => void;
  train_list: (msg: { mobId: string }, ack: Ack<TrainListResponse>) => void;
  train: (msg: TrainMessage, ack: Ack<TrainResponse>) => void;
  use_item: (msg: { slot: number }, ack: Ack<UseItemResponse>) => void;
  loot_corpse: (msg: { corpseId: string; slotId: string }, ack: Ack<LootCorpseResponse>) => void;
  read_board: (msg: { boardId: string }, ack: Ack<ReadBoardResponse>) => void;
  post_to_board: (msg: { boardId: string; text: string }, ack: Ack<PostBoardResponse>) => void;
  set_hotbar: (msg: { hotbar: (string | null)[] }, ack: ResultAck) => void;
}

export interface UseItemResponse {
  ok: boolean;
  reason?: string;
  self?: PlayerEntity;
  healed?: number;
  restored?: number;
}

export interface LootCorpseResponse {
  ok: boolean;
  reason?: string;
  self?: PlayerEntity;
}

// HTTP /api/quests payload — quest defs + an index of giver template id to
// quest ids that giver offers. Fetched once by the client on join.
export interface QuestsApiPayload {
  defs: Record<string, QuestDef>;
  byGiver: Record<string, string[]>;
}
