import { describe, expect, it } from 'vitest';
import { KEY_GRAYS, SPRITE_SIZE } from '../../shared/playerComposite.ts';
import { TRANSPARENT, pixelsToSteps, stepsToPixels } from './playerSpritePng.ts';

const AREA = SPRITE_SIZE * SPRITE_SIZE;

// The sprite-lab editor paints steps and saves PNGs; this pair is the boundary
// between the two. A lossy round-trip means an edit silently degrades the art
// every time it's saved and reopened.
describe('overlay step round-trip', () => {
  it('preserves every key gray and transparency', () => {
    const steps = new Int8Array(AREA).fill(TRANSPARENT);
    for (let i = 0; i < KEY_GRAYS.length; i++) steps[i] = i;
    expect([...pixelsToSteps(stepsToPixels(steps))]).toEqual([...steps]);
  });

  it('writes each step as its key gray, fully opaque', () => {
    const steps = new Int8Array(AREA).fill(TRANSPARENT);
    steps[0] = 3;
    const px = stepsToPixels(steps);
    expect([px[0], px[1], px[2], px[3]]).toEqual([KEY_GRAYS[3], KEY_GRAYS[3], KEY_GRAYS[3], 255]);
  });

  it('leaves transparent pixels fully clear, not black', () => {
    const px = stepsToPixels(new Int8Array(AREA).fill(TRANSPARENT));
    expect(px.every((v) => v === 0)).toBe(true);
  });

  it('snaps an off-key gray to its nearest stop rather than dropping it', () => {
    const px = new Uint8ClampedArray(AREA * 4);
    px[0] = 185; px[1] = 185; px[2] = 185; px[3] = 255; // a few off KEY_GRAYS[3]
    expect(pixelsToSteps(px)[0]).toBe(3);
  });

  it('treats any zero-alpha pixel as transparent whatever its color', () => {
    const px = new Uint8ClampedArray(AREA * 4);
    px[0] = 255; px[1] = 255; px[2] = 255; px[3] = 0;
    expect(pixelsToSteps(px)[0]).toBe(TRANSPARENT);
  });

  it('ignores an out-of-range step instead of writing garbage', () => {
    const steps = new Int8Array(AREA).fill(TRANSPARENT);
    steps[0] = 9;
    expect(stepsToPixels(steps)[3]).toBe(0);
  });
});
