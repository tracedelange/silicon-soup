// Node-only: composite a player paper-doll to a PNG buffer. Kept out of shared/
// so the client/vite build never pulls in pngjs (the compositor itself, in
// shared/playerComposite.ts, is pure and browser-safe).
//
// This is the same renderComposite the game calls — the workbench previews the
// real draw path, not a lookalike of it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { GearVisual } from '../../shared/itemVisuals.ts';
import { KEY_GRAYS, SPRITE_SIZE, rampStep } from '../../shared/playerComposite.ts';
import { renderComposite } from '../../shared/playerComposite.ts';
import type { CompositeLayer, CompositeSpec } from '../../shared/playerComposite.ts';

/** Where the hand-authored grayscale overlays live. Served to the game by vite
 *  as /gear/<layer>.png, read straight off disk here — so re-saving art in
 *  Aseprite and reloading the workbench is the whole iteration loop. */
export const GEAR_DIR = join(import.meta.dirname, '../../client/public/gear');

export class LayerSizeError extends Error {}

/** Decode one overlay. Returns null when the art doesn't exist yet, which is
 *  the normal state for archetypes nobody has drawn. */
export function loadGearLayer(name: string, dir = GEAR_DIR): Uint8ClampedArray | null {
  const path = join(dir, `${name}.png`);
  if (!existsSync(path)) return null;
  const png = PNG.sync.read(readFileSync(path));
  if (png.width !== SPRITE_SIZE || png.height !== SPRITE_SIZE) {
    throw new LayerSizeError(`${name}.png is ${png.width}x${png.height}, must be ${SPRITE_SIZE}x${SPRITE_SIZE}`);
  }
  return new Uint8ClampedArray(png.data);
}

/**
 * Overlay art as one authored step per pixel: -1 transparent, else the key-gray
 * index 0..4. This is the form the sprite-lab editor paints in and posts back —
 * a PNG's exact bytes are an encoding detail, the steps are the actual art, and
 * round-tripping through steps is what guarantees an edit can't drift the
 * palette off its key grays.
 */
export const TRANSPARENT = -1;

export function pixelsToSteps(pixels: Uint8ClampedArray): Int8Array {
  const steps = new Int8Array(SPRITE_SIZE * SPRITE_SIZE);
  for (let p = 0; p < steps.length; p++) {
    const i = p * 4;
    steps[p] = (pixels[i + 3] ?? 0) === 0
      ? TRANSPARENT
      : rampStep(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
  }
  return steps;
}

export function stepsToPixels(steps: ArrayLike<number>): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(SPRITE_SIZE * SPRITE_SIZE * 4);
  for (let p = 0; p < SPRITE_SIZE * SPRITE_SIZE; p++) {
    const step = steps[p] ?? TRANSPARENT;
    if (step < 0 || step >= KEY_GRAYS.length) continue;
    const v = KEY_GRAYS[step]!;
    const i = p * 4;
    pixels[i] = v; pixels[i + 1] = v; pixels[i + 2] = v; pixels[i + 3] = 255;
  }
  return pixels;
}

/** Nearest-neighbour upscale — pixel art previews have to stay hard-edged. */
function upscale(rgba: Uint8ClampedArray, factor: number): { data: Buffer; size: number } {
  const size = SPRITE_SIZE * factor;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (Math.floor(y / factor) * SPRITE_SIZE + Math.floor(x / factor)) * 4;
      const d = (y * size + x) * 4;
      out[d] = rgba[s]!; out[d + 1] = rgba[s + 1]!; out[d + 2] = rgba[s + 2]!; out[d + 3] = rgba[s + 3]!;
    }
  }
  return { data: out, size };
}

export function rgbaToPng(rgba: Uint8ClampedArray, scale = 1): Buffer {
  const { data, size } = scale > 1 ? upscale(rgba, scale) : { data: Buffer.from(rgba), size: SPRITE_SIZE };
  const png = new PNG({ width: size, height: size });
  png.data = data;
  return PNG.sync.write(png);
}

export interface SpriteRenderResult {
  png: Buffer;
  /** Layers that resolved but have no art on disk — what the workbench reports
   *  as "nothing drawn for this yet" rather than silently showing a bare body. */
  missing: string[];
}

export interface SpriteRenderOpts {
  scale?: number;
  dir?: string;
  /** Unsaved editor art, by layer name. Takes precedence over the PNG on disk,
   *  which is what makes the workbench preview a stroke before it's committed. */
  drafts?: Record<string, Uint8ClampedArray>;
}

export function playerSpritePng(
  spec: CompositeSpec,
  visuals: readonly GearVisual[],
  { scale = 1, dir = GEAR_DIR, drafts }: SpriteRenderOpts = {},
): SpriteRenderResult {
  const layers: CompositeLayer[] = [];
  const missing: string[] = [];
  for (const visual of visuals) {
    const pixels = drafts?.[visual.layer] ?? loadGearLayer(visual.layer, dir);
    if (pixels) layers.push({ pixels, visual });
    else missing.push(visual.layer);
  }
  return { png: rgbaToPng(renderComposite(spec, layers), scale), missing };
}

/** Write an overlay back to disk from the editor's step array. */
export function saveGearLayer(name: string, steps: ArrayLike<number>, dir = GEAR_DIR): void {
  writeFileSync(join(dir, `${name}.png`), rgbaToPng(stepsToPixels(steps)));
}
