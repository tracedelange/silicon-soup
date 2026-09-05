import { describe, expect, it } from 'vitest';
import { SPRITE_SIZE } from '../../shared/playerComposite.ts';
import { TRANSPARENT } from './playerSpritePng.ts';
import { CENTRE_PIVOT, handPivot, rotateSteps } from './spriteTransform.ts';

const AREA = SPRITE_SIZE * SPRITE_SIZE;
const at = (s: ArrayLike<number>, x: number, y: number) => s[y * SPRITE_SIZE + x];
const lit = (s: ArrayLike<number>) => { let n = 0; for (let i = 0; i < AREA; i++) if (s[i]! >= 0) n++; return n; };

function blank(): Int8Array { return new Int8Array(AREA).fill(TRANSPARENT); }

/** A short vertical bar above the pivot — a stand-in for a blade. */
function bar(pivot = CENTRE_PIVOT): Int8Array {
  const s = blank();
  for (let y = pivot.y - 10; y < pivot.y; y++) s[y * SPRITE_SIZE + pivot.x] = 4;
  return s;
}

describe('rotateSteps', () => {
  it('leaves art untouched at zero and at a full turn', () => {
    const s = bar();
    expect([...rotateSteps(s, 0)]).toEqual([...s]);
    expect([...rotateSteps(s, 360)]).toEqual([...s]);
  });

  it('returns to the original after four quarter turns', () => {
    const s = bar();
    let r = s;
    for (let i = 0; i < 4; i++) r = rotateSteps(r, 90);
    expect([...r]).toEqual([...s]);
  });

  it('keeps every pixel of a quarter turn — no art falls off the grid', () => {
    const s = bar();
    expect(lit(rotateSteps(s, 90))).toBe(lit(s));
  });

  it('swings a bar above the pivot out to the pivot\'s side', () => {
    const p = CENTRE_PIVOT;
    const turned = rotateSteps(bar(), 90);
    // Clockwise: what pointed up now points right.
    expect(at(turned, p.x + 4, p.y)).toBe(4);
    expect(at(turned, p.x, p.y - 4)).toBe(TRANSPARENT);
  });

  // The palette-safety property: sampling, never blending.
  it('never invents a value that was not already in the art', () => {
    const s = blank();
    for (let i = 0; i < 400; i++) s[i * 7 % AREA] = (i % 5) as number;
    const seen = new Set([...rotateSteps(s, 37)]);
    const source = new Set([...s, TRANSPARENT]);
    for (const v of seen) expect(source.has(v), `invented ${v}`).toBe(true);
  });

  it('fills what rotates in from outside with transparency, not wrapped art', () => {
    const s = blank();
    // A full top edge: after a quarter turn its old row must be empty, not wrapped.
    for (let x = 0; x < SPRITE_SIZE; x++) s[x] = 2;
    const turned = rotateSteps(s, 90);
    expect(at(turned, SPRITE_SIZE - 1, 0)).toBe(2);
    expect(at(turned, 0, 0)).toBe(TRANSPARENT);
  });

  // A pivot lands on a grid corner, so the four cells around it rotate among
  // themselves rather than one cell staying put. What matters for authoring is
  // that art AT the pivot doesn't drift away from it — that's what keeps a
  // rotated grip in the hand.
  //
  // Pivots here are explicit rather than handPivot's: that one reads whatever
  // body is checked in, and a test of rotation shouldn't change meaning when
  // someone redraws the character.
  it('keeps art at the pivot within the pivot block, at any angle', () => {
    const p = { x: 40, y: 40 };
    const s = blank();
    s[p.y * SPRITE_SIZE + p.x] = 3;
    for (const angle of [15, 45, 90, 137, 180, -60]) {
      const r = rotateSteps(s, angle, p);
      const block = [
        at(r, p.x, p.y), at(r, p.x - 1, p.y),
        at(r, p.x, p.y - 1), at(r, p.x - 1, p.y - 1),
      ];
      expect(block, `${angle}`).toContain(3);
    }
  });
});

describe('handPivot', () => {
  it('sits inside the sprite for every class', () => {
    for (const k of ['fighter', 'rogue', 'wizard'] as const) {
      const p = handPivot(k);
      expect(p.x, k).toBeGreaterThan(0);
      expect(p.x, k).toBeLessThan(SPRITE_SIZE);
      expect(p.y, k).toBeGreaterThan(0);
      expect(p.y, k).toBeLessThan(SPRITE_SIZE);
    }
  });

  it('sits on the weapon-hand side, not the middle', () => {
    // Rotating about the hand rather than the centre is the whole point; if the
    // two coincided, a rotated blade would leave the grip.
    expect(handPivot('fighter').x).toBeGreaterThan(CENTRE_PIVOT.x);
  });

  // An arm an odd number of pixels wide centres on a half pixel. Rotation works
  // in floats, so that's fine — but only if nothing downstream assumes an index.
  it('may land between pixels without breaking a rotation', () => {
    const p = handPivot('fighter');
    const s = blank();
    s[Math.floor(p.y) * SPRITE_SIZE + Math.floor(p.x)] = 2;
    expect([...rotateSteps(s, 90, p)].filter((v) => v === 2)).toHaveLength(1);
  });

  it('falls back to the centre for a body it cannot read', () => {
    expect(handPivot('necromancer' as never)).toEqual(handPivot('fighter'));
  });
});
