// The semantic gate for item bases — the item-side counterpart to
// lint-ability.ts. Item bases have no zod schema at all: loadWorld does a bare
// `readYaml<ItemBase>(file)` and drops the result straight into the registry
// (loader.ts:293-296), so nothing checks shape, vocabulary, or cross-references
// the way mobs get role/ability/biome checks. Everything below is therefore a
// load-time failure that currently isn't one.
//
// What makes a malformed base expensive here is that almost every read site
// degrades silently instead of throwing:
//
//   - a weapon with no `scaling` takes damageBonus's *unarmed* branch
//     (combat.ts:88-99), so a 22-34 damage blade scales like a bare fist
//   - a scaling letter outside SCALING_COEFFS is skipped by scaledBonus
//     (combat.ts:39-47) and contributes nothing
//   - a base_speed of 0 fails weaponSpeed's `sp > 0` guard (stats.ts:150-157)
//     and silently becomes 1.0
//   - an unknown slot returns null from resolveEquipSlot (inventory.ts:42) and
//     the item simply can't be equipped, with no error anywhere
//
// None of those surface as a crash, a log line, or a visibly wrong number — the
// item just quietly underperforms. That is the whole reason for this file.
//
// Convention mirrors lint-ability.ts: a flat string[] of problems, entries
// prefixed `warn:` are advisory, everything else is blocking. Every base in
// world/entities/items/bases/ passes clean at the blocking level — that is the
// regression fixture (see tools/lint-items.ts).

import { ITEM_BASE_SLOTS, SCALING_COEFFS, WEAPON_FAMILY_TAGS, ALLOCATABLE_STATS } from '../../shared/constants.ts';
import type { ItemBase, Range } from '../../shared/types.ts';

// Slots whose bases are equipped and so carry a combat profile.
const WEAPON_SLOT = 'mainhand';
const ARMOR_SLOTS = ['helmet', 'chest', 'gloves', 'leggings', 'boots'];
// A merchant refuses these outright (UNSELLABLE_SLOTS in pricing.ts), so a
// missing sell_value on one is correct rather than an omission.
const UNSELLABLE_SLOTS = ['quest', 'currency'];

// Swing-rate multipliers outside this band aren't wrong so much as extreme:
// attackCooldown divides by the multiplier, so 0.1 is a ten-times-slower swing
// and 3.0 a three-times-faster one. Real weapons sit between the maul (0.65)
// and the dagger (1.5); anything well outside that reads as a debug value.
const SANE_SPEED = [0.5, 2.0] as const;

// Every field ItemBase declares (shared/types.ts). Kept as a list rather than
// derived, since a TS interface leaves no runtime trace — if you add a field
// there, add it here.
const ITEM_BASE_KEYS: readonly string[] = [
  'id', 'name', 'slot', 'sprite', 'tags', 'base_damage', 'base_defense', 'base_speed',
  'attack_ability', 'value', 'sell_value', 'use_effect', 'scaling', 'min_ilvl',
];

export interface LintItemOpts {
  /** Known ability ids, for checking `attack_ability`. Omit to skip that check
   *  (the caller may not have loaded world/abilities/). */
  abilities?: Set<string>;
}

function rangeProblems(label: string, r: Range): string[] {
  const out: string[] = [];
  if (!Array.isArray(r) || r.length !== 2 || typeof r[0] !== 'number' || typeof r[1] !== 'number') {
    return [`${label} must be a two-number range, got ${JSON.stringify(r)}`];
  }
  const [lo, hi] = r;
  if (lo > hi) out.push(`${label} [${lo}, ${hi}] is inverted (lo > hi)`);
  if (lo < 0 || hi < 0) out.push(`${label} [${lo}, ${hi}] is negative`);
  return out;
}

/** Semantic problems for one item base. `warn:`-prefixed entries are advisory;
 *  any other entry is blocking. */
export function lintItemBase(base: ItemBase, opts: LintItemOpts = {}): string[] {
  const out: string[] = [];

  // ── Identity and vocabulary ────────────────────────────────────────────────
  if (!base.id) out.push('missing `id`');
  if (!base.name) out.push('missing `name`');
  if (!base.slot) out.push('missing `slot`');
  else if (!ITEM_BASE_SLOTS.includes(base.slot)) {
    out.push(`warn: slot '${base.slot}' is not a known slot — no equip path accepts it, so the item is inert inventory junk (known: ${ITEM_BASE_SLOTS.join(', ')})`);
  }
  // A key outside ItemBase is dropped on the floor by readYaml's cast — the
  // author (usually a model) wrote intent the engine will never read. `value`
  // and `sell_value` are the two easiest to confuse, so name the near-misses.
  for (const key of Object.keys(base)) {
    if (!ITEM_BASE_KEYS.includes(key)) out.push(`warn: unknown field '${key}' — not part of ItemBase, silently ignored at load`);
  }
  // Affix eligibility (`applies_to`), merchant shelves (AFFINITY_TAGS) and the
  // weapon-family checks below all do tags.includes — an absent array makes
  // every one of those reads throw or silently miss.
  if (!Array.isArray(base.tags)) out.push('`tags` must be an array (affix applies_to and merchant affinity both read it)');

  const isWeapon = base.slot === WEAPON_SLOT;
  const isArmor = ARMOR_SLOTS.includes(base.slot);

  // ── Stat ranges ────────────────────────────────────────────────────────────
  if (base.base_damage != null) out.push(...rangeProblems('base_damage', base.base_damage));
  if (base.base_defense != null) out.push(...rangeProblems('base_defense', base.base_defense));

  // ── Profile lands on a slot that reads it ──────────────────────────────────
  // baseDamageRange only ever consults the mainhand (combat.ts:73-84) and
  // totalDefense only sums ARMOR_SLOTS (combat.ts:113-127), so a profile on the
  // wrong slot is authored intent that no read site will ever see.
  if (base.base_damage != null && !isWeapon) {
    out.push(`warn: base_damage on slot '${base.slot}' is never read — only the mainhand contributes attack damage`);
  }
  if (base.base_defense != null && !isArmor) {
    out.push(`warn: base_defense on slot '${base.slot}' is never read — only ${ARMOR_SLOTS.join('/')} contribute defense`);
  }
  if (isArmor && base.base_defense == null) {
    out.push(`warn: armor base has no base_defense — it equips but adds nothing`);
  }

  // ── Scaling ────────────────────────────────────────────────────────────────
  for (const [stat, letter] of Object.entries(base.scaling ?? {})) {
    if (!(ALLOCATABLE_STATS as readonly string[]).includes(stat)) {
      out.push(`scaling key '${stat}' is not a stat — effectiveStat reads 0 for it (valid: ${ALLOCATABLE_STATS.join(', ')})`);
    }
    // '-' is the authored way to say "this weapon ignores the stat"; every other
    // letter must be in the coefficient table or scaledBonus skips it, which
    // looks identical to '-' but wasn't what the author meant.
    if (letter !== '-' && !SCALING_COEFFS[letter as string]) {
      out.push(`scaling.${stat} letter '${letter}' is not in SCALING_COEFFS — it contributes nothing (valid: ${Object.keys(SCALING_COEFFS).join(', ')}, or '-')`);
    }
  }

  // ── Weapon completeness (the mirror_shard_weapon class of bug) ─────────────
  if (isWeapon) {
    if (base.base_damage == null) {
      out.push(`warn: weapon has no base_damage — it falls back to the wielder's bare-fist range`);
    }
    if (base.scaling == null) {
      out.push(`warn: weapon has no scaling — damageBonus takes the unarmed branch, so the wielder's stats scale it exactly like bare fists`);
    }
    if (base.base_speed == null) {
      out.push(`warn: weapon has no base_speed — it silently swings at 1.0 regardless of its weight`);
    }
    if (Array.isArray(base.tags) && !base.tags.some((t) => WEAPON_FAMILY_TAGS.includes(t))) {
      out.push(`warn: weapon has no family tag — it matches no family-specific affix (expected one of: ${WEAPON_FAMILY_TAGS.join(', ')})`);
    }
  }

  if (base.base_speed != null) {
    if (!(base.base_speed > 0)) {
      out.push(`base_speed ${base.base_speed} must be > 0 — weaponSpeed rejects it and silently substitutes 1.0`);
    } else if (base.base_speed < SANE_SPEED[0] || base.base_speed > SANE_SPEED[1]) {
      out.push(`warn: base_speed ${base.base_speed} is outside the ${SANE_SPEED[0]}–${SANE_SPEED[1]} band every real weapon sits in — debug value?`);
    }
  }

  // ── Cross-references ───────────────────────────────────────────────────────
  // attackAbilityFor falls through to unarmed_strike when the id doesn't
  // resolve, so a typo turns a staff back into a punch.
  if (base.attack_ability && opts.abilities && !opts.abilities.has(base.attack_ability)) {
    out.push(`unknown attack_ability '${base.attack_ability}' — define it in world/abilities/`);
  }

  // ── Economy ────────────────────────────────────────────────────────────────
  // sellPriceOf starts from sell_value; without one the item is worth only its
  // rolled budget, and a plain unrolled copy sells for nothing.
  if (base.sell_value == null && base.slot && !UNSELLABLE_SLOTS.includes(base.slot)) {
    out.push(`warn: no sell_value — a plain copy of this base sells for 0`);
  }

  return out;
}

/** Lint raw parsed YAML. Item bases have no schema to parse through, so shape
 *  failures come back as blocking problems rather than a thrown error. */
export function lintItemBaseRaw(raw: unknown, opts: LintItemOpts = {}): string[] {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`not a YAML mapping (got ${Array.isArray(raw) ? 'a list' : typeof raw})`];
  }
  return lintItemBase(raw as ItemBase, opts);
}
