// TTK balance table — tunes mob HP / unarmed damage against the TTK anchor in
// docs/plan-combat-retune.md. Run: npx tsx tools/combat-sim.ts
//
// The harness itself lives in tools/lib/combat-sim.ts, shared with the zone
// editor's mob panel so a template tuned in the GUI and a template checked here
// report the same numbers.

import { avgHitsToKill, gearUp, makePlayer } from './lib/combat-sim.ts';
import { makeMob } from '../server/game/entities.ts';
import type { MobRole, PlayerEntity, MobTemplate } from '../shared/types.ts';

// Canonical unarmed fighter build (see makePlayer).
function makeFighter(level: number): PlayerEntity {
  return makePlayer('fighter', level);
}

// Geared fighter: iron sword (dmg [4,7], STR:D/DEX:E) + full iron set (~20 def).
function makeGearedFighter(level: number): PlayerEntity {
  return gearUp(makePlayer('fighter', level));
}

function makeSimMob(level: number, role: MobRole): ReturnType<typeof makeMob> {
  const template: MobTemplate = {
    id: `sim-${role}`, name: role, sprite: 'x',
    level, role, speed: 1.0, behavior: 'aggressive', aggro_range: 5,
  };
  const mob = makeMob(template, { zone: 'sim', x: 1, y: 0 });
  return mob;
}

const ROLES: MobRole[] = ['pest', 'soldier', 'ranged', 'support', 'tank'];

function row(label: string, makeP: () => any, pLvl: number, mLvl: number, role: MobRole): void {
  const mob = makeSimMob(mLvl, role);
  const hp = mob.components.health.max;
  const killsIn = avgHitsToKill(makeP, () => makeSimMob(mLvl, role));
  const dmg = mob.components.stats.damage;
  const maxDmg = Array.isArray(dmg) ? dmg[1] : dmg;
  const mobDmgZero = maxDmg === 0;
  const diesIn = mobDmgZero ? Infinity : avgHitsToKill(() => makeSimMob(mLvl, role), makeP);
  const win = diesIn > killsIn ? 'WIN ' : 'LOSE';
  console.log(
    `  ${label.padEnd(11)} mobHP=${String(hp).padStart(3)}  killsIn=${killsIn.toFixed(1).padStart(5)}  ` +
    `diesIn=${(diesIn === Infinity ? '∞' : diesIn.toFixed(1)).padStart(5)}  ${win}`,
  );
}

console.log('TTK anchor: at level parity, unarmed player kills in ~5-6 hits, dies in ~8-10.');
console.log('(non-tank roles should satisfy diesIn > killsIn → player wins)\n');

console.log('═══ Unarmed, level parity ═══\n');
for (const level of [1, 2, 3, 5, 7, 10]) {
  console.log(`── Level ${level} ──`);
  for (const role of ROLES) row(role, () => makeFighter(level), level, level, role);
  console.log();
}

console.log('═══ Step 2: L3 player vs L2 mob (level advantage) ═══\n');
for (const role of ROLES) row(role, () => makeFighter(3), 3, 2, role);
console.log();

console.log('═══ Unarmed vs mobs 3 levels BELOW (should WIN comfortably) ═══\n');
for (const pLvl of [5, 8, 10]) {
  console.log(`── Player L${pLvl} vs L${pLvl - 3} mobs ──`);
  for (const role of ROLES) row(role, () => makeFighter(pLvl), pLvl, pLvl - 3, role);
  console.log();
}

console.log('═══ +3-level gap: mob HP vs player HP (should be WELL above) ═══\n');
for (const pLvl of [2, 5, 7]) {
  const p = makeFighter(pLvl);
  console.log(`── Player L${pLvl} (HP ${p.components.health.max}) vs L${pLvl + 3} mobs ──`);
  for (const role of ROLES) {
    const mob = makeSimMob(pLvl + 3, role);
    const mhp = mob.components.health.max;
    const ratio = (mhp / p.components.health.max).toFixed(2);
    console.log(`  ${role.padEnd(11)} mobHP=${String(mhp).padStart(3)}  ${ratio}× player HP`);
  }
  console.log();
}

console.log('═══ Step 4: geared (iron sword + iron set), level parity ═══\n');
for (const level of [5, 10]) {
  console.log(`── Level ${level} ──`);
  for (const role of ROLES) row(role, () => makeGearedFighter(level), level, level, role);
  console.log();
}
