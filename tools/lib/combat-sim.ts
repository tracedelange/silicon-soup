// Shared TTK harness. Swings run through combat's real damage core
// (rollDamage / applyResolvedDamage), so this measures the game's mitigation,
// dodge and scaling rather than a second copy of the formulas.
//
// Split out of tools/combat-sim.ts so the zone editor's mob panel and the CLI
// balance table are the same numbers — the same discipline the mapgen bake
// follows between the editor preview and the runtime.
//
// Reach is deliberately not modelled: this is a damage-per-swing harness, and
// who can reach whom is the ability executor's business (attackAbilityFor).

import { applyResolvedDamage, rollDamage } from '../../server/game/systems/combat.ts';
import { makeMob } from '../../server/game/entities.ts';
import { CLASSES } from '../../shared/constants.ts';
import type { ClassId, MobEntity, MobTemplate, PlayerEntity, WorldDefs } from '../../shared/types.ts';

// The sim's combatants carry no ItemBase — rollDamage only consults defs to
// fill in for a weapon with no roll of its own.
const NO_DEFS = { itemBases: {} } as WorldDefs;

type Combatant = Parameters<typeof rollDamage>[0];

/** One swing from att into tgt, through the real mitigation path. */
export function swing(att: Combatant, tgt: Combatant): void {
  applyResolvedDamage(att, tgt, rollDamage(att, NO_DEFS));
}

/**
 * A canonical player of `klass` at `level`. Starts from the class's own
 * start_stats and spends one point per level, ~60% into the class's primary
 * stat and the rest into constitution — the same build assumption
 * docs/plan-combat-retune.md anchors its TTK targets to.
 */
export function makePlayer(klass: ClassId, level: number): PlayerEntity {
  const primary: Record<ClassId, 'strength' | 'dexterity' | 'intelligence'> = {
    fighter: 'strength', rogue: 'dexterity', wizard: 'intelligence',
  };
  const base = { ...CLASSES[klass].start_stats };
  const pts = level - 1;
  const primaryAdds = Math.round(pts * 0.6);
  base[primary[klass]] += primaryAdds;
  base.constitution += pts - primaryAdds;
  const maxHp = 100 + (base.constitution - 5) * 10;
  return {
    id: 'sim-player', type: 'player', name: 'Sim', klass,
    position: { zone: 'sim', x: 0, y: 0 }, facing: 'south',
    nextActTick: 0, nextRegenTick: 0,
    components: {
      health: { current: maxHp, max: maxHp },
      inventory: { slots: [] },
      equipment: {} as PlayerEntity['components']['equipment'],
      wallet: { gold: 0 },
      stats: { ...base, speed: 1.0, damage: [3, 6] },
      progress: { level, xp: 0, unspent_points: 0 },
      quests: { active: [], completed: [] },
      knownAbilities: {},
    },
  } as PlayerEntity;
}

/** Same player, in the tier-1 kit: iron sword plus a full iron set (~20 def).
 *  The gap between the two is what says whether a fight is gear-checked. */
export function gearUp(p: PlayerEntity): PlayerEntity {
  const eq = p.components.equipment as Record<string, unknown>;
  const armorRoll = (lo: number, hi: number) => ({ item: { components: { equipment: { rolled: { defense: [lo, hi] } } } } });
  eq.mainhand = { item: { components: { equipment: { rolled: { damage: [4, 7], scaling: { strength: 'D', dexterity: 'E' } } } } } };
  eq.helmet = armorRoll(3, 5);
  eq.chest = armorRoll(4, 7);
  eq.gloves = armorRoll(2, 4);
  eq.leggings = armorRoll(3, 5);
  eq.boots = armorRoll(2, 3);
  return p;
}

/** Average swings for `makeAtt` to kill `makeTgt`. Fresh combatants per run, so
 *  the spread of damage rolls and dodges is what the average is over. */
export function avgHitsToKill(makeAtt: () => Combatant, makeTgt: () => Combatant, runs = 2000): number {
  let total = 0;
  for (let i = 0; i < runs; i++) {
    const att = makeAtt();
    const tgt = makeTgt();
    let hits = 0;
    while ((tgt.components.health.current ?? 0) > 0 && hits < 1000) { swing(att, tgt); hits++; }
    total += hits;
  }
  return total / runs;
}

export interface MatchUp {
  klass: ClassId;
  /** Player swings to kill this mob. */
  killsIn: number;
  /** Mob swings to kill the player. Infinity when the mob deals no damage. */
  diesIn: number;
  /** Whether the player wins the straight trade. */
  win: boolean;
}

export interface MobSim {
  level: number;
  hp: number;
  damage: [number, number] | number;
  xp: number;
  armor: number;
  stats: Record<string, number>;
  unarmed: MatchUp[];
  geared: MatchUp[];
}

/**
 * Derived combat profile for a template, at `playerLevel` (defaults to the
 * mob's own level — parity, the case the TTK anchor is stated for).
 *
 * Runs against the ACTUAL template, so hp/stats/armor overrides and role
 * scaling are both reflected; a boss with hand-set hp reads as itself, not as
 * its role's average.
 */
export function simulateTemplate(template: MobTemplate, playerLevel?: number, runs = 1200): MobSim {
  const level = template.level ?? 1;
  const pLevel = playerLevel ?? level;
  const make = () => makeMob(template, { zone: 'sim', x: 1, y: 0 }) as MobEntity;
  const probe = make();
  const dmg = probe.components.stats.damage;
  const maxDmg = Array.isArray(dmg) ? dmg[1] : dmg;

  const versus = (geared: boolean): MatchUp[] =>
    (Object.keys(CLASSES) as ClassId[]).map(klass => {
      const makeP = () => (geared ? gearUp(makePlayer(klass, pLevel)) : makePlayer(klass, pLevel));
      const killsIn = avgHitsToKill(makeP, make, runs);
      const diesIn = maxDmg === 0 ? Infinity : avgHitsToKill(make, makeP, runs);
      return { klass, killsIn, diesIn, win: diesIn > killsIn };
    });

  return {
    level,
    hp: probe.components.health.max,
    damage: (dmg ?? 0) as [number, number] | number,
    xp: probe.xpReward,
    armor: template.armor ?? 0,
    stats: {
      strength: probe.components.stats.strength ?? 0,
      dexterity: probe.components.stats.dexterity ?? 0,
      intelligence: probe.components.stats.intelligence ?? 0,
      constitution: probe.components.stats.constitution ?? 0,
    },
    unarmed: versus(false),
    geared: versus(true),
  };
}
