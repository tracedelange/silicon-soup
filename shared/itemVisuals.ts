// How an equipped item turns into pixels: which overlay art to draw, and what
// colors to paint it with. Pure and browser-safe so the client compositor and
// the sprite-lab workbench (tools/sprite-lab) resolve gear identically.
//
// The load-bearing idea (docs/plan-player-sprites.md): 14 archetypes x ~5
// materials x 4 rarities x 7 brands never converges as per-item art, so
// **shape comes from art, color comes from code**. One grayscale overlay per
// archetype gets recolored through the material's ramp; rarity and brand are
// additive passes on top. Adding a material or a brand costs a table row here,
// not a drawing.

import { BRAND_KEYS } from './constants.ts';
import type { Equipment, ItemEntity } from './types.ts';

/** A material's 5-stop shade ramp, darkest first. Overlay art is authored in
 *  five key grays (0/64/128/192/255); each maps to the stop at its index. */
export type Ramp = readonly [string, string, string, string, string];

/** Armor silhouette class — picks between the light/heavy overlay shapes.
 *  Mirrors `armor_tag` in world/entities/items/materials.yaml; the coverage
 *  test in itemVisuals.test.ts is what keeps the two from drifting. */
export type ArmorWeight = 'light' | 'heavy';

interface MaterialVisual {
  ramp: Ramp;
  /** Absent for materials that compose no armor (wood, precious). */
  weight?: ArmorWeight;
}

export const MATERIAL_VISUALS: Record<string, MaterialVisual> = {
  // ── metal: cold grays climbing to blue-steel, then runed violet ──
  crude:    { weight: 'heavy', ramp: ['#24201c', '#3b342c', '#574c40', '#756758', '#948573'] },
  iron:     { weight: 'heavy', ramp: ['#1c1f22', '#333940', '#4e5761', '#6f7a86', '#97a2ad'] },
  steel:    { weight: 'heavy', ramp: ['#22262b', '#414a55', '#66727f', '#93a0ad', '#c8d3dd'] },
  tempered: { weight: 'heavy', ramp: ['#171d2b', '#2a3752', '#465a80', '#6b83ad', '#9fb5d8'] },
  runed:    { weight: 'heavy', ramp: ['#21172e', '#3b2750', '#5c3f7d', '#8461ab', '#b592d4'] },
  // ── leather: warm browns ──
  ragged:   { weight: 'light', ramp: ['#241a12', '#3a2a1c', '#513c29', '#6b5238', '#8a6d4d'] },
  leather:  { weight: 'light', ramp: ['#2a1c10', '#46301b', '#644729', '#85623c', '#a67f55'] },
  studded:  { weight: 'light', ramp: ['#241a14', '#3d2c20', '#5a4331', '#7b5f47', '#9c8062'] },
  hardened: { weight: 'light', ramp: ['#1e1710', '#362819', '#523e26', '#715837', '#94784f'] },
  // ── cloth: desaturated, silk picks up a violet sheen ──
  tattered: { weight: 'light', ramp: ['#262320', '#3d3934', '#565049', '#706960', '#8b8378'] },
  wool:     { weight: 'light', ramp: ['#2b2622', '#46403a', '#635b52', '#82796e', '#a2988c'] },
  silk:     { weight: 'light', ramp: ['#2a2434', '#473c56', '#68597b', '#8d7ba3', '#b6a4cb'] },
  // ── wood: staves and hafts ──
  worn:     { ramp: ['#241c14', '#3a2e21', '#52412f', '#6d573f', '#8b7253'] },
  oak:      { ramp: ['#2a2015', '#453522', '#634d33', '#836a48', '#a68a63'] },
  yew:      { ramp: ['#221a1a', '#3b2c2a', '#573f3c', '#765853', '#97746e'] },
  // ── precious: rings and amulets (no world overlay yet, but icons want them) ──
  copper:   { ramp: ['#2c1a10', '#52301b', '#7d4a28', '#a86b3c', '#cf9660'] },
  bronze:   { ramp: ['#2b2314', '#4d3f22', '#746033', '#9d8548', '#c6ad6a'] },
  silver:   { ramp: ['#23262a', '#414850', '#6a7480', '#99a4b0', '#ccd6e0'] },
  gold:     { ramp: ['#2e2410', '#57431a', '#85682a', '#b8933e', '#e8c565'] },
  jeweled:  { ramp: ['#24162c', '#452a52', '#6c447d', '#9767a8', '#c295cd'] },
};

const FALLBACK_RAMP: Ramp = MATERIAL_VISUALS['iron']!.ramp;

/** Rarity name -> display color. The sprite's outline glow and the inventory
 *  slot text read from this same table so a legendary looks legendary in both. */
export const RARITY_COLORS: Record<string, string> = {
  common: '#cccccc',
  uncommon: '#5acc5a',
  rare: '#5a9aff',
  legendary: '#ff8c2a',
};

export function rarityColor(rarity?: string): string {
  return RARITY_COLORS[rarity ?? 'common'] ?? RARITY_COLORS['common']!;
}

/** Elemental brand -> accent color, keyed by the BRAND_KEYS stat names that
 *  land in `rolled.weapon_brand`. */
export const BRAND_COLORS: Record<string, string> = {
  fire_damage: '#ff6b2a',
  cold_damage: '#6fd8ff',
  poison_damage: '#7ad14a',
  electricity_damage: '#ffe14a',
  acid_damage: '#b6e83a',
  negative_damage: '#9a5fd0',
  positive_damage: '#ffe9b0',
};

/** Base ids are composed as `${material.id}_${archetype.id}` (see
 *  server/game/items/bases.ts) and neither half contains an underscore, so the
 *  first separator splits them. Returns null for anything else — hand-authored
 *  bases in world/entities/items/bases/ don't follow the convention. */
export function parseBaseId(base: string | undefined): { material: string; archetype: string } | null {
  if (!base) return null;
  const i = base.indexOf('_');
  if (i <= 0 || i === base.length - 1) return null;
  return { material: base.slice(0, i), archetype: base.slice(i + 1) };
}

export function rampFor(material: string | undefined): Ramp {
  return (material && MATERIAL_VISUALS[material]?.ramp) || FALLBACK_RAMP;
}

export function weightFor(material: string | undefined): ArmorWeight {
  return (material && MATERIAL_VISUALS[material]?.weight) || 'light';
}

/** One overlay to composite over the body. `layer` is the basename of the
 *  grayscale PNG in client/public/gear/. */
export interface GearVisual {
  layer: string;
  ramp: Ramp;
  /** Rarity outline color; absent for common (common gets no glow). */
  glow?: string;
  /** Elemental accent blended into the layer's highlights. */
  tint?: string;
}

/** Only these slots get a world overlay. Gloves, boots, leggings, rings and
 *  amulets are a handful of pixels at on-screen scale — they read as noise, so
 *  they stay inventory-only. Order is bottom-to-top draw order. */
const OVERLAY_SLOTS = ['chest', 'helmet', 'mainhand'] as const;

/** Archetypes worn rather than swung. Their overlays are silhouettes per weight
 *  class, not shapes per archetype: a Steel Chest and a Wool Chest differ by
 *  ramp and weight, nothing else. */
const ARMOR_ARCHETYPES = new Set(['helmet', 'chest', 'gloves', 'leggings', 'boots']);

/** The least an item has to be for art to be resolved from it. Satisfied by an
 *  InventoryStack, a LootSlot, and a merchant's plain `{ base }` stock line —
 *  all three want the same icon, and none should have to pretend to be another. */
export interface VisualSource {
  base?: string;
  item?: ItemEntity | null;
}

/**
 * Resolve one item to the art that represents it — used both for the layer a
 * worn piece composites onto the body, and for the icon the same item shows in
 * a bag, a merchant list or a corpse. It's the same drawing either way, which
 * is why an inventory icon needs no assets of its own.
 *
 * Derives armor-vs-weapon from the archetype rather than the equip slot, so it
 * works for an item sitting in a bag that isn't equipped anywhere.
 */
export function itemVisual(stack: VisualSource | null | undefined): GearVisual | null {
  const parsed = parseBaseId(stack?.base);
  // A known material is the signal that this id is a composed base and not a
  // hand-authored one from world/entities/items/bases/ that merely happens to
  // contain an underscore (`health_potion`, `bandit_ledger`). Hand-authored
  // *weapons* that do start with a material (`crude_knife`) fall through on
  // purpose: they render the moment someone draws `knife.png`, and skip until.
  if (!parsed || !MATERIAL_VISUALS[parsed.material]) return null;
  const eq = stack?.item?.components?.equipment;
  const rarity = eq?.rarity as string | undefined;
  const brand = eq?.rolled?.weapon_brand as string | undefined;
  const armor = ARMOR_ARCHETYPES.has(parsed.archetype);

  const v: GearVisual = {
    layer: armor ? `${parsed.archetype}_${weightFor(parsed.material)}` : parsed.archetype,
    ramp: rampFor(parsed.material),
  };
  if (rarity && rarity !== 'common') v.glow = rarityColor(rarity);
  // A brand only reads on the thing that swings; branded armor doesn't exist.
  if (!armor && brand && BRAND_COLORS[brand]) v.tint = BRAND_COLORS[brand];
  return v;
}

/** Resolve a player's equipment into ordered overlay layers. Slots with no
 *  item, or whose base doesn't parse, are simply skipped — a missing overlay
 *  degrades to "no layer", never to a broken sprite. */
export function gearVisuals(equipment: Equipment | undefined): GearVisual[] {
  if (!equipment) return [];
  const out: GearVisual[] = [];
  for (const slot of OVERLAY_SLOTS) {
    const v = itemVisual(equipment[slot] ?? null);
    if (v) out.push(v);
  }
  return out;
}

/** Stable identity for a resolved look — the cache key for a composited
 *  sprite. Recomputed every snapshot, so it has to be cheap to build and
 *  compare; it is just the fields that change what gets drawn. */
export function visualSignature(klass: string, color: string, visuals: readonly GearVisual[]): string {
  let key = `${klass}|${color}`;
  for (const v of visuals) key += `|${v.layer}:${v.ramp[2]}:${v.glow ?? ''}:${v.tint ?? ''}`;
  return key;
}

/** Brand keys that have no color entry — a startup-time drift check for
 *  callers that want to fail loudly rather than silently drop the accent. */
export function unmappedBrands(): string[] {
  return BRAND_KEYS.filter((k) => !BRAND_COLORS[k]);
}
