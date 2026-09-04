import { describe, expect, it } from 'vitest';
import { generateZoneGrid } from './index.ts';
import type { GenOp, ZoneDef } from '../../../shared/types.ts';

const BLOCKING = new Set(['wall', 'thatch']);

// A camp: one hand-placed structure at the centre, then buildings scattered
// around it. The scatter is what the reservation has to survive.
function camp(regionOp: Partial<Extract<GenOp, { type: 'region' }>>, seed: string): ZoneDef {
  return {
    id: 'camp', seed, width: 40, height: 40, default_tile: 'grass',
    ops: [
      {
        type: 'region', id: 'keep', shape: { kind: 'rect', w: 9, h: 9 },
        at: { center: true }, floor: 'wood_floor', ...regionOp,
      },
      {
        type: 'scatter_sites', count: 6, spacing: 9, seed: 'plots',
        id_prefix: 'plot', tags: ['plot'], over: 'grass', margin: 4,
      },
      {
        type: 'stamp', at_tag: 'plot', seed: 'huts', region: 'hut',
        prefab: { data: 'HHHHH\nH...H\nH...H\nH...H\nHHHHH', legend: { H: 'thatch', '.': 'wood_floor' } },
      },
    ] as GenOp[],
  } as ZoneDef;
}

function hutsClippingKeep(def: ZoneDef): number {
  const { bounds } = generateZoneGrid(def, BLOCKING);
  const keep = bounds.keep!;
  let n = 0;
  for (const [id, r] of Object.entries(bounds)) {
    if (id === 'keep' || !id.includes('hut')) continue;
    if (r.x < keep.x + keep.w && keep.x < r.x + r.w && r.y < keep.y + keep.h && keep.y < r.y + r.h) n++;
  }
  return n;
}

describe('region claim', () => {
  it('registers the region either way — `region` is the atom that cannot fail', () => {
    for (const op of [{}, { claim: 'reserved' as const }]) {
      expect(generateZoneGrid(camp(op, 'c:1'), BLOCKING).bounds.keep).toBeDefined();
    }
  });

  // A claim protects the POINT a scatter picks, but a prefab stamped on that
  // point spreads from it — so a bare rect claim still lets a building clip the
  // corner of what it was meant to protect. This is what claim_margin is for.
  it('keeps scattered buildings out of the reserved rect', () => {
    let bare = 0, claimed = 0, margined = 0;
    for (let i = 0; i < 40; i++) {
      const seed = `c:${i}`;
      bare += hutsClippingKeep(camp({}, seed));
      claimed += hutsClippingKeep(camp({ claim: 'reserved' }, seed));
      margined += hutsClippingKeep(camp({ claim: 'reserved', claim_margin: 3 }, seed));
    }
    expect(bare).toBeGreaterThan(0);
    // A bare claim is measurably NOT enough here — it comes out equal to no
    // claim at all, because with this spacing the scatter point never lands
    // inside the rect anyway; only the stamped footprint spills in. Asserted as
    // "no worse" rather than "equal" so that teaching `stamp` about RESERVED
    // later is an improvement rather than a failure.
    expect(claimed).toBeLessThanOrEqual(bare);
    expect(margined).toBe(0);
  });

  it('passes tags through to the registered feature', () => {
    const def = camp({ tags: ['boss_chamber'] }, 'c:1');
    const { bounds } = generateZoneGrid(def, BLOCKING);
    expect(bounds.keep).toBeDefined();
    // The tag is what ensure_reach's ensure_tags / network's nodes_tag select on.
    const { blackboard } = generateZoneGrid(def, BLOCKING);
    expect(blackboard.features.byTag('boss_chamber').map(f => f.id)).toContain('keep');
  });
});
