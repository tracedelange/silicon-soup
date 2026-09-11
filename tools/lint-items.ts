// Runs the item-base gate (forge/lib/lint-item.ts) over every authored base in
// world/entities/items/bases/, plus every base composed from materials ×
// archetypes. Doubles as the regression fixture: the whole library must pass
// clean at the blocking level, so a generator minting new bases can be held to
// the same bar. Run: npx tsx tools/lint-items.ts
//
// Exit code is non-zero if any BLOCKING problem is found (warn: entries don't
// fail the run) so it can gate CI / a generation loop.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { lintItemBaseRaw } from '../forge/lib/lint-item.ts';
import { composeBases } from '../server/game/items/bases.ts';
import type { Archetype, ItemBase, Material } from '../shared/types.ts';

const WORLD = process.env.WORLD_DIR || join(process.cwd(), 'world');
const ITEMS = join(WORLD, 'entities', 'items');
const BASES = join(ITEMS, 'bases');

function readYaml<T>(path: string): T {
  return yaml.load(readFileSync(path, 'utf8')) as T;
}

// Ability ids, for the attack_ability cross-reference. Read straight off the
// directory rather than through loadWorld: loadWorld would validate the whole
// world and throw on the first unrelated problem, which is the opposite of what
// a lint should do.
const abilities = new Set<string>();
const abilitiesDir = join(WORLD, 'abilities');
if (existsSync(abilitiesDir)) {
  for (const f of readdirSync(abilitiesDir)) {
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
    const id = readYaml<{ id?: string }>(join(abilitiesDir, f))?.id;
    if (id) abilities.add(id);
  }
}

let blocking = 0;
let warnings = 0;

function report(label: string, problems: string[]): void {
  const blockers = problems.filter((p) => !p.startsWith('warn:'));
  const warns = problems.filter((p) => p.startsWith('warn:'));
  blocking += blockers.length;
  warnings += warns.length;
  if (problems.length === 0) return;
  console.log(`\n${label}`);
  for (const p of blockers) console.log(`  ✗ ${p}`);
  for (const p of warns) console.log(`  ⚠ ${p.replace(/^warn:\s*/, '')}`);
}

const files = readdirSync(BASES).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();

// Hand-authored bases. Also catch duplicate ids across files: loadWorld keys the
// registry by `base.id`, so two files claiming one id silently leave whichever
// walk() reached last, and the other file's tuning is simply gone.
const seen = new Map<string, string>();
for (const file of files) {
  const raw = readYaml<ItemBase>(join(BASES, file));
  const problems = lintItemBaseRaw(raw, { abilities });
  const id = raw?.id;
  if (id) {
    const prev = seen.get(id);
    if (prev) problems.push(`duplicate id '${id}' — also defined in ${prev}; the loader keeps only one`);
    else seen.set(id, file);
  }
  report(file, problems);
}

// Composed bases (material × archetype). These are code output rather than
// authored files, so a problem here is a bug in an archetype or material entry
// and shows up multiplied across every material it composes with — report the
// archetype once instead of once per material.
let composed = 0;
const materialsPath = join(ITEMS, 'materials.yaml');
const archetypesPath = join(ITEMS, 'archetypes.yaml');
if (existsSync(materialsPath) && existsSync(archetypesPath)) {
  const materials = readYaml<{ materials: Material[] }>(materialsPath).materials || [];
  const archetypes = readYaml<{ archetypes: Archetype[] }>(archetypesPath).archetypes || [];
  for (const arch of archetypes) {
    const bases = composeBases(materials, [arch]);
    composed += bases.length;
    // The first composition is representative: every material produces the same
    // problems, since the material only scales numbers the archetype supplied.
    if (bases.length === 0) {
      report(`archetypes.yaml → ${arch.id}`, [`warn: composes with no material — material_classes [${arch.material_classes?.join(', ')}] matches nothing in materials.yaml`]);
      continue;
    }
    const problems = lintItemBaseRaw(bases[0], { abilities });
    report(`archetypes.yaml → ${arch.id} (×${bases.length} materials)`, problems);
  }
}

console.log(`\n${files.length} authored + ${composed} composed bases · ${blocking} blocking · ${warnings} warnings`);
process.exit(blocking > 0 ? 1 : 0);
