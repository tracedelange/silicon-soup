import { describe, it, expect } from 'vitest';
import { lintItemBase, lintItemBaseRaw } from './lint-item.ts';
import { SCALING_COEFFS } from '../../shared/constants.ts';
import type { ItemBase } from '../../shared/types.ts';

// A minimal well-formed weapon to mutate per-case, so each test states only the
// thing it is actually about.
function weapon(over: Partial<ItemBase> = {}): ItemBase {
  return {
    id: 'test_sword',
    name: 'Test Sword',
    slot: 'mainhand',
    tags: ['melee', 'blade'],
    base_damage: [4, 7],
    base_speed: 1.0,
    sell_value: 20,
    scaling: { strength: 'D' },
    ...over,
  } as ItemBase;
}

const blocking = (problems: string[]) => problems.filter((p) => !p.startsWith('warn:'));
const warns = (problems: string[]) => problems.filter((p) => p.startsWith('warn:'));

describe('lintItemBase — a well-formed base is clean', () => {
  it('passes a complete weapon with no problems at all', () => {
    expect(lintItemBase(weapon())).toEqual([]);
  });

  it('passes a quest item without demanding a combat profile or a price', () => {
    const quest = { id: 'letter', name: 'Letter', slot: 'quest', tags: ['quest_item'] } as ItemBase;
    expect(lintItemBase(quest)).toEqual([]);
  });
});

describe('lintItemBase — identity and vocabulary', () => {
  it('blocks a base with no slot', () => {
    const problems = lintItemBase(weapon({ slot: undefined as unknown as ItemBase['slot'] }));
    expect(blocking(problems).some((p) => p.includes('missing `slot`'))).toBe(true);
  });

  it('blocks a base whose tags are not an array, since every read site does tags.includes', () => {
    const problems = lintItemBase(weapon({ tags: undefined as unknown as string[] }));
    expect(blocking(problems).some((p) => p.includes('`tags` must be an array'))).toBe(true);
  });

  // resolveEquipSlot returns null for anything it doesn't recognize, so a typo'd
  // slot produces an item that simply cannot be equipped, with no error.
  it('warns on a slot outside the known vocabulary rather than blocking, since such items still function as junk', () => {
    const problems = lintItemBase(weapon({ slot: 'mainhnd' as unknown as ItemBase['slot'] }));
    expect(blocking(problems)).toHaveLength(0);
    expect(warns(problems).some((p) => p.includes("slot 'mainhnd' is not a known slot"))).toBe(true);
  });

  it('warns on a field that is not part of ItemBase and is dropped at load', () => {
    const problems = lintItemBase(weapon({ description: 'flavor' } as unknown as ItemBase));
    expect(warns(problems).some((p) => p.includes("unknown field 'description'"))).toBe(true);
  });
});

describe('lintItemBase — stat ranges', () => {
  it('blocks an inverted damage range', () => {
    const problems = lintItemBase(weapon({ base_damage: [9, 4] }));
    expect(blocking(problems).some((p) => p.includes('inverted'))).toBe(true);
  });

  it('blocks a negative damage range', () => {
    const problems = lintItemBase(weapon({ base_damage: [-2, 4] }));
    expect(blocking(problems).some((p) => p.includes('negative'))).toBe(true);
  });

  it('blocks a damage range that is not a pair of numbers', () => {
    const problems = lintItemBase(weapon({ base_damage: 7 as unknown as ItemBase['base_damage'] }));
    expect(blocking(problems).some((p) => p.includes('two-number range'))).toBe(true);
  });
});

describe('lintItemBase — scaling', () => {
  // scaledBonus does `SCALING_COEFFS[letter]` and skips anything falsy, so an
  // unknown letter looks exactly like '-' at runtime but wasn't the intent.
  it('blocks a scaling letter outside the coefficient table', () => {
    const problems = lintItemBase(weapon({ scaling: { strength: 'F' } as unknown as ItemBase['scaling'] }));
    expect(blocking(problems).some((p) => p.includes('not in SCALING_COEFFS'))).toBe(true);
  });

  it("accepts '-', the authored way to say the stat is ignored", () => {
    expect(lintItemBase(weapon({ scaling: { strength: 'D', intelligence: '-' } }))).toEqual([]);
  });

  // Importing the table rather than hardcoding today's letters, so adding a
  // grade to SCALING_COEFFS doesn't produce a false failure here.
  it('accepts every letter the engine actually defines a coefficient for', () => {
    for (const letter of Object.keys(SCALING_COEFFS)) {
      const problems = lintItemBase(weapon({ scaling: { strength: letter } as unknown as ItemBase['scaling'] }));
      expect(problems, `letter ${letter}`).toEqual([]);
    }
  });

  it('blocks a scaling key that is not a stat', () => {
    const problems = lintItemBase(weapon({ scaling: { wisdom: 'C' } as unknown as ItemBase['scaling'] }));
    expect(blocking(problems).some((p) => p.includes("scaling key 'wisdom'"))).toBe(true);
  });
});

describe('lintItemBase — weapon completeness', () => {
  // The mirror_shard_weapon bug: damageBonus falls through to the unarmed
  // branch when a weapon has no scaling, so an expensive blade scales like a fist.
  it('warns when a weapon has no scaling', () => {
    const problems = lintItemBase(weapon({ scaling: undefined }));
    expect(warns(problems).some((p) => p.includes('unarmed branch'))).toBe(true);
  });

  it('warns when a weapon has no base_speed', () => {
    const problems = lintItemBase(weapon({ base_speed: undefined }));
    expect(warns(problems).some((p) => p.includes('silently swings at 1.0'))).toBe(true);
  });

  it('warns when a weapon carries no family tag', () => {
    const problems = lintItemBase(weapon({ tags: ['weapon', 'melee'] }));
    expect(warns(problems).some((p) => p.includes('no family tag'))).toBe(true);
  });

  it('does not ask a non-weapon for a weapon profile', () => {
    const armor = { id: 'vest', name: 'Vest', slot: 'chest', tags: ['armor'], base_defense: [2, 4], sell_value: 5 } as ItemBase;
    expect(lintItemBase(armor)).toEqual([]);
  });
});

describe('lintItemBase — speed sanity', () => {
  // weaponSpeed guards on `sp > 0` and substitutes 1.0, so a zero or negative
  // speed is a silent no-op rather than a crash.
  it('blocks a non-positive base_speed', () => {
    const problems = lintItemBase(weapon({ base_speed: 0 }));
    expect(blocking(problems).some((p) => p.includes('must be > 0'))).toBe(true);
  });

  // The sword_of_heros case: schema-valid, but a 10x swing rate.
  it('warns on a speed far outside the band real weapons occupy', () => {
    const problems = lintItemBase(weapon({ base_speed: 0.1 }));
    expect(blocking(problems)).toHaveLength(0);
    expect(warns(problems).some((p) => p.includes('debug value'))).toBe(true);
  });
});

describe('lintItemBase — profile lands where it is read', () => {
  it('warns about base_defense on a weapon, which totalDefense never sums', () => {
    const problems = lintItemBase(weapon({ base_defense: [2, 3] }));
    expect(warns(problems).some((p) => p.includes('base_defense on slot'))).toBe(true);
  });

  it('warns about armor with no base_defense', () => {
    const armor = { id: 'vest', name: 'Vest', slot: 'chest', tags: ['armor'], sell_value: 5 } as ItemBase;
    expect(warns(lintItemBase(armor)).some((p) => p.includes('adds nothing'))).toBe(true);
  });
});

describe('lintItemBase — cross-references', () => {
  it('blocks an attack_ability that no ability defines', () => {
    const problems = lintItemBase(weapon({ attack_ability: 'staff_blot' }), { abilities: new Set(['staff_bolt']) });
    expect(blocking(problems).some((p) => p.includes("unknown attack_ability 'staff_blot'"))).toBe(true);
  });

  it('skips the check when the caller supplied no ability set', () => {
    expect(lintItemBase(weapon({ attack_ability: 'anything' }))).toEqual([]);
  });
});

describe('lintItemBaseRaw', () => {
  it('reports a non-mapping document as a problem instead of throwing', () => {
    expect(blocking(lintItemBaseRaw(['a', 'list']))).toHaveLength(1);
    expect(blocking(lintItemBaseRaw(null))).toHaveLength(1);
  });
});
