import type { ClassId, EquipSlot, KnownAbilities, MobRole, StatId } from './types.ts';

export const INVENTORY_SLOT_COUNT = 30;

// ─── Action cadence ──────────────────────────────────────────────────────────
// Shared so the client can predict the exact interval the server will enforce.
// The client used to assume a flat 1.5s basic attack; once a weapon's swing rate
// entered the formula that stopped being true (a 0.9-speed staff actually swings
// every 1.7s), and every request sent in the gap was silently dropped — which
// reads as a wizard that attacks slower than its own cooldown ring says.
export const TICK_MS = 100;
/** The basic-attack gate, in ticks, at speed 1. Matches the mob act cadence, so a
 *  speed-1 player and a speed-1 mob attack at the same rate. */
export const PLAYER_BASE_ACT_TICKS = 15;

/** Ticks between actions at a given effective speed — the one rounding both the
 *  server's gate and the client's prediction go through, so they cannot drift. */
export function actTicks(baseTicks: number, speed: number): number {
  return Math.max(1, Math.round(baseTicks / (speed > 0 ? speed : 1)));
}

export const EQUIPMENT_SLOTS: readonly EquipSlot[] = [
  'mainhand', 'helmet', 'chest', 'gloves', 'leggings', 'boots',
  'ring1', 'ring2', 'amulet',
] as const;

export const ARMOR_SLOTS: readonly EquipSlot[] = [
  'helmet', 'chest', 'gloves', 'leggings', 'boots',
] as const;

export const ALLOCATABLE_STATS: readonly StatId[] = [
  'strength', 'dexterity', 'intelligence', 'constitution',
] as const;

export interface ClassTemplate {
  id: ClassId;
  name: string;
  start_stats: { strength: number; dexterity: number; intelligence: number; constitution: number };
}

export const CLASSES: Record<ClassId, ClassTemplate> = {
  fighter: { id: 'fighter', name: 'Fighter', start_stats: { strength: 8, dexterity: 4, intelligence: 4, constitution: 6 } },
  rogue:   { id: 'rogue',   name: 'Rogue',   start_stats: { strength: 4, dexterity: 8, intelligence: 4, constitution: 6 } },
  wizard:  { id: 'wizard',  name: 'Wizard',  start_stats: { strength: 4, dexterity: 4, intelligence: 8, constitution: 6 } },
};

/** The attack an actor makes with an empty mainhand. Also what every mob swings,
 *  since mobs carry no equipment. */
export const UNARMED_ATTACK_ID = 'unarmed_strike';

/** The attack a weapon makes when it doesn't name one of its own. Defaulting to
 *  a swing rather than to unarmed is what keeps a weapon that nobody annotated
 *  behaving like a weapon: every hand-authored base (iron_sword, warhammer, …)
 *  and every future melee archetype works with no extra field, and only a weapon
 *  that attacks *differently* — the staff and its bolt — has to say so. */
export const WEAPON_ATTACK_ID = 'weapon_swing';

/** The weapon each class is born holding, equipped to the mainhand at character
 *  creation — the counterpart to CLASS_STARTERS (the starter ability). Reach and
 *  attack style live entirely on the weapon, so this is what makes a wizard open
 *  as a caster rather than a brawler; with an empty hand every class is melee.
 *  Base ids are `<material>_<archetype>` (see composeBases), tier-1 materials. */
export const CLASS_STARTER_WEAPON: Record<ClassId, string> = {
  fighter: 'crude_sword',
  rogue:   'crude_dagger',
  wizard:  'worn_staff',
};

export const SCALING_COEFFS: Record<string, number> = {
  S: 1.5, A: 1.0, B: 0.6, C: 0.4, D: 0.25, E: 0.15,
};

// ─── Mana / abilities (see docs/plan-abilities.md) ────────────────────────────
// Base mana pool, plus an intelligence slope so INT does double duty (spell
// power and sustain). Regen mirrors health regen: a flat amount on an interval,
// suppressed for a lockout window after spending or being hit in combat.
export const BASE_MANA = 30;
export const MANA_PER_INT = 3;
export const MANA_REGEN_INTERVAL_TICKS = 10;
export const MANA_REGEN_PER_TICK = 1;
export const MANA_COMBAT_LOCKOUT_TICKS = 30;

/** How often a modifier's tick_effect (dot/hot) fires while active. */
export const MODIFIER_TICK_INTERVAL_TICKS = 10;

/** The one ability each class is born knowing (rank 1, free). Seeded into a new
 *  character's knownAbilities. See docs/plan-class-abilities.md. */
export const CLASS_STARTERS: Record<ClassId, string> = {
  fighter: 'power_strike',
  rogue:   'backstab',
  wizard:  'firebolt',
};

/** Hotbar size. Slot 0 is the basic attack; the remaining slots hold learned
 *  abilities. Consumable/manual-assignment slots come later. */
export const HOTBAR_SLOTS = 10;

/** Stable ordering of a player's learned abilities into the hotbar's ability
 *  slots (everything past slot 0 / the basic attack): class starter first, then
 *  the rest alphabetically, capped to the available slots. Shared so client key
 *  bindings and any server-side checks agree. */
export function equippedAbilityIds(known: KnownAbilities, klass: ClassId): string[] {
  const starter = CLASS_STARTERS[klass];
  return Object.keys(known)
    .sort((a, b) => (a === starter ? -1 : b === starter ? 1 : a.localeCompare(b)))
    .slice(0, HOTBAR_SLOTS - 1);
}

/** Number of assignable ability slots (everything past slot 0 / basic attack). */
export const ABILITY_SLOTS = HOTBAR_SLOTS - 1;

/** Resolve the ability-slot layout (index 0 = slot 1 .. index 8 = slot 9). If a
 *  player has a stored `hotbar`, that wins (with ids they no longer know blanked
 *  to null); otherwise fall back to the derived layout. Always length
 *  ABILITY_SLOTS. Single source of truth for both client render/keybinds and
 *  server-side checks. */
export function resolveHotbar(
  known: KnownAbilities,
  klass: ClassId,
  stored?: (string | null)[] | null,
): (string | null)[] {
  const slots: (string | null)[] = new Array(ABILITY_SLOTS).fill(null);
  if (stored && stored.length) {
    for (let i = 0; i < ABILITY_SLOTS; i++) {
      const id = stored[i];
      slots[i] = id && known[id] ? id : null; // drop abilities no longer known
    }
    return slots;
  }
  equippedAbilityIds(known, klass).forEach((id, i) => { slots[i] = id; });
  return slots;
}

/** Drop a newly-learned ability into the first empty slot of a stored layout so
 *  it stays reachable without forcing manual assignment. No-op if already
 *  present or the bar is full. Mutates in place. */
export function equipInFirstEmpty(hotbar: (string | null)[], id: string): void {
  if (hotbar.includes(id)) return;
  const i = hotbar.indexOf(null);
  if (i >= 0) hotbar[i] = id;
}

/** Base mana pool for an actor with the given intelligence. */
export function baseMaxMana(intelligence: number): number {
  return BASE_MANA + Math.max(0, intelligence) * MANA_PER_INT;
}

// ─── Loot / item-level (see docs/plan-affix-brand-procgen.md) ─────────────────

/** Upper clamp on a rolled item-level. */
export const MAX_ILVL = 50;

/** Chance per drop that ilvl jumps well above mob level (rare godrolls). */
export const ILVL_JUMP_CHANCE = 0.01;
export const ILVL_JUMP_RANGE: [number, number] = [5, 12];
/** Normal per-drop ilvl variance around mob level. */
export const ILVL_VARIANCE: [number, number] = [-1, 2];

/** Chance a combat-role mob drops a generated equip item (on top of loot_table). */
export const GENERIC_DROP_CHANCE = 0.35;

/** Generic gold: every combat-role mob rolls level-scaled gold (no hand-authored
 *  currency entry needed). amount = rollRange(GOLD_BASE) + level*rollRange(GOLD_PER_LEVEL). */
export const GOLD_DROP_CHANCE = 0.5;
export const GOLD_BASE: [number, number] = [1, 5];
export const GOLD_PER_LEVEL: [number, number] = [1, 4];

/** Rarity magnitude multipliers — rarer items roll stronger affix values. */
export const RARITY_MAGNITUDE: Record<string, number> = {
  common: 1.0, uncommon: 1.1, rare: 1.25, legendary: 1.5,
};
/** Per-ilvl slope added to the magnitude multiplier. */
export const ILVL_MAGNITUDE_SLOPE = 0.015;

/** Rolled stat keys that add flat damage to a swing (brands). Combat reads these.
 *  Physical (untyped, brand undefined) is implicit and not listed — armor is its
 *  only mitigation. DCSS-aligned array: elemental opposites (fire/cold,
 *  electricity/acid) plus poison and the negative/positive axis. */
export const BRAND_KEYS: readonly string[] = [
  'fire_damage', 'cold_damage', 'poison_damage', 'electricity_damage',
  'acid_damage', 'negative_damage', 'positive_damage',
] as const;

/** Per-brand player gear resistance stat keys (e.g. `fire_resistance`), rolled
 *  as percentage points and summed across equipment (see resistanceMult in
 *  combat.ts). Derived from BRAND_KEYS so the two can't drift apart. */
export const RESISTANCE_KEYS: readonly string[] = BRAND_KEYS.map((k) => k.replace('_damage', '_resistance'));

// ─── Sale pricing (see server/game/items/pricing.ts) ─────────────────────────
// A merchant pays `ItemBase.sell_value` for a plain example of a base, plus a
// cut of whatever the item's *roll* put on top of it. Without that second term
// a legendary gold ring fetched exactly what a common one did — jewelry has no
// base stats at all, so its entire worth is its roll — and there was no gold
// source that scaled with the loot curve to tune ability ranks and shop prices
// against.
//
// Gold worth of one point of a rolled stat, before AFFIX_SELL_RATE. These are
// relative-worth judgements (what a point of strength is worth against a point
// of armor), NOT the gold faucet's size — turn AFFIX_SELL_RATE for that.
export const STAT_SELL_WORTH: Record<string, number> = {
  // Flat weapon/armor power folded into the base's damage/defense range.
  damage_bonus: 6,
  defense_bonus: 5,
  // Attack speed is a multiplier on every swing, and the affix deltas are
  // small (0.1–0.3), so a point of it is worth two orders more than flat damage.
  speed: 120,
  // Attributes scale damage, dodge, mana and HP at once, and are the whole
  // reason to wear jewelry — the scarcest thing an affix grants.
  strength: 12, dexterity: 12, intelligence: 12, constitution: 12,
  armor: 5,
  // Elemental brands: flat damage that also types the whole swing (weapon-imbue).
  fire_damage: 7, cold_damage: 7, poison_damage: 7, electricity_damage: 7,
  acid_damage: 7, negative_damage: 7, positive_damage: 7,
  // Resistances roll in percentage points (5–16), so worth-per-point is low.
  fire_resistance: 1.5, cold_resistance: 1.5, poison_resistance: 1.5,
  electricity_resistance: 1.5, acid_resistance: 1.5,
  negative_resistance: 1.5, positive_resistance: 1.5,
  max_health: 1, max_mana: 1.2,
};

// Worth of a rolled stat with no STAT_SELL_WORTH entry. A deliberate non-zero:
// the pipeline can mint affixes granting stats this table hasn't been taught,
// and they should price as *something* rather than silently as free.
export const DEFAULT_STAT_SELL_WORTH = 4;

// The fraction of a roll's assessed worth a merchant actually pays. This is the
// gold faucet's main dial — raise it and loot funds ability ranks faster.
export const AFFIX_SELL_RATE = 0.5;

// ─── Featured merchant stock (see server/game/items/featured_stock.ts) ───────
// A merchant's `featured_stock` shelf holds individually rolled high-end items,
// one copy each, re-rolled on a fixed wall-clock cadence. The rotation is what
// makes them worth coming back for; the price is what makes them a goal.

// How often the shelf re-rolls. Windows are aligned to the epoch, not to server
// start, so every merchant everywhere turns over at the same moment and the
// countdown a player sees is the real one.
export const FEATURED_STOCK_PERIOD_MS = 60 * 60 * 1000; // 1 hour

// Featured rows are always rare or better — this is the shelf you save for, so
// a common roll would just be a worse version of the staple stock beside it.
// Everything that isn't legendary is rare.
export const FEATURED_LEGENDARY_CHANCE = 0.35;

// Asking price as a multiple of what a merchant would PAY for the same item
// (sellPriceOf). The staple stock runs ~2-3x its sell_value; featured stock is
// deliberately steeper — a legendary here should cost more than an ability rank
// and take real saving, which is the whole point of a shelf that rotates away.
export const FEATURED_STOCK_MARKUP = 8;

// A featured base must be made of a material whose min_ilvl is at least this
// fraction of the roll's item level. pickDropBase treats every base under the
// ilvl as eligible (weighted toward higher tiers, but a crude dagger can still
// surface), and a crude dagger carrying legendary affixes is not what a shelf
// like this is for.
export const FEATURED_BASE_TIER_FLOOR = 0.6;

// Gear-based resistance is emergent (summed percentage points across every
// equipped slot) and could otherwise stack toward true immunity; this floor
// caps it at 90% damage reduction. Hand-authored mob `resistances` (a direct
// multiplier, not a summed percentage) are NOT capped by this — a mob template
// can still declare a real 0 (immune) on purpose.
export const PLAYER_RESIST_CAP_PCT = 90;

// Tiles that block movement. Shared so client-side pathfinding agrees with
// server's canMoveTo.
export const BLOCKING_TILES: ReadonlySet<string> = new Set(['wall', 'water', 'void', 'tree']);

// Zone where new players spawn, and the origin the content pipeline expands
// outward from (sticky loop). Falls back to the first loaded zone if absent —
// see startingZone() in server/index.ts.
export const PREFERRED_STARTING_ZONE = 'zone_0_0';

// ─── Mob level scaling ───────────────────────────────────────────────────────

interface RoleConfig {
  hp:  number;   // multiplier applied to the constitution-derived max HP
  dmg: number;   // multiplier on base dmg (see MOB_DMG_LO/HI)
  xp:  number;   // multiplier on base XP  (base = level); 0 = no default XP
}

// ─── Mob HP scaling (see docs/plan-combat-retune.md) ──────────────────────────
// Mobs are meant to out-HP the player, sharply so when they out-level them: a
// mob three or more levels above the player should be *well* above the player's
// ~110-150 HP even in the squishiest roles. HP therefore scales strongly with
// the mob's own level (see MOB_HP_* below), and the role multipliers are
// compressed on the low end so pest/support still clear that bar. Because one
// mob is fought by players of every level, HP can only key off the *mob's*
// level — so "same-level fight" and "+3-level-gap fight" read the same curve at
// different points. That is intentional: unarmed combat is only expected to win
// against mobs a few levels *below* the player (see UNARMED_DMG_PER_LEVEL in
// combat.ts); weapons and abilities carry parity fights and up. Tune MOB_HP_*
// and these multipliers against tools/combat-sim.ts, not by feel.
export const MOB_ROLES: Record<MobRole, RoleConfig> = {
  // High HP, medium damage — closes to melee and is meant to be a real threat
  // if ignored, not a pure sponge. Absorbs the old brute's "hits harder than
  // baseline" niche on top of the old tank's tankiness.
  tank:       { hp: 1.6, dmg: 0.7, xp: 3 },
  // Weak individually — swarms in numbers — but even a pest should out-HP the
  // player when it out-levels them, so its multiplier is well off the floor.
  pest:       { hp: 0.85, dmg: 0.6, xp: 1 },
  // The stock all-around melee mob (was `skirmisher`'s tuning).
  soldier:    { hp: 1.0, dmg: 1.0, xp: 3 },
  // Lower hp, keeps its distance (archer/caster) — damage is comparable to
  // soldier but delivered from range instead of melee.
  ranged:     { hp: 0.8, dmg: 0.9, xp: 3 },
  // Support buffs/heals rather than fighting, but is not a paper target — it
  // still out-HPs a lower-level player, matching the "well above" bar.
  support:    { hp: 0.75, dmg: 0.5, xp: 3 },
  // NPCs deal no damage normally (they never initiate combat); this value only
  // manifests when a player attacks one and it defends itself.
  npc:        { hp: 1.6, dmg: 0.8, xp: 0 },
  passive:    { hp: 0.75, dmg: 0.0, xp: 1 },
};

// Mob max HP = round((MOB_HP_BASE + level × MOB_HP_PER_LEVEL) × role.hp).
// Keyed off the mob's level, NOT constitution: the old con-driven term grew
// ~0.2-0.8 HP/level, so a L1 and L10 pest were both ~20 HP and the player/mob
// HP gap *inverted* as levels climbed. This puts a L5 soldier near ~150 and a
// L10 soldier near ~270 so higher-level mobs are real walls. Constitution still
// drives mob defense (see totalDefense) but no longer HP.
const MOB_HP_BASE = 30;
const MOB_HP_PER_LEVEL = 24;

// Mob base damage range per level, before role.dmg. The old [×2, ×4] slope
// (avg level×3) outpaced the player's nearly-flat unarmed damage, so parity
// collapsed past ~L5. A gentler slope keeps same-level fights winnable 1-10.
const MOB_DMG_LO = 1.3;
const MOB_DMG_HI = 2.3;

// Per-role base stats and per-level growth rates.
// These values are chosen so that a level-5 mob's HP stays close to the
// previous flat formula (20 × level × role.hp) while giving meaningful stats.
interface RoleStatConfig {
  str_base: number; str_lvl: number;
  dex_base: number; dex_lvl: number;
  // int_lvl is 0 for non-casters (their int_base stays flat, as before);
  // ranged/support scale it so spell-effect scaling doesn't flatten out
  // relative to player power as they level.
  int_base: number; int_lvl: number;
  con_base: number; con_lvl: number;
}

const MOB_ROLE_STATS: Record<MobRole, RoleStatConfig> = {
  tank:    { str_base: 5, str_lvl: 0.7, dex_base: 2, dex_lvl: 0.2, int_base: 2, int_lvl: 0,   con_base: 4, con_lvl: 0.8 },
  pest:    { str_base: 2, str_lvl: 0.3, dex_base: 5, dex_lvl: 0.8, int_base: 2, int_lvl: 0,   con_base: 2, con_lvl: 0.2 },
  soldier: { str_base: 4, str_lvl: 0.8, dex_base: 5, dex_lvl: 0.8, int_base: 2, int_lvl: 0,   con_base: 3, con_lvl: 0.4 },
  ranged:  { str_base: 2, str_lvl: 0.3, dex_base: 6, dex_lvl: 0.9, int_base: 4, int_lvl: 0.5, con_base: 2, con_lvl: 0.3 },
  support: { str_base: 2, str_lvl: 0.2, dex_base: 3, dex_lvl: 0.4, int_base: 6, int_lvl: 1.0, con_base: 2, con_lvl: 0.3 },
  npc:     { str_base: 2, str_lvl: 0.0, dex_base: 2, dex_lvl: 0.0, int_base: 5, int_lvl: 0,   con_base: 5, con_lvl: 0.8 },
  passive: { str_base: 2, str_lvl: 0.3, dex_base: 4, dex_lvl: 0.5, int_base: 2, int_lvl: 0,   con_base: 2, con_lvl: 0.4 },
};

export function mobStatBlock(level: number, role: MobRole): { strength: number; dexterity: number; intelligence: number; constitution: number } {
  const r = MOB_ROLE_STATS[role];
  return {
    strength:     Math.max(1, Math.round(r.str_base + level * r.str_lvl)),
    dexterity:    Math.max(1, Math.round(r.dex_base + level * r.dex_lvl)),
    intelligence: Math.max(1, Math.round(r.int_base + level * r.int_lvl)),
    constitution: Math.max(1, Math.round(r.con_base + level * r.con_lvl)),
  };
}

export function mobStats(level: number, role: MobRole): { hp: number; damage: [number, number]; xp: number; stats: ReturnType<typeof mobStatBlock> } {
  const r = MOB_ROLES[role];
  const stats = mobStatBlock(level, role);
  const hp = Math.max(1, Math.round((MOB_HP_BASE + level * MOB_HP_PER_LEVEL) * r.hp));
  const damage: [number, number] = r.dmg === 0
    ? [0, 0]
    : [Math.max(1, Math.round(level * MOB_DMG_LO * r.dmg)), Math.max(1, Math.round(level * MOB_DMG_HI * r.dmg))];
  const xp = Math.round(level * r.xp);
  return { hp, damage, xp, stats };
}

// ─── Level-based aggro ────────────────────────────────────────────────────────
// How a mob reacts to a player scales with their relative level. At parity or
// when the mob is stronger, it aggros at its full aggro_range. For each level
// the player is *above* the mob, effective aggro range shrinks by this many
// tiles, so weaker mobs notice you later (or not at all). Once the player is
// AGGRO_AVERSION_GAP+ levels above, the mob stops aggroing and instead flees
// when the player comes within its aggro_range.
export const AGGRO_DROPOFF_PER_LEVEL = 1;
export const AGGRO_AVERSION_GAP = 5;

// ─── Threat ───────────────────────────────────────────────────────────────────
// A mob picks its target off an accumulated threat table (see ai.ts), not off
// proximity: damage dealt to it, and healing done to anyone already on its
// table, are what hold its attention.
//
// Damage credits threat 1:1. Healing credits the healer this fraction of the
// amount healed — below 1 so a healer topping off a tank doesn't out-threat the
// tank's own damage, but high enough that a healer left unguarded pulls.
export const HEAL_THREAT_FACTOR = 0.5;
// A challenger has to beat the current target's threat by this factor to pull
// the mob off it. Without the margin two similar attackers make a mob flip
// targets every tick and it never actually swings at either.
export const THREAT_SWITCH_MULT = 1.15;
// A taunt (the `antagonize` CC) forces the target outright, but it also lifts
// its caster to this multiple of the table's current top — so when the CC
// expires the mob doesn't snap straight back to whoever it was on.
export const TAUNT_THREAT_MULT = 1.1;
// Threat a mob puts on a player it aggros on sight (or is alerted to by a
// packmate). Just enough to seat them on an otherwise empty table; the first
// real hit dwarfs it.
export const AGGRO_SEED_THREAT = 1;

const XP_TABLE = [
     50,   131,   253,   417,   648,
    825,   957,  1173,  1455,  1641,
   1739,  1855,  1978,  2109,  2249,
   2398,  2557,  2727,  2907,  3100,
   3306,  3525,  3759,  4008,  4274,
   4557,  4859,  5182,  5525,  5892,
   6282,  6699,  7143,  7617,  8122,
   8660,  9235,  9847, 10500, 16692,
  17772, 18897, 20066, 21281, 22543,
  23853, 25999, 27933, 30815, 38806,
];

export function xpForNext(level: number): number {
  return XP_TABLE[Math.min(level, XP_TABLE.length) - 1];
}

// Every `slot` an item base may declare. Wider than EQUIPMENT_SLOTS: the tail
// entries are inventory-only kinds (a pelt, a quest token, a coin) that no
// equip path accepts. Nothing reads a base's slot against a list at runtime —
// resolveEquipSlot just returns null for anything it doesn't know, which is why
// a typo'd slot produces an inert item rather than an error. This is the
// vocabulary the item lint (forge/lib/lint-item.ts) checks against.
export const ITEM_BASE_SLOTS: readonly string[] = [
  'mainhand', 'helmet', 'chest', 'gloves', 'leggings', 'boots', 'ring', 'amulet',
  'consumable', 'quest', 'currency', 'crafting', 'misc',
] as const;

// The weapon-family words a mainhand base is expected to carry in `tags`.
// Affix `applies_to` lists match on these, so a weapon tagged only
// [weapon, melee] is eligible for no family-specific affix at all.
export const WEAPON_FAMILY_TAGS: readonly string[] = ['blade', 'blunt', 'staff', 'bow', 'polearm'] as const;
