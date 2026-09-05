import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { BRAND_KEYS } from './constants.ts';
import {
  BRAND_COLORS, MATERIAL_VISUALS, gearVisuals, parseBaseId, rampFor,
  unmappedBrands, visualSignature, weightFor,
} from './itemVisuals.ts';
import type { Equipment, InventoryStack } from './types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface MaterialRow { id: string; class: string; armor_tag?: string }
const materials = (yaml.load(
  readFileSync(join(ROOT, 'world/entities/items/materials.yaml'), 'utf8'),
) as { materials: MaterialRow[] }).materials;

interface ArchetypeRow { id: string; slot: string; material_classes: string[] }
const archetypes = (yaml.load(
  readFileSync(join(ROOT, 'world/entities/items/archetypes.yaml'), 'utf8'),
) as { archetypes: ArchetypeRow[] }).archetypes;

const HEX = /^#[0-9a-f]{6}$/;

// MATERIAL_VISUALS restates the material registry, so the registry is what
// grades it: a new material in the YAML must fail here until it has a ramp.
describe('material visual coverage', () => {
  it('gives every material in materials.yaml a ramp', () => {
    const missing = materials.map((m) => m.id).filter((id) => !MATERIAL_VISUALS[id]);
    expect(missing).toEqual([]);
  });

  it('has no ramps for materials that no longer exist', () => {
    const known = new Set(materials.map((m) => m.id));
    expect(Object.keys(MATERIAL_VISUALS).filter((id) => !known.has(id))).toEqual([]);
  });

  it('agrees with each material armor_tag on silhouette weight', () => {
    for (const m of materials) {
      if (!m.armor_tag) continue;
      expect(weightFor(m.id), m.id).toBe(m.armor_tag);
    }
  });

  it('ramps are five hex stops that get lighter', () => {
    for (const [id, v] of Object.entries(MATERIAL_VISUALS)) {
      expect(v.ramp, id).toHaveLength(5);
      const lum = v.ramp.map((hex) => {
        expect(hex, id).toMatch(HEX);
        const n = parseInt(hex.slice(1), 16);
        return ((n >> 16) & 0xff) + ((n >> 8) & 0xff) + (n & 0xff);
      });
      for (let i = 1; i < lum.length; i++) expect(lum[i], `${id} stop ${i}`).toBeGreaterThan(lum[i - 1]!);
    }
  });
});

describe('brand accents', () => {
  it('colors every brand in BRAND_KEYS', () => {
    expect(unmappedBrands()).toEqual([]);
  });

  it('has no colors for brands that no longer exist', () => {
    expect(Object.keys(BRAND_COLORS).filter((k) => !BRAND_KEYS.includes(k))).toEqual([]);
  });
});

describe('parseBaseId', () => {
  // Composed base ids are `${material}_${archetype}` (server/game/items/bases.ts).
  it('splits every base the material x archetype cross-product can compose', () => {
    const byClass = new Map(materials.map((m) => [m.id, m.class]));
    let checked = 0;
    for (const arch of archetypes) {
      for (const mat of materials) {
        if (!arch.material_classes.includes(byClass.get(mat.id)!)) continue;
        expect(parseBaseId(`${mat.id}_${arch.id}`)).toEqual({ material: mat.id, archetype: arch.id });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('rejects ids with no separator or an empty half', () => {
    for (const bad of ['', 'sword', '_sword', 'steel_', undefined]) {
      expect(parseBaseId(bad)).toBeNull();
    }
  });

  it('keeps the archetype whole when it contains an underscore', () => {
    expect(parseBaseId('steel_great_sword')).toEqual({ material: 'steel', archetype: 'great_sword' });
  });
});

describe('rampFor', () => {
  it('falls back rather than throwing on an unknown material', () => {
    expect(rampFor('unobtanium')).toHaveLength(5);
    expect(rampFor(undefined)).toHaveLength(5);
  });
});

function stack(base: string, rarity?: string, brand?: string): InventoryStack {
  return {
    base,
    name: base,
    sprite: base,
    item: {
      id: base, type: 'item',
      components: { equipment: { base, affixes: [], rolled: { weapon_brand: brand }, rarity } },
    },
  } as unknown as InventoryStack;
}

function equip(partial: Partial<Record<string, InventoryStack>>): Equipment {
  return partial as unknown as Equipment;
}

describe('gearVisuals', () => {
  it('draws armor bottom-up and the weapon last, so it reads as held in front', () => {
    const v = gearVisuals(equip({
      mainhand: stack('steel_sword'), chest: stack('leather_chest'), helmet: stack('iron_helmet'),
    }));
    expect(v.map((g) => g.layer)).toEqual(['chest_light', 'helmet_heavy', 'sword']);
  });

  it('skips empty slots and unparseable bases instead of emitting a broken layer', () => {
    expect(gearVisuals(equip({ mainhand: null as never, chest: stack('heirloom') }))).toEqual([]);
    expect(gearVisuals(undefined)).toEqual([]);
  });

  // Hand-authored bases in world/entities/items/bases/ share the underscore
  // shape; only a known material makes an id a composed base.
  it('ignores a hand-authored base whose first token is not a material', () => {
    expect(gearVisuals(equip({ mainhand: stack('health_potion') }))).toEqual([]);
  });

  it('still resolves a hand-authored weapon that does lead with a material', () => {
    expect(gearVisuals(equip({ mainhand: stack('crude_knife') }))[0]!.layer).toBe('knife');
  });

  it('ignores the slots that are too small to read on screen', () => {
    const v = gearVisuals(equip({ boots: stack('leather_boots'), ring1: stack('gold_ring') }));
    expect(v).toEqual([]);
  });

  it('gives common no glow and every other rarity one', () => {
    expect(gearVisuals(equip({ mainhand: stack('steel_sword', 'common') }))[0]!.glow).toBeUndefined();
    expect(gearVisuals(equip({ mainhand: stack('steel_sword', 'rare') }))[0]!.glow).toMatch(HEX);
  });

  it('tints a branded weapon but never branded armor', () => {
    expect(gearVisuals(equip({ mainhand: stack('steel_sword', 'rare', 'fire_damage') }))[0]!.tint)
      .toBe(BRAND_COLORS['fire_damage']);
    expect(gearVisuals(equip({ chest: stack('steel_chest', 'rare', 'fire_damage') }))[0]!.tint).toBeUndefined();
  });

  it('drops an unknown brand rather than tinting with undefined', () => {
    expect(gearVisuals(equip({ mainhand: stack('steel_sword', 'rare', 'sonic_damage') }))[0]!.tint).toBeUndefined();
  });
});

describe('visualSignature', () => {
  it('separates looks that differ only by material, rarity or brand', () => {
    const sig = (b: string, r?: string, br?: string) =>
      visualSignature('fighter', '#6ec6f0', gearVisuals(equip({ mainhand: stack(b, r, br) })));
    const base = sig('steel_sword', 'rare');
    expect(sig('iron_sword', 'rare')).not.toBe(base);
    expect(sig('steel_sword', 'legendary')).not.toBe(base);
    expect(sig('steel_sword', 'rare', 'fire_damage')).not.toBe(base);
    expect(sig('steel_sword', 'rare')).toBe(base);
  });

  it('separates two players who differ only by color', () => {
    expect(visualSignature('fighter', '#ff0000', [])).not.toBe(visualSignature('fighter', '#00ff00', []));
  });
});
