// Which equippable items have art, which are waiting on a drawing, and which
// can never get one as things stand.
//
//   npm run sprite-coverage
//
// Runs the real resolver (shared/itemVisuals.ts itemVisual) over the real item
// universe — composeBases' material x archetype cross-product plus every
// hand-authored base in world/entities/items/bases — so the report can't drift
// from what the game actually draws. A report, not a gate: missing art is the
// normal state of this system, and CI has no business failing over it.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import yaml from 'js-yaml';
import { composeBases } from '../server/game/items/bases.ts';
import { itemVisual, parseBaseId } from '../shared/itemVisuals.ts';
import type { Archetype, ItemBase, Material } from '../shared/types.ts';
import { GEAR_DIR } from './lib/playerSpritePng.ts';

const ROOT = join(import.meta.dirname, '..');
const ITEMS = join(ROOT, 'world/entities/items');

/** Base `slot` values that put an item on the body. Anything else — consumable,
 *  quest, currency, crafting — is out of scope: it's never worn, so it has no
 *  gear overlay to miss. */
const EQUIPPABLE = new Set(['mainhand', 'helmet', 'chest', 'gloves', 'leggings', 'boots', 'ring', 'amulet']);

/** Slots the paper-doll composites. The rest can still carry an inventory icon;
 *  they're just too small to read on a 64px body (docs/plan-player-sprites.md). */
const WORN_SLOTS = new Set(['mainhand', 'chest', 'helmet']);

function readList<T>(file: string, key: string): T[] {
  return (yaml.load(readFileSync(join(ITEMS, file), 'utf8')) as Record<string, T[]>)[key] ?? [];
}

const composed = composeBases(
  readList<Material>('materials.yaml', 'materials'),
  readList<Archetype>('archetypes.yaml', 'archetypes'),
);

const authored = readdirSync(join(ITEMS, 'bases'))
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => {
    const def = yaml.load(readFileSync(join(ITEMS, 'bases', f), 'utf8')) as ItemBase;
    return { ...def, id: def.id ?? basename(f, '.yaml') };
  });

interface Row { id: string; name: string; slot: string; layer: string | null; authored: boolean }

const rows: Row[] = [...composed, ...authored]
  .filter((b) => b.slot && EQUIPPABLE.has(b.slot))
  .map((b) => ({
    id: b.id,
    name: b.name ?? b.id,
    slot: b.slot!,
    layer: itemVisual({ base: b.id })?.layer ?? null,
    authored: !composed.some((c) => c.id === b.id),
  }));

const hasArt = (layer: string) => existsSync(join(GEAR_DIR, `${layer}.png`));

// A hand-authored base whose id collides with one the cross-product already
// composes. Not a sprite problem, but this report is where it shows up: the
// duplicate inflates every count, and whichever one the loader keeps decides
// the item's real stats.
const composedIds = new Set(composed.map((b) => b.id));
const shadowed = authored.filter((b) => composedIds.has(b.id)).map((b) => b.id);

// Group by the layer each item wants: the actionable unit is a drawing, and one
// drawing typically unlocks a whole material family at once.
const byLayer = new Map<string, Row[]>();
const unmapped: Row[] = [];
for (const r of rows) {
  if (!r.layer) { unmapped.push(r); continue; }
  const list = byLayer.get(r.layer) ?? [];
  list.push(r);
  byLayer.set(r.layer, list);
}

const drawn = [...byLayer.entries()].filter(([l]) => hasArt(l)).sort();
const pending = [...byLayer.entries()].filter(([l]) => !hasArt(l))
  .sort((a, b) => b[1].length - a[1].length);

const pad = (s: string, n: number) => s.padEnd(n);
const covered = drawn.reduce((n, [, items]) => n + items.length, 0);

console.log(`\nEquippable item bases: ${rows.length}  (${composed.filter((b) => EQUIPPABLE.has(b.slot!)).length} composed, ${rows.length - composed.filter((b) => EQUIPPABLE.has(b.slot!)).length} hand-authored)`);
console.log(`Covered by existing art: ${covered}  (${Math.round((covered / rows.length) * 100)}%)\n`);

console.log(`── Drawn (${drawn.length} overlays) ─────────────────────────────────────`);
for (const [layer, items] of drawn) {
  console.log(`  ${pad(`${layer}.png`, 22)} ${String(items.length).padStart(3)} items   ${items.slice(0, 4).map((i) => i.id).join(', ')}${items.length > 4 ? ', …' : ''}`);
}

console.log(`\n── Waiting on art (${pending.length} overlays, ${pending.reduce((n, [, i]) => n + i.length, 0)} items) ──`);
console.log('   Draw the file and every item listed picks it up. * = also worn on the body.\n');
for (const [layer, items] of pending) {
  const worn = items.some((i) => WORN_SLOTS.has(i.slot)) ? '*' : ' ';
  console.log(`  ${worn} ${pad(`${layer}.png`, 22)} ${String(items.length).padStart(3)} items   ${items.slice(0, 4).map((i) => i.id).join(', ')}${items.length > 4 ? ', …' : ''}`);
}

console.log(`\n── No sprite association (${unmapped.length}) ───────────────────────────`);
console.log('   These resolve to no overlay at all, so no drawing can reach them.');
console.log('   Art is keyed off `<material>_<archetype>`; a hand-authored id that');
console.log('   does not start with a real material has nothing to key on.\n');
for (const r of unmapped) {
  const parsed = parseBaseId(r.id);
  const why = !parsed ? 'no underscore — single-token id'
    : `"${parsed.material}" is not a material in materials.yaml`;
  console.log(`  ${pad(r.id, 24)} ${pad(r.slot, 9)} ${why}`);
}

if (shadowed.length) {
  console.log(`\n── Duplicate ids (${shadowed.length}) ─────────────────────────────────────`);
  console.log('   Hand-authored bases that composeBases already generates. Counted');
  console.log('   twice above, and the loader picks one of the two stat profiles.\n');
  for (const id of shadowed) console.log(`  ${id}`);
}
console.log();
