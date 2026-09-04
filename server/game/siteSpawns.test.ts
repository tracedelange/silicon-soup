import { describe, expect, it, vi } from 'vitest';
import { resolveSiteSpawns } from './siteSpawns.ts';
import type { DungeonDef, ZoneSpawn } from '../../shared/types.ts';

const BLOCKING = new Set(['wall', 'thatch', 'water', 'tree']);

function site(spawns: ZoneSpawn[]): DungeonDef[] {
  return [{
    id: 'camp', name: 'Camp',
    placement: { min_level: 5, max_level: 10 },
    zone: { biome: 'cave' } as never,
    footprint: {
      width: 32, height: 32, default_tile: 'transparent',
      ops: [
        { type: 'region', id: 'great_tent', shape: { kind: 'rect', w: 8, h: 8 }, at: { center: true }, floor: 'wood_floor', walls: { tile: 'thatch' } },
      ],
      spawns,
    } as never,
  } as DungeonDef];
}

const SITES = [{ id: 'camp', worldX: 200, worldY: -80 }];
const atlas = { sites: SITES, epoch: 0 } as never;

describe('resolveSiteSpawns', () => {
  it('is deterministic in (site, epoch)', () => {
    const roster = site([{ entity: 'wolf', count: 6 }]);
    expect(resolveSiteSpawns(atlas, roster, BLOCKING)).toEqual(resolveSiteSpawns(atlas, roster, BLOCKING));
  });

  it('re-rolls with the epoch', () => {
    const roster = site([{ entity: 'wolf', count: 6 }]);
    const a = resolveSiteSpawns({ sites: SITES, epoch: 0 } as never, roster, BLOCKING);
    const b = resolveSiteSpawns({ sites: SITES, epoch: 1 } as never, roster, BLOCKING);
    expect(a.map(s => `${s.x},${s.y}`)).not.toEqual(b.map(s => `${s.x},${s.y}`));
  });

  it('never stacks two entities on one tile', () => {
    const out = resolveSiteSpawns(atlas, site([{ entity: 'wolf', count: 12 }, { entity: 'bear', count: 12 }]), BLOCKING);
    expect(new Set(out.map(s => `${s.x},${s.y}`)).size).toBe(out.length);
  });

  it('places a region spawn inside that region', () => {
    // The region is 8x8 centered in a 32x32 footprint, i.e. local 12..19, and
    // the footprint is centered on the site tile (200, -80) → world 184..191 in
    // x. Anything outside means the local→world translation drifted.
    const out = resolveSiteSpawns(atlas, site([{ entity: 'torch', region: 'great_tent', count: 4 }]), BLOCKING);
    expect(out).toHaveLength(4);
    for (const s of out) {
      expect(s.x).toBeGreaterThanOrEqual(200 - 16 + 12);
      expect(s.x).toBeLessThan(200 - 16 + 20);
      expect(s.y).toBeGreaterThanOrEqual(-80 - 16 + 12);
      expect(s.y).toBeLessThan(-80 - 16 + 20);
      expect(s.region).toBe('great_tent');
    }
  });

  it('never places a scattered spawn on a blocking tile', () => {
    // The tent walls are thatch; a scatter across the whole footprint must route
    // around them rather than sealing a mob inside a wall.
    const out = resolveSiteSpawns(atlas, site([{ entity: 'wolf', count: 20 }]), BLOCKING);
    expect(out.length).toBeGreaterThan(0);
    // Re-derive the footprint frame and assert none landed on the tent's wall ring.
    const x0 = 200 - 16, y0 = -80 - 16;
    for (const s of out) {
      const lx = s.x - x0, ly = s.y - y0;
      const onWallRing = (lx === 12 || lx === 19 || ly === 12 || ly === 19)
        && lx >= 12 && lx <= 19 && ly >= 12 && ly <= 19;
      expect(onWallRing, `${lx},${ly}`).toBe(false);
    }
  });

  // Consequence 1: the arrangement re-rolls, so a region an authored spawn
  // depends on may simply not be there. That must be loud, not silent.
  it('warns and skips when a named region did not generate', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = resolveSiteSpawns(atlas, site([{ entity: 'boss', region: 'no_such_room' }]), BLOCKING);
    expect(out).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('stays quiet for an if_region spawn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = resolveSiteSpawns(atlas, site([{ entity: 'boss', region: 'no_such_room', if_region: true }]), BLOCKING);
    expect(out).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // `at` is the sconce escape hatch: exact, unfiltered, may sit on a wall.
  it('honours an exact `at` without a walkability check', () => {
    const out = resolveSiteSpawns(atlas, site([{ entity: 'torch', at: { x: 12, y: 12 }, count: 5 }]), BLOCKING);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ x: 200 - 16 + 12, y: -80 - 16 + 12 });
  });

  it('ignores a site with no footprint', () => {
    const roster = site([{ entity: 'wolf', count: 3 }]);
    delete roster[0]!.footprint;
    expect(resolveSiteSpawns(atlas, roster, BLOCKING)).toEqual([]);
  });
});
