import { describe, expect, it } from 'vitest';
import { rampFor } from './itemVisuals.ts';
import type { GearVisual } from './itemVisuals.ts';
import {
  GRID, POSE_ANCHORS, RAMP_STOPS, SPRITE_SIZE, TEMPLATES,
  buildPalette, expandRow, renderComposite,
} from './playerComposite.ts';
import type { ClassId } from './types.ts';

const CLASSES = Object.keys(TEMPLATES) as ClassId[];

function px(buf: Uint8ClampedArray, x: number, y: number): [number, number, number, number] {
  const i = (y * SPRITE_SIZE + x) * 4;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!, buf[i + 3]!];
}

/** A layer whose row y is painted in key gray step (y % RAMP_STOPS), so the
 *  recolor can be read back stop by stop. */
function gradientLayer(visual: GearVisual, x0 = 0, x1 = SPRITE_SIZE): { pixels: Uint8ClampedArray; visual: GearVisual } {
  const pixels = new Uint8ClampedArray(SPRITE_SIZE * SPRITE_SIZE * 4);
  for (let y = 0; y < SPRITE_SIZE; y++) {
    const gray = Math.round((y % RAMP_STOPS) * (255 / (RAMP_STOPS - 1)));
    for (let x = x0; x < x1; x++) {
      const i = (y * SPRITE_SIZE + x) * 4;
      pixels[i] = gray; pixels[i + 1] = gray; pixels[i + 2] = gray; pixels[i + 3] = 255;
    }
  }
  return { pixels, visual };
}

function hexToRGB(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// The mirror trick and the pose contract are what every future overlay is
// drawn against, so they are invariants, not incidental facts about today's art.
describe('body templates', () => {
  it('are half-width grids of the declared size', () => {
    for (const k of CLASSES) {
      expect(TEMPLATES[k], k).toHaveLength(GRID);
      for (const row of TEMPLATES[k]) expect(row.length, `${k}: "${row}"`).toBe(GRID / 2);
    }
  });

  it('mirror to a full row that is symmetric about the centre', () => {
    const row = expandRow('ab..............');
    expect(row).toHaveLength(GRID);
    expect(row).toBe('ab..............' + '..............ba');
  });

  it('use only legend characters the palette can paint', () => {
    for (const k of CLASSES) {
      const palette = buildPalette(k, '#6ec6f0');
      const unknown = new Set<string>();
      for (const row of TEMPLATES[k]) for (const ch of row) if (ch !== '.' && !palette[ch]) unknown.add(ch);
      expect([...unknown], k).toEqual([]);
    }
  });

  it('keep every pose anchor inside the grid', () => {
    for (const a of POSE_ANCHORS) {
      expect(a.from, a.label).toBeGreaterThanOrEqual(0);
      expect(a.to, a.label).toBeLessThan(GRID);
      expect(a.to, a.label).toBeGreaterThanOrEqual(a.from);
    }
  });
});

describe('renderComposite', () => {
  it('is deterministic for the same spec', () => {
    const a = renderComposite({ klass: 'rogue', color: '#a03040' });
    const b = renderComposite({ klass: 'rogue', color: '#a03040' });
    expect(a).toEqual(b);
  });

  it('renders every class at the full sprite size', () => {
    for (const k of CLASSES) {
      expect(renderComposite({ klass: k }), k).toHaveLength(SPRITE_SIZE * SPRITE_SIZE * 4);
    }
  });

  it('gives two players with different colors different pixels', () => {
    const a = renderComposite({ klass: 'fighter', color: '#ff0000' });
    const b = renderComposite({ klass: 'fighter', color: '#00ff00' });
    expect(a).not.toEqual(b);
  });

  it('falls back to a real body rather than throwing on an unknown class', () => {
    const odd = renderComposite({ klass: 'necromancer' as ClassId, color: '#6ec6f0' });
    expect(odd).toEqual(renderComposite({ klass: 'fighter', color: '#6ec6f0' }));
  });

  it('leaves transparent template cells transparent', () => {
    const buf = renderComposite({ klass: 'fighter', color: '#6ec6f0' });
    // Row 0 of every template is fully blank, so the top scanline must be clear.
    for (let x = 0; x < SPRITE_SIZE; x++) expect(px(buf, x, 0)[3], `x=${x}`).toBe(0);
  });
});

describe('overlay recoloring', () => {
  const ramp = rampFor('steel');

  it('maps each key gray onto the ramp stop at its index', () => {
    const buf = renderComposite({ klass: 'fighter' }, [gradientLayer({ layer: 'test', ramp })]);
    for (let step = 0; step < RAMP_STOPS; step++) {
      expect(px(buf, 0, step).slice(0, 3), `stop ${step}`).toEqual(hexToRGB(ramp[step]!));
    }
  });

  it('recolors the same shape differently per material, which is the whole point', () => {
    const steel = renderComposite({ klass: 'fighter' }, [gradientLayer({ layer: 'test', ramp: rampFor('steel') })]);
    const runed = renderComposite({ klass: 'fighter' }, [gradientLayer({ layer: 'test', ramp: rampFor('runed') })]);
    expect(steel).not.toEqual(runed);
  });

  it('pushes a brand into the highlights and leaves the darkest stop alone', () => {
    const plain = renderComposite({ klass: 'fighter' }, [gradientLayer({ layer: 'test', ramp })]);
    const fired = renderComposite({ klass: 'fighter' }, [gradientLayer({ layer: 'test', ramp, tint: '#ff6b2a' })]);
    expect(px(fired, 0, 0)).toEqual(px(plain, 0, 0));                      // stop 0: untouched
    expect(px(fired, 0, RAMP_STOPS - 1)).not.toEqual(px(plain, 0, RAMP_STOPS - 1)); // top stop: tinted
    expect(px(fired, 0, RAMP_STOPS - 1)[0]).toBeGreaterThan(px(plain, 0, RAMP_STOPS - 1)[0]);
  });

  it('draws layers in the order given, last on top', () => {
    const under = gradientLayer({ layer: 'a', ramp: rampFor('iron') });
    const over = gradientLayer({ layer: 'b', ramp: rampFor('gold') });
    const buf = renderComposite({ klass: 'fighter' }, [under, over]);
    expect(px(buf, 0, 2).slice(0, 3)).toEqual(hexToRGB(rampFor('gold')[2]));
  });
});

describe('rarity glow', () => {
  // The glow rings the item; it must never paint over the character.
  const ramp = rampFor('steel');
  const band = (visual: GearVisual) => gradientLayer(visual, 10, 12);

  it('lands on transparent pixels beside the silhouette', () => {
    const glowed = renderComposite({ klass: 'fighter' }, [band({ layer: 'test', ramp, glow: '#ff8c2a' })]);
    expect(px(glowed, 9, 0)[3]).toBeGreaterThan(0);
    expect(px(glowed, 12, 0)[3]).toBeGreaterThan(0);
  });

  it('does not paint over the body it rings', () => {
    const plain = renderComposite({ klass: 'fighter' }, [band({ layer: 'test', ramp })]);
    const glowed = renderComposite({ klass: 'fighter' }, [band({ layer: 'test', ramp, glow: '#ff8c2a' })]);
    for (let y = 0; y < SPRITE_SIZE; y++) {
      for (let x = 0; x < SPRITE_SIZE; x++) {
        if (px(plain, x, y)[3] === 0) continue;
        expect(px(glowed, x, y), `${x},${y}`).toEqual(px(plain, x, y));
      }
    }
  });

  it('does not glow at all when rarity is common', () => {
    const plain = renderComposite({ klass: 'fighter' }, [band({ layer: 'test', ramp })]);
    expect(plain).toEqual(renderComposite({ klass: 'fighter' }, [band({ layer: 'test', ramp })]));
    expect(px(plain, 9, 0)[3]).toBe(0);
  });
});
