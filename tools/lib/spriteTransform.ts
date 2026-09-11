// Authoring-time transforms on overlay art, in the editor's step-per-pixel form.
// Lives in tools/ rather than shared/ because nothing at runtime rotates a
// sprite — the game draws what was baked — so the client bundle has no reason
// to carry this.

import { SPRITE_SIZE, handColumns } from '../../shared/playerComposite.ts';
import type { ClassId } from '../../shared/types.ts';
import { readAnchors, resolveBody } from './bodyStore.ts';
import { TRANSPARENT } from './playerSpritePng.ts';

export interface Pivot { x: number; y: number }

export const CENTRE_PIVOT: Pivot = { x: SPRITE_SIZE / 2, y: SPRITE_SIZE / 2 };

/**
 * The middle of the body's off-hand grip box, in sprite pixels — where a weapon
 * is actually held, and so the only pivot that keeps a rotated blade attached
 * to the character. Falls back to the image centre for a body whose arms can't
 * be read, since a slightly wrong pivot beats refusing to rotate.
 */
export function handPivot(klass: ClassId): Pivot {
  const anchors = readAnchors();
  const hands = handColumns(resolveBody(klass), anchors);
  const rows = anchors.find((a) => a.label === 'hands');
  if (!hands || !rows) return CENTRE_PIVOT;
  return {
    x: (hands.right[0] + hands.right[1] + 1) / 2,
    y: (rows.from + rows.to + 1) / 2,
  };
}

/**
 * Rotate art clockwise about `pivot`, by inverse-sampling: each destination
 * pixel asks which source pixel it came from, nearest-neighbour.
 *
 * That direction matters for more than speed. Sampling never blends two
 * neighbours, so every output value is a value that was already in the input —
 * a rotation cannot invent a gray between two key steps and quietly push the
 * art off its palette. It does mean the usual pixel-art cost: at anything but
 * a multiple of 90 degrees, thin diagonals get ragged and want a cleanup pass
 * by hand, which is exactly why this is a preview-then-apply operation.
 */
export function rotateSteps(
  steps: ArrayLike<number>,
  angleDeg: number,
  pivot: Pivot = CENTRE_PIVOT,
  size = SPRITE_SIZE,
): Int8Array {
  const out = new Int8Array(size * size).fill(TRANSPARENT);
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Offsets are measured from pixel centres, so a 90-degree turn maps whole
      // cells onto whole cells instead of landing on a boundary.
      const ex = x + 0.5 - pivot.x;
      const ey = y + 0.5 - pivot.y;
      const sx = Math.floor(pivot.x + ex * cos + ey * sin);
      const sy = Math.floor(pivot.y - ex * sin + ey * cos);
      if (sx < 0 || sx >= size || sy < 0 || sy >= size) continue;
      out[y * size + x] = steps[sy * size + sx] ?? TRANSPARENT;
    }
  }
  return out;
}
