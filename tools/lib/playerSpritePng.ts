// Node-only: composite a player paper-doll to a PNG buffer. Kept out of shared/
// so the client/vite build never pulls in pngjs (the compositor itself, in
// shared/playerComposite.ts, is pure and browser-safe).
//
// This is the same renderComposite the game calls — the workbench previews the
// real draw path, not a lookalike of it.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { GearVisual } from '../../shared/itemVisuals.ts';
import { SPRITE_SIZE, renderComposite } from '../../shared/playerComposite.ts';
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

export function playerSpritePng(
  spec: CompositeSpec,
  visuals: readonly GearVisual[],
  { scale = 1, dir = GEAR_DIR }: { scale?: number; dir?: string } = {},
): SpriteRenderResult {
  const layers: CompositeLayer[] = [];
  const missing: string[] = [];
  for (const visual of visuals) {
    const pixels = loadGearLayer(visual.layer, dir);
    if (pixels) layers.push({ pixels, visual });
    else missing.push(visual.layer);
  }
  return { png: rgbaToPng(renderComposite(spec, layers), scale), missing };
}
