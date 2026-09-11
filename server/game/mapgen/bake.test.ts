import { describe, expect, it } from 'vitest';
import { bakeSiteFootprint } from './bake.ts';
import { stampTileAt, TRANSPARENT } from '../../../shared/worldgen/stamps.ts';
import type { ZoneDef } from '../../../shared/types.ts';

const BLOCKING = new Set(['wall', 'water', 'tree']);

// A camp-shaped zone: void background (falls through to the field) with one
// walled structure scattered somewhere inside it.
const camp: ZoneDef = {
  id: 'test_camp',
  name: 'Test Camp',
  biome: 'wild',
  width: 24,
  height: 24,
  default_tile: 'void',
  ops: [
    { type: 'region', id: 'great_tent', shape: { kind: 'rect', w: 6, h: 6 }, at: { center: true }, floor: 'wood_floor', walls: { tile: 'wall' } },
  ],
} as unknown as ZoneDef;

describe('bakeSiteFootprint', () => {
  it('is deterministic for a given seed', () => {
    const a = bakeSiteFootprint(camp, 'camp:1', 0, 0, BLOCKING);
    const b = bakeSiteFootprint(camp, 'camp:1', 0, 0, BLOCKING);
    expect(a.stamp.runs).toEqual(b.stamp.runs);
  });

  it('anchors the footprint centered on the placement tile', () => {
    const { stamp } = bakeSiteFootprint(camp, 'camp:1', 300, -120, BLOCKING);
    expect(stamp.ox).toBe(300 - 12);
    expect(stamp.oy).toBe(-120 - 12);
    expect(stamp.w).toBe(24);
    expect(stamp.h).toBe(24);
  });

  // The whole point of the exercise: paint the structure, fall through everywhere
  // else, so the camp sits IN the terrain rather than on a rectangle of it.
  it('turns void background into fall-through and keeps the structure', () => {
    const { stamp } = bakeSiteFootprint(camp, 'camp:1', 0, 0, BLOCKING);
    expect(stampTileAt(stamp.ox, stamp.oy, [stamp])).toBeNull();     // corner: background
    expect(stampTileAt(0, 0, [stamp])).not.toBeNull();               // center: the tent
    expect(stamp.runs).not.toContain('void');
    expect(stamp.runs).toContain(TRANSPARENT);
  });

  it('reports only the blocking tiles it actually painted', () => {
    const { blocking } = bakeSiteFootprint(camp, 'camp:1', 0, 0, BLOCKING);
    expect(blocking).toContain('wall');
    expect(blocking).not.toContain('water');
    expect(blocking).not.toContain('wood_floor');
  });

  // Consequence 1: spawns address regions by name because the arrangement
  // re-rolls. A region an authored spawn depends on must survive every epoch.
  it('names the reserved region in every epoch', () => {
    for (let epoch = 0; epoch < 20; epoch++) {
      const { bounds } = bakeSiteFootprint(camp, `camp:${epoch}`, 0, 0, BLOCKING);
      expect(bounds.great_tent, `epoch ${epoch}`).toBeDefined();
    }
  });
});
