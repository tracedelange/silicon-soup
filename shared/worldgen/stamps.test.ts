import { describe, expect, it } from 'vitest';
import { encodeGridRuns, stampTileAt, TRANSPARENT, type GridStamp, type WildStamp } from './stamps.ts';

function grid(ox: number, oy: number, w: number, h: number, cells: string[]): GridStamp {
  return { kind: 'grid', ox, oy, w, h, runs: encodeGridRuns(cells) };
}

describe('encodeGridRuns', () => {
  it('round-trips through stampTileAt', () => {
    const cells = ['a', 'a', 'b', 'c', 'c', 'c'];
    const g = grid(0, 0, 3, 2, cells);
    for (let i = 0; i < cells.length; i++) {
      expect(stampTileAt(i % 3, Math.floor(i / 3), [g])).toBe(cells[i]);
    }
  });

  it('collapses a uniform grid to a single run', () => {
    expect(encodeGridRuns(new Array(64 * 64).fill('dirt'))).toEqual([4096, 'dirt']);
  });

  it('emits one pair per run, not per cell', () => {
    expect(encodeGridRuns(['a', 'a', 'a', 'b'])).toEqual([3, 'a', 1, 'b']);
  });
});

describe('grid stamp', () => {
  it('translates local cells to the world origin', () => {
    const g = grid(100, -50, 2, 2, ['a', 'b', 'c', 'd']);
    expect(stampTileAt(100, -50, [g])).toBe('a');
    expect(stampTileAt(101, -50, [g])).toBe('b');
    expect(stampTileAt(100, -49, [g])).toBe('c');
    expect(stampTileAt(101, -49, [g])).toBe('d');
  });

  it('falls through outside its bounds', () => {
    const g = grid(0, 0, 2, 2, ['a', 'a', 'a', 'a']);
    expect(stampTileAt(-1, 0, [g])).toBeNull();
    expect(stampTileAt(2, 0, [g])).toBeNull();
    expect(stampTileAt(0, 2, [g])).toBeNull();
  });

  // The property that keeps a footprint from reading as a rectangular decal:
  // a transparent cell must not shadow the stamp painted beneath it.
  it('falls through transparent cells to the stamp beneath', () => {
    const under: WildStamp = { kind: 'blob', cx: 0, cy: 0, radius: 10, feather: 0, noiseScale: 1, seed: 1, tile: 'tree' };
    const over = grid(0, 0, 2, 1, ['dirt', TRANSPARENT]);
    expect(stampTileAt(0, 0, [under, over])).toBe('dirt');
    expect(stampTileAt(1, 0, [under, over])).toBe('tree');
  });

  it('is overridden by a later stamp (paint order)', () => {
    const g = grid(0, 0, 1, 1, ['dirt']);
    const road: WildStamp = { kind: 'line', x0: -5, y0: 0, x1: 5, y1: 0, half: 0, tile: 'road' };
    expect(stampTileAt(0, 0, [g, road])).toBe('road');
    expect(stampTileAt(0, 0, [road, g])).toBe('dirt');
  });

  // Same descriptor, repeated reads: the decode cache must not shift results.
  it('is stable across repeated lookups', () => {
    const g = grid(0, 0, 3, 3, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    const once = stampTileAt(2, 1, [g]);
    for (let i = 0; i < 5; i++) expect(stampTileAt(2, 1, [g])).toBe(once);
    expect(once).toBe('f');
  });
});
