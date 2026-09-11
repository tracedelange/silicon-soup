import { describe, expect, it } from 'vitest';
import { MASK_FULL, makeTileLayerBuffer, pickSeamTile, pickTileLayers, pickTileVariant } from './tileset.ts';
import type { Tileset } from './types.ts';

const ts: Tileset = {
  name: 'test',
  tile_size: 32,
  tiles: {
    grass: { color: '#0f0', blend: true, blendOrder: 3 },
    dirt: { color: '#960', blend: true, blendOrder: 2 },
    sand: { color: '#fc0', blend: true, blendOrder: 1 },
    snow: { color: '#fff', blend: true },      // blends, but no order — opted out
    water: { color: '#00f', blocking: true }, // no blend — must never leak
    chest: { color: '#a52' },                 // decoration, no blend
  },
  sprites: {},
};

describe('pickSeamTile', () => {
  it('leaves a tile alone when every neighbour is the same material', () => {
    for (let x = 0; x < 40; x++) {
      expect(pickSeamTile('grass', x, 7, ts, () => 'grass')).toBe('grass');
    }
  });

  it('never swaps a tile that has not opted into blending', () => {
    // A water tile fully surrounded by grass is the strongest possible pull.
    for (let x = 0; x < 40; x++) {
      expect(pickSeamTile('water', x, 3, ts, () => 'grass')).toBe('water');
    }
  });

  it('never swaps *to* a material that has not opted into blending', () => {
    // Drawing walkable grass as blocking water would lie about the map.
    for (let x = 0; x < 40; x++) {
      expect(pickSeamTile('grass', x, 5, ts, () => 'water')).toBe('grass');
      expect(pickSeamTile('grass', x, 6, ts, () => 'chest')).toBe('grass');
    }
  });

  it('only ever draws its own material or a neighbouring one', () => {
    for (let x = 0; x < 60; x++) {
      const drawn = pickSeamTile('grass', x, 0, ts, (dx, dy) => {
        if (dx === 0 && dy === -1) return 'sand';
        if (dx === 1 && dy === 0) return 'snow';
        return 'grass';
      });
      expect(['grass', 'sand', 'snow']).toContain(drawn);
    }
  });

  it('dithers along a seam without repainting the whole edge', () => {
    let swapped = 0;
    for (let y = 0; y < 200; y++) {
      if (pickSeamTile('grass', 0, y, ts, dx => (dx < 0 ? 'sand' : 'grass')) === 'sand') swapped++;
    }
    expect(swapped).toBeGreaterThan(0);
    expect(swapped).toBeLessThan(200);
  });

  it('blends harder the more of the other material surrounds it', () => {
    const count = (neighbor: (dx: number, dy: number) => string) => {
      let n = 0;
      for (let y = 0; y < 400; y++) if (pickSeamTile('grass', 11, y, ts, neighbor) === 'sand') n++;
      return n;
    };
    const cornerOnly = count((dx, dy) => (dx === -1 && dy === -1 ? 'sand' : 'grass'));
    const straightEdge = count(dx => (dx < 0 ? 'sand' : 'grass'));
    const surrounded = count(() => 'sand');
    expect(cornerOnly).toBeLessThan(straightEdge);
    expect(straightEdge).toBeLessThan(surrounded);
  });

  it('prefers the material with the most weight behind it', () => {
    // Sand on three cardinals, snow on one: snow never wins the tally.
    let sand = 0, snow = 0;
    for (let y = 0; y < 300; y++) {
      const drawn = pickSeamTile('grass', 3, y, ts, (dx, dy) => {
        if (dx === 1 && dy === 0) return 'snow';
        return dx === 0 || dy === 0 ? 'sand' : 'grass';
      });
      if (drawn === 'sand') sand++;
      if (drawn === 'snow') snow++;
    }
    expect(sand).toBeGreaterThan(0);
    expect(snow).toBe(0);
  });

  it('is deterministic in (x, y) — same coords, same answer', () => {
    const neighbor = (dx: number) => (dx < 0 ? 'sand' : 'grass');
    for (let y = 0; y < 50; y++) {
      expect(pickSeamTile('grass', 4, y, ts, neighbor))
        .toBe(pickSeamTile('grass', 4, y, ts, neighbor));
    }
  });
});

describe('pickTileVariant', () => {
  it('returns 0 when there is nothing to choose between', () => {
    expect(pickTileVariant('grass', 3, 9, 1)).toBe(0);
    expect(pickTileVariant('grass', 3, 9, 0)).toBe(0);
  });

  it('stays inside the variant range, weighted or not', () => {
    for (let x = 0; x < 100; x++) {
      const v = pickTileVariant('grass', x, 2, 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
      const w = pickTileVariant('grass', x, 2, 5, [3, 2, 2, 1, 1]);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(5);
    }
  });

  it('ignores weights whose length does not match the variant count', () => {
    for (let x = 0; x < 40; x++) {
      expect(pickTileVariant('grass', x, 1, 5, [1, 1])).toBe(pickTileVariant('grass', x, 1, 5));
    }
  });

  it('gives a zero-weight variant no patches at all', () => {
    for (let x = 0; x < 200; x++) {
      expect(pickTileVariant('sand', x, 6, 3, [1, 0, 1])).not.toBe(1);
    }
  });
});

// Bit order for corner masks: NW, NE, SE, SW.
const NW = 1, NE = 2, SE = 4, _SW = 8;

// A neighbourAt over a literal 3x3 written the way it looks on screen, so a
// test reads as the picture it is asserting about.
function neighborhood(rows: [string[], string[], string[]]) {
  return (dx: number, dy: number) => rows[dy + 1]![dx + 1]!;
}

describe('pickTileLayers', () => {
  const buf = makeTileLayerBuffer();
  const layers = (tile: string, at: (dx: number, dy: number) => string) =>
    Array.from({ length: pickTileLayers(tile, ts, at, buf) }, (_, i) => ({ ...buf[i]! }));

  it('returns a single full-coverage layer for a material with no blendOrder', () => {
    // snow opts out, so it must render exactly as it did before corner blending.
    expect(layers('snow', () => 'grass')).toEqual([{ tile: 'snow', mask: MASK_FULL }]);
  });

  it('returns a single full-coverage layer away from any seam', () => {
    expect(layers('grass', () => 'grass')).toEqual([{ tile: 'grass', mask: MASK_FULL }]);
  });

  it('never lets a non-participating neighbour bleed onto the ground', () => {
    // water/chest are the tiles whose look encodes where you can walk.
    expect(layers('sand', () => 'water')).toEqual([{ tile: 'sand', mask: MASK_FULL }]);
    expect(layers('sand', () => 'chest')).toEqual([{ tile: 'sand', mask: MASK_FULL }]);
  });

  it('gives a diagonal-only neighbour the single corner it touches', () => {
    expect(layers('sand', neighborhood([
      ['grass', 'sand', 'sand'],
      ['sand', 'sand', 'sand'],
      ['sand', 'sand', 'sand'],
    ]))).toEqual([
      { tile: 'sand', mask: MASK_FULL },
      { tile: 'grass', mask: NW },
    ]);
  });

  it('gives an edge neighbour both corners along that edge', () => {
    // The whole north edge is grass, so the seam runs across the tile rather
    // than nipping one corner of it.
    expect(layers('sand', neighborhood([
      ['grass', 'grass', 'grass'],
      ['sand', 'sand', 'sand'],
      ['sand', 'sand', 'sand'],
    ]))).toEqual([
      { tile: 'sand', mask: MASK_FULL },
      { tile: 'grass', mask: NW | NE },
    ]);
  });

  it('covers the tile completely when the higher material wins every corner', () => {
    expect(layers('sand', () => 'grass')).toEqual([
      { tile: 'sand', mask: MASK_FULL },
      { tile: 'grass', mask: MASK_FULL },
    ]);
  });

  it('orders three materials low to high, each filling under the next', () => {
    // sand tile with dirt to the west and grass to the east. Every corner is
    // won by dirt or grass, so sand is the base but never actually visible.
    const got = layers('sand', neighborhood([
      ['dirt', 'sand', 'grass'],
      ['dirt', 'sand', 'grass'],
      ['dirt', 'sand', 'grass'],
    ]));
    expect(got.map(l => l.tile)).toEqual(['sand', 'dirt', 'grass']);
    // Dirt covers the grass corners too — it underlies grass rather than
    // abutting it, so a soft mask edge can never open a gap between the two.
    expect(got[1]!.mask).toBe(MASK_FULL);
    expect(got[2]!.mask).toBe(NE | SE);
  });

  it('has each layer cover its own corners plus every higher layer\'s', () => {
    // Only the SE corner is grass; dirt holds the other three. Dirt still
    // covers all four, and grass sits on the one it won.
    const got = layers('dirt', neighborhood([
      ['dirt', 'dirt', 'dirt'],
      ['dirt', 'dirt', 'dirt'],
      ['dirt', 'dirt', 'grass'],
    ]));
    expect(got).toEqual([
      { tile: 'dirt', mask: MASK_FULL },
      { tile: 'grass', mask: SE },
    ]);
  });

  it('agrees with its neighbour about the corner they share', () => {
    // The masks only line up across a tile boundary if both sides resolve the
    // shared corner identically — this is the property the whole approach rests
    // on. Left tile's NE/SE corners must match the right tile's NW/SW.
    const grid: Record<string, string> = {
      '0,0': 'sand', '1,0': 'grass', '2,0': 'grass',
      '0,1': 'sand', '1,1': 'sand', '2,1': 'grass',
      '0,2': 'dirt', '1,2': 'sand', '2,2': 'grass',
    };
    const at = (x: number, y: number) => (dx: number, dy: number) => grid[`${x + dx},${y + dy}`] ?? 'sand';

    const left = layers(grid['1,1']!, at(1, 1));
    const leftGrass = left.find(l => l.tile === 'grass')!;
    const right = layers(grid['2,1']!, at(2, 1));

    // Right tile is grass throughout its own material, so grass covers its
    // whole tile; the left tile must therefore hand grass both corners on the
    // boundary they share.
    expect(right).toEqual([{ tile: 'grass', mask: MASK_FULL }]);
    expect(leftGrass.mask & NE).toBeTruthy();
    expect(leftGrass.mask & SE).toBeTruthy();
  });

  it('does not blend two materials that share a blendOrder', () => {
    const tied = { ...ts, tiles: { ...ts.tiles, dirt: { color: '#960', blend: true, blendOrder: 3 } } };
    const n = pickTileLayers('grass', tied, () => 'dirt', buf);
    expect(Array.from({ length: n }, (_, i) => ({ ...buf[i]! })))
      .toEqual([{ tile: 'grass', mask: MASK_FULL }]);
  });
});
