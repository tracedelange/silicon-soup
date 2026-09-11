import { describe, expect, it } from 'vitest';
import { avgHitsToKill, gearUp, makePlayer, simulateTemplate } from './combat-sim.ts';
import { CLASSES } from '../../shared/constants.ts';
import type { MobTemplate } from '../../shared/types.ts';

const soldier: MobTemplate = {
  id: 't', name: 'T', sprite: 'x', level: 5, role: 'soldier',
  speed: 1, behavior: 'aggressive', aggro_range: 5,
};

describe('makePlayer', () => {
  it('starts from the class template and spends one point per level', () => {
    const p = makePlayer('fighter', 1);
    expect(p.components.stats.strength).toBe(CLASSES.fighter.start_stats.strength);
    const p10 = makePlayer('fighter', 10);
    const spent = (p10.components.stats.strength! - CLASSES.fighter.start_stats.strength)
      + (p10.components.stats.constitution! - CLASSES.fighter.start_stats.constitution);
    expect(spent).toBe(9);
  });

  it('puts the majority into the class primary stat', () => {
    const rogue = makePlayer('rogue', 21).components.stats;
    expect(rogue.dexterity!).toBeGreaterThan(rogue.constitution!);
    const wizard = makePlayer('wizard', 21).components.stats;
    expect(wizard.intelligence!).toBeGreaterThan(wizard.constitution!);
  });
});

describe('simulateTemplate', () => {
  // The whole point of running the ACTUAL template rather than its role: a boss
  // with hand-set hp must read as itself, not as its role's average.
  it('honours an hp override instead of the role curve', () => {
    expect(simulateTemplate({ ...soldier, hp: 999 }, 5, 20).hp).toBe(999);
    expect(simulateTemplate(soldier, 5, 20).hp).not.toBe(999);
  });

  it('honours stat overrides', () => {
    const sim = simulateTemplate({ ...soldier, stats: { strength: 30 } }, 5, 20);
    expect(sim.stats.strength).toBe(30);
  });

  it('reports one matchup per player class', () => {
    const sim = simulateTemplate(soldier, 5, 20);
    expect(sim.unarmed.map(m => m.klass).sort()).toEqual(Object.keys(CLASSES).sort());
  });

  // A tougher mob takes more swings to kill. Stochastic, so the gap is made
  // wide enough that noise cannot flip it.
  it('takes more hits to kill the more hp it has', () => {
    const weak = simulateTemplate({ ...soldier, hp: 40 }, 5, 400);
    const tough = simulateTemplate({ ...soldier, hp: 400 }, 5, 400);
    expect(tough.unarmed[0]!.killsIn).toBeGreaterThan(weak.unarmed[0]!.killsIn * 2);
  });

  it('reports an unkillable player as an infinite time-to-die', () => {
    // role `passive` swings for nothing, so the player is never in danger.
    const sim = simulateTemplate({ ...soldier, role: 'passive' }, 5, 20);
    expect(sim.unarmed.every(m => m.diesIn === Infinity && m.win)).toBe(true);
  });
});

describe('gearUp', () => {
  it('raises the player defense it is meant to model', () => {
    const bare = () => makePlayer('fighter', 5);
    const geared = () => gearUp(makePlayer('fighter', 5));
    const mob = () => ({ ...soldier }) as never;
    // Not asserting a damage improvement: tier-1 weapon scaling currently
    // UNDERPERFORMS unarmed (see tools/combat-sim.ts's geared table), which is
    // a balance question, not a harness one. Survivability is what gear here
    // unambiguously buys.
    void mob;
    expect(avgHitsToKill(
      () => ({ type: 'mob', components: { stats: { damage: [10, 10], strength: 0 }, health: { current: 1, max: 1 } } }) as never,
      geared, 200,
    )).toBeGreaterThan(avgHitsToKill(
      () => ({ type: 'mob', components: { stats: { damage: [10, 10], strength: 0 }, health: { current: 1, max: 1 } } }) as never,
      bare, 200,
    ));
  });
});
